require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createServer } = require("http");

const kioskRoutes = require("./routes/kiosk");

const app = express();
const server = createServer(app);

app.use(cors());
app.use(express.json());

app.use("/api/kiosk", kioskRoutes);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`서버실행 중 ${PORT}`);
});
