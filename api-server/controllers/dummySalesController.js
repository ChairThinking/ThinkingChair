// server/controllers/dummySalesController.js
// CSV처럼 생성된 모든 거래를 MySQL에 100% 저장하도록 강화한 버전
// 변경점: card_id 제거, UID → SHA-256 → BINARY(32) 저장(card_uid_hash)

const pool = require('../models/db');
const crypto = require('crypto');

// ───────── helpers
const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const startOfMonth = (y, m) => new Date(y, m, 1, 0, 0, 0, 0);
const endOfMonth   = (y, m) => new Date(y, m + 1, 0, 23, 59, 59, 999);

const iso = (d) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

const daysBetween = (s, e) => {
  const out = [];
  const cur = new Date(s.getFullYear(), s.getMonth(), s.getDate());
  while (cur <= e) {
    out.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
};
const isWeekend = (d) => [0, 6].includes(d.getDay());
const randomTimeOn = (date) => {
  const h = rnd(6, 23);
  const m = rnd(0, h === 23 ? 30 : 59);
  const s = rnd(0, 59);
  return iso(new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m, s));
};

// UID → sha256 hex(64)
const sha256Hex = (uid) => crypto.createHash('sha256').update(String(uid), 'utf8').digest('hex');

// 요청 본문에서 들어온 UID 배열 사용, 없으면 더미 UID 생성
function getUidListFromBody(body, fallbackCount = 10) {
  const arr = Array.isArray(body?.uids) ? body.uids.filter(Boolean) : [];
  if (arr.length > 0) return arr.map(String);
  // fallback 더미 UID (MIFARE 느낌으로 '04' 시작, 14~16 hex)
  const gen = [];
  for (let i = 0; i < fallbackCount; i++) {
    const len = 14; // 7바이트 표현
    let hex = '04';
    while (hex.length < len) hex += Math.floor(Math.random() * 16).toString(16);
    gen.push(hex.toUpperCase());
  }
  return gen;
}

// ───────── schema helpers
async function getPriceSource(conn) {
  const [spCols] = await conn.query(`SHOW COLUMNS FROM store_products`);
  if (spCols.some(c => c.Field === 'sale_price')) return { table: 'store_products', col: 'sale_price' };
  const [pCols] = await conn.query(`SHOW COLUMNS FROM products`);
  if (pCols.some(c => c.Field === 'price')) return { table: 'products', col: 'price' };
  throw new Error('store_products.sale_price 또는 products.price 칼럼이 필요합니다.');
}

async function loadPricedStoreProducts(conn, storeId) {
  const src = await getPriceSource(conn);
  if (src.table === 'store_products') {
    const [rows] = await conn.query(
      `SELECT sp.id AS store_product_id, sp.product_id, sp.store_id, sp.sale_price AS unit_price
       FROM store_products sp
       WHERE sp.store_id=? AND sp.sale_price IS NOT NULL AND sp.sale_price>0`,
      [storeId]
    );
    return rows;
  }
  const [rows] = await conn.query(
    `SELECT sp.id AS store_product_id, sp.product_id, sp.store_id, p.price AS unit_price
     FROM store_products sp
     JOIN products p ON p.id=sp.product_id
     WHERE sp.store_id=? AND p.price IS NOT NULL AND p.price>0`,
    [storeId]
  );
  return rows;
}

// ───────── cart / generation
function sampleDayWeighted(days) {
  const weights = days.map(d => (isWeekend(d) ? 1.3 : 1.0));
  const sum = weights.reduce((a,b)=>a+b,0);
  let r = Math.random() * sum;
  for (let i=0;i<days.length;i++) {
    r -= weights[i];
    if (r <= 0) return days[i];
  }
  return days[days.length-1];
}

