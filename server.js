// server.js (v6 - 최종 간소화 버전)
// MongoDB와 refiner.js를 제거하고, 이 파일 하나로 모든 것을 처리합니다.

const express = require('express');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const app = express();
const port = 8080;
app.use(express.json());

// 해시 생성 함수
function createHash(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

// --- MySQL 설정 (유일한 데이터베이스) ---
const mysqlConfig = {
    host: 'kiosk-db.cxss0eug8zre.ap-northeast-2.rds.amazonaws.com',
    user: 'admin',
    password: 'ghdwldud', // RDS 비밀번호 재설정한 것으로 입력
    database: 'kiosk_db',
    timezone: 'Asia/Seoul' // 최종적으로 한국 시간대를 사용합니다.
};
const mysqlPool = mysql.createPool(mysqlConfig);


// --- API 엔드포인트 ---

// 1. Wemos로부터 UID를 받아 "즉시" MySQL 'tags' 테이블에 저장
app.post('/api/tag', async (req, res) => {
  const { uid } = req.body;
  if (uid) {
    try {
      const uid_hash = createHash(uid);
      
      const sql = 'INSERT INTO tags (card_uid_hash, timestamp) VALUES (?, NOW())';
      await mysqlPool.query(sql, [uid_hash]);
      
      console.log(`[${new Date().toLocaleString('ko-KR')}] UID HASH received and saved directly to MySQL: ${uid_hash}`);
      res.status(200).json({ status: 'success', message: 'UID saved to MySQL' });
    } catch (error) {
      console.error('Error saving to MySQL:', error);
      res.status(500).json({ status: 'error', message: 'Failed to save UID' });
    }
  } else {
    res.status(400).json({ status: 'error', message: 'UID not found' });
  }
});

// 2. 키오스크가 최신 태그 정보로 "세션"을 가져오거나 생성하는 API
app.get('/api/session', async (req, res) => {
  try {
    // 1. 'tags' 테이블에서 가장 최근 태그된 UID를 가져옵니다.
    const getLatestTagSql = 'SELECT card_uid_hash FROM tags ORDER BY timestamp DESC LIMIT 1';
    const [tagRows] = await mysqlPool.query(getLatestTagSql);

    if (tagRows.length === 0) {
      return res.status(404).json({ message: 'No tag data found' });
    }
    const currentUserUidHash = tagRows[0].card_uid_hash;
    console.log(`Latest user HASH from tags table: ${currentUserUidHash}`);

    // 2. 해당 UID로 활성(status가 NULL) 상태인 세션이 있는지 찾습니다.
    const findSessionSql = 'SELECT * FROM purchase_sessions WHERE card_uid_hash = ? AND status IS NULL';
    const [sessionRows] = await mysqlPool.query(findSessionSql, [currentUserUidHash]);

    if (sessionRows.length > 0) {
      // 3-1. 활성 세션이 있으면, 그 세션 정보를 반환합니다.
      console.log(`Found active session for user HASH: ${currentUserUidHash}`);
      res.status(200).json(sessionRows[0]);
    } else {
      // 3-2. 활성 세션이 없으면, 새로운 세션을 만들고 그 정보를 반환합니다.
      console.log(`No active session found. Creating a new session for user HASH: ${currentUserUidHash}`);
      const now = new Date();
      const sessionCode = `KIOSK-${now.toISOString().slice(0,19).replace(/[-T:]/g,'')}-${Math.random().toString(36).substring(2,6).toUpperCase()}`;
      const createSessionSql = 'INSERT INTO purchase_sessions (store_id, session_code, card_uid_hash, total_price) VALUES (?, ?, ?, ?)';
      const [insertResult] = await mysqlPool.query(createSessionSql, [1, sessionCode, currentUserUidHash, 0]);
      
      const newSessionId = insertResult.insertId;
      const getNewSessionSql = 'SELECT * FROM purchase_sessions WHERE id = ?';
      const [newSessionRows] = await mysqlPool.query(getNewSessionSql, [newSessionId]);
      
      res.status(201).json(newSessionRows[0]);
    }
  } catch (error) {
    console.error('Error processing session:', error);
    res.status(500).json({ status: 'error', message: 'Failed to process session' });
  }
});

// --- 서버 시작 ---
app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
    console.log('Simplified server is running. Ready for all tasks.');
});

