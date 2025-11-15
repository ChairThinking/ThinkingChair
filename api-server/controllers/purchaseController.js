const db = require('../models/db');

// ─────────────────────────────────────────
// 타임존 전략
// 저장된 값: UTC
// 조회 시: KST(+09:00)로 변환
// ─────────────────────────────────────────
const KST = '+09:00';
const UTC = '+00:00';

const pad2 = (n) => String(n).padStart(2, '0');
function todayKstYmd() {
  const now = new Date();
  const k = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return `${k.getUTCFullYear()}-${pad2(k.getUTCMonth() + 1)}-${pad2(k.getUTCDate())}`;
}
function ymd(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// 기본 기간: 최근 7일(KST)
function kstRange(from, to) {
  if (!from || !to) {
    const today = todayKstYmd();
    const t = new Date(`${today}T00:00:00+09:00`);
    const d7 = new Date(t);
    d7.setDate(d7.getDate() - 6);
    from = ymd(d7);
    to = today;
  }
  return { from, to, startKst: `${from} 00:00:00`, endKst: `${to} 23:59:59` };
}

/** 트랜잭션 */
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

// ─────────────────────────────────────────
// 1) 단건 구매 생성 (테스트용 / 기존 유지)
// 실제 결제는 purchaseSessionController.checkout에서 처리됨
// ─────────────────────────────────────────
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

// ─────────────────────────────────────────
// 2) 여러 상품 구매 (테스트용 / 기존 유지)
// ─────────────────────────────────────────
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

// ─────────────────────────────────────────
// 3) 기간 매출 조회 (🔥 PAID 세션만 + purchased_at 그룹 묶기)
// ─────────────────────────────────────────
exports.getPurchasesByDateRange = async (req, res) => {
  try {
    const { from: qFrom, to: qTo } = req.query;
    const { startKst, endKst, from, to } = kstRange(qFrom, qTo);

    const [rows] = await db.query(
      `
     SELECT
      pu.id,
      pu.session_code,
      pu.quantity,
      pu.unit_price,
      pu.total_price,
      DATE_FORMAT(pu.purchased_at, '%Y-%m-%d %H:%i') AS purchased_at_kst,
      pr.name AS product_name,
      pr.barcode,
      pr.category,
      pu.payment_method
    FROM purchases pu
    JOIN purchase_sessions ps ON pu.session_code = ps.session_code
    JOIN store_products sp     ON pu.store_product_id = sp.id
    JOIN products pr           ON sp.product_id = pr.id
    WHERE ps.status = 'PAID'
      AND pu.purchased_at BETWEEN ? AND ?
    ORDER BY pu.purchased_at DESC;
      `,
      [startKst, endKst]
    );

    // 그룹 묶기
    const groups = {};
    for (const row of rows) {
      const key = row.purchased_group;
      if (!groups[key]) groups[key] = [];

      groups[key].push({
        session_code: row.session_code,
        product_name: row.product_name,
        barcode: row.barcode,
        category: row.category,
        quantity: row.quantity,
        unit_price: row.unit_price,
        total_price: row.total_price,
        payment_method: row.payment_method,
      });
    }

    const result = Object.entries(groups).map(([purchased_at, items]) => ({
      purchased_at,
      items
    }));

    // 그룹 없이 rows 를 그대로 보내기
    res.status(200).json({
      range: { from, to },
      items: rows  // ★ 백엔드 rows 직접 반환
    });

  } catch (err) {
    console.error('매출 조회 오류:', err);
    res.status(500).json({ message: '서버 오류' });
  }
};

// ─────────────────────────────────────────
// 4) 전체 누적 요약 (🔥 PAID 세션만)
// ─────────────────────────────────────────
exports.getPurchaseSummary = async (_req, res) => {
  try {
    const [[summary]] = await db.query(
      `
      SELECT 
        COALESCE(SUM(pu.total_price),0) AS total_price,
        COALESCE(SUM(pu.quantity),0)    AS total_quantity
      FROM purchases pu
      JOIN purchase_sessions ps ON pu.session_code = ps.session_code
      WHERE ps.status = 'PAID'
      `
    );
    res.json(summary);
  } catch (err) {
    console.error('매출 요약 조회 오류:', err);
    res.status(500).json({ message: '서버 오류' });
  }
};

// ─────────────────────────────────────────
// 5) 오늘 요약 (PAID만)
// ─────────────────────────────────────────
exports.getTodaySummary = async (_req, res) => {
  try {
    const [[row]] = await db.query(
      `
      SELECT
        COALESCE(SUM(pu.total_price),0) AS total_price,
        COALESCE(SUM(pu.quantity),0)    AS total_quantity,
        COUNT(*) AS orders
      FROM purchases pu
      JOIN purchase_sessions ps ON pu.session_code = ps.session_code
      WHERE ps.status = 'PAID'
        AND DATE(CONVERT_TZ(pu.purchased_at, '${UTC}', '${KST}'))
        = DATE(CONVERT_TZ(UTC_TIMESTAMP(), '${UTC}', '${KST}'))
      `
    );
    res.json(row);
  } catch (err) {
    console.error('오늘 매출 요약 오류:', err);
    res.status(500).json({ message: '서버 오류' });
  }
};

// ─────────────────────────────────────────
// 6) 오늘 목록 (PAID만)
// ─────────────────────────────────────────
exports.getTodayList = async (_req, res) => {
  try {
    const [rows] = await db.query(
      `
      SELECT
        pu.id,
        pu.session_code,
        pu.quantity,
        pu.unit_price,
        pu.total_price,
        DATE_FORMAT(
          CONVERT_TZ(pu.purchased_at, '${UTC}', '${KST}'),
          '%Y-%m-%d %H:%i'
        ) AS purchased_at_kst,
        pr.name AS product_name
      FROM purchases pu
      JOIN purchase_sessions ps ON pu.session_code = ps.session_code
      JOIN store_products sp     ON pu.store_product_id = sp.id
      JOIN products pr           ON sp.product_id = pr.id
      WHERE ps.status = 'PAID'
        AND DATE(CONVERT_TZ(pu.purchased_at, '${UTC}', '${KST}'))
        = DATE(CONVERT_TZ(UTC_TIMESTAMP(), '${UTC}', '${KST}'))
      ORDER BY pu.purchased_at DESC
      `
    );
    res.json(rows);
  } catch (err) {
    console.error('오늘 매출 목록 오류:', err);
    res.status(500).json({ message: '서버 오류' });
  }
};

// ─────────────────────────────────────────
// 7) 주간/기간 매출 추이 (PAID만)
// ─────────────────────────────────────────
exports.getWeeklySales = async (req, res) => {
  try {
    const { from: qFrom, to: qTo } = req.query;
    const { from, to } = kstRange(qFrom, qTo);

    const [rows] = await db.query(
      `
      WITH RECURSIVE dates AS (
        SELECT DATE(?) AS d
        UNION ALL
        SELECT DATE_ADD(d, INTERVAL 1 DAY)
        FROM dates
        WHERE d < DATE(?)
      ),
      daily AS (
        SELECT 
          DATE(pu.purchased_at) AS d,
          SUM(pu.total_price) AS total
        FROM purchases pu
        JOIN purchase_sessions ps ON pu.session_code = ps.session_code
        WHERE ps.status = 'PAID'
          AND pu.purchased_at BETWEEN ? AND ?
        GROUP BY DATE(pu.purchased_at)
      )
      SELECT 
        dates.d AS date,
        COALESCE(daily.total,0) AS total
      FROM dates
      LEFT JOIN daily ON daily.d = dates.d
      ORDER BY dates.d
      `,
      [`${from}`, `${to}`, `${from} 00:00:00`, `${to} 23:59:59`]
    );

    res.json(rows);
  } catch (err) {
    console.error('주간/기간 매출 조회 오류:', err);
    res.status(500).json({ message: '서버 오류' });
  }
};

// ─────────────────────────────────────────
// 8) 카테고리별 매출 요약 (PAID만)
// ─────────────────────────────────────────
exports.getSalesByCategory = async (_req, res) => {
  try {
    const [rows] = await db.query(
      `
      SELECT pr.category, SUM(pu.total_price) AS total
      FROM purchases pu
      JOIN purchase_sessions ps ON pu.session_code = ps.session_code
      JOIN store_products sp ON pu.store_product_id = sp.id
      JOIN products pr       ON sp.product_id = pr.id
      WHERE ps.status = 'PAID'
      GROUP BY pr.category
      ORDER BY total DESC
      `
    );
    res.json(rows);
  } catch (err) {
    console.error('카테고리별 매출 조회 오류:', err);
    res.status(500).json({ message: '서버 오류' });
  }
};
