const db = require('../models/db');

// ─────────────────────────────────────────
// 타임존 전략
// - 저장: UTC로 고정(UTC_TIMESTAMP())
// - 조회: KST 달력 경계(00:00:00 ~ 23:59:59)를 UTC로 변환해 BETWEEN
// ─────────────────────────────────────────
const KST = '+09:00';
const UTC = '+00:00';
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function kstRange(from, to) {
  if (!from || !to) {
    const today = new Date();
    const d7 = new Date(today);
    d7.setDate(d7.getDate() - 6);
    from = ymd(d7);
    to   = ymd(today);
  }
  const startKst = `${from} 00:00:00`;
  const endKst   = `${to} 23:59:59`;
  return { from, to, startKst, endKst };
}

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
 * 저장 시간: UTC
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
         VALUES (?, ?, ?, ?, ?, 'RFID', UTC_TIMESTAMP())`,
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
 * 저장 시간: UTC
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
        if (!store_product_id || !quantity || quantity <= 0) {
          throw Object.assign(new Error('요청 데이터 오류'), { status: 400 });
        }

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
           VALUES (?, ?, ?, ?, ?, 'RFID', UTC_TIMESTAMP())`,
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
 * 기간 매출 조회 (KST 기준, 파라미터 없으면 최근 7일)
 * GET /api/purchases?from=YYYY-MM-DD&to=YYYY-MM-DD
 */
exports.getPurchasesByDateRange = async (req, res) => {
  try {
    const { from: qFrom, to: qTo } = req.query;
    const { from, to, startKst, endKst } = kstRange(qFrom, qTo);

    // ⚠️ 상품명은 products.name 이다. sp.name 사용 금지!
    const [rows] = await db.query(
      `
      SELECT
        pu.id,
        pu.quantity,
        pu.unit_price,
        pu.total_price,
        pu.purchased_at, -- UTC
        CONVERT_TZ(pu.purchased_at, '${UTC}', '${KST}') AS purchased_at_kst,
        pr.name        AS product_name,
        pr.category    AS category,
        pr.barcode     AS barcode,
        pu.payment_method AS payment_method,
        pu.store_id
      FROM purchases pu
      JOIN store_products sp ON pu.store_product_id = sp.id
      JOIN products pr       ON sp.product_id = pr.id
      WHERE pu.purchased_at BETWEEN
            CONVERT_TZ(?, '${KST}', '${UTC}')
        AND CONVERT_TZ(?, '${KST}', '${UTC}')
      ORDER BY pu.purchased_at DESC, pu.id DESC
      `,
      [startKst, endKst]
    );

    res.status(200).json({
      range: { from, to },
      count: rows.length,
      items: rows
    });
  } catch (err) {
    console.error('매출 조회 오류:', err);
    res.status(500).json({ message: '서버 오류', detail: String(err?.message || err) });
  }
};

/** 전체 매출 누적 요약 */
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
    res.status(500).json({ message: '서버 오류' });
  }
};

/** 오늘(KST) 매출 요약 */
exports.getTodaySummary = async (_req, res) => {
  try {
    const [[row]] = await db.query(
      `
      SELECT
        COALESCE(SUM(pu.total_price), 0) AS total_price,
        COALESCE(SUM(pu.quantity), 0)    AS total_quantity,
        COUNT(*)                          AS orders
      FROM purchases pu
      WHERE DATE(CONVERT_TZ(pu.purchased_at, '${UTC}', '${KST}')) = CURDATE()
      `
    );
    res.json(row);
  } catch (err) {
    console.error('오늘 매출 요약 오류:', err);
    res.status(500).json({ message: '서버 오류' });
  }
};

/** 오늘(KST) 매출 목록 */
exports.getTodayList = async (_req, res) => {
  try {
    // ⚠️ 여기서도 상품명은 products.name!
    const [rows] = await db.query(
      `
      SELECT
        pu.id,
        pu.quantity,
        pu.unit_price,
        pu.total_price,
        CONVERT_TZ(pu.purchased_at, '${UTC}', '${KST}') AS purchased_at_kst,
        pr.name AS product_name
      FROM purchases pu
      JOIN store_products sp ON pu.store_product_id = sp.id
      JOIN products pr       ON sp.product_id = pr.id
      WHERE DATE(CONVERT_TZ(pu.purchased_at, '${UTC}', '${KST}')) = CURDATE()
      ORDER BY pu.purchased_at DESC
      `
    );
    res.json(rows);
  } catch (err) {
    console.error('오늘 매출 목록 오류:', err);
    res.status(500).json({ message: '서버 오류' });
  }
};

/** 주간/기간 매출 추이 (KST 기준) */
exports.getWeeklySales = async (req, res) => {
  try {
    const { from: qFrom, to: qTo } = req.query;
    const { from, to } = kstRange(qFrom, qTo);

    // MySQL8 CTE 버전 (5.7/MariaDB면 CTE 미지원 → 필요시 단순 GROUP BY 버전으로 교체)
    const [rows] = await db.query(
      `
      WITH RECURSIVE date_series AS (
        SELECT DATE(?) AS d
        UNION ALL
        SELECT DATE_ADD(d, INTERVAL 1 DAY) FROM date_series WHERE d < DATE(?)
      ),
      daily AS (
        SELECT DATE(CONVERT_TZ(purchased_at, '${UTC}', '${KST}')) AS d,
               SUM(total_price) AS total
          FROM purchases
         WHERE purchased_at BETWEEN
               CONVERT_TZ(CONCAT(?, ' 00:00:00'), '${KST}', '${UTC}')
           AND CONVERT_TZ(CONCAT(?, ' 23:59:59'), '${KST}', '${UTC}')
         GROUP BY DATE(CONVERT_TZ(purchased_at, '${UTC}', '${KST}'))
      )
      SELECT DATE_FORMAT(ds.d, '%m-%d') AS date,
             COALESCE(dy.total, 0)       AS total
        FROM date_series ds
        LEFT JOIN daily dy ON dy.d = ds.d
       ORDER BY ds.d
      `,
      [from, to, from, to]
    );

    res.json(rows);
  } catch (err) {
    console.error('주간/기간 매출 조회 오류:', err);
    res.status(500).json({ message: '서버 오류' });
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
        GROUP BY pr.category
        ORDER BY total DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('카테고리별 매출 조회 오류:', err);
    res.status(500).json({ message: '서버 오류' });
  }
};
