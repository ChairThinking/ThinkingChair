// WebSocket 및 컨트롤러 로드
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const kioskController = require("../controllers/kioskController");

// Express 서버를 인자로 받아 WebSocket 서버 초기화
module.exports = (server) => {
  // 기존 HTTP 서버 위에 WebSocket 서버 생성
  const wss = new WebSocket.Server({ server });

  // 클라이언트가 WebSocket에 연결되었을 때
  wss.on("connection", (ws) => {
    console.log("WebSocket 클라이언트 연결됨");

    ws.on("message", (message) => {
      console.log("클라이언트로부터 수신한 메시지:", message);

      let parsed;
      try {
        parsed = JSON.parse(message);
      } catch (e) {
        console.error("메시지 파싱 실패:", e);
        return;
      }

      if (parsed.action === "simulateScan") {
        console.log("simulateScan 메시지 확인됨");

        const result = kioskController.simulateScan();
        console.log("스캔 결과:", result);

        // refunds.json에 스캔 및 환불 결과 저장
        const refundDataPath = path.join(__dirname, "../test/refunds.json");
        let refundList = [];

        if (fs.existsSync(refundDataPath)) {
          try {
            refundList = JSON.parse(fs.readFileSync(refundDataPath));
          } catch (err) {
            console.error("refunds.json 파싱 실패:", err);
          }
        }

        refundList.push({
          timestamp: new Date().toISOString(),
          ...result,
        });

        fs.writeFileSync(refundDataPath, JSON.stringify(refundList, null, 2));
        console.log("refunds.json에 저장 완료");

        ws.send(
          JSON.stringify({
            type: "scanResult",
            ...result,
          })
        );
      }
    });
  });
};
