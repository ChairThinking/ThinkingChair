// controllers/purchaseSessionController.js
const db = require('../models/db');
const crypto = require('crypto');

const STORE_ID = Number(process.env.STORE_ID || 1);

// "열림" 상태 집합 (이 중 하나면 장바구니 작업 허용)
const OPEN_STATES = new Set(['SCANNING', 'READY', 'OPEN']);

// ───────── 유틸 ─────────
function pad2(n){ return String(n).padStart(2,'0'); }
function ts14(d=new Date()){
  return d.getFullYear().toString()+pad2(d.getMonth()+1)+pad2(d.getDate())+
         pad2(d.getHours())+pad2(d.getMinutes())+pad2(d.getSeconds());
}
function rand4(){ return Math.random().toString(36).slice(2,6).toUpperCase(); }
function makeSessionCode(kioskId='KIOSK'){ return `${kioskId}-${ts14()}-${rand4()}`; }

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

// UID 정규화: 0x/콜론/대시/공백 제거 + 대문자
function normalizeUid(raw){
  return String(raw || '')
    .replace(/^0x/i, '')
    .replace(/[:\-\s]/g, '')
    .toUpperCase();
}

// SHA-256(uid 평문) → BINARY(32)
function uidToHashBinary(uid){
  const hex = crypto.createHash('sha256').update(String(uid),'utf8').digest('hex');
  return Buffer.from(hex,'hex');
}

// (백업/디버그용) tags 테이블에서 최근 해시 1건
async function getRecentHashFromTags(windowSec = 60){
  const [[row]] = await db.query(
    `SELECT card_uid_hash AS h
       FROM tags
      WHERE timestamp >= (NOW() - INTERVAL ? SECOND)
      ORDER BY timestamp DESC
      LIMIT 1`,
    [Number(windowSec)||60]
  );
  return row?.h || null; // Buffer 또는 null
}

// ───────── 컨트롤러 ─────────

