const WebSocket = require("ws");

// 외부에서 Express 서버를 받아 WebSocket 서버 초기화
function initWebSocket(server) {
  const wss = new WebSocket.Server({ server }); // 기존 HTTP 서버 위에 WebSocket 서버 생성

  wss.on("connection", (ws) => {
    console.log("WebSocket 클라이언트 연결됨");

    // 클라이언트로부터 메시지 수신 시 처리
    ws.on("message", (message) => {
      const data = JSON.parse(message);

      // 프론트에서 보낸 mock-scan 트리거 처리 (mockProducts 배열에서 중복 없이 무작위로 3개를 추출하는 로직)
      const shuffled = mockProducts.sort(() => 0.5 - Math.random()); // 배열 무작위 섞기
      const selected = shuffled.slice(0, 3); // 처음 3개 선택

      ws.send(
        JSON.stringify({
          type: "scanResult",
          products: selected,
        })
      );
    });
  });
}

module.exports = initWebSocket;
