// websocket/kioskSocket.js
// 역할: 오케스트레이션(세션 생성/아이템 업서트/카드 바인딩/체크아웃) + 실시간 중계

require('dotenv').config();
console.log('[ENV]', process.env.KIOSK_ID, process.env.STORE_ID, process.env.API_BASE, process.env.TZ);

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
try {
  fs.watch(MAP_PATH, { persistent: false }, () => setTimeout(loadLabelMap, 200));
} catch { }

function getProductId(label) {
  const v = LABEL_TO_SPID?.[label];
  if (typeof v === "number") return v;
  if (v && typeof v === "object") return v.product_id ?? v.store_product_id;
  return null;
}

// ───── 유틸
function countsSignature(counts = {}) {
  return Object.entries(counts)
    .map(([k, v]) => `${k}:${Number(v) || 0}`)
    .sort()
    .join("|");
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
    try { c.send(msg); cnt++; } catch { }
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
    if (!spid) {
      console.warn("⚠️ unmapped label:", label);
      continue;
    }
    const qty = Math.max(1, Number(qtyRaw) || 1);

    // 서버가 upsert/replace를 지원하면 그 플래그를 같이 보냄
    await apiAddItem(sessionCode, { store_product_id: spid, quantity: qty, replace: true });
  }
}

// ───── Vision 시작/정지 명령 (controller에게 재시도 포함)
function sendStartVision(wss, sid, by = "server") {
  let sent = broadcast(
    wss,
    { action: "startVision", type: "startVision", cmd: "start", sessionId: sid, by },
    { role: "controller", sessionId: sid }
  );
  if (sent === 0) {
    sent = broadcast(
      wss,
      { action: "startVision", type: "startVision", cmd: "start", sessionId: sid, by },
      { role: "controller" }
    );
  }
  if (sent === 0) {
    broadcast(
      wss,
      { action: "startVision", type: "startVision", cmd: "start", sessionId: sid, by }
    );
  }

  // broadcast(
  //   wss,
  //   { type: "goToScreen", screen: "screen-scan", sessionId: sid, ts: Date.now() },
  //   { sessionId: sid }
  // );
  // console.log(`[STARTV] sent=${sent} sid=${sid}`);
}

function sendStopVision(wss, sid, by = "server") {
  let sent = broadcast(
    wss,
    { action: "stopVision", type: "stopVision", cmd: "stop", sessionId: sid, ts: Date.now(), by },
    { role: "controller", sessionId: sid }
  );
  if (sent === 0) {
    sent = broadcast(
      wss,
      { action: "stopVision", type: "stopVision", cmd: "stop", sessionId: sid, ts: Date.now(), by },
      { role: "controller" }
    );
  }
  if (sent === 0) {
    broadcast(
      wss,
      { action: "stopVision", type: "stopVision", cmd: "stop", sessionId: sid, ts: Date.now(), by }
    );
  }
  console.log(`[STOPV] sent=${sent} sid=${sid}`);
}

// ───── 세션 상태 매니저
const SESS = new Map(); // sid -> session object

function getAnyOpenSession() {
  for (const [k, v] of SESS.entries()) {
    if (v.open && v.code) return { sid: k, S: v };
  }
  return null;
}

