// api-server/routes/aiInsightRoutes.js
const express = require('express');
const router = express.Router();
const pool = require('../models/db');
const OpenAI = require('openai');
require('dotenv').config();

/** 대상 기간 계산 (기본: 다음달) */
function getTargetPeriod(q) {
  if (q?.period && /^\d{4}-\d{2}$/.test(q.period)) {
    const [y, m] = q.period.split('-').map(Number);
    return { year: y, month: m };
  }
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const next = new Date(Date.UTC(y, m, 1));
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1 };
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * 최근 매출 요약을 DB에서 뽑아오기
 * 🔧 변경점:
 *  - 상품명은 store_products가 아니라 products에 있다고 가정 → products를 JOIN하고 pr.name 사용
 *  - 만약 컬럼명이 다르면 아래 pr.name을 pr.product_name 등으로 바꿔주세요.
 */
async function getSalesSummaryFromDB() {
  // 최근 3개월 베스트
  const [topSold] = await pool.query(`
    SELECT
      sp.id AS product_id,
      pr.name AS name,                         -- ✅ 상품명은 products에서
      SUM(p.quantity) AS total_qty,
      SUM(p.total_price) AS total_revenue
    FROM purchases p
    JOIN store_products sp ON sp.id = p.store_product_id
    JOIN products pr ON pr.id = sp.product_id -- ✅ JOIN 추가
    WHERE p.created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 MONTH)
    GROUP BY sp.id, pr.name
    ORDER BY total_qty DESC
    LIMIT 15
  `);

  // 최근 1개월 vs 직전 1개월 증감
  const [trend] = await pool.query(`
    SELECT
      t.product_id,
      t.name,
      t.qty_recent,
      t.qty_prev,
      CASE
        WHEN t.qty_prev = 0 THEN 100
        ELSE ROUND(((t.qty_recent - t.qty_prev) / t.qty_prev) * 100, 1)
      END AS growth_pct
    FROM (
      SELECT
        sp.id AS product_id,
        pr.name AS name,  -- ✅ 동일하게 products에서 이름
        SUM(CASE WHEN p.created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MONTH)
                 THEN p.quantity ELSE 0 END) AS qty_recent,
        SUM(CASE
              WHEN p.created_at <  DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MONTH)
               AND p.created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 MONTH)
             THEN p.quantity ELSE 0 END) AS qty_prev
      FROM purchases p
      JOIN store_products sp ON sp.id = p.store_product_id
      JOIN products pr ON pr.id = sp.product_id
      WHERE p.created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 2 MONTH)
      GROUP BY sp.id, pr.name
    ) t
    ORDER BY growth_pct DESC
    LIMIT 10
  `);

  return { topSold, trend };
}

/** OpenAI로 인사이트 생성 */
async function generateInsightText({ summary, period }) {
  const sys = `당신은 소매점 매출/재고 컨설턴트입니다. 한국어로 간결하고 실용적인 제안을 해주세요.`;
  const user = `
다음은 최근 매출 요약 데이터입니다. 이를 참고해
"${period.year}년 ${period.month}월" 입고 전략, 재고 증감 추천, 주말/평일 운영 팁을 제안하세요.

데이터(JSON):
${JSON.stringify(summary, null, 2)}

출력 형식(마크다운):
- 요약: (한 문장)
- 추천 상품: (3~5개, 각각 사유/예상 효과)
- 트렌드: (증가/감소 품목 간단 언급)
- 액션 아이템: (입고 수량/주문 타이밍/진열 팁 3~5개)
- 점주에게: (자연스러운 한 문장 제안, 예: "다음달에는 ○○ 상품의 입고 수량을 30% 늘려보는 게 좋겠습니다.")
`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.7,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ],
  });

  return resp.choices?.[0]?.message?.content?.trim() || '결과를 생성하지 못했습니다.';
}

/**
 * GET /api/ai-insight/insight
 *  - ?period=YYYY-MM (옵션, 없으면 다음달)
 *  - ?force=true 캐시 무시 재생성
 */
router.get('/insight', async (req, res) => {
  try {
    const { year, month } = getTargetPeriod(req.query);
    const useCache = req.query.force !== 'true';

    // 캐시 조회
    if (useCache) {
      const [[cached]] = await pool.query(
        `SELECT content, created_at
           FROM ai_insights
          WHERE scope='store' AND period_year=? AND period_month=?`,
        [year, month]
      );
      if (cached) {
        return res.json({
          ok: true,
          period: { year, month },
          cached: true,
          insight: cached.content,
          created_at: cached.created_at,
        });
      }
    }

    // DB 요약
    const summary = await getSalesSummaryFromDB();

    // OpenAI 생성
    const content = await generateInsightText({ summary, period: { year, month } });

    // 캐시 저장
    try {
      await pool.query(
        `INSERT INTO ai_insights (scope, period_year, period_month, content)
         VALUES ('store', ?, ?, ?)
         ON DUPLICATE KEY UPDATE content=VALUES(content), created_at=CURRENT_TIMESTAMP`,
        [year, month, content]
      );
    } catch (e) {
      console.warn('AI insight cache save failed:', e.message);
    }

    res.json({
      ok: true,
      period: { year, month },
      cached: false,
      insight: content,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

module.exports = router;
