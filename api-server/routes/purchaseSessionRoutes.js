// routes/purchaseSessionRoutes.js

const express = require('express');
const router = express.Router();
const controller = require('../controllers/purchaseSessionController');

// ⚠️ 아래 두 라인은 이제 필요 없으므로 삭제하세요.
// router.post('/', controller.createSession);
// router.patch('/:session_code/bind-card', controller.bindCard);

// 특정 세션의 정보를 조회합니다. (장바구니와 태그 포함)
router.get('/:session_code', controller.getSessionByCode);

// 장바구니에 아이템을 추가합니다.
router.post('/:session_code/items', controller.addItem);

// 장바구니에서 아이템을 제거합니다.
router.delete('/:session_code/items/:item_id', controller.removeItem);

// 결제 프로세스를 시작하여 구매를 완료합니다.
router.post('/:session_code/checkout', controller.checkout);

// 세션을 취소합니다.
router.post('/:session_code/cancel', controller.cancelSession);

module.exports = router;