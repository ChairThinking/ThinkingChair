const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

// 세션 시작 시 실행되는 컨트롤러 함수
exports.startSession = (req, res) => {
  const sessionId = uuidv4();
  const mockPayment = 100000; //선결제 금액 설정
  const entryTime = new Date();
  //10분까지 물건 구매 없을 시 세션 자동 만료
  const expireTime = new Date(Date.now() + 10 * 60 * 1000);

  //자동으로 가상 카드 결제 정보 생성
  const paymentInfo = {
    sessionId,
    amount: mockPayment,
    method: "card", //가상 카드 결제
    entryTime,
  };

  // 결제 정보 저장 파일 경로 지정
  const filePath = path.join(__dirname, "../test/paidSessions.json");

  // 기존 결제 정보 불러오기 (파일이 존재하면)
  let existing = [];
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      existing = raw ? JSON.parse(raw) : []; // 파일이 비어있을 경우 대비
    } catch (e) {
      console.error("JSON 파싱 오류:", e);
      return res.status(500).json({ message: "결제 정보 로딩 오류" });
    }
  }
  // 새 결제 정보를 배열에 추가
  existing.push(paymentInfo);

  // 결제 정보 배열을 파일에 저장
  try {
    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
  } catch (err) {
    console.error("파일 저장 실패:", err);
    return res.status(500).json({ message: "결제 정보 저장 실패" });
  }

  // 응답으로 세션 정보 전달
  res.json({ sessionId, paidAmount: mockPayment, entryTime, expireTime });
};

//환불 API
exports.processRefund = (req, res) => {
  const { sessionId, scannedTotal } = req.body;

  if (!sessionId || scannedTotal === undefined) {
    return res.status(400).json({ message: "필수 정보 누락" });
  }

  const filePath = path.join(__dirname, "../test/paidSessions.json");
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ message: "결제 정보 없음" });
  }

  const sessions = JSON.parse(fs.readFileSync(filePath));
  const session = sessions.find((s) => s.sessionId === sessionId);

  if (!session) {
    return res
      .status(404)
      .json({ message: "세션 ID에 해당하는 결제 정보 없음" });
  }

  const refundAmount = session.amount - scannedTotal;

  // 로그 출력 (실제로는 환불 처리 로직이 필요)
  console.log(`환불 처리: ${refundAmount}원 (${sessionId})`);

  // 세션 제거 후 저장
  const updatedSessions = sessions.filter((s) => s.sessionId !== sessionId);
  fs.writeFileSync(filePath, JSON.stringify(updatedSessions, null, 2));

  res.json({ message: "환불 완료", refundAmount });
};

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
  const refund = 100000 - totalPrice;

  return {
    items: selectedItems,
    totalPrice,
    refund,
  };
};
