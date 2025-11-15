// controllers/purchaseSessionController.js
const db = require('../models/db');
const crypto = require('crypto');
const wsHub = require('../sockets/wsHub');

const STORE_ID = Number(process.env.STORE_ID || 1);

// 장바구니 수정 허용 상태
const OPEN_STATES = new Set(['OPEN', 'CARD_BOUND']);

// ───────── 유틸 ─────────
function pad2(n){ return String(n).padStart(2,'0'); }
function ts14(d=new Date()){
  return d.getFullYear().toString()+pad2(d.getMonth()+1)+pad2(d.getDate())+
         pad2(d.getHours())+pad2(d.getMinutes())+pad2(d.getSeconds());
}
function rand4(){ return Math.random().toString(36).slice(2,6).toUpperCase(); }
function makeSessionCode(kioskId='KIOSK'){ return `${kioskId}-${ts14()}-${rand4()}`; }

// JSON 보정
function ensureJsonBody(req,res){
  const ct = req.headers['content-type']||'';
  const isJson = ct.includes('application/json')||ct.includes('+json');
  if (req.body==null){
    if (isJson && req.rawBody){
      try{ req.body = JSON.parse(req.rawBody);}catch{ return res.status(400).json({error:'Malformed JSON payload'}); }
    } else req.body = {};
  }
  return null;
}

// UID 정규화
function normalizeUid(raw){
  return String(raw || '')
    .replace(/^0x/i, '')
    .replace(/[:\-\s]/g, '')
    .toUpperCase();
}

// SHA-256 → BINARY(32)
function uidToHashBinary(uid){
  const hex = crypto.createHash('sha256').update(String(uid),'utf8').digest('hex');
  return Buffer.from(hex,'hex');
}

// tags 최근 1개
async function getRecentHashFromTags(windowSec = 60){
  const [[row]] = await db.query(
    `SELECT card_uid_hash AS h
       FROM tags
      WHERE timestamp >= (NOW() - INTERVAL ? SECOND)
      ORDER BY timestamp DESC
      LIMIT 1`,
    [Number(windowSec)||60]
  );
  return row?.h || null;
}

// purchase_items → 합계 → purchase_sessions 반영
async function recomputeTotal(conn, sessionId) {
  const [[row]] = await conn.query(
    `SELECT COALESCE(SUM(quantity * unit_price), 0) AS total
       FROM purchase_items
      WHERE session_id = ?`,
    [sessionId]
  );
  const total = Number(row?.total || 0);
  await conn.query(
    `UPDATE purchase_sessions
        SET total_price = ?, updated_at = NOW()
      WHERE id = ?`,
    [total, sessionId]
  );
  return total;
}

// ───────── 컨트롤러 ─────────

// 1) 세션 생성
async function createSession(req,res,next){
  const err = ensureJsonBody(req,res); if (err) return;
  const { kiosk_id } = req.body||{};
  const session_code = makeSessionCode(kiosk_id||'KIOSK');

  const conn = await db.getConnection();
  try{
    await conn.beginTransaction();
    const [ins] = await conn.execute(
      `INSERT INTO purchase_sessions
        (store_id, session_code, status, total_price, created_at, updated_at)
        VALUES (?, ?, 'OPEN', 0, NOW(), NOW())`,
      [STORE_ID, session_code]
    );
    const [[row]] = await conn.query(
      `SELECT id, store_id, session_code, status, created_at
         FROM purchase_sessions WHERE id=?`, [ins.insertId]
    );
    await conn.commit();
    res.status(201).json({
      id: row.id,
      session_id: row.id,
      store_id: row.store_id,
      session_code: row.session_code,
      status: row.status,
      created_at: row.created_at
    });
  } catch(e){ try{await conn.rollback();}catch{} next(e); }
  finally{ conn.release(); }
}

// 2) 세션 상세 조회
async function getSessionByCode(req,res,next){
  const { session_code } = req.params;
  try{
    const [[session]] = await db.query(
      `SELECT id, store_id, session_code, card_uid_hash, status, created_at, total_price
         FROM purchase_sessions
        WHERE session_code=?`,
      [session_code]
    );
    if (!session) return res.status(404).json({error:'Session not found'});

    const [items] = await db.query(
      `SELECT id, store_product_id, quantity, unit_price,
              (unit_price*quantity) AS line_total
         FROM purchase_items
        WHERE session_id=?
        ORDER BY id ASC`,
      [session.id]
    );

    const total_estimated = items.reduce((s,x)=>s+Number(x.line_total||0),0);
    const card_uid_hash_hex = session.card_uid_hash ? Buffer.from(session.card_uid_hash).toString('hex') : null;

    res.json({
      session: {
        id: session.id,
        store_id: session.store_id,
        session_code: session.session_code,
        status: session.status,
        created_at: session.created_at,
        total_price: session.total_price ?? null,
        card_uid_hash_hex
      },
      items,
      total_estimated
    });
  } catch(e){ next(e); }
}

