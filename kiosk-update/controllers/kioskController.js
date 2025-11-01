// const { v4: uuidv4 } = require("uuid");
// const fs = require("fs");
// const path = require("path");
// const { broadcast } = require("../websocket/kioskSocket");
// const axios = require('axios');

// // 상품 불러오기
// exports.fetchProductsFromApi = async () => {
//   try {
//     // const res = await axios.get('https://[API서버 IP]:4000/api/store-products');
//     const res = await axios.get('http://43.201.105.163:4000/api/store-products');
//     return res.data;  // 제품 목록 반환
//   } catch (error) {
//     console.error('상품 불러오기 실패:', error.message);
//     return [];
//   }
// };

// // 결제 정보 보내기
// exports.sendPurchaseToApi = async (purchaseData) => {
//   try {
//     // await axios.post('https://[API서버 IP]:4000/api/purchases', purchaseData);
//     await axios.post('http://43.201.105.163:4000/api/purchases', purchaseData);
//     console.log('✅ 결제 정보 전송 완료');
//   } catch (error) {
//     console.error('❌ 결제 정보 전송 실패:', error.message);
//   }
// };


// // ✅ 세션 시작
// exports.startSession = (req, res) => {
//   const sessionId = uuidv4();
//   const entryTime = new Date();
//   const expireTime = new Date(Date.now() + 10 * 60 * 1000); // 10분 세션
//   const serverTime = Date.now(); // 서버 기준 현재 시각 (ms)

//   // 더 이상 paidAmount 저장하지 않음
//   res.json({ sessionId, entryTime, expireTime, serverTime, });
// };

// // ✅ 상품 인식 시뮬레이션
// exports.simulateScan = () => {
//   const filePath = path.join(__dirname, "../test/mock-products.json");
//   const raw = fs.readFileSync(filePath);
//   const mockProducts = JSON.parse(raw);

//   const shuffled = mockProducts.sort(() => 0.5 - Math.random());
//   const selectedItems = shuffled.slice(0, 3);
//   const totalPrice = selectedItems.reduce(
//     (sum, item) => sum + item.판매가격,
//     0
//   );

//   // 환불 개념 없음 → totalPrice만 반환
//   return {
//     items: selectedItems,
//     totalPrice,
//   };
// };

// // ✅ RFID 처리
// exports.processRFID = (req, res) => {
//   const { uid } = req.body;
//   console.log("[RFID] 카드 태깅됨:", uid);
//   // const message = JSON.stringify({ type: "rfid", uid });
  
//   // WebSocket으로도 전송
//   broadcast({ type: "rfidDetected", uid });
  
//   // 저장해뒀던 WebSocket 연결 객체로 메시지 보냄
//   if (global.rfidSocket) {
//     global.rfidSocket.send(JSON.stringify({
//       type: "rfidDetected",
//       uid
//     }));
//   }

//   // res.json({ message: "RFID 수신됨" });
//   res.status(200).json({ message: "RFID 수신됨" });
// };

// exports.startSession = (req, res) => {
//   try {
//     const sessionId = Date.now().toString();
//     const expireTime = Date.now() + 60000;

//     console.log("세션 생성:", sessionId, expireTime);

//     res.json({ sessionId, expireTime });
//   } catch (err) {
//     console.error("세션 생성 중 오류:", err);
//     res.status(500).send("세션 생성 실패");
//   }
// };

// controllers/kioskController.js
// MVC의 Controller: 요청을 받고 → 외부 API/DB 호출 → WebSocket으로 화면 업데이트를 "알림"만 보냄.
// WS 서버(kioskSocket.js)는 '중계기'로만 두고, 비즈니스 로직은 여기로 몰아옵니다.

const axios = require("axios");
const path = require("path");
const fs = require("fs");

// ─────────────────────────────────────────────
// 환경설정
// ─────────────────────────────────────────────
const API_BASE = process.env.API_BASE_URL || "http://13.209.14.101:4000/api";
const STORE_ID = parseInt(process.env.STORE_ID || "1", 10);

// WebSocket 브로드캐스트 (중계기 역할은 websocket/kioskSocket.js)
const { broadcast } = require("../websocket/kioskSocket");

// ─────────────────────────────────────────────
// 공용 axios 인스턴스
// ─────────────────────────────────────────────
const api = axios.create({
  baseURL: API_BASE,
  timeout: 7000,
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    const msg = err.response?.data || err.message;
    console.error("[HTTP] error:", msg);
    throw err;
  }
);

// // ─────────────────────────────────────────────
// // 라벨맵 로딩 (YOLO 라벨 → 상품코드 매핑)
// // ─────────────────────────────────────────────
// let LABEL_MAP = {};
// try {
//   const p = path.join(process.cwd(), "label-map.json");
//   if (fs.existsSync(p)) {
//     LABEL_MAP = JSON.parse(fs.readFileSync(p, "utf-8"));
//     console.log("[LABEL] loaded keys:", Object.keys(LABEL_MAP).length);
//   } else {
//     console.warn("[LABEL] label-map.json not found; using empty map");
//   }
// } catch (e) {
//   console.warn("[LABEL] failed to load label-map.json:", e.message);
// }