function buildCart(products) {
  const itemCnt = rnd(1, 3);
  const items = [];
  for (let i=0;i<itemCnt;i++) {
    const p = products[rnd(0, products.length-1)];
    const qty = p.unit_price >= 12000 ? rnd(1,2) : rnd(1,4);
    items.push({ store_product_id: p.store_product_id, unit_price: p.unit_price, quantity: qty });
  }
  const total = items.reduce((s, it) => s + it.unit_price * it.quantity, 0);
  return { items, total };
}

function flattenRows(trans, storeId) {
  const rows = [];
  for (const t of trans) {
    for (const it of t.items) {
      rows.push({
        store_product_id: it.store_product_id,
        // card_uid_hash는 DB에서 UNHEX(sha256-hex)로 저장할 것이므로 hex로 들고간다
        card_uid_hash: t.uid_hash_hex,
        quantity: it.quantity,
        unit_price: it.unit_price,
        total_price: it.unit_price * it.quantity,
        payment_method: 'RFID',
        purchased_at: t.purchased_at,
        store_id: storeId
      });
    }
  }
  return rows;
}

// 컬럼 존재 여부 체크(created_at 유무에 따라 INSERT 구성)
async function hasColumn(conn, table, column) {
  const [rows] = await conn.query(
    `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?`,
    [table, column]
  );
  return rows.length > 0;
}

// ───────── insertBatch: 컬럼 수와 ? 수를 정확히 맞춤
async function insertBatch(conn, rows, chunkSize = 500) {
  let total = 0;
  const hasCreatedAt = await hasColumn(conn, 'purchases', 'created_at');

  for (let i = 0; i < rows.length; i += chunkSize) {
    const part = rows.slice(i, i + chunkSize);

    // 컬럼 목록
    // 공통 8개: store_product_id, card_uid_hash, quantity, unit_price, total_price,
    //           payment_method, purchased_at, store_id
    // + created_at(있으면 1개 추가) => 총 9개
    const placeholders = part.map(() => hasCreatedAt
      ? // 9개의 파라미터 (UNHEX(?) 포함)
        '(?,UNHEX(?),?,?,?,?,?,?,?)'
      : // 8개의 파라미터 (UNHEX(?) 포함)
        '(?,UNHEX(?),?,?,?,?,?,?)'
    ).join(',');

    // 파라미터 적재 순서: 반드시 컬럼 순서와 일치!
    const params = [];
    part.forEach(r => {
      // 1~8
      params.push(
        r.store_product_id,     // 1
        r.card_uid_hash,    // 2 (UNHEX로 변환될 64-hex 문자열)
        r.quantity,             // 3
        r.unit_price,           // 4
        r.total_price,          // 5
        r.payment_method,       // 6
        r.purchased_at,         // 7
        r.store_id              // 8
      );
      // 9 (옵션)
      if (hasCreatedAt) params.push(r.purchased_at); // created_at = purchased_at
    });

    const sql = hasCreatedAt
      ? `
        INSERT INTO purchases
          (store_product_id, card_uid_hash, quantity, unit_price, total_price,
           payment_method, purchased_at, store_id, created_at)
        VALUES ${placeholders}
      `
      : `
        INSERT INTO purchases
          (store_product_id, card_uid_hash, quantity, unit_price, total_price,
           payment_method, purchased_at, store_id)
        VALUES ${placeholders}
      `;

    const [ret] = await conn.query(sql, params);
    total += ret.affectedRows || 0;
  }
  return total;
}