// 열린 최신 세션
async function getOpenLatest(req, res, next) {
  const kioskId = (req.query.kiosk_id || '').trim();
  try {
    let sql = `
      SELECT session_code, status, created_at, total_price
        FROM purchase_sessions
       WHERE store_id = ?
         AND status = 'OPEN'
    `;
    const params = [STORE_ID];

    if (kioskId) {
      sql += ` AND session_code LIKE ?`;
      params.push(`${kioskId}-%`);
    }

    sql += ` ORDER BY created_at DESC LIMIT 1`;

    const [rows] = await db.query(sql, params);

    if (!rows || rows.length === 0) {
      return res.status(404).json({ message: 'NO_OPEN_SESSION' });
    }

    const row = rows[0];
    return res.json({
      session_code: row.session_code,
      status: row.status,
      created_at: row.created_at,
    });
  } catch (e) {
    next(e);
  }
}

// 3) 아이템 추가 (누적)
async function addItem(req,res,next){
  const err = ensureJsonBody(req,res); if (err) return;
  const { session_code } = req.params;
  let { store_product_id, quantity, unit_price } = req.body||{};
  const spid = Number(store_product_id), qty = Number(quantity);
  if (!spid || !(qty>0)) return res.status(400).json({error:'store_product_id, quantity required'});

  const conn = await db.getConnection();
  try{
    await conn.beginTransaction();

    const [[sess]] = await conn.query(
      `SELECT id, status, store_id
         FROM purchase_sessions
        WHERE session_code=? FOR UPDATE`,
      [session_code]
    );
    if (!sess){ await conn.rollback(); return res.status(404).json({error:'Session not found'}); }
    if (!OPEN_STATES.has(sess.status)){ await conn.rollback(); return res.status(409).json({error:'Session is not OPEN'}); }

    if (unit_price==null){
      const [[sp]] = await conn.query(
        `SELECT sale_price FROM store_products WHERE id=? AND store_id=?`,
        [spid, sess.store_id]
      );
      if (!sp){ await conn.rollback(); return res.status(404).json({error:'store_product not found'}); }
      unit_price = Number(sp.sale_price)||0;
    } else {
      unit_price = Number(unit_price);
      if (!(unit_price>=0)){ await conn.rollback(); return res.status(400).json({error:'invalid unit_price'}); }
    }

    // 수량 누적
    await conn.query(
      `INSERT INTO purchase_items (session_id, store_product_id, quantity, unit_price)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         quantity = quantity + VALUES(quantity)`,
      [sess.id, spid, qty, unit_price]
    );

    const total = await recomputeTotal(conn, sess.id);
    await conn.commit();

    res.status(201).json({ ok: true, total_price: total });

  } catch (e) {
    try { await conn.rollback(); } catch {}
    next(e);
  } finally {
    conn.release();
  }
}

// 4) 아이템 삭제
async function removeItem(req,res,next){
  const { session_code, item_id } = req.params;

  const conn = await db.getConnection();
  try{
    await conn.beginTransaction();

    const [[sess]] = await conn.query(
      `SELECT id, status FROM purchase_sessions
        WHERE session_code=? FOR UPDATE`,
      [session_code]
    );
    if (!sess){ await conn.rollback(); return res.status(404).json({error:'Session not found'}); }
    if (!OPEN_STATES.has(sess.status)){ await conn.rollback(); return res.status(409).json({error:'Session is not OPEN'}); }

    const [del] = await conn.query(
      `DELETE FROM purchase_items WHERE id=? AND session_id=?`,
      [item_id, sess.id]
    );

    const total = await recomputeTotal(conn, sess.id);

    await conn.commit();
    if (!del.affectedRows) return res.status(404).json({error:'Item not found'});
    res.json({ ok: true, total_price: total });

  } catch(e){ try{await conn.rollback();}catch{} next(e); }
  finally{ conn.release(); }
}

