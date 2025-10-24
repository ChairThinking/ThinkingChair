// src/components/AIDummyDataGenerator.js
import React, { useState } from "react";

const AIDummyDataGenerator = () => {
  const [salesTargetStr, setSalesTargetStr] = useState("100"); // 만원 단위
  const [datePeriod, setDatePeriod] = useState(1); // 1,3,5,7개월
  const [uidsText, setUidsText] = useState(
    "04032FDC300289, 04B36A33300289"
  );
  const [isGenerating, setIsGenerating] = useState(false);

  // CSV 변환
  const toCSV = (rows) => {
    if (!rows || rows.length === 0) return "";
    const header = Object.keys(rows[0]).join(",");
    const body = rows
      .map((row) =>
        Object.values(row)
          .map((v) =>
            typeof v === "string" && v.includes(",") ? `"${v}"` : v
          )
          .join(",")
      )
      .join("\n");

    return header + "\n" + body;
  };

  // CSV 다운로드
  const download = (text, filename) => {
    const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.setAttribute("download", filename);
    document.body.appendChild(a);
    a.click();

    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // 더미 데이터 생성 요청
  const generateData = async () => {
    if (isGenerating) return;
    setIsGenerating(true);

    try {
      // "100"(만원) → 100 * 10000 = 1,000,000원
      const monthlyTargetWon = Number(salesTargetStr) * 10000;

      // "a,b,c" → ["a","b","c"]
      const uidList = uidsText
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      const res = await fetch(
        `${import.meta.env.VITE_API_BASE || "http://localhost:4000"}/api/ai/generate-dummy-sales`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetMonthlySales: monthlyTargetWon,
            periodMonths: datePeriod,
            uids: uidList,
          }),
        }
      );

      if (!res.ok) {
        console.error("더미 데이터 생성 실패:", res.status);
        return;
      }

      const data = await res.json();
      const csvText = toCSV(data.rows || []);
      download(csvText, "dummy_sales_data.csv");
    } catch (err) {
      console.error("요청 중 에러:", err);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* 1. 월 매출 목표 */}
      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm font-semibold text-gray-700">
          <span role="img" aria-label="money">💸</span>
          월 매출 목표 (만원)
        </label>

        <input
          type="number"
          min={1}
          className="border rounded px-3 py-2 text-sm w-32"
          value={salesTargetStr}
          onChange={(e) => {
            // 숫자만 허용, 앞의 0들 제거
            const raw = e.target.value.replace(/[^0-9]/g, "");
            const normalized = raw.replace(/^0+/, "") || "0";
            setSalesTargetStr(normalized);
          }}
        />

        <p className="text-xs text-gray-500 leading-relaxed">
          예) 100 → 약 1,000,000원 목표 매출
        </p>
      </div>

      {/* 2. 기간 선택 */}
      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm font-semibold text-gray-700">
          <span role="img" aria-label="calendar">📅</span>
          데이터 기간 (개월)
        </label>

        <select
          className="border rounded px-3 py-2 text-sm w-32"
          value={datePeriod}
          onChange={(e) => setDatePeriod(Number(e.target.value))}
        >
          <option value={1}>1개월</option>
          <option value={3}>3개월</option>
          <option value={5}>5개월</option>
          <option value={7}>7개월</option>
        </select>

        <p className="text-xs text-gray-500 leading-relaxed">
          선택한 개월 수 동안의 거래 로그를 합성해줄 거야.
        </p>
      </div>

      {/* 3. UID 목록 */}
      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm font-semibold text-gray-700">
          <span role="img" aria-label="card">🪪</span>
          UID 목록 (비워도 됨)
        </label>

        <textarea
          rows={3}
          className="border rounded px-3 py-2 text-sm w-full"
          value={uidsText}
          onChange={(e) => setUidsText(e.target.value)}
        />

        <p className="text-xs text-gray-500 leading-relaxed">
          쉼표(,)로 구분: 04032FDC300289, 04B36A33300289
          <br />
          비워두면 서버가 가짜 UID를 생성해.
        </p>
      </div>

      {/* 실행 버튼 */}
      <div>
        <button
          onClick={generateData}
          disabled={isGenerating}
          className="bg-blue-600 text-white px-6 py-2 rounded text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
        >
          {isGenerating ? "생성 중..." : "🚀 더미 데이터 생성 및 다운로드"}
        </button>
      </div>
    </div>
  );
};

export default AIDummyDataGenerator;
