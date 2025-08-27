const express = require('express');
const router = express.Router();
const storeProductController = require('../controllers/storeProductController');

// [POST] 매장 상품 등록
// body: { product_id, store_id?, sale_price, quantity }
router.post('/', storeProductController.registerStoreProduct);

// [GET] 매장 상품 전체 조회 (store_id=1 고정)
router.get('/', storeProductController.getAllStoreProducts);

// [PUT] 매장 상품 수정 (판매가/수량) → 인벤토리 로그 자동 기록
// body: { sale_price, quantity }
router.put('/:id', storeProductController.updateStoreProduct);

// [DELETE] 매장 상품 삭제
router.delete('/:id', storeProductController.deleteStoreProduct);

module.exports = router;
