const express = require("express");
const path = require("path");
const kioskRoutes = require("./routes/kioskRoutes");

const app = express();
const PORT = 3000;

// 미들웨어 설정
app.use(express.json());

// API 라우터 연결
app.use("/api", kioskRoutes);

// 정적 파일 서빙 (프론트)
app.use(express.static(path.join(__dirname, "public")));
app.use("/test", express.static(path.join(__dirname, "test")));

// 서버 시작
app.listen(PORT, () => {
  console.log(`Kiosk server running at http://localhost:${PORT}`);
});


