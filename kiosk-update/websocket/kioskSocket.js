// websocket/kioskSocket.js
// 역할: 오케스트레이션(세션 생성/아이템 업서트/카드 바인딩/체크아웃) + 실시간 중계
const axios = require("axios");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

// ───── 설정
const API_BASE = process.env.API_BASE || "http://13.209.14.101:4000/api";
const STORE_ID = Number(process.env.STORE_ID || 1);
const KIOSK_ID = process.env.KIOSK_ID || "KIOSK-01";

const YOLO_CONF_THR = Number(process.env.YOLO_CONF_THR || 0.15);
const SCAN_STABLE_MS = Number(process.env.SCAN_STABLE_MS || 5000);

const api = axios.create({ baseURL: API_BASE, timeout: 8000 });

// ───── 라벨맵 로딩
const MAP_PATH = path.join(__dirname, "label-map.json");
let LABEL_TO_SPID = {};
function loadLabelMap() {
  try {
    LABEL_TO_SPID = JSON.parse(fs.readFileSync(MAP_PATH, "utf-8"));
    console.log("🗺️ label-map loaded. keys:", Object.keys(LABEL_TO_SPID).length);
  } catch (e) {
    console.warn("⚠️ label-map load fail:", e.message);
    LABEL_TO_SPID = {};
  }
}
loadLabelMap();
try { fs.watch(MAP_PATH, { persistent: false }, () => setTimeout(loadLabelMap, 200)); } catch {}

function getProductId(label) {
  const v = LABEL_TO_SPID?.[label];
  if (typeof v === "number") return v;
  if (v && typeof v === "object") return v.product_id ?? v.store_product_id;
  return null;
}

// ───── 유틸
function countsSignature(counts = {}) {
  return Object.entries(counts).map(([k, v]) => `${k}:${Number(v) || 0}`).sort().join("|");
}
function safeJson(p) {
  try { return JSON.stringify(p); } catch { return "{}"; }
}
function broadcast(wss, payload, { role, sessionId } = {}) {
  const msg = safeJson(payload);
  let cnt = 0;
  for (const c of wss.clients) {
    if (c.readyState !== WebSocket.OPEN) continue;
    if (role && c.role !== role) continue;
    if (sessionId && c.sessionId && c.sessionId !== sessionId) continue;
    try { c.send(msg); cnt++; } catch {}
  }
  const kind = payload.type || payload.action;
  const sid = payload.sessionId || sessionId || "ALL";
  console.log(`[WS→${role || "ALL"}] kind=${kind} sid=${sid} cnt=${cnt}`);
  return cnt;
}
function sendGoToScreen(wss, screen, sessionId) {
  const s = getSess(sessionId);
  if (s.lastScreen === screen) return;
  s.lastScreen = screen;
  const ts = Date.now();
  broadcast(wss, { type: "goToScreen", screen, sessionId, ts });
  broadcast(wss, { action: "goToScreen", screen, sessionId, ts });
}

async function upsertSessionItemsOnce(sessionCode, counts) {
  // label-map.json → store_product_id
  for (const [label, qtyRaw] of Object.entries(counts || {})) {
    const spid = getProductId(label);
    if (!spid) { console.warn("⚠️ unmapped label:", label); continue; }
    const qty = Math.max(1, Number(qtyRaw) || 1);

    // 서버가 upsert/replace를 지원하면 그 플래그를 같이 보냄
    // (없어도 동작은 함: 한 번만 보내니까)
    await apiAddItem(sessionCode, { store_product_id: spid, quantity: qty, replace: true });
  }
}


// ───── Vision 시작 명령 (controller에게 재시도 포함)
function sendStartVision(wss, sid, by="server") {
  // 1️⃣ controller + sessionId
  let sent = broadcast(wss, { action: "startVision" }, { role: "controller", sessionId: sid });
  // 2️⃣ controller 전체
  if (sent === 0) sent = broadcast(wss, { action: "startVision" }, { role: "controller" });
  // 3️⃣ 전체 브로드캐스트 (fallback)
  if (sent === 0) broadcast(wss, { action: "startVision" });

  // 모니터링용 프런트 표시(선택)
  broadcast(wss, { type: "startVision", by, sessionId: sid, ts: Date.now() }, { sessionId: sid });
}

// 세션 맵에서 열린 세션 하나 찾기
function getAnyOpenSession() {
  for (const [k, v] of SESS.entries()) {
    if (v.open && v.code) return { sid: k, S: v };
  }
  return null;
}

