const { v4: uuidv4 } = require("uuid");

exports.startSession = (req, res) => {
  const sessionId = uuidv4();
  const mockPayment = 100000;
  const entryTime = new Date();
  //10분까지 물건 구매 없을 시 세션 자동 만료
  const expireTime = new Date(Date.now() + 1 * 60 * 1000);

  // 실제 구현 시: DB 저장, RFID 인증, 문 개방, 결제 처리
  res.json({ sessionId, paidAmount: mockPayment, entryTime, expireTime });
};