// ───────── controller
exports.generateDummySales = async (req, res) => {
  // 👉 디버깅 로그
  console.log('body:', req.body);

  const monthlyGoalIn10kWon = Number(req.body?.monthlyGoalIn10kWon);
  const durationMonths      = Number(req.body?.durationMonths);

  console.log('monthlyGoalIn10kWon:', monthlyGoalIn10kWon, typeof monthlyGoalIn10kWon);
  console.log('durationMonths:', durationMonths, typeof durationMonths);

  const saveToDb            = req.body?.saveToDb !== false;
  const storeId             = 1;

  if (!monthlyGoalIn10kWon || ![1,3,5,7].includes(durationMonths)) {
    return res.status(400).json({ error: 'monthlyGoalIn10kWon(만원), durationMonths(1|3|5|7) 필요' });
  }

  const monthTarget = monthlyGoalIn10kWon * 10000;
  const minGoal = Math.floor(monthTarget * 0.9);
  const maxGoal = Math.ceil(monthTarget * 1.1);

  let conn;
  try {
    conn = await pool.getConnection();

    const [products] = await Promise.all([
      loadPricedStoreProducts(conn, storeId)
    ]);
    if (!products.length) return res.status(400).json({ error: '판매 가능한 상품(가격>0)이 없습니다.' });

    // 🔁 card_info 의존 제거 → 요청 본문 uids 사용(없으면 자동 생성)
    const uidList = getUidListFromBody(req.body, 20);

    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const windows = [];
    for (let i = durationMonths - 1; i >= 0; i--) {
      const base = new Date(lastMonth.getFullYear(), lastMonth.getMonth() - i, 1);
      windows.push({ start: startOfMonth(base.getFullYear(), base.getMonth()), end: endOfMonth(base.getFullYear(), base.getMonth())});
    }

    const monthlySummary = {};
    const allRows = [];
    const dbReport = [];

    let uidIdx = 0;

    for (const w of windows) {
      const days = daysBetween(w.start, w.end);
      const avgPrice = products.reduce((a,p)=>a+p.unit_price,0) / products.length;
      const estTicket = Math.max(1500, Math.round(avgPrice * 2.2));
      let estTx = Math.max(1, Math.round(monthlyGoalIn10kWon * 10000 / estTicket));

      let sum = 0, txs = [], guard = 0;
      while ((sum < minGoal || sum > maxGoal) && guard < 2000) {
        txs = [];
        sum = 0;
        const txCount = Math.max(1, Math.round(estTx * (0.8 + Math.random()*0.4)));
        for (let i=0;i<txCount;i++) {
          const day = sampleDayWeighted(days);
          const cart = buildCart(products);
          const purchased_at = randomTimeOn(day);

          // UID 선택 → sha256 hex 준비
          const uid = uidList[uidIdx % uidList.length]; uidIdx++;
          const uid_hash_hex = sha256Hex(uid);

          txs.push({ items: cart.items, total: cart.total, purchased_at, uid_hash_hex });
          sum += cart.total;
        }
        if (sum < minGoal) estTx = Math.ceil(estTx * 1.1);
        if (sum > maxGoal) estTx = Math.max(1, Math.floor(estTx * 0.9));
        guard++;
      }

      const rows = flattenRows(txs, storeId).sort((a,b)=> new Date(a.purchased_at) - new Date(b.purchased_at));

      let inserted = 0;
      if (saveToDb) {
        await conn.beginTransaction();
        try {
          inserted = await insertBatch(conn, rows, 500);
          if (inserted !== rows.length) {
            throw new Error(`삽입 검증 실패: 기대 ${rows.length}, 실제 ${inserted}`);
          }
          await conn.commit();
        } catch (e) {
          await conn.rollback();
          throw e;
        }
      }

      const ym = `${w.start.getFullYear()}-${pad2(w.start.getMonth()+1)}`;
      monthlySummary[ym] = txs.reduce((a,t)=>a+t.total,0);

      allRows.push(...rows);
      dbReport.push({ month: ym, generatedRows: rows.length, insertedRows: inserted });
    }

    allRows.sort((a,b)=> new Date(a.purchased_at) - new Date(b.purchased_at));
    const grandTotal = Object.values(monthlySummary).reduce((a,b)=>a+b,0);

    return res.json({
      purchases: allRows,
      monthlySummary,
      grandTotal,
      dbReport,
      savedToDb: saveToDb
    });

  } catch (err) {
    console.error('❌ generateDummySales 오류:', err);
    return res.status(500).json({ error: err.message || '서버 내부 오류' });
  } finally {
    if (conn) conn.release();
  }
};
