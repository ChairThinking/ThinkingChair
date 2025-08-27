// models/db.js
const mysql = require('mysql2/promise');
require('dotenv').config();

/**
 * 권장 .env 키
 * DB_HOST, DB_PORT(옵션), DB_USER, DB_PASSWORD, DB_DATABASE
 * 기존에 DB_NAME을 쓰고 있었다면 아래에서 DB_DATABASE || DB_NAME 으로 호환 처리함.
 */
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE || process.env.DB_NAME, // 호환
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // 날짜/시간 일관성: 문자열로 받고(프런트/백엔드 변환 주도)
  dateStrings: true,
  // 서버/DB 타임존 다를 때 혼선 방지 (DB가 UTC라면 'Z', KST 고정이면 '+09:00')
  timezone: 'Z',
});

/** 초기 핑으로 연결 확인 (로그만) */
(async () => {
  try {
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    console.log('✅ MySQL pool connected');
  } catch (e) {
    console.error('❌ MySQL connection failed:', e.message);
  }
})();

module.exports = pool;
