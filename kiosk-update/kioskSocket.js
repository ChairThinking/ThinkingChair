// kioskSocket.js (patched final)
const axios = require("axios");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

// ─────────────────────────────────────────────
// API & 상수
// ─────────────────────────────────────────────
const API_BASE  = process.env.API_BASE  || "http://43.201.105.163:4000/api";
const STORE_ID  = Number(process.env.STORE_ID  || 1);
const KIOSK_ID  = process.env.KIOSK_ID || "KIOSK-01";

const OFFLINE_MODE = process.env.OFFLINE_MODE === "0";

const AUTO_SUB = process.env.AUTO_SUB !== "0";

const api = axios.create({ baseURL: API_BASE, timeout: 7000 });
console.log("🔗 API base:", API_BASE);

const YOLO_CONF_THR    = Number(process.env.YOLO_CONF_THR || 0.40);
const YOLO_COOLDOWN_MS = Number(process.env.YOLO_COOLDOWN_MS || 2000);
const SESSION_TTL_MS   = Number(process.env.SESSION_TTL_MS || 5 * 60 * 1000);
const SCAN_IDLE_MS     = Number(process.env.SCAN_IDLE_MS   || 5000); // “무변화” 타임아웃(ms)

const lastAdd = new Map();
const ADD_COOLDOWN_MS = 3000;

// 라이다
const LIDAR_THRESHOLD_CM = 50;
const LIDAR_HYSTERESIS   = 5;
const LIDAR_COOLDOWN_MS  = 2000;

// 라벨 → store_product_id 매핑(JSON)
const MAP_PATH = path.join(__dirname, "label-map.json"); // { "cola_can": 101, ... }
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
fs.watch(MAP_PATH, { persistent: false }, () => setTimeout(loadLabelMap, 200));

// ─────────────────────────────────────────────
// 세션/상태 전역
// ─────────────────────────────────────────────
let currentSession = null;     // { id, session_code, store_id, status, created_at }
let lastSessionTouched = 0;
const lastYoloSentAt = new Map(); // (session_code:spid)별 쿨다운

// 화면/스캔 단계
let sessionActive = false;
let sessionArmed  = false;     // ← 누락 보완
let wasNear = false;
let prevDist = null;
let lidarCooldownUntil = 0;
let controllerReady = false; 

let visionEnabled = false;     // "서버가" 연 상태에서만 비전 이벤트 처리
let phase = "start";           // "start" | "scan" | "card"

let hasAnyVision = false;      // 첫 탐지 전에는 idle 타이머 금지
let finalized = false;         // 중복 finalize 방지
let idleTimer = null;

// ─────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────
function broadcastAll(wss, obj) {
  const msg = JSON.stringify(obj);
  for (const c of wss.clients) {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  }
}

function broadcastToSession(wss, sessionCode, obj) {
  if (!sessionCode) return;
  const msg = JSON.stringify(obj);
  for (const c of wss.clients) {
    if (c.readyState !== WebSocket.OPEN) continue;
    if (c.subscribedSession === sessionCode) {
      try { c.send(msg); } catch {}
    }
  }
}

function reply(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch (e) { console.error("ws.send 실패:", e); }
}

// ★★★ [ADD] AUTO-SUB 유틸: 개별 소켓, 전체 소켓
function autoSubscribe(ws, sessionCode) {
  if (!ws || !sessionCode) return;
  ws.subscribedSession = sessionCode;
  reply(ws, { type: "SUB_OK", session_code: sessionCode });
  console.log(`[WS] AUTO_SUB → ${sessionCode}`);
}

function autoSubscribeAll(wss, sessionCode) {
  if (!wss || !sessionCode) return;
  for (const c of wss.clients) {
    if (c.readyState === WebSocket.OPEN && !c.subscribedSession) {
      c.subscribedSession = sessionCode;
      reply(c, { type: "SUB_OK", session_code: sessionCode });
      console.log(`[WS] AUTO_SUB (all) → ${sessionCode}`);
    }
  }
}


