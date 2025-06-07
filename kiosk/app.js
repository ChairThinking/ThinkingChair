const express = require("express");
const path = require("path");
const http = require("http");
const kioskRoutes = require("./routes/kioskRoutes");
const initWebSocket = require("./websocket/kioskSocket");

const app = express();
const PORT = 3000;
const server = http.createServer(app); // WebSocket 연동 가능한 서버

// 미들웨어
app.use(express.json());
app.use("/api", kioskRoutes);
//정적 파일 서빙(프론트)
app.use(express.static(path.join(__dirname, "public")));
app.use("/test", express.static(path.join(__dirname, "test")));

// WebSocket 연결
initWebSocket(server);

// 서버 시작
server.listen(PORT, () => {
  console.log(`Kiosk server running at http://localhost:${PORT}`);
});
