// refiner.js
// MongoDB에서 데이터를 읽어와 MySQL로 옮기는 프로그램

const mongoose = require('mongoose'); // MongoDB 라이브러리
const mysql = require('mysql2/promise'); // MySQL 라이브러리

// --- 1. MongoDB 접속 정보 ---
const mongoDbUrl = "mongodb+srv://admin:ghdwldud@nfc-mongodb.7tbh0en.mongodb.net/?retryWrites=true&w=majority&appName=nfc-mongodb";

// MongoDB 데이터 구조(Schema) 정의 (server.js와 동일해야 함)
const rawTagSchema = new mongoose.Schema({
  uid: String,
  timestamp: { type: Date, default: Date.now }
});
const RawTag = mongoose.model('RawTag', rawTagSchema);


// --- 2. MySQL 접속 정보 ---
const mysqlConfig = {
    host: 'kiosk-db.cxss0eug8zre.ap-northeast-2.rds.amazonaws.com',
    user: 'admin',
    password: 'ghdwldud', // RDS 비밀번호 재설정한 것으로 입력
    database: 'kiosk_db'
};

// --- 3. 데이터 정제 및 이동 함수 ---
async function refineAndMoveData() {
    console.log('Starting data refinement process...');
    
    try {
        // MongoDB에서 가장 최신 데이터 1개 가져오기
        const latestRawTag = await RawTag.findOne().sort({ timestamp: -1 });

        if (latestRawTag) {
            console.log(`Found latest tag in MongoDB: ${latestRawTag.uid}`);

            // MySQL 커넥션 풀 생성
            const pool = mysql.createPool(mysqlConfig);

            // MySQL에 데이터 저장 (또는 업데이트)
            // 여기서는 간단하게 항상 새로 추가(INSERT)합니다.
            const sql = 'INSERT INTO tags (uid, timestamp) VALUES (?, ?)';
            await pool.query(sql, [latestRawTag.uid, latestRawTag.timestamp]);
            
            console.log(`Successfully moved data to MySQL.`);
            pool.end(); // 작업 후 커넥션 풀 닫기
        } else {
            console.log('No new data in MongoDB to process.');
        }
    } catch (error) {
        console.error('An error occurred during the process:', error);
    }
}

// --- 4. 메인 실행 로직 ---
async function main() {
    try {
        // MongoDB에 먼저 연결
        await mongoose.connect(mongoDbUrl);
        console.log('MongoDB connection successful for refiner.');
        
        // 연결 성공 후, 데이터 정제 함수 실행
        await refineAndMoveData();

    } catch (error) {
        console.error('Failed to run refiner script:', error);
    } finally {
        // 모든 작업이 끝나면 MongoDB 연결 종료
        await mongoose.disconnect();
        console.log('MongoDB connection closed.');
    }
}

// 스크립트 실행
main();