// 5) 수동 UID 바인딩
async function bindCardUid(req,res,next){
  const err = ensureJsonBody(req,res); if (err) return;
  const { session_code } = req.params;
  const { uid } = req.body||{};
  if (!uid) return res.status(400).json({error:'uid is required'});

  const hashBin = uidToHashBinary(normalizeUid(uid));
  try{
    const [r] = await db.query(
      `UPDATE purchase_sessions
          SET card_uid_hash=?, updated_at=NOW()
        WHERE session_code=?`,
      [hashBin, session_code]
    );
    if (!r.affectedRows) return res.status(404).json({error:'Session not found'});
    res.json({ok:true, uid_hash_hex: Buffer.from(hashBin).toString('hex')});
  } catch(e){ next(e); }
}

// 6) 최근 tags → 바인딩
async function bindCardTagsOnly(req,res,next){
  const err = ensureJsonBody(req,res); if (err) return;
  const { session_code } = req.params;
  const win = Number(req.body?.window_sec) || 60;

  try{
    const hashBin = await getRecentHashFromTags(win);
    if (!hashBin) return res.status(404).json({error:'No recent tag'});

    const [r] = await db.query(
      `UPDATE purchase_sessions
          SET card_uid_hash=?, updated_at=NOW()
        WHERE session_code=?`,
      [hashBin, session_code]
    );
    if (!r.affectedRows) return res.status(404).json({error:'Session not found'});

    res.json({ok:true, uid_hash_hex: Buffer.from(hashBin).toString('hex')});
  } catch(e){ next(e); }
}

// 7) 바인딩 이벤트 (WebSocket 포함)
function wsBroadcast(msg) {
  try {
    if (global.kioskBroadcast) return global.kioskBroadcast(msg);
  } catch {}
  try {
    const kioskController = require('../controllers/kioskController');
    if (kioskController?.broadcast) return kioskController.broadcast(msg);
  } catch {}
  try {
    const hub = require('../sockets/wsHub');
    if (hub?.broadcast) return hub.broadcast(msg);
  } catch {}
  console.log('[WS] no broadcast function found');
}

async function bindCardEvent(req, res, next) {
  const { session_code } = req.params;
  const { uid: rawUid, record_tag = true } = req.body || {};
  if (!rawUid) return res.status(400).json({ error: 'uid is required' });

  const uid = normalizeUid(rawUid);
  const hashBin = uidToHashBinary(uid);
  const hashHex = Buffer.from(hashBin).toString('hex');

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    if (record_tag) {
      await conn.query(
        `INSERT INTO tags (card_uid_hash, timestamp) VALUES (?, NOW())`,
        [hashBin]
      );
    }

    const [[sess]] = await conn.query(
      `SELECT id, status
         FROM purchase_sessions
        WHERE session_code=? FOR UPDATE`,
      [session_code]
    );
    if (!sess) {
      await conn.rollback();
      return res.status(404).json({ error: 'Session not found' });
    }

    const total = await recomputeTotal(conn, sess.id);

    await conn.query(
      `UPDATE purchase_sessions
          SET card_uid_hash = IFNULL(card_uid_hash, ?),
              status        = 'CARD_BOUND',
              total_price   = ?,
              updated_at    = NOW()
        WHERE id = ?`,
      [hashBin, total, sess.id]
    );

    await conn.commit();

    res.json({
      ok: true,
      session_code,
      uid_hash_hex: hashHex,
      new_status: 'CARD_BOUND',
      total_price: total
    });

    setImmediate(() => {
      wsHub.broadcastToSession(session_code, {
        type: 'SESSION_CARD_BOUND',
        session_code,
        uid_hash_hex: hashHex,
        total_price: total,
        next: 'PAYMENT_READY'
      });
    });

  } catch (e) {
    try { await conn.rollback(); } catch {}
    next(e);
  } finally {
    conn.release();
  }
}

