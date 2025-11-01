const express = require("express");
const path = require("path");
const http = require("http");
const kioskRoutes = require("./routes/kioskRoutes");
const initWebSocket = require('./websocket/kioskSocket');
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = 3000;
const server = app.listen(PORT, () => {
  console.log(`Kiosk server running at http://localhost:${PORT}`);
});

// ✅ 홈 접속 시 세션 자동 생성
app.get("/", (req, res) => {
  const sessionId = uuidv4();
  const entryTime = new Date();
  const expireTime = new Date(Date.now() + 10 * 60 * 1000);

  const query = `?sessionId=${sessionId}&expireTime=${expireTime.toISOString()}`;
  res.redirect(`/index.html${query}`);
});

// 미들웨어
app.use(express.json());
app.use("/api", kioskRoutes);
app.use(express.static(path.join(__dirname, "public")));
app.use("/test", express.static(path.join(__dirname, "test")));
app.use("/api/kiosk", require("./routes/kioskRoutes"));


// WebSocket 연결
initWebSocket(server);

// // 서버 시작
// server.listen(PORT, () => {
//   console.log(`Kiosk server running at http://localhost:${PORT}`);
// });