// 1) 세션 생성: status 명시적으로 'SCANNING'
async function createSession(req,res,next){
  const err = ensureJsonBody(req,res); if (err) return;
  const { kiosk_id } = req.body||{};
  const session_code = makeSessionCode(kiosk_id||'KIOSK');

  const conn = await db.getConnection();
  try{
    await conn.beginTransaction();
    const [ins] = await conn.execute(
      `INSERT INTO purchase_sessions (store_id, session_code, status, created_at, updated_at)
       VALUES (?, ?, 'SCANNING', NOW(), NOW())`,
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

// 2) 세션 조회 (상세)
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

// 2-1) (신규) 열린 세션 최신 1건 조회: ESP8266 폴링용
// GET /api/purchase-sessions/open-latest?kiosk_id=KIOSK-01
async function getOpenLatest(req, res, next) {
  const kioskId = (req.query.kiosk_id || '').trim();
  try {
    // OPEN_STATES → (?, ?, ?) 자리표시자 만들기
    const openArr = Array.from(OPEN_STATES);
    const placeholders = openArr.map(() => '?').join(', ');
    let sql =
      `SELECT session_code, status, created_at
         FROM purchase_sessions
        WHERE store_id = ?
          AND status IN (${placeholders})`;
    const params = [STORE_ID, ...openArr];

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

// 3) 아이템 추가
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

    await conn.query(
      `INSERT INTO purchase_items (session_id, store_product_id, quantity, unit_price)
       VALUES (?, ?, ?, ?)`,
      [sess.id, spid, qty, unit_price]
    );

    await conn.commit();
    res.status(201).json({ok:true});
  } catch(e){ try{await conn.rollback();}catch{} next(e); }
  finally{ conn.release(); }
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

    await conn.commit();
    if (!del.affectedRows) return res.status(404).json({error:'Item not found'});
    res.json({ok:true});
  } catch(e){ try{await conn.rollback();}catch{} next(e); }
  finally{ conn.release(); }
}

// 5) UID 직접 바인딩 (수동/디버그용)
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

// 6) 최근 태그 바인딩 (백업/디버그용, 운영은 이벤트 즉시 바인딩 사용)
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

// 7) (권장) 이벤트 기반 바인딩: 세션코드로 즉시 바인딩 + tags 기록
async function bindCardEvent(req, res, next) {
  const err = ensureJsonBody(req, res); if (err) return;

  const { session_code } = req.params;
  const { uid: rawUid, record_tag = true } = req.body || {};
  if (!rawUid) return res.status(400).json({ error: 'uid is required' });

  const uid = normalizeUid(rawUid);
  if (!/^[0-9A-F]{6,32}$/.test(uid)) {
    return res.status(400).json({ error: 'invalid uid format (hex 6~32)' });
  }
  const hashBin = uidToHashBinary(uid);

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // (선택) 태그 이벤트 기록
    if (record_tag) {
      await conn.query(
        `INSERT INTO tags (card_uid_hash, timestamp) VALUES (?, NOW())`,
        [hashBin]
      );
    }

    // 세션 잠금 & 상태 확인
    const [[sess]] = await conn.query(
      `SELECT id, status
         FROM purchase_sessions
        WHERE session_code = ?
        FOR UPDATE`,
      [session_code]
    );
    if (!sess) { await conn.rollback(); return res.status(404).json({ error: 'Session not found' }); }
    if (!OPEN_STATES.has(sess.status)) { await conn.rollback(); return res.status(409).json({ error: 'Session is not OPEN' }); }

    // 이미 값 있으면 덮어쓰지 않음(IFNULL)
    const [upd] = await conn.query(
      `UPDATE purchase_sessions
          SET card_uid_hash = IFNULL(card_uid_hash, ?), updated_at = NOW()
        WHERE id = ? AND card_uid_hash IS NULL`,
      [hashBin, sess.id]
    );

    const bound = upd.affectedRows > 0;
    await conn.commit();

    return res.json({
      ok: true,
      bound,
      alreadyBound: !bound,
      session_code,
      uid_hash_hex: Buffer.from(hashBin).toString('hex')
    });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    next(e);
  } finally {
    conn.release();
  }
}

// 8) 체크아웃 (RFID 결제, 출고 로그)
async function checkout(req,res,next){
  const err = ensureJsonBody(req,res); if (err) return;
  const { session_code } = req.params;
  const { approve } = req.body||{};
  if (!approve) return res.status(400).json({error:'approve is required'});

  const conn = await db.getConnection();
  try{
    await conn.beginTransaction();

    // 세션 잠금
    const [[sess]] = await conn.query(
      `SELECT id, store_id, card_uid_hash, status
         FROM purchase_sessions
        WHERE session_code=? FOR UPDATE`,
      [session_code]
    );
    if (!sess){ await conn.rollback(); return res.status(404).json({error:'Session not found'}); }
    if (!OPEN_STATES.has(sess.status)){ await conn.rollback(); return res.status(409).json({error:'Session is not OPEN'}); }

    // 장바구니
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
      if (!sp){ await conn.rollback(); return res.status(404).json({error:`store_product not found: ${spid}`}); }
      if (Number(sp.quantity) < qty){
        await conn.rollback();
        return res.status(409).json({
          error:'INSUFFICIENT_STOCK',
          detail:{store_product_id:spid, have:Number(sp.quantity), need:qty}
        });
      }
    }

    // 차감 + 로그(출고) + 매출(RFID)
    let grandTotal = 0;
    for (const it of items){
      const spid = Number(it.store_product_id);
      const qty  = Number(it.quantity);
      const unit = Number(it.unit_price)||0;
      const line = unit*qty; grandTotal += line;

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

      // 매출 기록 (card_uid_hash 사용)
      await conn.query(
        `INSERT INTO purchases
          (store_product_id, card_uid_hash, quantity, unit_price, total_price,
           payment_method, purchased_at, store_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'RFID', NOW(), ?, NOW())`,
        [spid, sess.card_uid_hash || null, qty, unit, line, sess.store_id]
      );
    }

    // 세션 마감
    await conn.query(
      `UPDATE purchase_sessions SET status='PAID', total_price=?, updated_at=NOW() WHERE id=?`,
      [grandTotal, sess.id]
    );

    await conn.commit();
    res.status(201).json({ok:true, total_price: grandTotal});
  } catch(e){ try{await conn.rollback();}catch{} next(e); }
  finally{ conn.release(); }
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
    await conn.query(`UPDATE purchase_sessions SET status='CANCELLED', updated_at=NOW() WHERE id=?`, [sess.id]);

    await conn.commit();
    res.json({ok:true});
  } catch(e){ try{await conn.rollback();}catch{} next(e); }
  finally{ conn.release(); }
}

module.exports = {
  createSession,
  getSessionByCode,
  getOpenLatest,      // ✅ 추가: 열린 세션 최신 1건
  addItem,
  removeItem,
  bindCardUid,        // 수동/디버그용
  bindCardTagsOnly,   // 윈도우 바인딩(디버그용)
  bindCardEvent,      // ✅ 권장: 세션코드 기반 즉시 바인딩
  checkout,
  cancelSession,
};
