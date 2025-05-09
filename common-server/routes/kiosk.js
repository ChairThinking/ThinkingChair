const express = require("express");
const router = express.Router();

// 추후 API 수정 예정
router.get("/", (req, res) => {
  res.send("키오스크 API 정상 작동!");
});

module.exports = router;
