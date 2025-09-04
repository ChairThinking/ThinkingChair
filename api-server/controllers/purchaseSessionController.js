// controllers/purchaseSessionController.js
const db = require('../models/db');
const crypto = require('crypto');

// ========= 설정 =========
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

// SHA-256(uid) → 32바이트 Buffer (BINARY(32) 저장용)
function uidToHashBinary(uid) {
  const hex = crypto.createHash('sha256').update(String(uid), 'utf8').digest('hex');
  return Buffer.from(hex, 'hex'); // 길이 32
}

// tags에서 최근 UID 1건 조회 (windowSec 안쪽, 최신 1개)
async function getRecentTagUid(windowSec = 60) {
  const [rows] = await db.query(
    `SELECT uid
       FROM tags
      WHERE timestamp >= (NOW() - INTERVAL ? SECOND)
      ORDER BY timestamp DESC
      LIMIT 1`,
    [Number(windowSec) || 60]
  );
  return rows[0]?.uid || null;
}

// ========= 트랜잭션 헬퍼 =========
async function withTx(run) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const result = await run(conn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ========= 컨트롤러 =========

/**
 * POST /api/purchase-sessions
 * Body: { kiosk_id: "KIOSK-01" }
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

    if (cols.has('kiosk_id')) {
      await conn.query(
        `INSERT INTO purchase_sessions (store_id, session_code, kiosk_id, status, created_at)
         VALUES (?, ?, ?, 'OPEN', NOW())`,
        [STORE_ID, session_code, fallbackKiosk]
      );
    } else {
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
 */
async function getSessionByCode(req, res, next) {
  const { session_code } = req.params;
  try {
    const [[session]] = await db.query(
      `SELECT id, store_id, session_code,
              COALESCE(kiosk_id, NULL) AS kiosk_id,
              card_id, card_uid_hash, status, created_at
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

    // card_uid_hash는 바이너리라 확인 편의로 hex도 같이 리턴
    const card_uid_hash_hex = session.card_uid_hash
      ? Buffer.from(session.card_uid_hash).toString('hex')
      : null;

    res.json({ session: { ...session, card_uid_hash_hex }, items });
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
 * - 정수 card_id를 직접 바인딩 (기존 방식 유지)
 */
async function bindCard(req, res, next) {
  const errResp = ensureJsonBody(req, res);
  if (errResp) return;

  const { session_code } = req.params;
  const { card_id } = req.body || {};
  if (!card_id) return res.status(400).json({ error: 'card_id is required' });

  try {
    const [result] = await db.query(
      `UPDATE purchase_sessions SET card_id = ?, updated_at = NOW() WHERE session_code = ?`,
      [card_id, session_code]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Session not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/purchase-sessions/:session_code/bind-card-uid
 * Body: { uid: "NTAG215_XXXX" }
 * - uid를 받아 SHA-256 → BINARY(32)로 card_uid_hash 저장
 */
async function bindCardUid(req, res, next) {
  const errResp = ensureJsonBody(req, res);
  if (errResp) return;

  const { session_code } = req.params;
  const { uid } = req.body || {};
  if (!uid) return res.status(400).json({ error: 'uid is required' });

  const hashBin = uidToHashBinary(uid);

  try {
    const [result] = await db.query(
      `UPDATE purchase_sessions
          SET card_uid_hash = ?, updated_at = NOW()
        WHERE session_code = ?`,
      [hashBin, session_code]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Session not found' });
    res.json({ ok: true, uid_hash_hex: Buffer.from(hashBin).toString('hex') });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/purchase-sessions/:session_code/bind-card-tags
 * Body: { window_sec?: 60 }
 * - body.uid가 없을 때 최근 tags에서 UID 자동 매칭
 */
async function bindCardTagsOnly(req, res, next) {
  const errResp = ensureJsonBody(req, res);
  if (errResp) return;

  const { session_code } = req.params;
  const { window_sec = 60 } = req.body || {};

  try {
    const uid = await getRecentTagUid(Number(window_sec) || 60);
    if (!uid) return res.status(404).json({ error: 'No recent tag uid' });

    const hashBin = uidToHashBinary(uid);

    const [result] = await db.query(
      `UPDATE purchase_sessions
          SET card_uid_hash = ?, updated_at = NOW()
        WHERE session_code = ?`,
      [hashBin, session_code]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Session not found' });

    res.json({ ok: true, uid, uid_hash_hex: Buffer.from(hashBin).toString('hex') });
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
      `SELECT id, card_id, card_uid_hash, status, store_id
         FROM purchase_sessions WHERE session_code = ? FOR UPDATE`,
      [session_code]
    );
    if (!session) { await conn.rollback(); return res.status(404).json({ error: 'Session not found' }); }
    if (session.status !== 'OPEN') { await conn.rollback(); return res.status(409).json({ error: 'Session is not OPEN' }); }

    const [items] = await conn.query(
      `SELECT price, quantity FROM purchase_items WHERE session_id = ?`,
      [session.id]
    );
    const total_price = items.reduce((sum, it) => sum + Number(it.price) * Number(it.quantity), 0);

    // purchases 스키마엔 card_uid_hash 컬럼이 없으므로, 세션의 card_id만 기록.
    const [purchaseResult] = await conn.query(
      `INSERT INTO purchases (store_product_id, card_id, quantity, unit_price, total_price, payment_method, purchased_at, store_id)
       VALUES (NULL, ?, NULL, NULL, ?, 'CARD', NOW(), ?)`,
      [session.card_id || null, total_price, session.store_id]
    );

    await conn.query(`UPDATE purchase_sessions SET status = 'CLOSED', total_price = ? WHERE id = ?`, [total_price, session.id]);

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
  bindCardUid,
  bindCardTagsOnly,
  checkout,
  cancelSession,
};
