const express = require('express');
const router = express.Router();
const productController = require('../controllers/productController');

// 전체 상품 조회
router.get('/', productController.getAllProducts);

// 개별 상품 조회
router.get('/:id', productController.getProductById);

// 상품 등록
router.post('/', productController.createProduct);

// 상품 수정
router.put('/:id', productController.updateProduct);

// 상품 삭제
router.delete('/:id', productController.deleteProduct);

module.exports = router;
