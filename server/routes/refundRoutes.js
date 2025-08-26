const express = require('express');
const router = express.Router();
const refundController = require('../controllers/refundController');

// 자동 환불
router.post('/auto', refundController.autoRefund);

// 수동 환불
router.post('/manual', refundController.manualRefund);

module.exports = router;
