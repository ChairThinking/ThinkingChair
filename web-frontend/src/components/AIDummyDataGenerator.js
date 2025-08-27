import React, { useState } from 'react';

const AIDummyDataGenerator = () => {
  // 💡 입력은 문자열로 관리(숫자만, 선행 0 제거). 표시/동작 모두 자연스럽게.
  const [salesTargetStr, setSalesTargetStr] = useState("100"); // "100"(만원) → 1,000,000원
  const [datePeriod, setDatePeriod] = useState(1);             // 1/3/5/7 개월
  const [isGenerating, setIsGenerating] = useState(false);

  const toCSV = (rows) => {
    if (!rows || rows.length === 0) return "";
    const headers = Object.keys(rows[0]);
    const esc = (v) => {
      if (v === null || v === undefined) return "";
      const s = String(v).replace(/"/g, '""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    };
    const head = headers.join(",");
    const body = rows.map(r => headers.map(h => esc(r[h])).join(",")).join("\n");
    return head + "\n" + body;
  };

  const download = (text, filename) => {
    const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  const generateData = async () => {
    setIsGenerating(true);
    try {
      const monthlyGoalIn10kWon = parseInt(salesTargetStr || "0", 10);
      if (!monthlyGoalIn10kWon || ![1,3,5,7].includes(Number(datePeriod))) {
        throw new Error("월 매출 목표(만원)와 기간(1/3/5/7개월)을 올바르게 입력하세요.");
      }

      const body = {
        monthlyGoalIn10kWon,
        durationMonths: Number(datePeriod),
      };

      const res = await fetch("/api/dummy-sales/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`서버 오류: ${res.status}${errText ? ` - ${errText}` : ""}`);
      }

      const result = await res.json();

      // purchases(데이터) → CSV
      const purchasesCsvRows = result.purchases.map(row => ({
        purchased_at: row.purchased_at,              // 첫 번째 열
        store_product_id: row.store_product_id,
        card_id: row.card_id,
        quantity: row.quantity,
        unit_price: row.unit_price,
        total_price: row.total_price,
        payment_method: row.payment_method,
        store_id: row.store_id,
      }));

      let csv = toCSV(purchasesCsvRows);

      // 한 파일에 요약도 함께 추가
      csv += "\n\n=== MONTHLY_SUMMARY ===\n";
      csv += "month,monthly_total_won\n";
      Object.entries(result.monthlySummary || {}).forEach(([m, won]) => {
        csv += `${m},${won}\n`;
      });
      csv += `TOTAL,${result.grandTotal ?? 0}\n`;

      const nowStr = new Date().toISOString().slice(0,19).replace(/[-:T]/g,"");
      download(csv, `dummy_sales_${nowStr}.csv`);
      alert("더미 데이터 생성 완료 (CSV 1개 저장)");
    } catch (err) {
      alert("데이터 생성 실패: " + err.message);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="bg-white p-4 rounded shadow">
      <div className="flex flex-wrap gap-4 mb-4">
        <div>
          <label className="block mb-1">📈 월 매출 목표 (만원)</label>
          <input
            // ⬇️ number → text 로 변경, 모바일 숫자 키패드 유지
            type="text"
            inputMode="numeric"
            value={salesTargetStr}
            onChange={(e) => {
              // 숫자만 허용
              let v = e.target.value.replace(/\D/g, "");
              // 선행 0 제거(빈값은 그대로 허용)
              if (v !== "") v = v.replace(/^0+/, "");
              setSalesTargetStr(v);
            }}
            placeholder="예: 300"
            className="p-2 rounded border"
          />
        </div>
        <div>
          <label className="block mb-1">📅 데이터 기간 (개월)</label>
          <select
            value={datePeriod}
            onChange={(e) => setDatePeriod(Number(e.target.value))}
            className="p-2 rounded border"
          >
            <option value={1}>1개월</option>
            <option value={3}>3개월</option>
            <option value={5}>5개월</option>
            <option value={7}>7개월</option>
          </select>
        </div>
      </div>

      <button
        onClick={generateData}
        disabled={isGenerating}
        className="bg-blue-600 text-white px-6 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
      >
        {isGenerating ? "생성 중..." : "🚀 더미 데이터 생성 및 다운로드"}
      </button>
    </div>
  );
};

export default AIDummyDataGenerator;
