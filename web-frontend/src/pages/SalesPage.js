import { useState, useEffect, useMemo } from "react";
import axios from "axios";
import Sidebar from "../components/Sidebar";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, CartesianGrid, ReferenceLine, Brush
} from "recharts";

function SalesPage() {
  const [salesData, setSalesData] = useState([]);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [summaryData, setSummaryData] = useState({ total_price: 0, total_quantity: 0 });
  const [weeklyData, setWeeklyData] = useState([]);
  const [categoryData, setCategoryData] = useState([]);

  // ✅ 페이지네이션 상태
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(20); // 10/20/50 중 선택 가능

  const commonButtonClass =
    "bg-[#b9e6e6] text-white font-medium px-4 py-2 rounded hover:brightness-110";

  const handleQuickRange = (type) => {
    const today = new Date();
    const format = (d) => d.toISOString().split("T")[0];
    let from = new Date();

    if (type === "오늘") from = today;
    else if (type === "1주일") from.setDate(today.getDate() - 7);
    else if (type === "1개월") from.setMonth(today.getMonth() - 1);
    else if (type === "3개월") from.setMonth(today.getMonth() - 3);

    setFromDate(format(from));
    setToDate(format(today));
  };

  // 🛠 응답 표준화: 백엔드 {items:[...]} → 화면에서 쓰는 필드로 맞춤
  const normalizeSalesItems = (raw) =>
    (raw || []).map((r) => ({
      id: r.id,
      date: r.date || r.purchased_at_kst || r.purchased_at, // 서버 버전에 따라
      name: r.name || r.product_name,
      barcode: r.barcode,
      quantity: Number(r.quantity ?? 0),
      total_price: Number(r.total_price ?? 0),
      method: r.method || r.payment_method || "",
    }));

  const handleSearch = async () => {
    if (!fromDate || !toDate) {
      alert("날짜를 선택해주세요.");
      return;
    }

    try {
      // 테이블용 상세 목록
      const salesRes = await axios.get("/api/purchases", {
        params: { from: fromDate, to: toDate },
      });
      // 백엔드는 { items: [...] } 형태로 응답
      const items = Array.isArray(salesRes.data)
        ? salesRes.data
        : (salesRes.data?.items ?? []);
      setSalesData(normalizeSalesItems(items));

      // 그래프용 날짜별 합계
      const graphRes = await axios.get("/api/purchases/weekly", {
        params: { from: fromDate, to: toDate },
      });
      setWeeklyData(graphRes.data || []);

      setCurrentPage(1); // ✅ 검색하면 1페이지로 리셋

      if ((items || []).length === 0) {
        console.info("선택 기간에 상세 매출 기록이 없습니다.");
      }
    } catch (err) {
      console.error("매출 조회 오류:", err);
      alert("매출 데이터를 불러오지 못했습니다.");
    }
  };

  const formatDate = (isoDate) =>
    isoDate ? new Date(isoDate).toLocaleDateString("ko-KR") : "";
  const formatKRW = (v) => `${Number(v || 0).toLocaleString("ko-KR")} 원`;

  const renderCustomizedLabel = ({
    cx,
    cy,
    midAngle,
    innerRadius,
    outerRadius,
    percent,
  }) => {
    const RADIAN = Math.PI / 180;
    const radius = innerRadius + (outerRadius - innerRadius) * 0.6;
    const x = cx + radius * Math.cos(-midAngle * RADIAN);
    const y = cy + radius * Math.sin(-midAngle * RADIAN);

    return (
      <text
        x={x}
        y={y}
        fill="#333"
        fontSize={12}
        textAnchor="middle"
        dominantBaseline="central"
      >
        {(percent * 100).toFixed(0)}%
      </text>
    );
  };

  useEffect(() => {
    axios.get("/api/purchases/summary").then((res) => setSummaryData(res.data));

    // 최근 7일 (서버에서 기본값 처리)
    axios.get("/api/purchases/weekly").then((res) => setWeeklyData(res.data || []));

    axios.get("/api/purchases/categories").then((res) => {
      const parsed = (res.data || []).map((item) => ({
        ...item,
        total: Number(item.total),
      }));
      setCategoryData(parsed);
    });
  }, []);

  // ✅ 그래프 가독성: 최대값/평균 계산 + Y축 상단 버퍼(+20%)
  const { avgTotal, yMax } = useMemo(() => {
    const totals = (weeklyData || []).map((d) => Number(d.total) || 0);
    const max = totals.length ? Math.max(...totals) : 0;
    const sum = totals.reduce((a, b) => a + b, 0);
    const avg = totals.length ? sum / totals.length : 0;

    const buffered =
      max === 0 ? 10000 : Math.max(1000, Math.ceil((max * 1.2) / 1000) * 1000);

    return { avgTotal: avg, yMax: buffered };
  }, [weeklyData]);

  const totalAmount = salesData.reduce(
    (sum, item) => sum + Number(item.total_price || 0),
    0
  );

  const downloadCSV = () => {
    const header = "판매날짜,상품명,바코드,판매수량,판매가,결제방법\n";
    const rows = salesData
      .map((item) =>
        [
          formatDate(item.date),
          item.name,
          item.barcode,
          item.quantity,
          Number(item.total_price).toLocaleString(),
          item.method ?? "",
        ].join(",")
      )
      .join("\n");

    const csvContent = "\uFEFF" + header + rows;
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", "sales_data.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const COLORS = ["#8884d8", "#82ca9d", "#ffc658", "#ff8042", "#00C49F"];

  // X축 레이블 간격 자동 조절
  const xLabelInterval =
    weeklyData.length > 0 ? Math.ceil(weeklyData.length / 8) : 0;

  // 'YYYY-MM-DD' → 'MM-DD' (툴팁/축 공용)
  const trimDate = (s) =>
    typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.slice(5) : s;

  // =========================
  // ✅ 페이지네이션 계산 로직
  // =========================
  const { totalPages, pagedData, startIdx, endIdx } = useMemo(() => {
    const totalPages = Math.max(1, Math.ceil(salesData.length / pageSize));
    const safePage = Math.min(Math.max(1, currentPage), totalPages);
    const start = (safePage - 1) * pageSize;
    const end = Math.min(start + pageSize, salesData.length);
    return {
      totalPages,
      pagedData: salesData.slice(start, end),
      startIdx: start + 1,
      endIdx: end,
    };
  }, [salesData, currentPage, pageSize]);

  // 페이지 버튼 (이웃 2개 + 처음/끝)
  const getPageButtons = () => {
    const pages = [];
    const neighbors = 2;
    const left = Math.max(1, currentPage - neighbors);
    const right = Math.min(totalPages, currentPage + neighbors);

    if (left > 1) pages.push(1);
    if (left > 2) pages.push("left-ellipsis");

    for (let p = left; p <= right; p++) pages.push(p);

    if (right < totalPages - 1) pages.push("right-ellipsis");
    if (right < totalPages) pages.push(totalPages);

    return pages;
  };

  return (
    <div className="flex min-h-screen">
      <div className="w-[12vw] min-w-[140px] max-w-[200px] bg-white shadow-md">
        <Sidebar />
      </div>

      <main className="flex-1 bg-[#e9f0ff] px-[4vw] py-[3vw] overflow-y-auto">
        <h2 className="text-2xl font-bold text-gray-800 mb-8">매출관리</h2>

        <section className="mb-8">
          <h3 className="text-lg font-semibold text-gray-700 mb-4">
            매출 및 판매내역 조회
          </h3>
          <div className="bg-white p-6 rounded-lg shadow">
            <div className="flex flex-wrap gap-4 mb-4">
              {["오늘", "1주일", "1개월", "3개월"].map((label) => (
                <button
                  key={label}
                  onClick={() => handleQuickRange(label)}
                  className={commonButtonClass}
                >
                  {label}
                </button>
              ))}
              <input
                type="date"
                className="border px-3 py-2 rounded"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
              />
              <span>~</span>
              <input
                type="date"
                className="border px-3 py-2 rounded"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
              />
              <button onClick={handleSearch} className={commonButtonClass}>
                검색
              </button>
            </div>
          </div>
        </section>

        {salesData.length === 0 && (
          <section className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="bg-white p-6 rounded-lg shadow text-center">
              <p className="text-base text-gray-500 mb-2">매출액</p>
              <p className="text-4xl font-bold text-gray-900">
                {Number(summaryData.total_price).toLocaleString()} 원
              </p>
            </div>
            <div className="bg-white p-6 rounded-lg shadow text-center">
              <p className="text-base text-gray-500 mb-2">판매수량</p>
              <p className="text-4xl font-bold text-gray-900">
                {Number(summaryData.total_quantity).toLocaleString()} 개
              </p>
            </div>
            <div className="bg-white p-6 rounded-lg shadow text-center">
              <p className="text-base text-gray-500 mb-2">
                상품 분류별 판매현황
              </p>
              {categoryData.length > 0 ? (
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Pie
                      data={categoryData}
                      dataKey="total"
                      nameKey="category"
                      cx="50%"
                      cy="50%"
                      outerRadius={90}
                      label={renderCustomizedLabel}
                      labelLine={false}
                    >
                      {categoryData.map((_, index) => (
                        <Cell
                          key={`cell-${index}`}
                          fill={COLORS[index % COLORS.length]}
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value) => `${Number(value).toLocaleString()} 원`}
                    />
                    <Legend verticalAlign="bottom" height={36} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-sm text-gray-400">데이터 없음</p>
              )}
            </div>
          </section>
        )}

        <section className="mt-10 bg-white p-6 rounded-lg shadow">
          <h3 className="text-lg font-semibold mb-4">
            {salesData.length > 0 ? "선택한 기간의 매출 추이" : "최근 일주일 매출 추이"}
          </h3>

          <ResponsiveContainer width="100%" height={300}>
            <BarChart
              data={weeklyData}
              margin={{ top: 10, right: 30, left: 0, bottom: 5 }}
              barCategoryGap={10}
              maxBarSize={22}
            >
              <defs>
                <linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#8884d8" stopOpacity={0.95} />
                  <stop offset="100%" stopColor="#8884d8" stopOpacity={0.7} />
                </linearGradient>
              </defs>

              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 12 }}
                interval={xLabelInterval}
                tickFormatter={trimDate}
              />
              <YAxis
                tick={{ fontSize: 12 }}
                domain={[0, yMax]}
                tickFormatter={(v) =>
                  v >= 1000 ? `${Math.round(v / 1000)}k` : v
                }
              />
              <Tooltip
                formatter={(value) => [formatKRW(value), "total"]}
                labelFormatter={(label) => trimDate(label)}
                cursor={{ fill: "rgba(0,0,0,0.04)" }}
              />

              {avgTotal > 0 && (
                <ReferenceLine
                  y={avgTotal}
                  stroke="#9aa4b2"
                  strokeDasharray="5 5"
                  label={{
                    value: `평균 ${formatKRW(Math.round(avgTotal))}`,
                    position: "right",
                    fill: "#6b7280",
                    fontSize: 12,
                  }}
                />
              )}

              <Bar dataKey="total" fill="url(#barGradient)" radius={[6, 6, 0, 0]} />

              {weeklyData.length > 20 && (
                <Brush
                  dataKey="date"
                  height={24}
                  travellerWidth={10}
                  stroke="#c7c9ff"
                />
              )}
            </BarChart>
          </ResponsiveContainer>
        </section>

        {salesData.length > 0 && (
          <section className="mt-10 bg-white p-6 rounded-lg shadow">
            {/* 헤더 + 페이지 크기 선택 */}
            <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
              <p className="text-gray-700 font-semibold">
                총 {salesData.length}건
              </p>
              <div className="flex items-center gap-4">
                <label className="text-sm text-gray-600">
                  페이지 크기:&nbsp;
                  <select
                    className="border rounded px-2 py-1"
                    value={pageSize}
                    onChange={(e) => {
                      setPageSize(Number(e.target.value));
                      setCurrentPage(1);
                    }}
                  >
                    <option value={10}>10</option>
                    <option value={20}>20</option>
                    <option value={50}>50</option>
                  </select>
                </label>
                <p className="text-gray-700 font-semibold">
                  합계 {totalAmount.toLocaleString()} 원
                </p>
                <button
                  onClick={downloadCSV}
                  className="bg-green-500 text-white font-medium px-4 py-2 rounded hover:bg-green-600"
                >
                  CSV 파일 다운로드
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-full text-sm text-left text-gray-700 border-t">
                <thead className="bg-gray-100 border-b sticky top-0">
                  <tr>
                    <th className="px-4 py-2">판매날짜</th>
                    <th className="px-4 py-2">상품명</th>
                    <th className="px-4 py-2">바코드</th>
                    <th className="px-4 py-2">판매수량</th>
                    <th className="px-4 py-2">판매가</th>
                    <th className="px-4 py-2">결제방법</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedData.map((item, idx) => (
                    <tr key={`${item.id}-${idx}`} className="border-b hover:bg-gray-50">
                      <td className="px-4 py-2">{formatDate(item.date)}</td>
                      <td className="px-4 py-2">{item.name}</td>
                      <td className="px-4 py-2">{item.barcode}</td>
                      <td className="px-4 py-2">
                        {Number(item.quantity).toLocaleString()} 개
                      </td>
                      <td className="px-4 py-2">
                        {Number(item.total_price).toLocaleString()} 원
                      </td>
                      <td className="px-4 py-2">{item.method ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* ✅ 페이지네이션 컨트롤 */}
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 mt-4">
              <p className="text-sm text-gray-600">
                {salesData.length === 0
                  ? "표시할 데이터가 없습니다."
                  : `${startIdx.toLocaleString()}–${endIdx.toLocaleString()} / ${salesData.length.toLocaleString()} 건`}
              </p>

              <div className="flex items-center gap-1">
                <button
                  className="px-3 py-1 rounded border hover:bg-gray-50 disabled:opacity-40"
                  onClick={() => setCurrentPage(1)}
                  disabled={currentPage === 1}
                >
                  « 처음
                </button>
                <button
                  className="px-3 py-1 rounded border hover:bg-gray-50 disabled:opacity-40"
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                >
                  ‹ 이전
                </button>

                {getPageButtons().map((p, i) =>
                  typeof p === "number" ? (
                    <button
                      key={i}
                      className={`px-3 py-1 rounded border ${
                        currentPage === p
                          ? "bg-[#b9e6e6] text-white border-[#b9e6e6]"
                          : "hover:bg-gray-50"
                      }`}
                      onClick={() => setCurrentPage(p)}
                    >
                      {p}
                    </button>
                  ) : (
                    <span key={i} className="px-2 text-gray-400">
                      …
                    </span>
                  )
                )}

                <button
                  className="px-3 py-1 rounded border hover:bg-gray-50 disabled:opacity-40"
                  onClick={() =>
                    setCurrentPage((p) => Math.min(totalPages, p + 1))
                  }
                  disabled={currentPage === totalPages}
                >
                  다음 ›
                </button>
                <button
                  className="px-3 py-1 rounded border hover:bg-gray-50 disabled:opacity-40"
                  onClick={() => setCurrentPage(totalPages)}
                  disabled={currentPage === totalPages}
                >
                  끝 »
                </button>
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

export default SalesPage;
