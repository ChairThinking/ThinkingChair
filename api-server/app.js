// app.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
// const morgan = require('morgan');
const http = require('http');
const WebSocket = require('ws');
const cookieParser = require('cookie-parser');            // ✅ 추가
const wsHub = require('./sockets/wsHub');

const app = express();

/* -------------------- 기본 설정 -------------------- */
const PORT = process.env.PORT || 4000;
app.set('trust proxy', 1);

/* -------------------- 미들웨어 -------------------- */
app.use(helmet());
// ⚠️ 쿠키+인증(Credentials) 허용을 위해 origin을 명시적으로 지정
app.use(cors({
  origin: process.env.CLIENT_ORIGIN || true,              // ✅ 수정: http://localhost:3000 권장
  credentials: true,
}));
app.use(compression());

// ⚠️ JSON 파서는 라우트 "등록 전에"
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => {
    req.rawBody = buf?.length ? buf.toString('utf8') : '';
  }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());                                   // ✅ 추가: HttpOnly 쿠키 읽기
// app.use(morgan('combined'));

/* -------------------- 라우트 모듈 -------------------- */
const productRoutes         = require('./routes/productRoutes');
const storeProductRoutes    = require('./routes/storeProductRoutes');
const inventoryRoutes       = require('./routes/inventoryRoutes');
const purchaseRoutes        = require('./routes/purchaseRoutes');
const refundRoutes          = require('./routes/refundRoutes');
const dashboardRoutes       = require('./routes/dashboardRoutes');
const cardInfoRoutes        = require('./routes/cardInfoRoutes');
const dummySalesRoutes      = require('./routes/dummySalesRoutes');
const purchaseSessionRoutes = require('./routes/purchaseSessionRoutes');
const aiInsightRoutes       = require('./routes/aiInsightRoutes');
const { router: authRoutes } = require('./routes/authRoutes');

/* -------------------- 헬스체크 -------------------- */
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

/* ----------- 타임존/시계 디버그(선택) ------------- */
const db = require('./models/db');
app.get('/api/timezonedebug', async (_req, res) => {
  try {
    const [[row]] = await db.query(`
      SELECT
        NOW() AS now_session,
        UTC_TIMESTAMP() AS utc_now,
        CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+09:00') AS kst_now
    `);
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/* -------------------- API 라우팅 -------------------- */
// 인증 라우트를 제일 위쪽에 등록(의존 적음)
app.use('/api/auth',           authRoutes);
app.use('/api/products',          productRoutes);
app.use('/api/store-products',    storeProductRoutes);
app.use('/api/inventory-log',     inventoryRoutes);
app.use('/api/purchases',         purchaseRoutes);
app.use('/api/refunds',           refundRoutes);
app.use('/api/dashboard',         dashboardRoutes);
app.use('/api/card-info',         cardInfoRoutes);
app.use('/api/dummy-sales',       dummySalesRoutes);       // ← POST /generate
app.use('/api/purchase-sessions', purchaseSessionRoutes);
app.use('/api/ai-insight', aiInsightRoutes);

/* -------------------- 라우트 목록 로그 -------------------- */
function printRoutes(app) {
  const out = [];
  (app._router?.stack || []).forEach((m) => {
    if (m.route) {
      const methods = Object.keys(m.route.methods).join(',').toUpperCase();
      out.push(`${methods.padEnd(6)} ${m.route.path}`);
    } else if (m.name === 'router' && m.handle?.stack) {
      const mount = m.regexp && m.regexp.fast_slash ? '' : (m.regexp?.toString() || '');
      m.handle.stack.forEach((h) => {
        if (h.route) {
          const methods = Object.keys(h.route.methods).join(',').toUpperCase();
          out.push(`${methods.padEnd(6)} ${mount} ${h.route.path}`);
        }
      });
    }
  });
  console.log('=== Registered Routes ===');
  out.forEach(r => console.log(r));
  console.log('=========================');
}
printRoutes(app);

/* -------------------- 404 & 에러 -------------------- */
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', method: req.method, path: req.originalUrl });
});
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('🔥 Unhandled error:', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

/* -------------------- 서버 시작 -------------------- */
const server = http.createServer(app);

// WebSocket 서버 열기
const wss = new WebSocket.Server({ server, path: '/ws' });

// 클라이언트 구독 처리
wss.on('connection', (ws) => {
  ws.subscribedSession = null;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      // 세션코드 구독 처리
      if (msg.type === 'SUB' && msg.session_code) {
        ws.subscribedSession = msg.session_code;
        ws.send(JSON.stringify({
          type: 'SUB_OK',
          session_code: ws.subscribedSession,
        }));
      }
    } catch {}
  });
});

// wsHub에 wss 주입
wsHub.init(wss);

// Express + WebSocket 서버 실행
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Express + WS 서버 실행 중: http://0.0.0.0:${PORT}`);
});