// ─────────────────────────────────────────────
// (A) 세션 로직 — 원래 WS에서 하던 ensureSession/apiCreateSession 등을 여기로
// ─────────────────────────────────────────────
async function createSession(storeId = STORE_ID) {
  const { data } = await api.post("/sessions", { store_id: storeId });
  return data; // { id, session_code, ... }
}

async function ensureSession(storeId = STORE_ID) {
  // 필요 시 활성 세션 조회 → 없으면 생성
  try {
    const { data } = await api.get("/sessions/active", { params: { store_id: storeId } });
    if (data?.session_code) return data;
  } catch (_) {
    // active 조회 실패는 무시하고 새로 생성
  }
  return createSession(storeId);
}

// 세션 시작(또는 보장) → 프론트에 sessionStarted 방송
exports.startSession = async (req, res) => {
  try {
    const sess = await ensureSession(STORE_ID);

    // WS로 sessionStarted 브로드캐스트 (프론트가 sessionId 저장)
    broadcast({
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

    return res.status(200).json(sess);
  } catch (e) {
    console.error("[startSession]", e);
    return res.status(500).json({ message: "failed to start/ensure session" });
  }
};

// ─────────────────────────────────────────────
// (B) YOLO 감지 처리 — 원래 WS(handleYoloDetection)에서 하던 상품 upsert 로직
//     (라벨→상품코드 매핑, 쿨다운, 수량 집계 → 세션에 반영)
// ─────────────────────────────────────────────
const COOLDOWN_MS = 2000;
const lastSeen = new Map(); // key: product_code, value: timestamp(ms)

function mapDetectionsToItems(dets) {
  // dets: [{ label: 'cola', conf: 0.78 }, ...]
  const counts = new Map();

  for (const d of dets || []) {
    const productCode = LABEL_MAP[d.label];
    if (!productCode) continue;

    // 쿨다운(같은 항목이 너무 빨리 중복 집계되지 않도록)
    const now = Date.now();
    const prev = lastSeen.get(productCode) || 0;
    if (now - prev < COOLDOWN_MS) continue;
    lastSeen.set(productCode, now);

    counts.set(productCode, (counts.get(productCode) || 0) + 1);
  }

  // {code -> qty} → [{product_code, qty}]
  return [...counts.entries()].map(([product_code, qty]) => ({ product_code, qty }));
}

async function upsertSessionItems(sessionCode, items) {
  // items: [{ product_code, qty }, ...]
  const { data } = await api.post(`/sessions/${sessionCode}/items`, { items });
  return data;
}

async function finalizeScan(sessionCode, reason = "first-detection") {
  const { data } = await api.post(`/sessions/${sessionCode}/finalize`, { reason });
  return data;
}

// 컨트롤러 엔드포인트: YOLO 감지 결과를 HTTP로 받아 처리
// (WS가 직접 비즈니스 하지 않고, 이 컨트롤러로 보내거나 컨트롤러가 API서버와 동기화)
exports.yoloDetections = async (req, res) => {
  try {
    const { session_code, detections } = req.body; // detections: [{label, conf}, ...]
    if (!session_code) return res.status(400).json({ message: "session_code required" });

    const items = mapDetectionsToItems(detections);
    if (items.length === 0) {
      // 감지 없으면 UI 업데이트만 (선택)
      broadcast({
        type: "scanResult",
        sessionId: session_code,
        items: [],
        ts: new Date().toISOString(),
      });
      return res.status(200).json({ upserted: 0 });
    }

    // 세션에 품목 반영
    const result = await upsertSessionItems(session_code, items);

    // UI 업데이트 (스캔 결과 반영)
    broadcast({
      type: "scanResult",
      sessionId: session_code,
      items,
      ts: new Date().toISOString(),
    });

    // 정책상 "첫 감지로 스캔 완료"를 트리거할 경우
    await finalizeScan(session_code, "first-detection");
    broadcast({ type: "scanComplete", sessionId: session_code, ts: new Date().toISOString() });

    return res.status(200).json({ upserted: items.length, result });
  } catch (e) {
    console.error("[yoloDetections]", e);
    return res.status(500).json({ message: "failed to handle detections" });
  }
};

// ─────────────────────────────────────────────
// (C) 카드/UID 바인딩 — 원래 WS/라우터에서 섞여 있던 RFID 처리
// ─────────────────────────────────────────────
exports.bindCard = async (req, res) => {
  try {
    const { session_code, uid } = req.body;
    if (!session_code || !uid) {
      return res.status(400).json({ message: "session_code & uid required" });
    }

    const { data } = await api.post(`/sessions/${session_code}/bind-card`, { uid });

    // 프론트/UI 업데이트
    broadcast({ type: "cardBound", sessionId: session_code, uid, ts: Date.now() });

    return res.status(200).json(data);
  } catch (e) {
    console.error("[bindCard]", e);
    return res.status(500).json({ message: "failed to bind card" });
  }
};
