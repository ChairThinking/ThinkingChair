// routes/purchaseSessionRoutes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/purchaseSessionController');

// 세션 생성(장바구니 시작)
router.post('/', ctrl.createSession);

// 세션 단건 조회
router.get('/:session_code', ctrl.getSessionByCode);

// 아이템 추가/삭제
router.post('/:session_code/items', ctrl.addItem);
router.delete('/:session_code/items/:item_id', ctrl.removeItem);

// (1) 카드ID 바인딩 (정수 card_id 사용)
router.patch('/:session_code/bind-card', ctrl.bindCard);

// (2) 카드 UID 바인딩 → card_uid_hash(BINARY32)에 저장
router.post('/:session_code/bind-card-uid', ctrl.bindCardUid);

// (3) 최근 tags에서 자동 매칭하여 card_uid_hash 저장
router.post('/:session_code/bind-card-tags', ctrl.bindCardTagsOnly);

// 결제(체크아웃)
router.post('/:session_code/checkout', ctrl.checkout);

// 세션 취소
router.post('/:session_code/cancel', ctrl.cancelSession);

module.exports = router;
