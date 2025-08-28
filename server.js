// server.js
// 데이터 수집(MongoDB), 기존 세션 테이블 연동 및 데이터 제공(MySQL)을 모두 처리하는 최종 서버

// --- 기본 설정 ---
const express = require('express');
const mongoose = require('mongoose');
const mysql = require('mysql2/promise');
const app = express();
const port = 8080;
app.use(express.json());

// --- MongoDB 설정 (데이터 수집용) ---
const mongoDbUrl = "mongodb+srv://admin:ghdwldud@nfc-mongodb.7tbh0en.mongodb.net/?retryWrites=true&w=majority&appName=nfc-mongodb";
const rawTagSchema = new mongoose.Schema({
  uid: String,
  timestamp: { type: Date, default: Date.now }
});
const RawTag = mongoose.model('RawTag', rawTagSchema);

// --- MySQL 설정 (데이터 제공 및 세션 관리용) ---
const mysqlConfig = {
    host: 'kiosk-db.cxss0eug8zre.ap-northeast-2.rds.amazonaws.com',
    user: 'admin',
    password: 'ghdwldud', // RDS 비밀번호 재설정한 것으로 입력
    database: 'kiosk_db'
};
const mysqlPool = mysql.createPool(mysqlConfig);


// --- API 엔드포인트 ---

// 1. Wemos로부터 태그 정보를 받아 MongoDB에 저장하는 API
app.post('/api/tag', async (req, res) => {
  // (기존 코드와 동일)
  const { uid } = req.body;
  if (uid) {
    try {
      const newRawTag = new RawTag({ uid: uid });
      await newRawTag.save();
      console.log(`[${newRawTag.timestamp.toISOString()}] Raw UID received and saved to MongoDB: ${uid}`);
      res.status(200).json({ status: 'success', message: 'Raw UID received' });
    } catch (error) {
      res.status(500).json({ status: 'error', message: 'Failed to save raw UID' });
    }
  } else {
    res.status(400).json({ status: 'error', message: 'UID not found' });
  }
});

// 2. 키오스크가 최신 태그 정보로 "세션"을 가져오거나 생성하는 API
app.get('/api/session', async (req, res) => {
  try {
    // 1. MySQL의 'tags' 테이블에서 가장 최근 태그된 UID를 가져옵니다.
    const getLatestTagSql = 'SELECT uid FROM tags ORDER BY timestamp DESC LIMIT 1';
    const [tagRows] = await mysqlPool.query(getLatestTagSql);

    if (tagRows.length === 0) {
      return res.status(404).json({ message: 'No tag data found in MySQL' });
    }
    const currentUserUid = tagRows[0].uid;
    console.log(`Latest user UID from tags table: ${currentUserUid}`);

    // 2. 해당 UID(card_id)로 활성 상태(status가 NULL)인 세션이 있는지 찾습니다.
    const findSessionSql = 'SELECT * FROM purchase_sessions WHERE card_id = ? AND status IS NULL';
    const [sessionRows] = await mysqlPool.query(findSessionSql, [currentUserUid]);

    if (sessionRows.length > 0) {
      // 3-1. 활성 세션이 있으면, 그 세션 정보를 반환합니다.
      console.log(`Found active session for user ${currentUserUid}`);
      res.status(200).json(sessionRows[0]);
    } else {
      // 3-2. 활성 세션이 없으면, 새로운 세션을 만들고 그 정보를 반환합니다.
      console.log(`No active session found. Creating a new session for user ${currentUserUid}`);
      
      // session_code를 간단하게 생성합니다. (예: KIOSK-20250827153000-ABC1)
      const now = new Date();
      const sessionCode = `KIOSK-${now.toISOString().slice(0,19).replace(/[-T:]/g,'')}-${Math.random().toString(36).substring(2,6).toUpperCase()}`;

      const createSessionSql = 'INSERT INTO purchase_sessions (store_id, session_code, card_id, total_price) VALUES (?, ?, ?, ?)';
      const [insertResult] = await mysqlPool.query(createSessionSql, [1, sessionCode, currentUserUid, 0]); // store_id=1, total_price=0으로 가정
      
      const newSessionId = insertResult.insertId;
      const getNewSessionSql = 'SELECT * FROM purchase_sessions WHERE id = ?';
      const [newSessionRows] = await mysqlPool.query(getNewSessionSql, [newSessionId]);
      
      res.status(201).json(newSessionRows[0]); // 201: Created
    }

  } catch (error) {
    console.error('Error processing session:', error);
    res.status(500).json({ status: 'error', message: 'Failed to process session' });
  }
});


// --- 서버 시작 ---
async function startServer() {
    try {
        await mongoose.connect(mongoDbUrl);
        console.log('MongoDB for data collection is connected.');
        
        app.listen(port, () => {
            console.log(`Server listening on port ${port}`);
            console.log('Ready to receive data from Wemos and serve data to Kiosk.');
        });
    } catch (error) {
        console.error('Failed to connect to MongoDB. Server not started.', error);
    }
}

startServer();
