// controllers/purchaseSessionController.js
const db = require('../models/db');

// ========= 설정 =========
// 환경변수로 바꾸고 싶으면 .env에 STORE_ID=1 넣으세요 (기본 1)
const STORE_ID = Number(process.env.STORE_ID || 1);

// ========= 유틸 =========
function pad2(n) { return String(n).padStart(2, '0'); }
function ts14(d = new Date()) {
  return (
    d.getFullYear().toString() +
    pad2(d.getMonth() + 1) +
    pad2(d.getDate()) +
    pad2(d.getHours()) +
    pad2(d.getMinutes()) +
    pad2(d.getSeconds())
  );
}
function rand4() { return Math.random().toString(36).slice(2, 6).toUpperCase(); }
function makeSessionCode(kioskId = 'KIOSK') { return `${kioskId}-${ts14()}-${rand4()}`; }

// ========= 공통 헬퍼 =========
function ensureJsonBody(req, res) {
  const ct = req.headers['content-type'] || '';
  const isJson = ct.includes('application/json') || ct.includes('+json');
  if (req.body == null) {
    if (isJson && req.rawBody) {
      try { req.body = JSON.parse(req.rawBody); }
      catch { return res.status(400).json({ error: 'Malformed JSON payload' }); }
    } else {
      req.body = {};
    }
  }
  return null;
}

// 현재 DB에서 특정 테이블의 컬럼 목록 조회
async function tableColumns(table) {
  const [rows] = await db.query(
    `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?`,
    [table]
  );
  return new Set(rows.map(r => r.COLUMN_NAME));
}

// ========= 컨트롤러 =========

/**
 * POST /api/purchase-sessions
 * Body: { kiosk_id: "KIOSK-01" }
 * -> purchase_sessions에 INSERT 후 session_code 반환
 */
async function createSession(req, res, next) {
  const errResp = ensureJsonBody(req, res);
  if (errResp) return;

  const { kiosk_id } = req.body || {};
  const fallbackKiosk = kiosk_id || 'KIOSK';

  let cols;
  try { cols = await tableColumns('purchase_sessions'); }
  catch (e) { return next(e); }

  const session_code = makeSessionCode(fallbackKiosk);

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 항상 store_id를 명시적으로 넣는다 (분기 모두 포함)
    if (cols.has('kiosk_id')) {
      // kiosk_id 컬럼이 있을 때
      await conn.query(
        `INSERT INTO purchase_sessions (store_id, session_code, kiosk_id, status, created_at)
         VALUES (?, ?, ?, 'OPEN', NOW())`,
        [STORE_ID, session_code, fallbackKiosk]
      );
    } else {
      // kiosk_id 컬럼이 없을 때도 store_id는 반드시 넣는다
      await conn.query(
        `INSERT INTO purchase_sessions (store_id, session_code, status, created_at)
         VALUES (?, ?, 'OPEN', NOW())`,
        [STORE_ID, session_code]
      );
    }

    await conn.commit();
    res.status(201).json({ session_code, store_id: STORE_ID });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
}

/**
 * GET /api/purchase-sessions/:session_code
 * -> 세션 정보 + 아이템 목록
 */
