// app.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
// const morgan = require('morgan');

const app = express();

/* -------------------- 기본 설정 -------------------- */
const PORT = process.env.PORT || 4000;
app.set('trust proxy', 1);

/* -------------------- 미들웨어 -------------------- */
// ✅ rawBody를 별도 미들웨어로 읽지 말고, express.json의 verify로 보존
app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(compression());

// ⚠️ 여기서 JSON 바디를 반드시 라우트 등록 "전에" 파싱해야 함
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => {
    // 필요하면 원문 바디도 보존
    req.rawBody = buf?.length ? buf.toString('utf8') : '';
  }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
// app.use(morgan('combined'));

/* -------------------- 라우트 모듈 -------------------- */
const productRoutes         = require('./routes/productRoutes');
const storeProductRoutes    = require('./routes/storeProductRoutes');
const inventoryRoutes       = require('./routes/inventoryRoutes');
// const prepaymentRoutes   = require('./routes/prepaymentRoutes');
const purchaseRoutes        = require('./routes/purchaseRoutes');
const refundRoutes          = require('./routes/refundRoutes');
const dashboardRoutes       = require('./routes/dashboardRoutes');
const cardInfoRoutes        = require('./routes/cardInfoRoutes');
const dummySalesRoutes      = require('./routes/dummySalesRoutes');
const purchaseSessionRoutes = require('./routes/purchaseSessionRoutes');

/* -------------------- 헬스체크 -------------------- */
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

/* -------------------- API 라우팅 -------------------- */
app.use('/api/products',          productRoutes);
app.use('/api/store-products',    storeProductRoutes);
app.use('/api/inventory-log',     inventoryRoutes);
// app.use('/api/prepayments',     prepaymentRoutes);
app.use('/api/purchases',         purchaseRoutes);
app.use('/api/refunds',           refundRoutes);
app.use('/api/dashboard',         dashboardRoutes);
app.use('/api/card-info',         cardInfoRoutes);
app.use('/api/dummy-sales',       dummySalesRoutes);       // ← 여기로 POST /generate
app.use('/api/purchase-sessions', purchaseSessionRoutes);

/* -------------------- 라우트 목록 로그 -------------------- */
function printRoutes(app) {
  const out = [];
  (app._router?.stack || []).forEach((m) => {
    if (m.route) {
      const methods = Object.keys(m.route.methods).join(',').toUpperCase();
      out.push(`${methods.padEnd(6)} ${m.route.path}`);
    } else if (m.name === 'router' && m.handle?.stack) {
      // 마운트 경로 표시
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
app.use((err, req, res, _next) => {
  console.error('🔥 Unhandled error:', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

/* -------------------- 서버 시작 -------------------- */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Express 서버 실행 중: http://0.0.0.0:${PORT}`);
});
