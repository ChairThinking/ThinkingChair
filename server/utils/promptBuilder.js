// server/utils/promptBuilder.js
/**
 * OpenAI에 보낼 "단일 문자열 프롬프트"를 만들어 준다.
 * - 출력은 반드시 JSON 한 덩어리(Object)만 나오도록 강하게 지시
 * - 날짜 분포(전 달 전체 일자), 주말 1.5배, 최소 일 거래수, 거래별 품목 수량/가격 합, 월/전체 합계 ±10% 등 하드 제약 명시
 * - CSV가 아니라 JSON으로만 생성하게 유도
 */
function buildAIPrompt(products, monthlyGoalIn10kWon, durationMonths, options = {}) {
  const monthlyGoalKRW = Math.round(Number(monthlyGoalIn10kWon) * 10000); // 만원 → 원
  const now = new Date();
  // “현재 기준 이전 달부터 durationMonths개월” (ex: 오늘 2025-08-21이면 7월, 6월, 5월…)
  const months = [];
  for (let i = 1; i <= durationMonths; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1); // 이전 i개월의 1일
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    months.push(`${y}-${m}`);
  }
  months.reverse(); // 과거→현재 순

  // 상품 목록(이름/카테고리/가격)을 프롬프트에 명시
  const productLines = products.map(p => {
    // 기대 필드: id, name, category, product_price (원)
    const price = Number(p.product_price || p.price || p.unit_price || p.selling_price || 0);
    return `{"id": ${p.id}, "name": "${p.name}", "category": "${p.category || ""}", "price": ${price}}`;
  }).join(",\n      ");

  // 요약 필드 템플릿
  const monthSummaryTemplate = months.map(m => `"${m}"`).join(", ");

  return `
You are a data generation engine. Produce **only one valid JSON object** and nothing else.

## Store product catalog (use ONLY these products)
products = [
      ${productLines}
]

## Business rules (HARD constraints)
1) Period: generate sales data that covers **all days in each month** for these months: [${months.join(", ")}].
   - For each month m in the list, create transactions for every calendar day (YYYY-MM-DD), not just the 1st.
2) Daily transactions: 
   - On weekdays (Mon–Fri): at least **30** transactions per day.
   - On weekends (Sat, Sun): **1.5x** the weekday count (ceil to integer).
3) Each transaction:
   - Contains **1 to 20 items** (products), picked from 'products' above.
   - Each item has integer quantity ≥ 1.
   - Use realistic unit prices from the product's "price" field.
   - Vary items and quantities; avoid making all quantities == 1.
   - "payment_method" must be exactly: "RFID".
   - "card_id" should look natural and varied per day (e.g., integers across a range); avoid repeating a single card all day.
4) Monthly revenue target per month:
   - Target per month = ${monthlyGoalKRW} KRW.
   - **Monthly total (sum of all transaction totals in that month) must be within ±10% of the target**.
5) Overall total:
   - For the entire period (all months combined), the grand total must be within ±10% of (Target per month × number of months).
6) Timestamp distribution:
   - "purchased_at" must be a full timestamp "YYYY-MM-DD HH:mm:ss".
   - Spread purchases through business hours **08:00:00 to 22:00:00**, random but **strictly ascending within the same day** (no decreasing times).
7) Column semantics:
   - Use these keys in each row of the "purchases" array:
     - "purchased_at" (first), "card_id", "total_price", "payment_method", "store_id"
   - And these keys in "purchase_items":
     - "purchased_at" (same timestamp as its parent), "store_product_id", "quantity", "unit_price", "line_total"
   - Do NOT invent any other columns.
   - "store_id" is always **1**.
8) Relational integrity:
   - Every "purchase_items" row must correspond to an actual product from "products" (use its "id" as "store_product_id").
   - "line_total" must equal quantity × unit_price for that item.
   - A purchase's "total_price" equals the sum of its items' "line_total".
9) Output ordering:
   - Sort both arrays by "purchased_at" ascending (month by month, day by day).
10) If constraints conflict:
   - Prefer to adjust **daily transaction counts** slightly, but you **must** keep monthly totals within ±10%.

## Output format (return ONLY JSON, no markdown, no commentary)
{
  "purchases": [
    {
      "purchased_at": "YYYY-MM-DD HH:mm:ss",
      "card_id": <integer or string id>,
      "total_price": <integer KRW>,
      "payment_method": "RFID",
      "store_id": 1
    },
    ...
  ],
  "purchase_items": [
    {
      "purchased_at": "YYYY-MM-DD HH:mm:ss",
      "store_product_id": <id from products>,
      "quantity": <integer>,
      "unit_price": <integer KRW>,
      "line_total": <integer KRW>
    },
    ...
  ],
  "summary": {
    "monthly_totals": {
      ${monthSummaryTemplate}: <integer KRW>
    },
    "grand_total": <integer KRW>
  }
}

## Critical notes
- Output must be a single JSON object. No prose, no code fences, no extra text.
- Dates must cover **every day** in each month listed.
- Monthly & grand totals must stay within ±10% of the targets.
- Payment method must be "RFID" only.
- Vary "card_id" values across the day; reduce duplicates.
- Within a day, ensure timestamps are strictly increasing (no time going backwards).
`.trim();
}

module.exports = { buildAIPrompt };
