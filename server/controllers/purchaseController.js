const db = require('../models/db');

/** 트랜잭션 헬퍼 */
async function withTx(fn) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch {}
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * 단건 구매 (RFID 전용)
 * body: { store_product_id, quantity }
 */
exports.createPurchase = async (req, res) => {
  const { store_product_id, quantity } = req.body;

  if (!store_product_id || !quantity || quantity <= 0) {
    return res.status(400).json({ message: '요청 데이터 오류' });
  }

  try {
    const result = await withTx(async (conn) => {
      const [[product]] = await conn.query(
        'SELECT sale_price, quantity, store_id FROM store_products WHERE id = ? FOR UPDATE',
        [store_product_id]
      );
      if (!product) throw Object.assign(new Error('상품이 존재하지 않습니다.'), { status: 404 });
      if (quantity > product.quantity) throw Object.assign(new Error('재고 부족'), { status: 400 });

      const itemTotal = product.sale_price * quantity;

      await conn.query(
        `INSERT INTO purchases
           (store_product_id, quantity, unit_price, total_price, store_id, payment_method, purchased_at)
         VALUES (?, ?, ?, ?, ?, 'RFID', NOW())`,
        [store_product_id, quantity, product.sale_price, itemTotal, product.store_id]
      );

      await conn.query(
        'UPDATE store_products SET quantity = quantity - ? WHERE id = ?',
        [quantity, store_product_id]
      );

      return {
        message: '구매 완료',
        total_price: itemTotal,
        remaining_stock: product.quantity - quantity,
        store_id: product.store_id,
      };
    });

    res.status(201).json(result);
  } catch (err) {
    console.error('구매 오류:', err);
    res.status(err.status || 500).json({ message: err.message || '서버 오류' });
  }
};

/**
 * 여러 상품 구매 (RFID 전용)
 * body: { items: [{ store_product_id, quantity }, ...] }
 */
exports.createBatchPurchase = async (req, res) => {
  const { items } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: '요청 데이터가 올바르지 않습니다.' });
  }

  try {
    const result = await withTx(async (conn) => {
      let total_price = 0;
      let store_id_last = null;

      for (const { store_product_id, quantity } of items) {
        const [[product]] = await conn.query(
          'SELECT sale_price, quantity, store_id FROM store_products WHERE id = ? FOR UPDATE',
          [store_product_id]
        );
        if (!product || product.quantity < quantity) {
          throw Object.assign(new Error('재고 부족 또는 상품 없음'), { status: 400 });
        }

        const itemTotal = product.sale_price * quantity;
        total_price += itemTotal;
        store_id_last = product.store_id;

        await conn.query(
          `INSERT INTO purchases
             (store_product_id, quantity, unit_price, total_price, store_id, payment_method, purchased_at)
           VALUES (?, ?, ?, ?, ?, 'RFID', NOW())`,
          [store_product_id, quantity, product.sale_price, itemTotal, product.store_id]
        );

        await conn.query(
          'UPDATE store_products SET quantity = quantity - ? WHERE id = ?',
          [quantity, store_product_id]
        );
      }

      return { message: '구매 완료', total_spent: total_price, store_id: store_id_last };
    });

    res.status(201).json(result);
  } catch (err) {
    console.error('여러 상품 구매 오류:', err);
    res.status(err.status || 500).json({ message: err.message || '서버 오류' });
  }
};

/**
 * 기간 매출 조회 (구매일 기준, RFID 고정)
 */
exports.getPurchasesByDateRange = async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ message: '날짜 범위가 필요합니다.' });

  try {
    const [rows] = await db.query(
      `
      SELECT
        pu.id,
        pu.quantity,
        pu.total_price,
        pu.purchased_at AS date,
        p.name,
        p.category,
        p.barcode,
        'RFID' AS method
      FROM purchases pu
      JOIN store_products sp ON pu.store_product_id = sp.id
      JOIN products p        ON sp.product_id = p.id
      WHERE DATE(pu.purchased_at) BETWEEN ? AND ?
      ORDER BY pu.purchased_at DESC
      `,
      [from, to]
    );

    res.status(200).json(rows);
  } catch (err) {
    console.error('매출 조회 오류:', err);
    res.status(500).send('서버 오류');
  }
};

/** 전체 매출 요약 */
exports.getPurchaseSummary = async (_req, res) => {
  try {
    const [[summary]] = await db.query(
      `SELECT COALESCE(SUM(total_price), 0) AS total_price,
              COALESCE(SUM(quantity), 0)     AS total_quantity
         FROM purchases`
    );
    res.json(summary);
  } catch (err) {
    console.error('매출 요약 조회 오류:', err);
    res.status(500).send('서버 오류');
  }
};

/** 주간/기간 매출 추이 */
exports.getWeeklySales = async (req, res) => {
  try {
    const { from, to } = req.query;
    const [rangeRow] = from && to
      ? [[{ from, to }]]
      : await db.query(`SELECT DATE_SUB(CURDATE(), INTERVAL 6 DAY) AS \`from\`, CURDATE() AS \`to\``);

    const fromDate = rangeRow[0].from;
    const toDate = rangeRow[0].to;

    const [rows] = await db.query(
      `
      WITH RECURSIVE date_series AS (
        SELECT DATE(?) AS d
        UNION ALL
        SELECT DATE_ADD(d, INTERVAL 1 DAY) FROM date_series WHERE d < DATE(?)
      ),
      daily AS (
        SELECT DATE(purchased_at) AS d, SUM(total_price) AS total
          FROM purchases
         WHERE DATE(purchased_at) BETWEEN DATE(?) AND DATE(?)
         GROUP BY DATE(purchased_at)
      )
      SELECT DATE_FORMAT(ds.d, '%m-%d') AS date,
             COALESCE(dy.total, 0)       AS total
        FROM date_series ds
        LEFT JOIN daily dy ON dy.d = ds.d
       ORDER BY ds.d
      `,
      [fromDate, toDate, fromDate, toDate]
    );

    res.json(rows);
  } catch (err) {
    console.error('주간/기간 매출 조회 오류:', err);
    res.status(500).send('서버 오류');
  }
};

/** 카테고리별 매출 요약 */
exports.getSalesByCategory = async (_req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT pr.category, SUM(pu.total_price) AS total
         FROM purchases pu
         JOIN store_products sp ON pu.store_product_id = sp.id
         JOIN products pr       ON sp.product_id = pr.id
        GROUP BY pr.category`
    );
    res.json(rows);
  } catch (err) {
    console.error('카테고리별 매출 조회 오류:', err);
    res.status(500).send('서버 오류');
  }
};
