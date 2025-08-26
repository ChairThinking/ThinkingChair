const express = require('express');
const router = express.Router();
const inventoryController = require('../controllers/inventoryController');

// 입출고 기록 생성 (POST)
router.post('/', inventoryController.recordInventoryChange);

// 전체 입출고 기록 조회 (GET)
router.get('/', inventoryController.getAllInventoryLogs);

module.exports = router;
