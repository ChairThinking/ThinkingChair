// controllers/purchaseSessionController.js

const db = require('../models/db');
const STORE_ID = Number(process.env.STORE_ID || 1);

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

/**
 * GET /api/purchase-sessions/:session_code
 * -> 세션 정보 + 아이템 목록 (태그 포함)
 */
async function getSessionByCode(req, res, next) {
  const { session_code } = req.params;
  try {
    // ✅ card_id 대신 card_uid_hash를 선택하도록 수정
    const [[session]] = await db.query(
      `SELECT id, store_id, session_code,
              COALESCE(kiosk_id, NULL) AS kiosk_id,
              card_uid_hash, status, created_at
         FROM purchase_sessions
        WHERE session_code = ?`,
      [session_code]
    );
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const [items] = await db.query(
      `SELECT
         pi.id, pi.quantity, pi.unit_price, pi.created_at,
         p.name AS product_name, p.id AS product_id,
         GROUP_CONCAT(t.uid) AS product_tags
       FROM purchase_items AS pi
       JOIN store_products AS sp ON pi.product_id = sp.id
       JOIN products AS p ON sp.product_id = p.id
       LEFT JOIN tags AS t ON p.id = t.id
       WHERE pi.session_id = ?
       GROUP BY pi.id
       ORDER BY pi.id ASC`,
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

    // ✅ card_id 대신 card_uid_hash를 선택하도록 수정
    const [[session]] = await conn.query(
      `SELECT id, card_uid_hash, status FROM purchase_sessions WHERE session_code = ? FOR UPDATE`,
      [session_code]
    );
    if (!session) { await conn.rollback(); return res.status(404).json({ error: 'Session not found' }); }
    if (session.status !== 'OPEN') { await conn.rollback(); return res.status(409).json({ error: 'Session is not OPEN' }); }

    const [items] = await conn.query(
      `SELECT price, quantity FROM purchase_items WHERE session_id = ?`,
      [session.id]
    );
    const total_price = items.reduce((sum, it) => sum + Number(it.price) * Number(it.quantity), 0);

    // ✅ card_id 대신 card_uid_hash를 사용하도록 수정
    const [purchaseResult] = await conn.query(
      `INSERT INTO purchases (session_id, card_id, total_price, purchased_at)
       VALUES (?, ?, ?, NOW())`,
      [session.id, session.card_uid_hash || null, total_price]
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
  getSessionByCode,
  addItem,
  removeItem,
  checkout,
  cancelSession,
};