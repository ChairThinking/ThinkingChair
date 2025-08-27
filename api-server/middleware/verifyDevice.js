// middleware/verifyDevice.js
const crypto = require('crypto');
const db = require('../models/db'); // mysql2/promise pool

/**
 * 단말 HMAC 검증 미들웨어
 * - 헤더: X-Device-Id, X-Timestamp(ISO), X-Signature(Base64)
 * - 서명대상: `${METHOD}\n${PATH}\n${TIMESTAMP}\n${RAW_BODY}`
 * - 타임스큐: ±60초 허용
 */
module.exports = async function verifyDevice(req, res, next) {
  try {
    const deviceId = req.header('X-Device-Id');
    const ts = req.header('X-Timestamp');
    const sig = req.header('X-Signature');

    if (!deviceId || !ts || !sig) {
      return res.status(401).json({ error: 'device auth required' });
    }

    const now = Date.now();
    const skew = Math.abs(now - Date.parse(ts || ''));
    if (isNaN(skew) || skew > 60 * 1000) {
      return res.status(401).json({ error: 'timestamp skew' });
    }

    const [[row]] = await db.query(
      'SELECT secret, role FROM device_keys WHERE device_id = ?',
      [deviceId]
    );
    if (!row) return res.status(401).json({ error: 'unknown device' });

    const method = req.method.toUpperCase();
    const pathOnly = req.originalUrl.split('?')[0];
    const body = req.rawBody || ''; // app.js에서 보관
    const payload = `${method}\n${pathOnly}\n${ts}\n${body}`;
    const mac = crypto.createHmac('sha256', row.secret).update(payload).digest('base64');

    if (mac !== sig) return res.status(401).json({ error: 'bad signature' });

    // (선택) 역할별 접근 제어 필요 시 사용
    req.device = { deviceId, role: row.role };
    next();
  } catch (e) {
    next(e);
  }
};