// ───── 세션 상태 매니저 (단일 책임)
const SESS = new Map(); // sid -> session object
function getSess(sessionId) {
  if (!SESS.has(sessionId))
    SESS.set(sessionId, { open: false, code: null, lastSig: null, lastChangeAt: 0, lastScreen: null, rescan: false });
  return SESS.get(sessionId);
}
let creatingSession = false;

// ─────────────────────────────────────────────
// 세션 자동 생성 / 재사용
// ─────────────────────────────────────────────

async function startOrReuseSession(wss, sid = "default") {
  const S = getSess(sid);

  // 이미 다른 sid에서 열린 세션이 있으면 그걸 재사용
  const opened = getAnyOpenSession?.();
  if (opened && (!S.open || !S.code)) {
    S.open = true;
    S.code = opened.S.code;
    S.lastSig = null;
    S.lastChangeAt = Date.now();
    S.lastScreen = null;

    console.log(`[SESSION] reuse opened code=${S.code} for sid=${sid} (from sid=${opened.sid})`);

    const payload = {
      type: "sessionStarted",
      session: {
        session_code: S.code,
        store_id: typeof STORE_ID !== "undefined" ? STORE_ID : opened.S.store_id ?? null,
        status: "OPEN",
      },
      sessionId: sid,
      ts: new Date().toISOString(),
    };

    // 해당 세션 구독자 & 전체에 브로드캐스트 (늦게 붙는 클라이언트 대비)
    broadcast(wss, payload, { sessionId: sid });
    broadcast(wss, payload);
    return S;
  }

  // 내 sid가 이미 열려 있으면 그대로 사용
  if (S.open && S.code) return S;

  // 누군가 생성 중이면 잠깐 대기 후 재시도(레이스 방지)
  if (creatingSession) {
    // wait until creating finished
    while (creatingSession) {
      // 150ms 대기
      /* eslint-disable no-await-in-loop */
      await new Promise((r) => setTimeout(r, 150));
      /* eslint-enable no-await-in-loop */
    }
    // 생성이 끝났다면 열린 세션을 재사용하거나 없으면 다시 호출
    const opened2 = getAnyOpenSession?.();
    if (opened2) {
      // 위 재사용 분기로 유도
      const tmp = { open: false, code: null };
      Object.assign(S, tmp);
    }
    return startOrReuseSession(wss, sid);
  }

  creatingSession = true;
  try {
    // 서버에 새 세션 생성
    const { data } = await api.post("/purchase-sessions", {
      store_id: STORE_ID,
      kiosk_id: KIOSK_ID,
      status: "OPEN",
    });

    const sess = (data && (data.session || data)) || {};

    // 필수 키 추출(백엔드 응답 shape 대비)
    const sessionCode = sess.session_code || sess.code;
    const storeId = sess.store_id ?? STORE_ID;
    const status = sess.status ?? "OPEN";

    if (!sessionCode) {
      throw new Error("No session_code returned from /purchase-sessions");
    }

    // 로컬 상태 갱신
    S.code = sessionCode;
    S.open = true;
    S.lastSig = null;
    S.lastChangeAt = Date.now();
    S.lastScreen = null;

    // 콘솔 로그(요청하신 포맷)
    console.log("🆕 session created:", {
      id: sess.id ?? null,
      session_code: sessionCode,
      store_id: storeId,
      status,
    });

    // 브로드캐스트
    const payload = {
      type: "sessionStarted",
      session: { session_code: sessionCode, store_id: storeId, status },
      sessionId: sid,
      ts: new Date().toISOString(),
    };
    broadcast(wss, payload, { sessionId: sid }); // 타깃
    broadcast(wss, payload);                     // 전체(늦게 붙은 클라 대비)

    return S;
  } catch (e) {
    const detail = e?.response?.data || e?.message || e;
    console.error("session create failed:", detail);
  } finally {
    creatingSession = false;
  }
  return S;
}



// function closeSession(sid) {
//   const S = getSess(sid);
//   if (!S.open) return;
//   console.log(`[SESSION] CLOSED sid=${sid} code=${S.code}`);
//   S.open = false; S.code = null; S.lastSig = null; S.lastChangeAt = 0; S.lastScreen = null;
// }

