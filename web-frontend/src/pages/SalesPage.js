import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import Sidebar from "../components/Sidebar";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
  Brush,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";

const CATEGORY_PALETTE = [
    "#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
    "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf"
  ];

/* 날짜 유틸(로컬 달력) */
const pad2 = (n) => String(n).padStart(2, "0");
const ymd = (d) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

export default function SalesPage() {
  // 검색 기간
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  // “조회 전/후” 화면 전환 플래그
  const [hasSearched, setHasSearched] = useState(false);

  // 개요(초기 화면) 데이터
  const [overviewSummary, setOverviewSummary] = useState({
    total_price: 0,
    total_quantity: 0,
  });
  const [overviewWeekly, setOverviewWeekly] = useState([]);
  const [overviewCategory, setOverviewCategory] = useState([]);

  // 조회 결과 데이터(그래프/표/요약)
  const [weekly, setWeekly] = useState([]);
  const [items, setItems] = useState([]);

  const categoryColorMap = useMemo(() => {
  const names = [...new Set((overviewCategory || []).map(d => d.category))].sort();
  const map = {};
  names.forEach((name, i) => (map[name] = CATEGORY_PALETTE[i % CATEGORY_PALETTE.length]));
  return map;
}, [overviewCategory]);

  // 테이블 페이지네이션
  const [pageSize, setPageSize] = useState(20);
  const [currentPage, setCurrentPage] = useState(1);

  const commonBtn =
    "bg-[#b9e6e6] text-white font-medium px-4 py-2 rounded hover:brightness-110";

  const formatKRW = (v) => `${Number(v || 0).toLocaleString("ko-KR")} 원`;
  const formatDate = (iso) =>
    iso ? new Date(iso).toLocaleDateString("ko-KR") : "";

  /* ======================
     초기 개요 데이터 로딩
     ====================== */
  const fetchOverview = async () => {
    try {
      // 파라미터 없이: 최근 1주일 그래프, 전체 누적 요약/카테고리(백엔드 기본 동작)
      const [sumRes, weekRes, catRes] = await Promise.all([
        axios.get("/api/purchases/summary"),
        axios.get("/api/purchases/weekly"),
        axios.get("/api/purchases/categories"),
      ]);
      setOverviewSummary(sumRes.data || { total_price: 0, total_quantity: 0 });
      setOverviewWeekly(weekRes.data || []);
      setOverviewCategory(
        (catRes.data || []).map((v) => ({ ...v, total: Number(v.total) }))
      );
    } catch (e) {
      console.error("개요 데이터 불러오기 오류:", e);
    }
  };

  useEffect(() => {
    fetchOverview();
  }, []);

  /* ======================
     검색(조회 후 화면)
     ====================== */
  const fetchSales = async (from, to) => {
    if (!from || !to) {
      alert("조회할 기간을 선택해주세요.");
      return;
    }
    try {
      const [listRes, weekRes] = await Promise.all([
        axios.get("/api/purchases", { params: { from, to} }),
        axios.get("/api/purchases/weekly", { params: { from, to } }),
      ]);
      const listItems = Array.isArray(listRes.data)
        ? listRes.data
        : listRes.data?.items ?? [];
      setItems(listItems);
      setWeekly(weekRes.data || []);
      setHasSearched(true);
      setCurrentPage(1);
    } catch (e) {
      console.error("매출 조회 오류:", e);
      alert("매출 데이터를 불러오지 못했습니다.");
    }
  };

  /* ======================
     빠른범위 버튼: 날짜만 세팅
     ====================== */
  const handleQuickRange = (type) => {
    const today = new Date();
    let from = new Date(today);
    if (type === "1주일") from.setDate(today.getDate() - 6);       // 오늘 포함 7일
    else if (type === "1개월") from.setMonth(today.getMonth() - 1);
    else if (type === "3개월") from.setMonth(today.getMonth() - 3);
    // “오늘”은 그대로 같은 날짜
    setFromDate(ymd(from));
    setToDate(ymd(today));
  };

  /* ======================
     그래프 보조 계산
     ====================== */
  const chartData = hasSearched ? weekly : overviewWeekly;
  const avgTotal = useMemo(() => {
    const totals = (chartData || []).map((d) => Number(d.total) || 0);
    return totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : 0;
  }, [chartData]);

  const yMax = useMemo(() => {
    const m = Math.max(0, ...chartData.map((d) => Number(d.total) || 0));
    return m === 0 ? 10000 : Math.ceil((m * 1.2) / 1000) * 1000;
  }, [chartData]);

  /* ======================
     페이징
     ====================== */
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const start = (safePage - 1) * pageSize;
  const end = Math.min(start + pageSize, items.length);
  const pageRows = items.slice(start, end);

  /* ======================
     렌더
     ====================== */
  return (
    <div className="flex min-h-screen">
      <div className="w-[12vw] min-w-[140px] max-w-[200px] bg-white shadow-md">
        <Sidebar />
      </div>

      <main className="flex-1 bg-[#e9f0ff] px-[4vw] py-[3vw] overflow-y-auto">
        <h2 className="text-2xl font-bold text-gray-800 mb-6">매출관리</h2>

        {/* 검색 바 */}
        <div className="bg-white p-6 rounded-lg shadow mb-6">
          <h3 className="text-lg font-semibold text-gray-700 mb-4">
            매출 및 판매내역 조회
          </h3>
          <div className="flex flex-wrap items-center gap-3">
            {["오늘", "1주일", "1개월", "3개월"].map((t) => (
              <button key={t} onClick={() => handleQuickRange(t)} className={commonBtn}>
                {t}
              </button>
            ))}
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="border rounded px-3 py-2"
            />
            <span>~</span>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="border rounded px-3 py-2"
            />
            <button onClick={() => fetchSales(fromDate, toDate)} className={commonBtn}>
              검색
            </button>
          </div>
        </div>

        {/* =======================
            조회 전(개요) 화면
           ======================= */}
        {!hasSearched && (
          <>
            {/* 카드 2 + 도넛 ― “깔끔하게” 정리 */}
            <section className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
              {/* 매출액 */}
              <div className="relative bg-white p-8 rounded-2xl shadow-sm border border-gray-200">
                {/* 우상단 뱃지(₩) */}
                <span className="absolute top-4 right-4 w-8 h-8 rounded-full bg-indigo-50 text-indigo-600 grid place-items-center text-sm font-bold">
                  ₩
                </span>

                <p className="text-gray-600 text-sm font-semibold">매출액</p>

                <div className="mt-2">
                  <span className="text-5xl font-extrabold tracking-tight text-gray-900">
                    {Number(overviewSummary.total_price || 0).toLocaleString()}
                  </span>
                  <span className="ml-1 text-lg text-gray-400 align-top">원</span>
                </div>

                {/* 카드 하단 구분선 + 서브텍스트 */}
                <div className="mt-6 border-t border-gray-100 pt-3">
                  <p className="text-xs text-gray-400">최근 집계 기준</p>
                </div>
              </div>

              {/* 판매수량 */}
              <div className="relative bg-white p-8 rounded-2xl shadow-sm border border-gray-200">
                {/* 우상단 뱃지(아이콘 사각형 느낌) */}
                <span className="absolute top-4 right-4 w-8 h-8 rounded-full bg-emerald-50 text-emerald-600 grid place-items-center text-[11px] font-bold">
                  ■
                </span>

                <p className="text-gray-600 text-sm font-semibold">판매수량</p>

                <div className="mt-2">
                  <span className="text-5xl font-extrabold tracking-tight text-gray-900">
                    {Number(overviewSummary.total_quantity || 0).toLocaleString()}
                  </span>
                  <span className="ml-1 text-lg text-gray-400 align-top">개</span>
                </div>

                <div className="mt-6 border-t border-gray-100 pt-3">
                  <p className="text-xs text-gray-400">최근 집계 기준</p>
                </div>
              </div>

              {/* 상품 분류별 판매현황 */}
              <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-gray-800 text-base font-extrabold">상품 분류별 판매현황</p>
                  <span className="text-xs text-gray-400">
                    합계 {Number(overviewCategory.reduce((s, v) => s + Number(v.total || 0), 0)).toLocaleString()} 원
                  </span>
                </div>

                {overviewCategory.length > 0 ? (
                  <ResponsiveContainer width="100%" height={280}>
  <PieChart>
    <Pie
      data={overviewCategory}
      dataKey="total"
      nameKey="category"
      cx="50%"
      cy="46%"
      innerRadius={68}
      outerRadius={108}
      paddingAngle={2}
      cornerRadius={3}
      labelLine={false}
      // ✅ 모든 퍼센트 라벨 표시
      label={({ cx, cy, midAngle, innerRadius, outerRadius, percent }) => {
        const RAD = Math.PI / 180;
        const r = innerRadius + (outerRadius - innerRadius) * 0.62;
        const x = cx + r * Math.cos(-midAngle * RAD);
        const y = cy + r * Math.sin(-midAngle * RAD);
        return (
          <text
            x={x}
            y={y}
            fill="#374151"
            fontSize={12}
            fontWeight="700"
            textAnchor="middle"
            dominantBaseline="central"
          >
            {(percent * 100).toFixed(0)}%
          </text>
        );
      }}
    >
      {overviewCategory.map((v, i) => (
        <Cell key={`${v.category}-${i}`} fill={categoryColorMap[v.category]} />
      ))}
    </Pie>

    <Tooltip
      formatter={(v) => `${Number(v).toLocaleString()} 원`}
      itemStyle={{ fontSize: 12 }}
    />
    <Legend
      verticalAlign="bottom"
      align="center"
      iconType="circle"
      iconSize={10}
      height={48}
      wrapperStyle={{
        width: "100%",
        fontSize: 12,
        lineHeight: "18px",
        paddingTop: 8,
        textAlign: "center",
      }}
    />
  </PieChart>
</ResponsiveContainer>


                ) : (
                  <p className="text-sm text-gray-400 text-center">데이터 없음</p>
                )}
              </div>
            </section>


            {/* 최근 일주일 매출 추이(개요) */}
            <section className="bg-white p-6 rounded-lg shadow mb-8">
              <h3 className="text-lg font-semibold mb-4">최근 일주일 매출 추이</h3>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={overviewWeekly} margin={{ top:10,right:30,left:0,bottom:5 }}>
                  <defs>
                    <linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#6D72FF" stopOpacity={0.95} />
                      <stop offset="100%" stopColor="#6D72FF" stopOpacity={0.7} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                  <YAxis
                    domain={[0, Math.max(10000, Math.ceil((Math.max(0,...overviewWeekly.map(d=>+d.total||0))*1.2)/1000)*1000)]}
                    tick={{ fontSize: 12 }}
                    tickFormatter={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : v)}
                  />
                  <Tooltip formatter={(v) => [formatKRW(v), "total"]} />
                  <Bar dataKey="total" fill="url(#barGradient)" radius={[6,6,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            </section>
          </>
        )}

        {/* =======================
            조회 후 화면(그래프 + 표)
           ======================= */}
        {hasSearched && (
          <>
            <section className="bg-white p-6 rounded-lg shadow mb-8">
              <h3 className="text-lg font-semibold mb-4">
                {fromDate === toDate ? "당일 매출 추이" : "선택한 기간의 매출 추이"}
              </h3>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={weekly} margin={{ top:10,right:30,left:0,bottom:5 }} barCategoryGap={10} maxBarSize={24}>
                  <defs>
                    <linearGradient id="barGradient2" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#6D72FF" stopOpacity={0.95} />
                      <stop offset="100%" stopColor="#6D72FF" stopOpacity={0.7} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                  <YAxis
                    domain={[0, yMax]}
                    tick={{ fontSize: 12 }}
                    tickFormatter={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : v)}
                  />
                  <Tooltip formatter={(v) => [formatKRW(v), "total"]} cursor={{ fill: "rgba(0,0,0,0.04)" }} />
                  {weekly.length > 1 && avgTotal > 0 && (
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
                  <Bar dataKey="total" fill="url(#barGradient2)" radius={[6,6,0,0]} />
                  {weekly.length > 20 && (
                    <Brush dataKey="date" height={24} travellerWidth={10} stroke="#c7c9ff" />
                  )}
                </BarChart>
              </ResponsiveContainer>
            </section>

            <section className="bg-white p-6 rounded-lg shadow">
              <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
                <p className="text-gray-700 font-semibold">총 {items.length}건</p>
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
                    합계{" "}
                    {formatKRW(
                      items.reduce((s, v) => s + Number(v.total_price || 0), 0)
                    )}
                  </p>
                  <button
                    onClick={() => {
                      const header =
                        "판매날짜,상품명,바코드,판매수량,판매가,결제방법\n";
                      const rows = items
                        .map((v) =>
                          [
                            formatDate(
                              v.purchased_at_kst || v.date || v.purchased_at
                            ),
                            v.product_name || v.name || "",
                            v.barcode || "",
                            Number(v.quantity || 0),
                            Number(v.total_price || 0).toLocaleString(),
                            v.payment_method || "",
                          ].join(",")
                        )
                        .join("\n");
                      const csv = "\uFEFF" + header + rows;
                      const blob = new Blob([csv], {
                        type: "text/csv;charset=utf-8;",
                      });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = "sales_data.csv";
                      document.body.appendChild(a);
                      a.click();
                      document.body.removeChild(a);
                    }}
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
                    {pageRows.map((v, i) => (
                      <tr key={`${v.id}-${i}`} className="border-b hover:bg-gray-50">
                        <td className="px-4 py-2">
                          {formatDate(v.purchased_at_kst || v.date || v.purchased_at)}
                        </td>
                        <td className="px-4 py-2">{v.product_name || v.name}</td>
                        <td className="px-4 py-2">{v.barcode}</td>
                        <td className="px-4 py-2">
                          {Number(v.quantity || 0).toLocaleString()} 개
                        </td>
                        <td className="px-4 py-2">
                          {Number(v.total_price || 0).toLocaleString()} 원
                        </td>
                        <td className="px-4 py-2">{v.payment_method || ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* 페이지네이션 */}
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3 mt-4">
                <p className="text-sm text-gray-600">
                  {items.length === 0
                    ? "표시할 데이터가 없습니다."
                    : `${(start + 1).toLocaleString()}–${end.toLocaleString()} / ${items.length.toLocaleString()} 건`}
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
                  {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                    <button
                      key={p}
                      className={`px-3 py-1 rounded border ${
                        currentPage === p
                          ? "bg-[#b9e6e6] text-white border-[#b9e6e6]"
                          : "hover:bg-gray-50"
                      }`}
                      onClick={() => setCurrentPage(p)}
                    >
                      {p}
                    </button>
                  ))}
                  <button
                    className="px-3 py-1 rounded border hover:bg-gray-50 disabled:opacity-40"
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
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
          </>
        )}
      </main>
    </div>
  );
}