function getSess(sessionId) {
  if (!SESS.has(sessionId)) {
    SESS.set(sessionId, {
      open: false,
      code: null,
      lastSig: null,
      lastChangeAt: 0,
      lastScreen: null,
    });
  }
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
    S.store_id = opened.S.store_id ?? (typeof STORE_ID !== "undefined" ? STORE_ID : null);
    S.lastSig = null;
    S.lastChangeAt = Date.now();
    S.lastScreen = null;
    S.createdAt = opened.S.createdAt || Date.now();
    S.itemsReady = !!opened.S.itemsReady;
    S._cardBound = false;
    S._pendingCard = null;

    console.log(`[SESSION] reuse opened code=${S.code} for sid=${sid} (from sid=${opened.sid})`);

    const payload = {
      type: "sessionStarted",
      session: {
        session_code: S.code,
        store_id: S.store_id,
        status: "OPEN",
      },
      sessionId: sid,
      ts: new Date().toISOString(),
    };

    broadcast(wss, payload, { sessionId: sid });
    broadcast(
      wss,
      {
        type: "sessionOpen",
        sessionId: sid,
        session_code: S.code,
        ts: new Date().toISOString(),
      },
      { sessionId: sid }
    );
    sendStopVision(wss, sid, "sessionOpen-reset");
    return S;
  }

  // 내 sid가 이미 열려 있으면 그대로 사용
  if (S.open && S.code) return S;

  // 누군가 생성 중이면 잠깐 대기 후 재시도(레이스 방지)
  if (creatingSession) {
    const waitUntil = Date.now() + 3000; // 3s
    while (creatingSession) {
      /* eslint-disable no-await-in-loop */
      await new Promise((r) => setTimeout(r, 150));
      /* eslint-enable no-await-in-loop */
      if (Date.now() > waitUntil) break;
    }
    const opened2 = getAnyOpenSession?.();
    if (opened2) {
      const tmp = { open: false, code: null };
      Object.assign(S, tmp);
    }
    return startOrReuseSession(wss, sid);
  }

  creatingSession = true;
  try {
    const { data } = await api.post("/purchase-sessions", {
      store_id: STORE_ID,
      kiosk_id: KIOSK_ID,
      status: "OPEN",
    });

    const sess = (data && (data.session || data)) || {};
    const sessionCode = sess.session_code || sess.code;
    const storeId = sess.store_id ?? STORE_ID;
    const status = sess.status ?? "OPEN";

    if (!sessionCode) {
      throw new Error("No session_code returned from /purchase-sessions");
    }

    S.code = sessionCode;
    S.open = true;
    S.store_id = storeId;
    S.lastSig = null;
    S.lastChangeAt = Date.now();
    S.lastScreen = null;
    S.createdAt = Date.now();
    S.itemsReady = false;
    S._cardBound = false;
    S._pendingCard = null;

    console.log("🆕 session created:", {
      id: sess.id ?? null,
      session_code: sessionCode,
      store_id: storeId,
      status,
    });

    const payload = {
      type: "sessionStarted",
      session: { session_code: sessionCode, store_id: storeId, status },
      sessionId: sid,
      ts: new Date().toISOString(),
    };
    broadcast(wss, payload, { sessionId: sid });

    broadcast(
      wss,
      {
        type: "sessionOpen",
        sessionId: sid,
        session_code: sessionCode,
        ts: new Date().toISOString(),
      },
      { sessionId: sid }
    );
    broadcast(
      wss,
      { type: "stopVision", sessionId: sid, ts: Date.now() },
      { sessionId: sid }
    );

    return S;
  } catch (e) {
    const detail = e?.response?.data || e?.message || e;
    console.error("session create failed:", detail);
  } finally {
    creatingSession = false;
  }
  return S;
}

function closeSession(wss, sid, reason = "completed") {
  const S = getSess(sid);
  if (!S.open) {
    console.log(`[SESSION] CLOSE ignored (already closed) sid=${sid}`);
    return;
  }

  const code = S.code;
  const closedAt = Date.now();
  console.log(`[SESSION] CLOSED sid=${sid} code=${code} reason=${reason}`);

  globalThis.__LAST_CLOSED_AT = globalThis.__LAST_CLOSED_AT || new Map();
  globalThis.__LAST_CLOSED_AT.set(code, closedAt);

  for (const [k, v] of SESS.entries()) {
    if (v.open && v.code === code) {
      v.open = false;
      v.code = null;
      v.lastSig = null;
      v.lastChangeAt = 0;
      v.lastScreen = null;
      v._cardBound = false;
      v._lastCardBindAt = 0;
      v.itemsReady = false;
      v._pendingCard = null;
      v.createdAt = 0;
      console.log(`[SESSION] closed peer sid=${k} (shared code)`);
    }
  }

  broadcast(wss, { type: "sessionEnded", reason, sessionId: sid, sessionCode: code });

  globalThis.__REOPEN_GUARD = globalThis.__REOPEN_GUARD || new Set();
  const reopenKey = `reopen:${sid}`;
  if (!globalThis.__REOPEN_GUARD.has(reopenKey)) {
    globalThis.__REOPEN_GUARD.add(reopenKey);
    setTimeout(() => {
      try {
        console.log(`[SESSION] calling startOrReuseSession() after close for sid=${sid}`);
        startOrReuseSession(wss, sid);
      } finally {
        globalThis.__REOPEN_GUARD.delete(reopenKey);
      }
    }, 1300);
  }
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
  const { data } = await api.post(`/purchase-sessions/${sessionCode}/bind-card-tags`, {
    window_sec: windowSec,
  });
  return data;
}

async function apiReplaceAllItems(sessionCode, items) {
  const { data } = await api.put(`/purchase-sessions/${sessionCode}/items/replace-all`, {
    items,
  });
  return data;
}