// 8) 체크아웃(PAID 순간 purchases에 INSERT)
async function checkout(req,res,next){
  const err = ensureJsonBody(req,res); if (err) return;
  const { session_code } = req.params;
  const { approve } = req.body||{};
  if (!approve) return res.status(400).json({error:'approve is required'});

  const conn = await db.getConnection();
  try{
    await conn.beginTransaction();

    const [[sess]] = await conn.query(
      `SELECT id, store_id, card_uid_hash, status
         FROM purchase_sessions
        WHERE session_code=? FOR UPDATE`,
      [session_code]
    );
    if (!sess){ await conn.rollback(); return res.status(404).json({error:'Session not found'}); }
    if (!OPEN_STATES.has(sess.status)){ await conn.rollback(); return res.status(409).json({error:'Session is not OPEN'}); }

    const [items] = await conn.query(
      `SELECT store_product_id, quantity, unit_price
         FROM purchase_items WHERE session_id=?`,
      [sess.id]
    );
    if (items.length===0){ await conn.rollback(); return res.status(400).json({error:'No items in session'}); }

    // 재고 검증
    for (const it of items){
      const spid = Number(it.store_product_id);
      const qty  = Number(it.quantity);
      const [[sp]] = await conn.query(
        `SELECT id, quantity FROM store_products
          WHERE id=? AND store_id=? FOR UPDATE`,
        [spid, sess.store_id]
      );
      if (!sp){
        await conn.rollback();
        return res.status(404).json({error:`store_product not found: ${spid}`});
      }
      if (Number(sp.quantity) < qty){
        await conn.rollback();
        return res.status(409).json({
          error:'INSUFFICIENT_STOCK',
          detail:{store_product_id:spid, have:Number(sp.quantity), need:qty}
        });
      }
    }

    // 결제 승인 → purchases INSERT
    let grandTotal = 0;
    for (const it of items){
      const spid = Number(it.store_product_id);
      const qty  = Number(it.quantity);
      const unit = Number(it.unit_price)||0;
      const line = unit*qty;
      grandTotal += line;

      // 재고 차감
      await conn.query(
        `UPDATE store_products SET quantity=quantity-? WHERE id=? AND store_id=?`,
        [qty, spid, sess.store_id]
      );

      // 출고 로그
      await conn.query(
        `INSERT INTO inventory_log (store_product_id, change_type, quantity, timestamp, store_id)
         VALUES (?, '출고', ?, NOW(), ?)`,
        [spid, qty, sess.store_id]
      );

      // ⭐ 결제 완료 → purchases INSERT (session_code 포함)
      await conn.query(
        `INSERT INTO purchases
          (store_product_id, quantity, unit_price, total_price, store_id,
           payment_method, purchased_at, session_code)
         VALUES (?, ?, ?, ?, ?, 'RFID', NOW(), ?)`,
        [spid, qty, unit, line, sess.store_id, session_code]
      );
    }

    // 세션 상태 = PAID
    await conn.query(
      `UPDATE purchase_sessions
          SET status='PAID', total_price=?, updated_at=NOW()
        WHERE id=?`,
      [grandTotal, sess.id]
    );

    await conn.commit();
    res.status(201).json({ok:true, total_price: grandTotal});

  } catch(e){
    try{await conn.rollback();}catch{}
    next(e);
  } finally {
    conn.release();
  }
}

// 9) 세션 취소
async function cancelSession(req,res,next){
  const { session_code } = req.params;
  const conn = await db.getConnection();
  try{
    await conn.beginTransaction();

    const [[sess]] = await conn.query(
      `SELECT id, status FROM purchase_sessions
        WHERE session_code=? FOR UPDATE`,
      [session_code]
    );
    if (!sess){ await conn.rollback(); return res.status(404).json({error:'Session not found'}); }
    if (!OPEN_STATES.has(sess.status)){ await conn.rollback(); return res.status(409).json({error:'Session is not OPEN'}); }

    await conn.query(`DELETE FROM purchase_items WHERE session_id=?`, [sess.id]);
    await conn.query(
      `UPDATE purchase_sessions SET status='CANCELLED', updated_at=NOW()
        WHERE id=?`, [sess.id]
    );

    await conn.commit();
    res.json({ok:true});
  } catch(e){
    try{await conn.rollback();}catch{}
    next(e);
  } finally {
    conn.release();
  }
}

