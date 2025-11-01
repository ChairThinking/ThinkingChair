// const express = require("express");
// const router = express.Router();
// const kioskController = require("../controllers/kioskController");

// // 세션 시작
// router.post("/session/start", kioskController.startSession);

// // RFID 태깅 수신 처리
// router.post("/rfid", (req, res) => {
//   const uid = req.body.uid;

//   if (!uid) {
//     return res.status(400).json({ message: "RFID UID가 없습니다" });
//   }

//   console.log("📡 RFID 태그 수신됨:", uid);

//   // WebSocket을 통해 프론트에 알림
//   const { wss } = require("../websocket/kioskSocket");
//   if (wss && typeof wss.broadcastRFID === "function") {
//     wss.broadcastRFID(uid);
//   } else {
//     console.warn("⚠️ wss.broadcastRFID가 정의되지 않았습니다");
//   }

//   return res.status(200).json({ message: "RFID 수신됨" });
// });

// module.exports = router;

const express = require("express");
const router = express.Router();
const kiosk = require("../controllers/kioskController");

// 세션 시작/보장
router.post("/session/start", kiosk.startSession);

// YOLO 감지 결과 수신
router.post("/yolo/detections", kiosk.yoloDetections);

// 카드 바인딩
router.post("/card/bind", kiosk.bindCard);

module.exports = router;
