const express = require('express');
const router = express.Router();
const { getCardInfo } = require('../controllers/cardInfoController');

// GET /api/card_info?uid=rfid_1002
router.get('/', getCardInfo);

module.exports = router;