function closeSession(wss, sid, reason = "completed") {
  const S = getSess(sid);
  if (!S.open) {
    console.log(`[SESSION] CLOSE ignored (already closed) sid=${sid}`);
    return;
  }

  const code = S.code;
  console.log(`[SESSION] CLOSED sid=${sid} code=${code} reason=${reason}`);

  // 상태 초기화
  S.open = false;
  S.code = null;
  S.lastSig = null;
  S.lastChangeAt = 0;
  S.lastScreen = null;

  broadcast(wss, { type: "sessionEnded", reason, sessionId: sid, sessionCode: code });

  setTimeout(() => {
    console.log(`[SESSION] calling startOrReuseSession() after close for sid=${sid}`);
    startOrReuseSession(wss, sid);
  }, 300);
}




// ───── API helpers
async function apiAddItem(sessionCode, { store_product_id, quantity }) {
  const payload = { store_product_id, quantity };
  const { data } = await api.post(`/purchase-sessions/${sessionCode}/items`, payload);
  return data;
}
async function apiBindCardUid(sessionCode, uid) {
  const { data } = await api.post(`/purchase-sessions/${sessionCode}/bind-card-uid`, { uid });
  return data;
}
async function apiBindCardTags(sessionCode, windowSec = 60) {
  const { data } = await api.post(`/purchase-sessions/${sessionCode}/bind-card-tags`, { window_sec: windowSec });
  return data;
}
async function apiCheckout(sessionCode) {
  const { data } = await api.post(`/purchase-sessions/${sessionCode}/checkout`, { approve: true });
  return data;
}