async function apiCheckout(sessionCode) {
  const { data } = await api.post(`/purchase-sessions/${sessionCode}/checkout`, {
    approve: true,
  });
  return data;
}

// ── 결제 중복 방지 락
const payLocks = new Map(); // sid -> boolean

function isLocked(sid) { return !!payLocks.get(sid); }
function lock(sid) { payLocks.set(sid, true); }
function unlockLater(sid, ms = 2500) {
  setTimeout(() => payLocks.set(sid, false), ms);
}

// ───── WebSocket 서버
module.exports = (server) => {
  const wss = new WebSocket.Server({ server });
  console.log("[WS] kioskSocket started");

  console.log("[BOOT] API base:", API_BASE);
  startOrReuseSession(wss, "default");

  wss.on("connection", (ws, req) => {
    try {
      const url = new URL(req?.url ?? "/", "http://localhost");
      ws.role = url.searchParams.get("role") || null;
      ws.sessionId = url.searchParams.get("session") || "default";
    } catch {
      ws.sessionId = "default";
    }

    console.log("[WS] client connected:", { role: ws.role, sessionId: ws.sessionId });

    ws.on("message", async (raw) => {
      let m;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const rk = String(m.type || m.action || m.event || "").toLowerCase();
      if (rk.includes("rfid") || rk.includes("card")) {
        console.log("[RFID/ CARD EVENT]", rk, m);
      }

      const kind = m.type || m.action || "";
      const sid = ws.sessionId || m.sessionId || "default";
      const S = getSess(sid);

      // ── hello ─────────────────────
      if (kind === "hello") {
        if (m.role) ws.role = m.role;
        if (m.sessionId) ws.sessionId = m.sessionId;
        const sid2 = ws.sessionId || "default";
        console.log(`[HELLO] role=${ws.role} sid=${sid2}`);

        const opened = getAnyOpenSession();
        if (opened) {
          const S2 = getSess(sid2);
          if (!S2.open || !S2.code) {
            S2.open = true;
            S2.code = opened.S.code;
            console.log(`[SESSION] bind existing code=${S2.code} to sid=${sid2}`);
          }

          if (ws.role === "lidar" || ws.role === "controller" || ws.role === "front") {
            const prev = ws.sessionId;
            ws.sessionId = opened.sid;
            console.log(`[HELLO] rebind ${ws.role} to sid=${ws.sessionId}`);

            const payload = {
              type: "sessionStarted",
              session: { session_code: S2.code, store_id: STORE_ID, status: "OPEN" },
              sessionId: ws.sessionId,
              ts: new Date().toISOString(),
            };
            try { ws.send(JSON.stringify(payload)); } catch { }
          }
        } else {
          await startOrReuseSession(wss, sid2);
        }

        const S2 = getSess(sid2);

        if (ws.role === "lidar") {
          const payload = {
            type: "sessionStarted",
            session: { session_code: S2.code, store_id: STORE_ID, status: "OPEN" },
            sessionId: sid2,
            ts: new Date().toISOString(),
          };
          try { ws.send(JSON.stringify(payload)); } catch { }
          console.log(`[HELLO→lidar] session echo sent sid=${sid2} code=${S2.code}`);
        }

        if (ws.role === "controller") {
          console.log(`[HELLO→controller] ready & waiting sid=${sid2}`);
          const effectiveSid = ws.sessionId || sid2;
          const Scur = getSess(effectiveSid);
          if (Scur.lastScreen === "screen-scan") {
            sendStartVision(wss, effectiveSid, "hello-controller");
          }
        }

        return;
      }

      // ── heartbeat ─────────────────
      if (kind === "hb" || kind === "heartbeat") {
        const phase = m.phase;
        const ready = m.ready;
        const sid2 = m.sessionId || ws.sessionId || "default";
        const S2 = getSess(sid2);

        if (S2.open && (phase === "waiting" || ready === false)) {
          // 필요 시 재시작용: sendStartVision(wss, sid2, "hb-retry");
        }
        return;
      }

      // ── LiDAR 거리 이벤트 ─────────
      if (kind === "lidarDistance" || kind === "startKioskByLidar") {
        const dist = Number(m.distance);
        const THR = Number(process.env.LIDAR_THRESHOLD_CM || 120);
        const near = Number.isFinite(dist) && dist <= THR;
        console.log("[LIDAR]", { dist, near, sid });

        if (!near) return;

        await startOrReuseSession(wss, sid);
        sendGoToScreen(wss, "screen-basket", sid);

        setTimeout(() => {
          sendStopVision(wss, sid, "pre-start");
          setTimeout(() => sendStartVision(wss, sid, "lidar"), 180);
        }, 120);

        return;
      }

      // ── 프론트/라이다가 보낸 startVision 중계 ─
      if (kind === "startVision") {
        console.log(`[WS] startVision relay sid=${sid}`);
        // ★ 재스캔 여부 저장
        S.rescanMode = m.mode === "rescan";

        // 컨트롤러로 송신 
        broadcast(wss, { type: "startVision", sessionId: sid });
        return;
      }

      // ── 바구니 안정 → 세션 보장 + Vision 시작 ─
      if (kind === "basketStable") {
        await startOrReuseSession(wss, sid);
        sendGoToScreen(wss, "screen-scan", sid);
        sendStartVision(wss, sid, "basketStable");
        return;
      }

      // ── 스캔 종료: 최종 결과 업로드 + 확인 화면 ─
      if (kind === "scanComplete") {
        const sid = m.sessionId || ws.sessionId || "default";
        const S = getSess(sid);
        if (!S.open || !S.code) return;

        const finalCounts = m.objects || m.counts || {};
        console.log("[SCAN] final counts:", finalCounts,
                    S.rescanMode ? "→ replace-all upload" : "→ upsert upload");

        const itemsPayload = [];
        for (const [label, qtyRaw] of Object.entries(finalCounts)) {
          const spid = getProductId(label);
          if (!spid) { console.warn("⚠️ unmapped label:", label); continue; }
          const qty = Math.max(1, Number(qtyRaw) || 1);
          itemsPayload.push({ store_product_id: spid, quantity: qty });
        }

        try {
          if (S.rescanMode) {
            // ✅ 재스캔: 전체 갈아치우기
            await apiReplaceAllItems(S.code, itemsPayload);
          } else {
            // ✅ 첫 스캔: 기존 upsert 로직 사용
            for (const it of itemsPayload) {
              await apiAddItem(S.code, {
                store_product_id: it.store_product_id,
                quantity: it.quantity,
                replace: false,
              });
            }
          }
        } catch (e) {
          console.warn("items upload fail:", e?.response?.data || e.message);
        } finally {
          // 재스캔 플래그 리셋
          S.rescanMode = false;
        }

        // DB 업로드 끝난 뒤
        S.lastSig = null;
        S.lastChangeAt = 0;
        S.finalCounts = null;

        // 이후 화면 전환/stopVision은 지금 코드 그대로 유지
        sendStopVision(wss, sid, "scan-complete");
        broadcast(wss, {
          type: "scanComplete",
          sessionId: sid,
          sessionCode: S.code,
          ts: Date.now(),
        });
        sendGoToScreen(wss, "screen-items", sid);
        return;
      }


      // ── 재스캔 시작 ─────────────────────────────
      if (kind === "rescanStart") {
        const S2 = getSess(sid);
        if (!S2.open || !S2.code) return;

        console.log(`[RESCAN] start for sid=${sid}, code=${S2.code}`);

        // 🔑 YOLO 안정성 상태 리셋
        S2.lastSig = null;
        S2.lastChangeAt = 0;
        S2.finalCounts = null;

        try {
          await apiReplaceAllItems(S2.code, []);   // DB 아이템 전체 삭제
        } catch (e) {
          console.warn("[RESCAN] replace-all([]) fail", e?.response?.data || e.message);
        }

        // 화면 전환 + Vision 재시작
        sendGoToScreen(wss, "screen-rescan", sid);
        sendStartVision(wss, sid, "rescan");
        return;
      }




      // ── 화면 이동 → 세션/결제 훅 ───────────
      if (kind === "goToScreen" && m.screen) {
        sendGoToScreen(wss, m.screen, sid);

        if (m.screen === "screen-start") {
          closeSession(wss, sid, "front-goto-start");
          return;
        }

        if (m.screen === "screen-card") {
          const S2 = getSess(sid);
          if (S2?.open && S2?.code) {
            // 카드 태깅 대기 상태만, 체크아웃은 프런트/다른 로직에서
          }
          return;
        }
      }

      // ── YOLO 인식 결과 ─────────────
      if (kind === "yoloDetection" || kind === "yoloDetected" || kind === "objectDetected") {
        if (!S.open || !S.code) return;

        const conf = Number(m.conf ?? m.confidence ?? 0);
        const counts = m.counts || {};
        if (conf < YOLO_CONF_THR) return;

        broadcast(wss, {
          type: "scanResult",
          counts,
          conf,
          sessionId: sid,
          ts: Date.now(),
        });

        const now = Date.now();
        const hasItems = Object.keys(counts).length > 0;

        if (!hasItems) {
          S.lastSig = null;
          S.lastChangeAt = now;
        } else {
          const sig = countsSignature(counts);
          if (sig !== S.lastSig) {
            S.lastSig = sig;
            S.lastChangeAt = now;
            S.finalCounts = counts;
          } else if (S.lastChangeAt && now - S.lastChangeAt >= SCAN_STABLE_MS) {
            const sessionCode = S.code;
            const ts = Date.now();
            sendStopVision(wss, sid, "stable-counts");
            broadcast(wss, {
              type: "scanComplete",
              reason: "stable-counts",
              sessionId: sid,
              sessionCode,
              ts,
            });
            sendGoToScreen(wss, "screen-items", sid);
          }
        }
        return;
      }

      // ── UID 직접 바인딩 ─────────────
      if (kind === "bindCardUid" || kind === "rfidUid") {
        if (!S.open || !S.code) return;
        const uid = m.uid || m.value;
        if (!uid) return;

        try {
          const r = await apiBindCardUid(S.code, uid);
          broadcast(
            wss,
            {
              type: "cardBound",
              ok: true,
              uid_hash_hex: r?.uid_hash_hex,
              sessionId: sid,
            },
            { sessionId: sid }
          );
        } catch (e) {
          broadcast(
            wss,
            {
              type: "cardBound",
              ok: false,
              reason: e?.response?.data || e?.message,
              sessionId: sid,
            },
            { sessionId: sid }
          );
        }
        return;
      }

      // ── RFID 이벤트(태그 + 즉시 결제) ────────
      if (rk === "rfidtagged" || rk === "rfiddetected" || rk === "bindcarduid") {
        const sid2 = ws.sessionId || m.sessionId || "default";
        const S2 = getSess(sid2);
        if (!S2?.open || !S2?.code) return;
        if (isLocked(sid2)) return;
        lock(sid2);

        (async () => {
          try {
            if (m.uid) {
              const r = await apiBindCardUid(S2.code, m.uid);
              const ok = !!(r?.uid_hash_hex || r?.card_uid_hash);
              if (!ok) throw new Error("bind-card-uid returned without uid hash");
              broadcast(wss, {
                type: "cardBound",
                sessionId: sid2,
                uid_hash_hex: r.uid_hash_hex,
              });
              await apiCheckout(S2.code);
              broadcast(wss, { type: "checkoutOk", sessionId: sid2 });
              sendGoToScreen(wss, "screen-receipt", sid2);
              setTimeout(
                () => closeSession(wss, sid2, "payment-complete"),
                3000
              );
            }
          } catch (e) {
            const reason = e?.response?.data || e?.message || String(e);
            console.warn("[RFID→bind/checkout] failed:", reason);
            broadcast(wss, {
              type: "checkoutFailed",
              ok: false,
              reason,
              sessionId: sid2,
            });
          } finally {
            unlockLater(sid2, 2500);
          }
        })();

        return;
      }

      // ── 결제 완료(수동 트리거) ─────────────
      if (kind === "checkout" || kind === "paymentApproved") {
        if (!S.open || !S.code) return;
        try {
          await apiCheckout(S.code);
          broadcast(wss, { type: "checkoutOk", sessionId: sid });

          sendGoToScreen(wss, "screen-receipt", sid);
          setTimeout(() => {
            closeSession(wss, sid, "payment-complete");
          }, 3000);
        } catch (e) {
          const reason = e?.response?.data || e?.message || String(e);
          console.error("[CHECKOUT] fail:", reason);
          broadcast(wss, {
            type: "checkoutFailed",
            ok: false,
            reason,
            sessionId: sid,
          });
        }
        return;
      }

      // ── 세션 종료(프론트 리셋) ──────────────
      if (kind === "sessionEnded" || kind === "session:end" || kind === "goHome") {
        console.log(`[WS] sessionEnded received from client → sid=${sid}`);
        closeSession(wss, sid, m?.reason || "front-reset");
        return;
      }
    });

    ws.on("close", () => {
      console.log("[WS] client disconnected:", {
        role: ws.role,
        sessionId: ws.sessionId,
      });
    });
  });
};
