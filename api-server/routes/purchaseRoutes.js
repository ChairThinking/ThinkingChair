const express = require('express');
const router = express.Router();
const purchaseController = require('../controllers/purchaseController');

// 구매 생성
router.post('/', purchaseController.createPurchase);
// 여러 상품 구매
router.post('/batch', purchaseController.createBatchPurchase);

// 기간(또는 기본 7일) 매출 조회(KST)
router.get('/', purchaseController.getPurchasesByDateRange);

// 누적 요약
router.get('/summary', purchaseController.getPurchaseSummary);

// 오늘(KST) 카드/목록
router.get('/today/summary', purchaseController.getTodaySummary);
router.get('/today/list', purchaseController.getTodayList);

// 주간/기간 추이(KST)
router.get('/weekly', purchaseController.getWeeklySales);

// 카테고리별
router.get('/categories', purchaseController.getSalesByCategory);

module.exports = router;
