const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");
const { broadcast } = require("../websocket/kioskSocket");
const axios = require('axios');

// 상품 불러오기
exports.fetchProductsFromApi = async () => {
  try {
    // const res = await axios.get('https://[API서버 IP]:4000/api/store-products');
    const res = await axios.get('http://43.201.105.163:4000/api/store-products');
    return res.data;  // 제품 목록 반환
  } catch (error) {
    console.error('상품 불러오기 실패:', error.message);
    return [];
  }
};

// 결제 정보 보내기
exports.sendPurchaseToApi = async (purchaseData) => {
  try {
    // await axios.post('https://[API서버 IP]:4000/api/purchases', purchaseData);
    await axios.post('http://43.201.105.163:4000/api/purchases', purchaseData);
    console.log('✅ 결제 정보 전송 완료');
  } catch (error) {
    console.error('❌ 결제 정보 전송 실패:', error.message);
  }
};


// ✅ 세션 시작
exports.startSession = (req, res) => {
  const sessionId = uuidv4();
  const entryTime = new Date();
  const expireTime = new Date(Date.now() + 10 * 60 * 1000); // 10분 세션
  const serverTime = Date.now(); // 서버 기준 현재 시각 (ms)

  // 더 이상 paidAmount 저장하지 않음
  res.json({ sessionId, entryTime, expireTime, serverTime, });
};

// ✅ 상품 인식 시뮬레이션
exports.simulateScan = () => {
  const filePath = path.join(__dirname, "../test/mock-products.json");
  const raw = fs.readFileSync(filePath);
  const mockProducts = JSON.parse(raw);

  const shuffled = mockProducts.sort(() => 0.5 - Math.random());
  const selectedItems = shuffled.slice(0, 3);
  const totalPrice = selectedItems.reduce(
    (sum, item) => sum + item.판매가격,
    0
  );

  // 환불 개념 없음 → totalPrice만 반환
  return {
    items: selectedItems,
    totalPrice,
  };
};

// ✅ RFID 처리
exports.processRFID = (req, res) => {
  const { uid } = req.body;
  console.log("[RFID] 카드 태깅됨:", uid);
  // const message = JSON.stringify({ type: "rfid", uid });
  
  // WebSocket으로도 전송
  broadcast({ type: "rfidDetected", uid });
  
  // 저장해뒀던 WebSocket 연결 객체로 메시지 보냄
  if (global.rfidSocket) {
    global.rfidSocket.send(JSON.stringify({
      type: "rfidDetected",
      uid
    }));
  }

  // res.json({ message: "RFID 수신됨" });
  res.status(200).json({ message: "RFID 수신됨" });
};

exports.startSession = (req, res) => {
  try {
    const sessionId = Date.now().toString();
    const expireTime = Date.now() + 60000;

    console.log("세션 생성:", sessionId, expireTime);

    res.json({ sessionId, expireTime });
  } catch (err) {
    console.error("세션 생성 중 오류:", err);
    res.status(500).send("세션 생성 실패");
  }
};