function clearIdleTimer() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}
function armIdleTimer(wss) {
  clearIdleTimer();
  if (!SCAN_IDLE_MS) return;
  if (!hasAnyVision) return; // 첫 탐지 전 X
  idleTimer = setTimeout(() => {
    finalizeScan(wss, "idle-timeout");
  }, SCAN_IDLE_MS);
}
function makeResetAll(wss) {
  return () => {
    sessionActive = false;
    sessionArmed = false;
    wasNear = false;
    currentSession = null;
    lastSessionTouched = 0;
    clearIdleTimer();
    lastYoloSentAt.clear();
    phase = "start";
    visionEnabled = false;
    finalized = false;
    hasAnyVision = false;
    broadcastAll(wss, { action: "sessionEnded", ts: new Date().toISOString() });
  };
}
function normalizeUid(raw) {
  if (!raw) return "";
  return String(raw).replace(/^0x/i,"").replace(/[^0-9a-fA-F]/g,"").toUpperCase();
}

// ─────────────────────────────────────────────
// API helpers
// ─────────────────────────────────────────────

// 세션 생성: 서버 스펙에 맞춰 OPEN으로 생성 (kiosk_id도 전달)
async function apiCreateSession() {
  const body = { store_id: STORE_ID, status: "OPEN", source: "kiosk" };
  if (KIOSK_ID) body.kiosk_id = KIOSK_ID;
  const { data } = await api.post(`/purchase-sessions`, body);
  return data; // { id, session_code, store_id, status, created_at }
}

let creatingSession = false;
async function ensureSession() {
  const now = Date.now();
  const expired = !currentSession || (now - lastSessionTouched > SESSION_TTL_MS);
  if (!expired) { lastSessionTouched = now; return currentSession; }

  if (creatingSession) {
    await new Promise(r => setTimeout(r, 200));
    lastSessionTouched = Date.now();
    return currentSession;
  }

  creatingSession = true;
  try {
    const sess = await apiCreateSession();
    if (!sess || !sess.session_code) throw new Error("apiCreateSession() invalid payload");
    currentSession = sess;
    lastSessionTouched = Date.now();
    console.log("🆕 session created:", {
      id: sess.id,
      session_code: sess.session_code,
      store_id: sess.store_id,
      status: sess.status,
    });
    return currentSession;
  } catch (e) {
    console.error("ensureSession error:", e?.response?.data || e.message || e);
    return null;
  } finally {
    creatingSession = false;
  }
}

// 상품 단가 조회(선택)
async function apiGetStoreProduct(storeProductId) {
  const { data } = await api.get(`/store-products/${storeProductId}`);
  return data;
}

// 장바구니에 아이템 추가
async function apiAddPurchaseItem(sessionCode, storeProductId, unitPrice = null, qty = 1, meta = null) {
  const body = { store_product_id: storeProductId, quantity: qty };
  if (unitPrice != null) body.unit_price = unitPrice;
  if (meta) body.meta = meta;
  const { data } = await api.post(`/purchase-sessions/${sessionCode}/items`, body);
  return data;
}

// 이미 아이템이 있으면 수량을 '설정'하거나(선호) 없으면 추가
async function upsertItem(sessionCode, storeProductId, quantity, meta = null) {
  try {
    // 먼저 추가 시도
    await apiAddPurchaseItem(sessionCode, storeProductId, null, quantity, meta);
    return true;
  } catch (e) {
    const data = e?.response?.data || {};
    const msg  = (data.error || data.message || "").toString();

    // 유니크 충돌 → 수량 갱신으로 전환 (PUT 또는 PATCH: 너희 API에 맞추기)
    if (/Duplicate entry|unique|already exists/i.test(msg)) {
      try {
        // ↓ 엔드포인트/메서드는 실제 API 스펙에 맞게 교체
        await api.put(`/purchase-sessions/${sessionCode}/items/${storeProductId}`, {
          quantity
        });
        return true;
      } catch (e2) {
        console.error("[UPSERT FAIL]", e2?.response?.data || e2.message);
        return false;
      }
    }
    console.error("add item error:", data || e.message);
    return false;
  }
}


// 카드 UID 이벤트(권장): uid → 서버가 해시 → 세션에 바인딩
async function apiBindCardEvent(sessionCode, uid, recordTag = false) {
  const norm = normalizeUid(uid);
  const { data } = await api.post(`/purchase-sessions/${sessionCode}/bind-card-event`, {
    uid: norm,
    record_tag: recordTag
  });
  return data; // { ok, bound, uid_hash_hex, ... }
}

