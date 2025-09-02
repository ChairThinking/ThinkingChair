// kioskSocket.js (patched)
const axios = require("axios");
const WebSocket = require("ws");
const kioskController = require("../controllers/kioskController");
const fs = require("fs");
const path = require("path");

// ─────────────────────────────────────────────
// API & 상수
// ─────────────────────────────────────────────
const API_BASE = process.env.API_BASE || "http://43.201.105.163:4000/api";
const STORE_ID = Number(process.env.STORE_ID || 1);

const api = axios.create({ baseURL: API_BASE, timeout: 7000 });
console.log("🔗 API base:", API_BASE);

const YOLO_CONF_THR    = Number(process.env.YOLO_CONF_THR || 0.70);
const YOLO_COOLDOWN_MS = Number(process.env.YOLO_COOLDOWN_MS || 2000);
const SESSION_TTL_MS   = Number(process.env.SESSION_TTL_MS || 5 * 60 * 1000);
const SCAN_IDLE_MS     = Number(process.env.SCAN_IDLE_MS   || 5000); // “무변화” 타임아웃(ms)

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
let currentSessionCode = null;      // { id, session_code, ... }
let currentSession = null;
let lastSessionTouched = 0;
const lastYoloSentAt = new Map(); // 라벨/세션별 쿨다운 타임스탬프

// ─────────────────────────────────────────────
// API helpers
// ─────────────────────────────────────────────
// ──────────────────────────────
// Session helpers
// ──────────────────────────────

// POST /api/purchase-sessions → { id, session_code, store_id, status, ... }
async function apiCreateSession() {
  const body = { store_id: STORE_ID, status: "active", source: "kiosk" };
  const { data } = await api.post(`/purchase-sessions`, body);
  return data; // 세션 "객체" 전체
}

// 전역 상태 예시:
// let currentSession = null;        // { id, session_code, ... }
// let lastSessionTouched = 0;
// const SESSION_TTL_MS = 5 * 60 * 1000;
let creatingSession = false;

