const db = require('../models/db');

// 매장 상품 등록
exports.registerStoreProduct = async (req, res) => {
  let { product_id, store_id, sale_price, quantity } = req.body;
  if (!store_id) store_id = 1;

  try {
    console.log('[registerStoreProduct] body=', req.body);

    const [[exists]] = await db.query(
      'SELECT id FROM store_products WHERE product_id = ? AND store_id = ?',
      [product_id, store_id]
    );
    if (exists) {
      console.log('[registerStoreProduct] 이미 존재 id=', exists.id);
      return res.status(400).json({ message: '이미 매장에 등록된 상품입니다.' });
    }

    // 1. store_products 등록
    const [result] = await db.query(
      'INSERT INTO store_products (product_id, store_id, sale_price, quantity) VALUES (?, ?, ?, ?)',
      [product_id, store_id, sale_price, quantity]
    );

    const store_product_id = result.insertId;
    console.log('[registerStoreProduct] INSERT store_products id=', store_product_id);

    // 2. inventory_log 에 입고 기록 추가
    await db.query(
      'INSERT INTO inventory_log (store_product_id, store_id, change_type, quantity) VALUES (?, ?, ?, ?)',
      [store_product_id, store_id, '입고', quantity]
    );
    console.log('[registerStoreProduct] INSERT inventory_log done');

    res.status(201).json({ message: '상품 등록 및 입고 완료', store_product_id });
  } catch (err) {
    console.error('상품 등록 오류:', err);
    res.status(500).send('서버 오류');
  }
};

// 매장 상품 전체 조회
exports.getAllStoreProducts = async (req, res) => {
  const store_id = 1; // 현재 매장은 고정 1번

  try {
    const [rows] = await db.query(`
      SELECT sp.id, sp.product_id, sp.store_id, sp.quantity, sp.sale_price,
             p.name, p.barcode, p.category, p.manufacturer, p.brand,
             p.origin_country, p.image_url
      FROM store_products sp
      JOIN products p ON sp.product_id = p.id
      WHERE sp.store_id = ?
    `, [store_id]);

    res.json(rows);
  } catch (err) {
    console.error('매장 상품 조회 오류:', err);
    res.status(500).send('서버 오류');
  }
};

// 매장 상품 삭제
exports.deleteStoreProduct = async (req, res) => {
  const storeProductId = req.params.id;

  try {
    console.log('[deleteStoreProduct] id=', storeProductId);

    const [result] = await db.query(
      'DELETE FROM store_products WHERE id = ?',
      [storeProductId]
    );

    if (result.affectedRows === 0) {
      console.log('[deleteStoreProduct] 해당 id 없음');
      return res.status(404).json({ message: '삭제할 매장 상품이 없습니다.' });
    }

    console.log('[deleteStoreProduct] 삭제 완료');
    res.json({ message: '매장 상품 삭제 완료' });
  } catch (err) {
    console.error('매장 상품 삭제 오류:', err);
    res.status(500).send('서버 오류');
  }
};

// 매장 상품 수정
// 프론트에서 보내는 body는 현재 구조:
// { sale_price: number, quantity: number(final 수량) }
exports.updateStoreProduct = async (req, res) => {
  const storeProductId = req.params.id;
  const { sale_price, quantity } = req.body;

  console.log('======== [updateStoreProduct] START ========');
  console.log('[updateStoreProduct] id =', storeProductId);
  console.log('[updateStoreProduct] body =', req.body);

  if (sale_price == null || quantity == null) {
    console.log('[updateStoreProduct] 400: sale_price or quantity missing');
    return res.status(400).json({ message: '판매가와 수량은 필수입니다.' });
  }

  try {
    // 1) 현재 수량/매장 정보 조회
    const [[before]] = await db.query(
      'SELECT quantity, store_id FROM store_products WHERE id = ?',
      [storeProductId]
    );
    console.log('[updateStoreProduct] before =', before);

    if (!before) {
      console.log('[updateStoreProduct] 404: not found');
      return res.status(404).json({ message: '수정할 매장 상품이 없습니다.' });
    }

    // 2) UPDATE 실행
    const [updateResult] = await db.query(
      'UPDATE store_products SET sale_price = ?, quantity = ? WHERE id = ?',
      [sale_price, quantity, storeProductId]
    );
    console.log('[updateStoreProduct] UPDATE result =', updateResult);

    // 3) 수량 변화량(diff) 계산하고 inventory_log 기록
    const diff = quantity - before.quantity;
    console.log('[updateStoreProduct] diff =', diff);

    if (diff !== 0) {
      await db.query(
        'INSERT INTO inventory_log (store_product_id, store_id, change_type, quantity) VALUES (?, ?, ?, ?)',
        [storeProductId, before.store_id, diff > 0 ? '입고' : '출고', Math.abs(diff)]
      );
      console.log('[updateStoreProduct] INSERT inventory_log ok');
    } else {
      console.log('[updateStoreProduct] quantity not changed, skip inventory_log');
    }

    console.log('======== [updateStoreProduct] END OK ========');
    res.json({
      message: '매장 상품 수정 및 로그 기록 완료',
      after: {
        sale_price,
        quantity,
      },
    });

  } catch (err) {
    console.error('매장 상품 수정 오류:', err);
    console.log('======== [updateStoreProduct] END ERROR ========');
    res.status(500).send('서버 오류');
  }
};