async function getSessionByCode(req, res, next) {
  const { session_code } = req.params;
  try {
    const [[session]] = await db.query(
      `SELECT id, store_id, session_code,
              COALESCE(kiosk_id, NULL) AS kiosk_id,
              card_id, status, created_at
         FROM purchase_sessions
        WHERE session_code = ?`,
      [session_code]
    );
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const [items] = await db.query(
      `SELECT id, product_id, name, price, quantity, created_at
         FROM purchase_items
        WHERE session_id = ? ORDER BY id ASC`,
      [session.id]
    );

    res.json({ session, items });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/purchase-sessions/:session_code/items
 * Body: { product_id, name, price, quantity }
 */
async function addItem(req, res, next) {
  const errResp = ensureJsonBody(req, res);
  if (errResp) return;

  const { session_code } = req.params;
  const { product_id, name, price, quantity } = req.body || {};

  if (!product_id || !name || !price || !quantity) {
    return res.status(400).json({
      error: 'product_id, name, price, quantity are required',
      hint: { example: { product_id: 101, name: '콜라', price: 3000, quantity: 2 } }
    });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[session]] = await conn.query(
      `SELECT id, status FROM purchase_sessions WHERE session_code = ? FOR UPDATE`,
      [session_code]
    );
    if (!session) { await conn.rollback(); return res.status(404).json({ error: 'Session not found' }); }
    if (session.status !== 'OPEN') { await conn.rollback(); return res.status(409).json({ error: 'Session is not OPEN' }); }

    await conn.query(
      `INSERT INTO purchase_items (session_id, product_id, name, price, quantity, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [session.id, product_id, name, price, quantity]
    );

    await conn.commit();
    res.status(201).json({ ok: true });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
}

/**
 * DELETE /api/purchase-sessions/:session_code/items/:item_id
 */
async function removeItem(req, res, next) {
  const { session_code, item_id } = req.params;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[session]] = await conn.query(
      `SELECT id, status FROM purchase_sessions WHERE session_code = ? FOR UPDATE`,
      [session_code]
    );
    if (!session) { await conn.rollback(); return res.status(404).json({ error: 'Session not found' }); }
    if (session.status !== 'OPEN') { await conn.rollback(); return res.status(409).json({ error: 'Session is not OPEN' }); }

    const [del] = await conn.query(
      `DELETE FROM purchase_items WHERE id = ? AND session_id = ?`,
      [item_id, session.id]
    );

    await conn.commit();
    if (del.affectedRows === 0) return res.status(404).json({ error: 'Item not found' });
    res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
}

/**
 * PATCH /api/purchase-sessions/:session_code/bind-card
 * Body: { card_id }
 */
async function bindCard(req, res, next) {
  const errResp = ensureJsonBody(req, res);
  if (errResp) return;

  const { session_code } = req.params;
  const { card_id } = req.body || {};
  if (!card_id) return res.status(400).json({ error: 'card_id is required' });

  try {
    const [result] = await db.query(
      `UPDATE purchase_sessions SET card_id = ? WHERE session_code = ?`,
      [card_id, session_code]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Session not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/purchase-sessions/:session_code/checkout
 * Body: { approve: true }
 */
async function checkout(req, res, next) {
  const errResp = ensureJsonBody(req, res);
  if (errResp) return;

  const { session_code } = req.params;
  const { approve } = req.body || {};
  if (!approve) return res.status(400).json({ error: 'approve is required' });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[session]] = await conn.query(
      `SELECT id, card_id, status FROM purchase_sessions WHERE session_code = ? FOR UPDATE`,
      [session_code]
    );
    if (!session) { await conn.rollback(); return res.status(404).json({ error: 'Session not found' }); }
    if (session.status !== 'OPEN') { await conn.rollback(); return res.status(409).json({ error: 'Session is not OPEN' }); }

    const [items] = await conn.query(
      `SELECT price, quantity FROM purchase_items WHERE session_id = ?`,
      [session.id]
    );
    const total_price = items.reduce((sum, it) => sum + Number(it.price) * Number(it.quantity), 0);

    const [purchaseResult] = await conn.query(
      `INSERT INTO purchases (session_id, card_id, total_price, purchased_at)
       VALUES (?, ?, ?, NOW())`,
      [session.id, session.card_id || null, total_price]
    );

    await conn.query(`UPDATE purchase_sessions SET status = 'CLOSED' WHERE id = ?`, [session.id]);

    await conn.commit();
    res.status(201).json({ ok: true, purchase_id: purchaseResult.insertId, total_price });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
}

/**
 * POST /api/purchase-sessions/:session_code/cancel
 */
async function cancelSession(req, res, next) {
  const { session_code } = req.params;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[session]] = await conn.query(
      `SELECT id, status FROM purchase_sessions WHERE session_code = ? FOR UPDATE`,
      [session_code]
    );
    if (!session) { await conn.rollback(); return res.status(404).json({ error: 'Session not found' }); }
    if (session.status !== 'OPEN') { await conn.rollback(); return res.status(409).json({ error: 'Session is not OPEN' }); }

    await conn.query(`DELETE FROM purchase_items WHERE session_id = ?`, [session.id]);
    await conn.query(`UPDATE purchase_sessions SET status = 'CLOSED' WHERE id = ?`, [session.id]);

    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
}

module.exports = {
  createSession,
  getSessionByCode,
  addItem,
  removeItem,
  bindCard,
  checkout,
  cancelSession,
};
