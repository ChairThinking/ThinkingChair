const express = require('express');
const router = express.Router();
const prepaymentController = require('../controllers/prepaymentController');

// 선결제 등록 (POST)
router.post('/', prepaymentController.createPrepayment);

// 전체 선결제 조회 (GET)
router.get('/', prepaymentController.getAllPrepayments);

module.exports = router;