// ───── WebSocket 서버
module.exports = (server) => {
  const wss = new WebSocket.Server({ server });
  console.log("[WS] kioskSocket started");

  // ✅ 서버 시작 시 기본 세션 1개 생성 (터미널에 무조건 찍히게)
  console.log("[BOOT] API base:", API_BASE);
  startOrReuseSession(wss, "default");

  wss.on("connection", (ws, req) => {
    try {
      const url = new URL(req?.url ?? "/", "http://localhost");
      ws.role = url.searchParams.get("role") || null;
      ws.sessionId = url.searchParams.get("session") || "default";
    } catch { ws.sessionId = "default"; }

    console.log("[WS] client connected:", { role: ws.role, sessionId: ws.sessionId });

    ws.on("message", async (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      const kind = m.type || m.action || "";
      const sid = m.sessionId || ws.sessionId || "default";
      const S = getSess(sid);

      if (kind === "hello") {
        if (m.role) ws.role = m.role;
        if (m.sessionId) ws.sessionId = m.sessionId;
        console.log(`[HELLO] role=${ws.role} sid=${ws.sessionId}`);

        const sid2 = ws.sessionId || "default";

        // A) 이미 '다른 sid'로 열린 세션이 있으면, 현재 sid에도 바인딩만 (새로 만들지 않음)
        const opened = getAnyOpenSession(); // ← 앞서 안내한 유틸
        if (opened) {
          const S2 = getSess(sid2);
          if (!S2.open || !S2.code) {
            S2.open = true; S2.code = opened.S.code;
            console.log(`[SESSION] bind existing code=${S2.code} to sid=${sid2}`);
            const payload = {
              type: "sessionStarted",
              session: { session_code: S2.code, store_id: STORE_ID, status: "OPEN" },
              sessionId: sid2,
              ts: new Date().toISOString(),
            };
            // ▶ 모든 클라이언트에게도 재통지하여 컨트롤러가 sid 갱신(재-hello) 하게 함
            broadcast(wss, payload);                     // ALL
            broadcast(wss, payload, { sessionId: sid2 }); // 타깃
          }
        } else {
          // 열린 세션이 하나도 없으면 생성
          await startOrReuseSession(wss, sid2);
        }

        // B) 컨트롤러가 이제 막 붙었고 세션이 열려있다면, 곧장 startVision 재전송
        if (ws.role === "controller") {
          const S2 = getSess(sid2);
          if (S2.open && S2.code) sendStartVision(wss, sid2, "hello-controller");
        }

        return;
      }



      if (kind === "hb" || kind === "heartbeat") {
        const phase = m.phase;   // ex) "waiting", "scan" 등
        const ready = m.ready;   // true/false
        const sid2 = m.sessionId || ws.sessionId || "default";
        const S2 = getSess(sid2);

        // ✅ waiting 상태면 startVision 재전송
        if (S2.open && (phase === "waiting" || ready === false)) {
          sendStartVision(wss, sid2, "hb-retry");
        }
        return;
      }



      // ── LiDAR 거리 이벤트
      if (kind === "lidarDistance") {
        const dist = Number(m.distance);
        const THR = Number(process.env.LIDAR_THRESHOLD_CM || 120);
        const near = Number.isFinite(dist) && dist <= THR;
        console.log("[LIDAR]", { dist, near, sid });
        if (near) sendGoToScreen(wss, "screen-basket", sid);
        return;
      }

      // ── 바구니 안정 → 세션 보장 + Vision 시작
      if (kind === "basketStable") {
        await startOrReuseSession(wss, sid);
        sendGoToScreen(wss, "screen-scan", sid);
        sendStartVision(wss, sid, "basketStable");        
        return;
      }

      // ── 스캔 종료: 최종 결과 업로드 + 확인 화면 전환
      if (kind === "scanComplete") {
        const sid = m.sessionId || ws.sessionId || "default";
        const S = getSess(sid);
        if (!S.open || !S.code) return;

        const finalCounts = m.objects || m.counts || {};  // controller가 보낸 최종 카운트
        console.log("[SCAN] final counts:", finalCounts, "→ upload once");

        // 1) 최종 카운트로 ‘한 번만’ 업로드
        for (const [label, qtyRaw] of Object.entries(finalCounts)) {
          const spid = getProductId(label);
          if (!spid) { console.warn("⚠️ unmapped label:", label); continue; }
          const qty = Math.max(1, Number(qtyRaw) || 1);
          try {
            await apiAddItem(S.code, { store_product_id: spid, quantity: qty });
          } catch (e) {
            console.warn("add item fail:", label, e?.response?.data || e.message);
          }
        }

        // 2) 컨트롤러 정지 지시(안전)
        broadcast(wss, { type: "stopVision", sessionId: sid, ts: Date.now() });

        // 3) 프론트가 세션코드 저장할 수 있게 함께 알림
        broadcast(wss, {
          type: "scanComplete",
          sessionId: sid,
          sessionCode: S.code,
          ts: Date.now()
        });

        // 4) 다음 화면 분기: 재스캔이면 바로 결제(card), 아니면 확인(items)
        const nextScreen = S.rescan ? "screen-card" : "screen-items";
        sendGoToScreen(wss, nextScreen, sid);
        S.rescan = false; // 소모 후 OFF
        return;
      }

      // ★ 클라이언트가 'start' 화면으로 복귀 요청하면 세션 종료로 간주
      if (kind === "goToScreen" && m.screen === "screen-start") {
        console.log(`[WS] goToScreen(screen-start) received → closeSession sid=${sid}`);
        closeSession(wss, sid, "returned-to-start");
        // 화면 전환은 close 이후에도 broadcast로 처리됨
        sendGoToScreen(wss, "screen-start", sid);
        return;
      }



      // YOLO 인식 결과
      if (kind === "yoloDetection" || kind === "yoloDetected" || kind === "objectDetected") {
        if (!S.open || !S.code) return;

        const conf   = Number(m.conf ?? m.confidence ?? 0);
        const counts = m.counts || {};
        if (conf < YOLO_CONF_THR) return;

        broadcast(wss, { type:"scanResult", counts, conf, sessionId:sid, ts: Date.now() });

        const now      = Date.now();
        const hasItems = Object.keys(counts).length > 0;

        if (!hasItems) {
          // ❗ 빈 결과는 안정화 타이머를 리셋(= 스캔 계속 유지)
          S.lastSig = null;
          S.lastChangeAt = now;
        } else {
          const sig = countsSignature(counts);
          if (sig !== S.lastSig) { S.lastSig = sig; S.lastChangeAt = now; S.finalCounts = counts; }
          else if (now - S.lastChangeAt >= SCAN_STABLE_MS) {
            const sessionCode = S.code;
            const ts = Date.now();
            broadcast(wss, { type:"stopVision", sessionId:sid, ts });
            broadcast(wss, { type:"scanComplete", reason:"stable-counts", sessionId:sid, sessionCode, ts });
            // 다음 화면 분기 
            const nextScreen = S.rescan ? "screen-card" : "screen-items";
            broadcast(wss, { type:"goToScreen",  screen: nextScreen, sessionId:sid, sessionCode, ts });
            broadcast(wss, { action:"goToScreen",screen: nextScreen, sessionId:sid, sessionCode, ts });
            S.rescan = false;
        }

        // 아이템 업로드 (기존 그대로)
        // for (const [label, qtyRaw] of Object.entries(counts)) {
        //   const spid = getProductId(label);
        //   if (!spid) continue;
        //   const qty = Math.max(1, Number(qtyRaw) || 1);
        //   await apiAddItem(S.code, { store_product_id: spid, quantity: qty })
        //     .catch(e => console.warn("add item fail:", label, e?.response?.data || e.message));
        // }
        return;
      }

      // ── (신규) 다시 스캔 요청: 프런트가 보냄
      if (kind === "requestRescan" || (kind === "goToScreen" && m.screen === "screen-rescan")) {
        await startOrReuseSession(wss, sid);   // 세션 보장
        const S = getSess(sid);
        S.rescan = true;                       // 재스캔 플래그 ON
        S.lastSig = null;                      // 안정화 타이머 리셋
        S.lastChangeAt = 0;

        // 화면 전환 + 비전 재시작
        sendGoToScreen(wss, "screen-rescan", sid);
        sendStartVision(wss, sid, "requestRescan");
        return;
      }

      // ── 카드 바인딩 (단발 + 타깃 브로드캐스트 + 디바운스)
      if (kind === "bindCardUid" || kind === "rfidUid") {
        if (!S.open || !S.code) return;

        const uid = m.uid || m.value;
        if (!uid) return;

        // ✅ 중복 방지: 같은 세션에서 1.5초 내 중복 무시
        const now = Date.now();
        if (S._lastCardBindAt && (now - S._lastCardBindAt) < 1500) {
          console.log(`[CARD] duplicated within 1.5s - ignored. sid=${sid}`);
          return;
        }
        // ✅ 이미 바인딩 끝났으면 무시(멱등)
        if (S._cardBound === true) {
          console.log(`[CARD] already bound - ignored. sid=${sid}`);
          return;
        }

        const r = await apiBindCardUid(S.code, uid).catch(e => ({ error: e }));
        S._lastCardBindAt = now;

        if (r?.error) {
          // 반드시 타깃만 전송
          broadcast(wss, { type: "cardBound", ok: false, reason: r.error.message, sessionId: sid }, { sessionId: sid });
          return;
        }

        S._cardBound = true; // 한 번만 처리되도록 플래그
        console.log(`[CARD] bound ok. sid=${sid} code=${S.code}`);

        // 반드시 타깃만 전송(전체 브로드캐스트 금지)
        broadcast(wss, { type: "cardBound", ok: true, uid_hash_hex: r?.uid_hash_hex, sessionId: sid }, { sessionId: sid });
        return;
      }


      // ── 결제 완료
      if (kind === "checkout" || kind === "paymentApproved") {
        if (!S.open || !S.code) return;
        try {
          // const r = await apiCheckout(S.code);
          // broadcast(wss, { type: "checkoutOk", ok: true, purchase_id: r.purchase_id, total_price: r.total_price, sessionId: sid });
          // closeSession(sid);
          // sendGoToScreen(wss, "screen-receipt", sid);
          const r = await apiCheckout(S.code);
          broadcast(wss, { type: "checkoutOk", /* ... */ sessionId: sid });
          // ✅ 종료 사유를 달아서 종료 + 자동 새 세션 생성
          closeSession(wss, sid, "payment-complete");
          // 영수증 화면으로 전환 (새 세션은 백그라운드에서 이미 생성됨)
          sendGoToScreen(wss, "screen-receipt", sid);

        } catch (e) {
          broadcast(wss, { type: "checkoutFailed", ok: false, reason: e?.response?.data || e.message, sessionId: sid });
        }
        return;
      }

      // 프런트가 resetKioskFlow()에서 보내는 종료 신호 처리
      if (kind === "sessionEnded" || kind === "session:end" || kind === "goHome") {
        console.log(`[WS] sessionEnded received from client → sid=${sid}`);
        closeSession(wss, sid, m?.reason || "front-reset");
        // closeSession 안에서 300ms 후 startOrReuseSession 호출됨
        return;
      }


      // ── 기타 화면 전환
      if (kind === "goToScreen" && m.screen) {
        sendGoToScreen(wss, m.screen, sid);
        return;
      }
  }});

    ws.on("close", () => {
      console.log("[WS] client disconnected:", { role: ws.role, sessionId: ws.sessionId });
    });
  });
};