async function ensureSession() {
  const now = Date.now();
  const expired = !currentSession || (now - lastSessionTouched > SESSION_TTL_MS);

  if (!expired) {
    lastSessionTouched = now;
    return currentSession;
  }

  if (creatingSession) {
    // 동시 생성 방지: 짧게 대기 후 현재 값 반환
    await new Promise(r => setTimeout(r, 200));
    lastSessionTouched = Date.now();
    return currentSession;
  }

  creatingSession = true;
  try {
    const sess = await apiCreateSession();
    if (!sess || !sess.session_code) {
      throw new Error("apiCreateSession() returned invalid session payload");
    }
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

// ──────────────────────────────
// Product & items
// ──────────────────────────────

async function apiGetStoreProduct(storeProductId) {
  const { data } = await api.get(`/store-products/${storeProductId}`);
  return data;
}

// POST /api/purchase-sessions/:session_code/items
async function apiAddPurchaseItem(sessionCode, storeProductId, unitPrice = null, qty = 1, meta = null) {
  const body = { store_product_id: storeProductId, quantity: qty };
  if (unitPrice != null) body.unit_price = unitPrice;
  if (meta) body.meta = meta;

  const { data } = await api.post(`/purchase-sessions/${sessionCode}/items`, body);
  return data;
}

// ──────────────────────────────
// Payment helpers (옵션: 서버에 있을 때만 사용)
// ──────────────────────────────

// GET /api/purchase-sessions/:session_code/payment-status → { status, amount, currency, ... }
async function apiGetPaymentStatus(sessionCode) {
  const { data } = await api.get(`/purchase-sessions/${sessionCode}/payment-status`);
  return data;
}

const PAYMENT_POLL_INTERVAL_MS = Number(process.env.PAYMENT_POLL_INTERVAL_MS || 1500);
const PAYMENT_POLL_TIMEOUT_MS  = Number(process.env.PAYMENT_POLL_TIMEOUT_MS  || 90_000);

// 결제 승인 대기(폴링). 승인되면 true, 실패/타임아웃이면 false
async function waitForPaymentAndFinalize(sessionCode, broadcast, resetAll) {
  const started = Date.now();

  while (Date.now() - started < PAYMENT_POLL_TIMEOUT_MS) {
    try {
      const st = await apiGetPaymentStatus(sessionCode);

      if (st?.status === "authorized") {
        broadcast({
          type: "purchaseCompleted",
          ok: true,
          session_code: sessionCode,
          amount: st.amount,
          currency: st.currency || "KRW",
          ts: new Date().toISOString(),
        });
        resetAll();
        return true;
      }

      if (st?.status === "failed" || st?.status === "canceled") {
        broadcast({
          type: "purchaseFailed",
          ok: false,
          session_code: sessionCode,
          reason: st.status,
          ts: new Date().toISOString(),
        });
        return false;
      }
    } catch (e) {
      console.error("poll payment error:", e?.response?.data || e.message);
      // 일시적 오류는 무시하고 재시도
    }

    await new Promise(r => setTimeout(r, PAYMENT_POLL_INTERVAL_MS));
  }

  // 타임아웃
  broadcast({
    type: "purchaseFailed",
    ok: false,
    session_code: sessionCode,
    reason: "timeout",
    ts: new Date().toISOString(),
  });
  return false;
}

// ─────────────────────────────────────────────
// WebSocket 서버
// ─────────────────────────────────────────────
module.exports = (server) => {
  const wss = new WebSocket.Server({ server });

  // 상태(클로저 내부): 세션/라이다/비전/타이머
  let sessionActive = false;
  let wasNear = false;
  let prevDist = null;
  let lidarCooldownUntil = 0;

  // ✅ 비전/화면 상태 게이트
  let visionEnabled = false; // "서버가" 연 상태에서만 비전 이벤트 처리
  let phase = "start";       // "start" | "scan" | "card" 등

  // ✅ idle/종료 제어
  let hasAnyVision = false;  // 첫 탐지 발생 전에는 idle 타이머 가동 금지
  let finalized = false;     // 중복 finalize 방지
  let idleTimer = null;

  // 유틸: 모든 클라이언트로 브로드캐스트
  function broadcast(obj) {
    const msg = JSON.stringify(obj);
    for (const c of wss.clients) {
      if (c.readyState === WebSocket.OPEN) c.send(msg);
    }
  }
  function reply(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { console.error("ws.send 실패:", e); }
  }

  // 타이머 유틸
  function clearIdleTimer() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }
  function armIdleTimer() {
    clearIdleTimer();
    if (!SCAN_IDLE_MS) return;
    // ✅ 최초 탐지 이전에는 idle 타이머 가동 금지
    if (!hasAnyVision) return;
    idleTimer = setTimeout(() => {
      finalizeScan("idle-timeout");
    }, SCAN_IDLE_MS);
  }

  // 스캔 마무리(서버 권한으로만 실행)
  async function finalizeScan(reason = "manual") {
    if (finalized) return;    // ✅ 중복 방지
    finalized = true;

    clearIdleTimer();
    phase = "card";
    visionEnabled = false;

    // ✅ stopVision은 서버가 브로드캐스트만 한다(클라/파이에서 보내도 무시)
    broadcast({ action: "stopVision", ts: new Date().toISOString() });
    broadcast({ action: "scanComplete", reason, ts: new Date().toISOString() });

    // 결제 상태 확인 (폴링 호출)
    try {
      const sess = await ensureSession();
      const resetAll = makeResetAll();
      waitForPaymentAndFinalize(sess.id, broadcast, resetAll); // ← 비동기로 결제 상태 감시 시작

    } catch (e) {
      console.error("finalizeScan ensureSession error:", e?.response?.data || e.message);
    }
    // 필요 시 세션/상태 일부 정리
    // (여기서는 유지: 결제 단계에서 사용)
  }

  wss.on("connection", (ws, req) => {
    console.log("WebSocket 클라이언트 연결됨");

    broadcast({ type: "startVision" });
    console.log("[VISION] startVision broadcasted");
    
    // 현재가 스캔 단계라면 합류한 클라이언트에도 즉시 startVision 알림
    if (phase === "scan") ws.send(JSON.stringify({ action:"startVision", ts:new Date().toISOString() }));

    // 연결 시 세션 보장 + 안내 브로드캐스트
    ensureSession()
      .then((sess) => {
        broadcast({
          action: "sessionStarted",
          session: {
            id: sess.id,
            session_code: sess.session_code,
            store_id: sess.store_id,
            status: sess.status,
            created_at: sess.created_at,
          },
          ts: new Date().toISOString(),
        });
      })
      .catch((e) => {
        console.error("session start error:", e.response?.data || e.message);
      });

    ws.on("message", async (message) => {
      console.log("클라이언트로부터 수신한 메시지:", message.toString());

      let parsed;
      try { parsed = JSON.parse(message); }
      catch (e) { console.error("메시지 파싱 실패:", e); return; }

      const kind = parsed.type || parsed.action;

      // 비전 이벤트 식별 (둘 다 지원)
      const isVisionMsg =
        kind === "visionDetected" ||
        kind === "objectDetected" ||
        kind === "yoloDetected"   ||
        kind === "yoloDetection";

      // ── 비전 시작/중지 ─────────────────────────
      if (kind === "startVision") {
        console.log("[WS] startVision 수신 → 브로드캐스트");
        phase = "scan";
        visionEnabled = true;
        hasAnyVision = false;    // ✅ 최초 탐지 전
        finalized = false;       // ✅ 새 사이클 시작
        clearIdleTimer();        // ✅ idle 초기화
        broadcast({ action: "startVision", ts: new Date().toISOString() });
        return;
      }

      if (kind === "stopVision") {
        // ✅ 문제 원인: 클라이언트발 stopVision은 무시(로그만)
        console.log("[WS] stopVision ignore (client-origin)");
        return;
      }

      // ── 세션 제어 ─────────────────────────────
      if (kind === "sessionStarted") {
        sessionActive = true;
        return;
      }

      if (kind === "sessionEnded") {
        sessionActive = false;
        wasNear = false;
        currentSession = null;
        lastSessionTouched = 0;
        clearIdleTimer();
        lastYoloSentAt.clear();
        broadcast({ action: "sessionEnded", ts: new Date().toISOString() });
        phase = "start";
        visionEnabled = false;
        finalized = false;
        hasAnyVision = false;
        return;
      }

      // ── 라이다 이벤트 ─────────────────────────
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
            broadcast({ type: "startKioskByLidar", distance: dist, ts: new Date().toISOString() });
            lidarCooldownUntil = now + LIDAR_COOLDOWN_MS;
            wasNear = true;
          }
        }
        prevDist = dist;
        return;
      }

      // ── 장바구니 안정 이벤트 ───────────────────
      if (kind === "basketStable") {
        broadcast({ type: "basketStable", ts: parsed.ts || new Date().toISOString() });
        return;
      }

      // 비전 메시지인데 게이트가 닫혀 있으면 무시
      if (isVisionMsg && (!visionEnabled || phase !== "scan")) {
        return;
      }

      // ── YOLO 결과 처리(통합) ───────────────────
      if (kind === "yoloDetected" || kind === "yoloDetection") {
        const label  = (parsed.class || parsed.label || parsed.name || "").trim();
        const conf   = Number(parsed.confidence ?? parsed.conf ?? 0);
        const ts     = parsed.ts || new Date().toISOString();
        const counts = parsed.counts || null;
        const imgPath = parsed.imgPath || null;

        if (!label) return;
        if (conf < YOLO_CONF_THR) return;

        const now = Date.now();
        const lastByLabel = lastYoloSentAt.get(label) || 0;
        if (now - lastByLabel < YOLO_COOLDOWN_MS) return;

        let sess;
        try { sess = await ensureSession(); }
        catch (e) { console.error("ensureSession error:", e?.response?.data || e.message); return; }
        if (!sess?.id) return;

        const storeProductId = LABEL_TO_SPID?.[label];

        // UI 반응은 항상 전달
        broadcast({
          type: "scanResult",
          sessionId: sess.id,
          class: label,
          conf,
          counts,
          imgPath,
          ts
        });

        // ✅ “탐지 발생” 표기 및 idle 타이머 무장
        hasAnyVision = true;
        lastYoloSentAt.set(label, now);
        armIdleTimer();

        // 장바구니 반영: 매핑 없으면 스킵(경고만)
        if (!storeProductId) {
          console.warn("⚠️ unmapped label:", label);
          return;
        }

        // 동일 세션·상품 쿨다운
        const key = `${sess.session_code}:${storeProductId}`;
        const lastForSession = lastYoloSentAt.get(key) || 0;
        if (now - lastForSession < YOLO_COOLDOWN_MS) return;

        try {
          // const sp = await apiGetStoreProduct(storeProductId);
          // const unitPrice = sp?.sale_price ?? null;
          await apiAddPurchaseItem(
            sess.session_code,
            storeProductId,
            null, // unitPrice
            1,
            { via: "yolo", label, confidence: conf, ts }
          );
          lastYoloSentAt.set(key, now);
          console.log(`🧺 item added: session=${sess.session_code} store_product_id=${storeProductId} (label=${label}, conf=${conf.toFixed(2)})`);
        } catch (e) {
          console.error("add item error:", e?.response?.data || e.message);
        }
        return;
      }

      // ── 비전 브로드캐스트(프론트 알림) ──────────
      if (kind === "objectDetected" || kind === "visionDetected") {
        const payload = {
          type: "objectDetected",
          name: parsed.name,
          conf: parsed.conf,
          ts: parsed.ts || new Date().toISOString(),
        };
        broadcast(payload);
        // ✅ 탐지 발생으로 간주
        hasAnyVision = true;
        armIdleTimer();
        return;
      }

      // ── 스캔 종료 트리거(파이썬 등에서만 허용) ────
      if (kind === "scanComplete") {
        await finalizeScan("python-scan-complete");
        return;
      }

      // ── 상품 목록 가져오기(예시) ────────────────
      if (kind === "fetchStoreProducts") {
        try {
          reply(ws, { type: "storeProducts", data: [] });
        } catch (e) {
          console.error("상품 목록 가져오기 실패:", e?.message || e);
          reply(ws, { type: "storeProducts", data: [] });
        }
        return;
      }

      // ── 결제 요청(예시) ─────────────────────────
      if (kind === "submitPurchase") {
        try {
          reply(ws, { type: "purchaseAck", ok: true });
        } catch (e) {
          console.error("submitPurchase 실패:", e?.message || e);
          reply(ws, { type: "purchaseAck", ok: false, error: String(e) });
        }
        return;
      }
    });

    ws.on("close", () => {
      console.log("WebSocket 클라이언트 연결 종료");
    });
  });
};
