// server/services/openaiService.js
/**
 * OpenAI 호출 유틸
 * - JSON만 받도록 response_format 강제
 * - 모델/샘플링/토큰 안전값 기본 설정
 * - JSON 파싱 실패 시, 마지막 수단으로 대괄호/중괄호 범위 추출 시도
 */
const OpenAI = require("openai");
const { buildAIPrompt } = require("../utils/promptBuilder");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 가능한 모델: gpt-4o-mini, gpt-4.1-mini 등(JSON 응답 보장)
// gpt-3.5-turbo는 response_format 미지원 → JSON 깨질 확률 높음
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

async function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    // 마지막 수단: 가장 바깥 { ... } 덩어리만 추출
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const sliced = text.slice(start, end + 1);
      return JSON.parse(sliced);
    }
    throw new Error("JSON 파싱 실패");
  }
}

/**
 * @param {Array<{id:number,name:string,category?:string,product_price?:number}>} products
 * @param {number} monthlyGoalIn10kWon  (만원)
 * @param {number} durationMonths       (1|3|5|7)
 */
exports.generateDummySalesWithOpenAI = async (products, monthlyGoalIn10kWon, durationMonths) => {
  const prompt = buildAIPrompt(products, monthlyGoalIn10kWon, durationMonths);

  // Responses API (SDK v5) — chat.completions도 가능하지만 JSON 강제 위해 responses가 더 안전
  const res = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.25,        // 수치 엄수 위해 낮춤
    top_p: 0.9,
    // JSON만 달라고 강하게 요청 (지원 모델이어야 작동)
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are a strict JSON generator. Return one valid JSON object only. Never include commentary or code fences.",
      },
      { role: "user", content: prompt },
    ],
    // 분량 많을 수 있으니 토큰 상향 (필요 시 조정)
    max_tokens: 200000, // 서버에서 모델 지원 한도 내로 자동 컷; 과도할 때는 16k~100k로 조정
  });

  const text = res.choices?.[0]?.message?.content || "";
  if (!text) throw new Error("OpenAI 응답이 비었습니다.");

  const parsed = await safeParseJson(text);

  // 간단한 구조 검증
  if (!parsed.purchases || !parsed.purchase_items || !parsed.summary) {
    throw new Error("JSON 구조가 올바르지 않습니다.(purchases/purchase_items/summary)");
  }
  if (!parsed.summary.monthly_totals || typeof parsed.summary.grand_total !== "number") {
    throw new Error("summary 구조가 올바르지 않습니다.(monthly_totals/grand_total)");
  }

  return parsed;
};
