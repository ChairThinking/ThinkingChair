const db = require('./models/db');

async function testConnection() {
  try {
    const [rows] = await db.query('SELECT NOW() AS now');
    console.log('✅ 연결 성공! 현재 시간:', rows[0].now);
  } catch (err) {
    console.error('❌ 연결 실패:', err.message);
  }
}

testConnection();