// (옵션) 최근 태그로 바인딩
async function apiBindCardTags(sessionCode, windowSec = 60, fallback = true) {
  const { data } = await api.post(`/purchase-sessions/${sessionCode}/bind-card-tags`, {
    window_sec: windowSec,
    fallback
  });
  return data; // { ok, uid_hash_hex, used_fallback }
}

// 체크아웃(즉시결제)
async function apiCheckout(sessionCode) {
  const { data } = await api.post(`/purchase-sessions/${sessionCode}/checkout`, { approve: true });
  return data; // { ok, total_price }
}

// ─────────────────────────────────────────────
// 스캔 마무리(서버 권한으로만 실행)
// ─────────────────────────────────────────────
async function finalizeScan(wss, reason = "manual") {
  if (finalized) return;
  finalized = true;

  clearIdleTimer();
  phase = "card";
  visionEnabled = false;

  // 비전 종료 알림
  broadcastAll(wss, { action: "stopVision", ts: new Date().toISOString() });
  broadcastAll(wss, { action: "scanComplete", reason, ts: new Date().toISOString() });

  // ★ 카드 대기 화면으로 전환 + 대기 신호
  broadcastAll(wss, { action: "goToScreen", screen: "screen-card", ts: new Date().toISOString() });
  broadcastAll(wss, {   type: "awaitingCard",               ts: new Date().toISOString() });

  // 여기서 세션은 유지!  (resetAll/ sessionEnded 절대 호출하지 않음)
}


async function handleYoloDetection(msg){
  if (!visionEnabled || phase !== "scan") return;

  const sessionCode = currentSessionCode; // 보유 중인 세션 코드
  const counts = msg.counts || {};
  // 한 번에 하나만 넣는다면, 대표 클래스만 선택:
  // const cls = pickMainClass(counts);  // 구현체에 맞게
  // const quantity = counts[cls] || 1;

  // 여러 클래스 동시 처리(각 spid에 대해 upsert):
  for (const [label, quantity] of Object.entries(counts)) {
    const spid = mapLabelToSpid(label);  // 라벨→상품ID 매핑
    if (!spid) continue;

    const key = `${sessionCode}:${spid}`;
    const now = Date.now();
    const prev = lastAdd.get(key);

    // 이전과 동일 수량 + 쿨다운 이내면 무시
    if (prev && prev.qty === quantity && (now - prev.ts) < ADD_COOLDOWN_MS) {
      console.log(`[DEDUPE] skip spid=${spid} qty=${quantity}`);
      continue;
    }

    // 서버 DB 상태와 맞추기: Upsert(POST 실패시 PUT/PATCH)
    const ok = await upsertItem(sessionCode, spid, quantity);
    if (ok) lastAdd.set(key, { ts: now, qty: quantity });
  }
}

