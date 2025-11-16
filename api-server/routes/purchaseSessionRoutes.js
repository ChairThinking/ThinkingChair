// routes/purchaseSessionRoutes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/purchaseSessionController');

// ✅ (1) 열린 세션 최신 조회는 동적 파라미터보다 "먼저"
router.get('/open-latest', ctrl.getOpenLatest);

// ✅ (2) 세션 생성/조회
router.post('/', ctrl.createSession);
router.get('/:session_code', ctrl.getSessionByCode);

// ✅ (3) 장바구니
router.post('/:session_code/items', ctrl.addItem);

// 상품 삭제
router.delete('/:session_code/items/:item_id', ctrl.removeItem);

// 특정 상품만 수량 재설정(재스캔)
router.put('/:session_code/items/reset', ctrl.resetItemQuantity);

// 전체 삭제 후 YOLO 인식값으로 재구성(완전 교체)
router.put('/:session_code/items/replace-all', ctrl.replaceAllItems);

// ✅ (4) 카드 바인딩
router.post('/:session_code/bind-card-uid', ctrl.bindCardUid);        // 수동/디버그용
router.post('/:session_code/bind-card-tags', ctrl.bindCardTagsOnly);  // 디버그용
router.post('/:session_code/bind-card-event', ctrl.bindCardEvent);    // 권장

// ✅ (5) 결제 & 취소
router.post('/:session_code/checkout', ctrl.checkout);
router.post('/:session_code/cancel', ctrl.cancelSession);

module.exports = router;
