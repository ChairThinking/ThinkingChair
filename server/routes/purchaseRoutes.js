const express = require('express');
const router = express.Router();
const purchaseController = require('../controllers/purchaseController');

// 구매 생성
router.post('/', purchaseController.createPurchase);

// 기간 매출 조회
router.get('/', purchaseController.getPurchasesByDateRange);

// 전체 매출 요약
router.get('/summary', purchaseController.getPurchaseSummary);

// 주간 매출 요약
router.get('/weekly', purchaseController.getWeeklySales);

// 카테고리별 판매 금액 요약
router.get('/categories', purchaseController.getSalesByCategory);

// 여러 상품 구매
router.post('/batch', purchaseController.createBatchPurchase);

module.exports = router;