// ─────────────────────────────────────────────
// WebSocket 서버
// ─────────────────────────────────────────────
module.exports = (server) => {
  const wss = new WebSocket.Server({ server });

  wss.on("connection", async (ws) => {
    console.log("WebSocket 클라이언트 연결됨");


    global.kioskBroadcast = (msg) => {
    try {
      // 컨트롤러가 넘길 수 있는 형태들 케어
      const sessionCode =
        msg?.session_code ||
        msg?.session?.session_code ||
        msg?.session?.code ||
        null;

      if (sessionCode) {
        broadcastToSession(wss, sessionCode, msg);
        console.log(`[WS] broadcastToSession → ${sessionCode} type=${msg?.type || msg?.action || 'unknown'}`);
      } else {
        broadcastAll(wss, msg);
        console.log(`[WS] broadcastAll type=${msg?.type || msg?.action || 'unknown'}`);
      }
    } catch (e) {
      console.error('[WS] global.kioskBroadcast error:', e);
    }
    };

    // 1) 세션은 '있으면' 알리고, 없어도 진행
    const sess = await ensureSession().catch(() => null);
    if (sess?.session_code) {
      // 1) 우선 현재 세션을 확정
      currentSession = sess;

      // 2) 세션 시작 브로드캐스트
      broadcastAll(wss, {
        type: "sessionStarted",
        session: {
          id: sess.id ?? null,
          code: sess.session_code,
          session_code: sess.session_code,
          store_id: sess.store_id,
          status: sess.status,
          created_at: sess.created_at,
        },
        ts: new Date().toISOString(),
      });

      // 3) 새 세션 코드로만 구독 (이전 코드 참조 금지)
      const code = sess.session_code;
      if (AUTO_SUB && code) {
        try { autoSubscribeAll(wss, code); } catch (e) { console.warn("autoSubscribeAll error:", e?.message || e); }
        console.log(`[WS] AUTO_SUB → ${code}`);
      }

      // 4) 현재 연결된 이 소켓도 구독
      try { autoSubscribe(ws, code); } catch (e) { console.warn("autoSubscribe(ws) error:", e?.message || e); }

    } else {
      console.warn("[SCAN] session unavailable; proceed without session");
    }



    // // 2) 내부 상태를 즉시 scan으로 전환 (정지 감지 없음)
    // sessionActive   = true;
    // sessionArmed    = false;
    // phase           = "scan";
    // visionEnabled   = true;
    // hasAnyVision    = false;
    // finalized       = false;
    // controllerReady = false;
    // clearIdleTimer();

    // // 3) 세션 유무와 무관하게 startVision 항상 브로드캐스트
    // const msg = { by: "server", ts: new Date().toISOString() };
    // broadcastAll(wss, { type: "startVision",  ...msg });
    // broadcastAll(wss, { action: "startVision", ...msg });
    // console.log("[SCAN] startVision broadcast (no-still mode)");

    // 이미 스캔 중이면 새로 붙은 소켓에 세트 리플레이
    if (phase === "scan" && currentSession?.session_code) {
      ws.send(JSON.stringify({
        type: "sessionStarted",
        session: {
          id: currentSession.id ?? null,
          code: currentSession.session_code,
          session_code: currentSession.session_code,
          store_id: currentSession.store_id,
          status: currentSession.status,
        },
        ts: new Date().toISOString(),
      }));
      const code = (currentSession?.session_code) || (sess?.session_code);
        if (AUTO_SUB && code) {
          autoSubscribeAll(wss, code);
          console.log(`[WS] AUTO_SUB → ${code}`);
        }

      ws.send(JSON.stringify({
        action: "startVision",
        by: "server-replay",
        ts: new Date().toISOString(),
      }));
      console.log("[WS] replayed sessionStarted + startVision to newly connected client");
    }

    ws.on("message", async (message) => {
      let parsed;
      try {
        const text = typeof message === "string" ? message : message.toString();
        parsed = JSON.parse(text);
      } catch (e) {
        console.error("메시지 파싱 실패:", e);
        return;
      }
      const kind = parsed.type || parsed.action || parsed.kind || "";
      console.log("[IN]", kind, parsed, "phase=", phase);

      if (kind === "SUB" && parsed.session_code) {
        ws.subscribedSession = parsed.session_code;
        reply(ws, { type: "SUB_OK", session_code: ws.subscribedSession });
        console.log(`[WS] SUB_OK for session_code=${ws.subscribedSession}`);
        return;
      }

      const isVisionMsg =
        parsed.type === "yoloDetection" ||
        kind === "visionDetected" || kind === "objectDetected";

      // ── 수동 스캔 제어 ─────────────────────────
      if (kind === "startVision") {
        // 이미 active면: 요청자에게만 세트 에코
        if (sessionActive && currentSession?.session_code) {
          ws.send(JSON.stringify({
            type: "sessionStarted",
            session: {
              id: currentSession.id ?? null,
              code: currentSession.session_code,
              session_code: currentSession.session_code,
              store_id: currentSession.store_id,
              status: currentSession.status,
            },
            ts: new Date().toISOString(),
          }));
          ws.send(JSON.stringify({
            action: "startVision",
            by: parsed.by || "server-echo",
            ts: new Date().toISOString(),
          }));
          console.log("[WS] startVision echoed to requester (already active)");
          return;
        }

        // inactive면: 세션 보장 후 정식 시작
        try {
          const sess2 = await ensureSession();
          if (!sess2?.session_code) return;
          currentSession = sess2;

          sessionActive = true;
          sessionArmed  = false;
          phase = "scan";
          visionEnabled = true;
          hasAnyVision = false;
          finalized = false;
          clearIdleTimer?.();

          broadcastAll(wss, {
            type: "sessionStarted",
            session: {
              id: sess2.id ?? null,
              code: sess2.session_code,
              session_code: sess2.session_code,
              store_id: sess2.store_id,
              status: sess2.status,
              created_at: sess2.created_at,
            },
            ts: new Date().toISOString(),
          });

          broadcastAll(wss, {
            action: "startVision",
            by: parsed.by || "manual",
            ts: new Date().toISOString(),
          });

          console.log(`[WS] startVision started → session_code=${sess2.session_code}`);
        } catch (e) {
          console.error("[WS] startVision ensureSession error:", e?.response?.data || e.message);
        }
        return;
      }

      if (kind === "stopVision") {
        // 클라발 stopVision은 무시
        console.log("[WS] stopVision ignore (client-origin)");
        return;
      }

      // ── 세션 라이프사이클 ─────────────────────
      if (kind === "sessionStarted") {
        sessionActive = true;
        return;
      }
      if (kind === "sessionEnded") {
        console.log("[WS] sessionEnded → reset kiosk state");
        sessionActive = false;
        sessionArmed  = false;
        wasNear = false;
        prevDist = null;
        lidarCooldownUntil = 0;
        controllerReady = false;
        visionEnabled = false;
        phase = "start";
        hasAnyVision = false;
        finalized = false;
        clearIdleTimer();
        currentSession = null;
        return;
      }

      // ── 라이다 이벤트 ─────────────────────────
      // if (kind === "lidarDistance") {
      //   const dist = Number(parsed.distance);
      //   if (sessionActive) return;

      //   const near = !Number.isNaN(dist) && dist <= LIDAR_THRESHOLD_CM;
      //   if (!Number.isNaN(dist) && dist >= (LIDAR_THRESHOLD_CM + LIDAR_HYSTERESIS)) {
      //     wasNear = false;
      //   }
      //   if (!wasNear && near) {
      //     const now = Date.now();
      //     if (now >= lidarCooldownUntil) {
      //       broadcastAll(wss, { type: "startKioskByLidar", distance: dist, ts: new Date().toISOString() });
      //       lidarCooldownUntil = now + LIDAR_COOLDOWN_MS;
      //       wasNear = true;
      //     }
      //   }
      //   prevDist = dist;
      //   return;
      // }

      if (kind === "lidarDistance") {
        const dist = Number(parsed.distance);
        if (sessionActive) return;

        const near = !Number.isNaN(dist) && dist <= LIDAR_THRESHOLD_CM;
        if (!Number.isNaN(dist) && dist >= (LIDAR_THRESHOLD_CM + LIDAR_HYSTERESIS)) {
          wasNear = false;
        }
        if (!wasNear && near) {
          const now = Date.now();
          if (now >= lidarCooldownUntil) {
            // ★ 화면: basket
            broadcastAll(wss, { action: "goToScreen", screen: "screen-basket", ts: new Date().toISOString() });
            broadcastAll(wss, {   type: "goToScreen", screen: "screen-basket", ts: new Date().toISOString() });

            // 세션은 있으면 쓰고 없으면 패스
            let sess = null;
            if (!OFFLINE_MODE) {
              try { sess = await ensureSession(); } catch {}
              if (sess) currentSession = sess;
            }

            // 상태 전환 및 스캔 시작 브로드캐스트 (정지 감지 없이 즉시)
            sessionActive = true;
            sessionArmed  = false;
            phase = "scan";
            visionEnabled = true;
            hasAnyVision  = false;
            finalized     = false;
            controllerReady = false;
            clearIdleTimer?.();

            const msg = { by: "lidar", ts: new Date().toISOString() };
            broadcastAll(wss, { action: "startVision", ...msg });
            broadcastAll(wss, {   type: "startVision", ...msg });

            lidarCooldownUntil = now + LIDAR_COOLDOWN_MS;
            wasNear = true;
          }
        }
        prevDist = dist;
        return;
      }


      // basketStable 처리
      if (kind === "basketStable") {
        // if (phase === "scan") {
        //   // 스캔 중엔 재시작 금지 (로그 스팸 쿨다운은 선택)
        //   if (!controllerReady) { // visionReady/ack 못 받은 상태라면
        //     console.log("[STILL] scan phase but no controller → re-broadcast startVision");
        //     const msg = { by:"still-detector", ts:new Date().toISOString() };
        //     broadcastAll(wss, { type:"startVision",  ...msg });
        //     broadcastAll(wss, { action:"startVision", ...msg });
        //   } else {
        //     console.log("[STILL] basketStable ignored (already in scan)");
        //   }
        //   return;
        // }

        // // 1) 내부 상태를 먼저 scan으로 전환 (게이트 오픈)
        // sessionActive = true;
        // sessionArmed  = false;
        // phase = "scan";
        // visionEnabled = true;
        // hasAnyVision  = false;
        // finalized     = false;
        // clearIdleTimer?.();

        // // 2) 파이썬 컨트롤러에 startVision을 **type/action 모두**로 통지
        // controllerReady = false;
        // const msg = { by: "still-detector", ts: new Date().toISOString() };
        // broadcastAll(wss, { type: "startVision",  ...msg });
        // broadcastAll(wss, { action: "startVision", ...msg });
        // console.log("[STILL] basketStable → startVision broadcast");

        // // 3) (비동기) 세션 보장 후 sessionStarted 통지 (실패해도 스캔은 계속)
        // try {
        //   const sess = await ensureSession();
        //   if (sess?.session_code) {
        //     currentSession = sess;
        //     broadcastAll(wss, { type: "sessionStarted", session: {
        //       id: sess.id ?? null, session_code: sess.session_code,
        //       store_id: sess.store_id, status: sess.status, created_at: sess.created_at
        //     }, ts: new Date().toISOString() });
        //   }
        // } catch (e) {
        //   console.error("[STILL] ensureSession error:", e?.response?.data || e.message);
        // }
        return;
      }



      if (kind === "visionReady") {
        controllerReady = true;
        sessionActive = true;
        sessionArmed  = false;
        phase = "scan";
        visionEnabled = true;
        hasAnyVision = false;
        finalized = false;
        clearIdleTimer?.();

        broadcastAll(wss, { type: "visionReadyAck", ts: new Date().toISOString() });

        // ★ 화면: scan
        broadcastAll(wss, { action: "goToScreen", screen: "screen-scan", ts: new Date().toISOString() });
        broadcastAll(wss, {   type: "goToScreen", screen: "screen-scan", ts: new Date().toISOString() });

        console.log("[WS] visionReady → gate opened (scan phase)");
        return;
      }


      // ── 비전 게이트 ───────────────────────────
      if (isVisionMsg && (!visionEnabled || phase !== "scan")) return;

      // ── YOLO 결과 처리 ────────────────────────
      if (parsed.type === "yoloDetection") {
        const label   = (parsed.class || parsed.label || parsed.name || "").trim();
        const conf    = Number(parsed.conf ?? parsed.confidence ?? 0);
        const ts      = parsed.ts || new Date().toISOString();
        const counts  = parsed.counts || {};
        const imgPath = parsed.imgPath || null;

        if (!label) return;
        if (conf < YOLO_CONF_THR) return;

        // ★ 항상 UI 먼저 (세션 없어도)
        broadcastAll(wss, {
          type: "scanResult",
          sessionId: currentSession?.id ?? null,
          class: label,
          conf,
          counts,
          imgPath,
          ts
        });
        hasAnyVision = true;
        armIdleTimer(wss);

        // 서버/세션은 있으면 처리, 없으면 패스
        if (!OFFLINE_MODE) {
          let sess = null;
          try { sess = await ensureSession(); } catch {}
          if (!sess?.session_code) return;

          // 라벨 → 상품 ID
          const storeProductId = LABEL_TO_SPID?.[label];
          if (!storeProductId) {
            console.warn("⚠️ unmapped label:", label);
            return;
          }

          // 수량 & 디듀프(동일 수량 + 쿨다운 이내면 무시)
          const qty = Math.max(1, Number(counts?.[label] ?? 1));
          const now = Date.now();
          const key = `${sess.session_code}:${storeProductId}`;
          const last = lastAdd.get(key);
          if (last && last.qty === qty && (now - last.ts) < ADD_COOLDOWN_MS) {
            console.log(`[DEDUPE] skip spid=${storeProductId} qty=${qty}`);
            return;
          }

          // upsert
          const ok = await upsertItem(
            sess.session_code,
            storeProductId,
            qty,
            { via: "yolo", label, confidence: conf, ts, imgPath }
          );
          if (ok) {
            lastAdd.set(key, { ts: now, qty });
            console.log(`🧺 items upsert qty=${qty} spid=${storeProductId} (label=${label}, conf=${conf.toFixed(2)}) → ${sess.session_code}`);
            await finalizeScan(wss, "first-detection");
          }
        }

        return; // ← yoloDetection 분기 종료
      }



      // ── 비전 브로드캐스트 ─────────────────────
      if (kind === "objectDetected" || kind === "visionDetected") {
        broadcastAll(wss, {
          type: "objectDetected",
          name: parsed.name,
          conf: parsed.conf,
          ts: parsed.ts || new Date().toISOString(),
        });
        hasAnyVision = true;
        armIdleTimer(wss);
        return;
      }

      // ── 스캔 종료(파이썬 등에서 지시) ──────────
      if (kind === "scanComplete") {
        await finalizeScan(wss, "python-scan-complete");
        return;
      }

      // ── NFC/카드 UID 수신 ─────────────────────
      // 예: { type:"rfidUid", uid:"04032FDC300289" }
      if (kind === "rfidUid" || kind === "nfcUid" || kind === "cardTag") {
        const uid = normalizeUid(parsed.uid || parsed.value || "");
        if (!uid) { console.warn("⚠️ empty uid in rfid message"); return; }

        // 디듀프: 같은 UID가 1.5초 내 재태깅되면 무시
        const now = Date.now();
        const seen = (globalThis.__lastCardSeen ||= { uid: null, ts: 0 });
        if (seen.uid === uid && (now - seen.ts) < 1500) {
          console.log("[CARD] duplicate tag ignored");
          return;
        }
        seen.uid = uid;
        seen.ts  = now;

        try {
          const sess = await ensureSession();
          if (!sess?.session_code) {
            console.warn("[CARD] no session_code; skip bind");
            return;
          }

          // (선택) 카드화면 유지 보장
          phase = "card";

          // 1) 바인딩만 수행 (결제 호출은 프론트가 함)
          const bind = await apiBindCardEvent(sess.session_code, uid, false);
          broadcastAll(wss, {
            type: "cardBound",
            ok: !!bind?.ok,
            session_code: sess.session_code,
            ts: new Date().toISOString(),
          });

          // 2) [REMOVED] 서버 측 checkout 호출
          // const paid = await apiCheckout(sess.session_code);

          // 3) [REMOVED] purchaseCompleted / goToScreen(receipt/goodbye) 브로드캐스트
          // 4) [REMOVED] resetAll() 후 sessionEnded/start 브로드캐스트

          // 여기서 끝. 이후 흐름:
          // - 중앙 API가 bind-card-event를 수신 → (자체 WS에서) SESSION_CARD_BOUND 브로드캐스트
          // - 프론트(app.js)가 API WS의 SESSION_CARD_BOUND 수신 → /checkout 호출 → UI 전환
        } catch (e) {
          const payload = e?.response?.data || { error: String(e?.message || e) };
          console.error("rfid bind error:", payload);
          // 실패 신호만 알림(서버는 결제를 시도하지 않음)
          broadcastAll(wss, {
            type: "purchaseFailed",
            ok: false,
            reason: payload.error || "rfid-bind-failed",
            ts: new Date().toISOString(),
          });
        }
        return;
      }



      // ── (옵션) 최근 태그 바인딩 요청 ────────────
      if (kind === "bindCardTags") {
        try {
          const sess6 = await ensureSession();
          if (!sess6?.session_code) return;
          const windowSec = Number(parsed.window_sec || 60);
          const ret = await apiBindCardTags(sess6.session_code, windowSec, true);
          broadcastAll(wss, { type: "cardBoundByTags", ok: !!ret?.ok, window_sec: windowSec, ts: new Date().toISOString() });
        } catch (e) {
          console.error("bindCardTags error:", e?.response?.data || e.message);
        }
        return;
      }
    });

    ws.on("close", () => {
      console.log("WebSocket 클라이언트 연결 종료");
      if (ws.role === "controller") {
        controllerReady = false; // ✅ 준비 해제
      }
    });
  });
};
