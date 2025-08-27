const db = require('../models/db');

const CHANGE_TYPES = ['입고', '출고'];

// 재고 변경 (입고/출고)
exports.recordInventoryChange = async (req, res) => {
  const { store_product_id, change_type, quantity } = req.body;

  if (!store_product_id || !change_type || !quantity || quantity <= 0) {
    return res.status(400).json({ message: '필수 데이터가 누락되었거나 수량이 잘못되었습니다.' });
  }

  if (!CHANGE_TYPES.includes(change_type)) {
    return res.status(400).json({ message: '입고 또는 출고만 가능합니다.' });
  }

  try {
    const [[product]] = await db.query(
      'SELECT quantity, store_id FROM store_products WHERE id = ?',
      [store_product_id]
    );

    if (!product) {
      return res.status(404).json({ message: '해당 매장 상품이 존재하지 않습니다.' });
    }

    let newQuantity = product.quantity;

    if (change_type === '입고') {
      newQuantity += quantity;
    } else if (change_type === '출고') {
      if (quantity > product.quantity) {
        return res.status(400).json({ message: '출고 수량이 재고보다 많습니다.' });
      }
      newQuantity -= quantity;
    }

    await db.query(
      'UPDATE store_products SET quantity = ? WHERE id = ?',
      [newQuantity, store_product_id]
    );

    await db.query(
      'INSERT INTO inventory_log (store_product_id, store_id, change_type, quantity) VALUES (?, ?, ?, ?)',
      [store_product_id, product.store_id, change_type, quantity]
    );

    res.status(201).json({
      message: `${change_type} 완료`,
      store_product_id,
      store_id: product.store_id,
      변경수량: quantity,
      현재수량: newQuantity
    });
  } catch (err) {
    console.error('재고 변경 오류:', err);
    res.status(500).send('서버 오류');
  }
};

// 전체 입출고 로그 조회
exports.getAllInventoryLogs = async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT il.id, il.store_product_id, il.store_id, p.name, il.change_type, il.quantity, il.timestamp
      FROM inventory_log il
      JOIN store_products sp ON il.store_product_id = sp.id
      JOIN products p ON sp.product_id = p.id
      ORDER BY il.timestamp DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error('입출고 로그 조회 오류:', err);
    res.status(500).send('서버 오류');
  }
};