// 10) 특정 상품 수량 재설정 (재스캔 시 해당 상품만 초기화 후 새 값으로 대체)
async function resetItemQuantity(req, res, next) {
  const err = ensureJsonBody(req, res); 
  if (err) return;

  const { session_code } = req.params;
  const { store_product_id, quantity } = req.body || {};

  const spid = Number(store_product_id);
  const qty = Number(quantity);

  if (!spid || !(qty >= 0)) {
    return res.status(400).json({ error: 'store_product_id and valid quantity required' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 세션 확인
    const [[sess]] = await conn.query(
      `SELECT id, status, store_id
         FROM purchase_sessions
        WHERE session_code=? FOR UPDATE`,
      [session_code]
    );
    if (!sess) {
      await conn.rollback();
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!OPEN_STATES.has(sess.status)) {
      await conn.rollback();
      return res.status(409).json({ error: 'Session is not OPEN' });
    }

    // store_products 가격 가져오기 (unit_price)
    const [[sp]] = await conn.query(
      `SELECT sale_price FROM store_products 
        WHERE id=? AND store_id=?`,
      [spid, sess.store_id]
    );
    if (!sp) {
      await conn.rollback();
      return res.status(404).json({ error: 'store_product not found' });
    }

    const unit_price = Number(sp.sale_price) || 0;

    // 기존 아이템 삭제 후 새로 삽입
    await conn.query(
      `DELETE FROM purchase_items
        WHERE session_id=? AND store_product_id=?`,
      [sess.id, spid]
    );

    if (qty > 0) {
      await conn.query(
        `INSERT INTO purchase_items
          (session_id, store_product_id, quantity, unit_price)
         VALUES (?, ?, ?, ?)`,
        [sess.id, spid, qty, unit_price]
      );
    }

    // 합계 갱신
    const total = await recomputeTotal(conn, sess.id);

    await conn.commit();

    res.json({
      ok: true,
      store_product_id: spid,
      new_quantity: qty,
      total_price: total,
    });

  } catch (e) {
    try { await conn.rollback(); } catch {}
    next(e);
  } finally {
    conn.release();
  }
}

// 11) 전체 삭제 후 새 YOLO 결과로 교체
async function replaceAllItems(req, res, next) {
  const err = ensureJsonBody(req, res);
  if (err) return;

  const { session_code } = req.params;
  const { items } = req.body || {}; 
  // items = [ { store_product_id: 3, quantity: 2 }, ... ]

  if (!Array.isArray(items)) {
    return res.status(400).json({ error: 'items(required array)' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 세션 확인
    const [[sess]] = await conn.query(
      `SELECT id, store_id, status
         FROM purchase_sessions
        WHERE session_code=? FOR UPDATE`,
      [session_code]
    );

    if (!sess) {
      await conn.rollback();
      return res.status(404).json({ error: 'Session not found' });
    }

    if (!OPEN_STATES.has(sess.status)) {
      await conn.rollback();
      return res.status(409).json({ error: 'Session is not OPEN' });
    }

    // 1) 기존 전체 아이템 삭제
    await conn.query(
      `DELETE FROM purchase_items WHERE session_id=?`,
      [sess.id]
    );

    // 2) 새로 Insert
    for (const it of items) {
      const spid = Number(it.store_product_id);
      const qty = Number(it.quantity);

      // 잘못된 데이터 들어오면 전체 롤백 + 에러 반환
      if (!spid || !(qty > 0)) {
        await conn.rollback();
        return res.status(400).json({
          error: 'Invalid item in items',
          item: it,
        });
      }

      const [[sp]] = await conn.query(
        `SELECT sale_price FROM store_products 
          WHERE id=? AND store_id=?`,
        [spid, sess.store_id]
      );
      if (!sp) {
        await conn.rollback();
        return res.status(404).json({
          error: 'store_product not found',
          store_product_id: spid,
        });
      }

      const unit = Number(sp.sale_price) || 0;

      await conn.query(
        `INSERT INTO purchase_items 
          (session_id, store_product_id, quantity, unit_price)
         VALUES (?, ?, ?, ?)`,
        [sess.id, spid, qty, unit]
      );
    }

    // 3) total_price 재계산
    const total = await recomputeTotal(conn, sess.id);

    await conn.commit();

    res.json({
      ok: true,
      total_price: total,
      replaced_count: items.length
    });

  } catch (e) {
    try { await conn.rollback(); } catch {}
    next(e);
  } finally {
    conn.release();
  }
}

module.exports = {
  createSession,
  getSessionByCode,
  getOpenLatest,
  addItem,
  removeItem,
  bindCardUid,
  bindCardTagsOnly,
  bindCardEvent,
  checkout,       // ⭐ PAID 순간 purchases INSERT가 여기 있음
  cancelSession,
  resetItemQuantity,
  replaceAllItems,
};
