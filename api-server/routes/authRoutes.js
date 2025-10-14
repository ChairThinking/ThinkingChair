const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const pool = require('../models/db');

const router = express.Router();

/* JWT 유틸 */
function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '2d',
  });
}

/* 쿠키 설정: 기본 2일 (Remember Me 없이) */
function setAuthCookie(res, token, { maxAgeMs = 1000 * 60 * 60 * 24 * 2 } = {}) {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie('auth_token', token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge: maxAgeMs, // 없애면 세션쿠키가 되어 브라우저 종료시 삭제
    path: '/',
  });
}

/* 인증 미들웨어 */
function authMiddleware(req, res, next) {
  const token = req.cookies?.auth_token;
  if (!token) return res.status(401).json({ error: '인증 필요' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: '토큰 만료/무효' });
  }
}

/* 회원가입 */
router.post(
  '/register',
  [
    body('email').isEmail(),
    body('password').isLength({ min: 6 }),
    body('name').notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ error: '입력 형식 오류', details: errors.array() });

    const { email, password, name } = req.body;

    try {
      const [exists] = await pool.query('SELECT id FROM users WHERE email=?', [email]);
      if (exists.length > 0) return res.status(400).json({ error: '이미 존재하는 이메일입니다.' });

      const hash = await bcrypt.hash(password, 10);
      await pool.query(
        'INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)',
        [email, hash, name, 'manager']
      );

      res.json({ ok: true, message: '회원가입 완료! 로그인해주세요.' });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: '회원가입 실패' });
    }
  }
);

/* 로그인 (remember 지원 옵션) */
router.post(
  '/login',
  [body('email').isEmail(), body('password').isLength({ min: 6 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty())
      return res.status(400).json({ error: '이메일/비밀번호 형식 확인', details: errors.array() });

    const { email, password, remember } = req.body;

    try {
      const [rows] = await pool.query(
        'SELECT id, email, password_hash, name, role FROM users WHERE email=?',
        [email]
      );
      const user = rows[0];
      if (!user) return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });

      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });

      const token = signToken({ uid: user.id, role: user.role, name: user.name, email: user.email });

      // remember=true면 14일, 아니면 2일
      const maxAgeMs = remember ? 1000 * 60 * 60 * 24 * 14 : 1000 * 60 * 60 * 24 * 2;
      setAuthCookie(res, token, { maxAgeMs });

      res.json({ id: user.id, name: user.name, email: user.email, role: user.role });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: '로그인 처리 중 오류' });
    }
  }
);

/* 세션 확인 */
router.get('/me', authMiddleware, async (req, res) => {
  const { uid } = req.user;
  try {
    const [[me]] = await pool.query('SELECT id, name, email, role FROM users WHERE id=?', [uid]);
    if (!me) return res.status(404).json({ error: '사용자 없음' });
    res.json(me);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '조회 오류' });
  }
});

/* 로그아웃 */
router.post('/logout', (req, res) => {
  res.clearCookie('auth_token', { path: '/' });
  res.json({ ok: true });
});

module.exports = { router, authMiddleware };
