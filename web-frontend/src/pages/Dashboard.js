import { useEffect, useState } from "react";
import axios from "axios";
import { Link } from "react-router-dom";

import Sidebar from "../components/Sidebar";
import SalesSummary from "../components/SalesSummary";
import PopularProducts from "../components/PopularProducts";
import WeeklySalesChart from "../components/WeeklySalesChart";
import AIInsightModal from "../components/AIInsightModal";

function Dashboard() {
  const [salesSummary, setSalesSummary] = useState(null);
  const [popularProducts, setPopularProducts] = useState([]);
  const [weeklySales, setWeeklySales] = useState([]);

  // ✅ AI 인사이트 모달 상태
  const [showInsight, setShowInsight] = useState(false);
  const [targetPeriod, setTargetPeriod] = useState(""); // 예: "2025-11"

  useEffect(() => {
    // 오늘 매출 요약
    axios.get("/api/dashboard/today-sales").then((res) => {
      const { today_total, change_rate, max_day_sales } = res.data;

      const today = new Date();
      const sixDaysAgo = new Date();
      sixDaysAgo.setDate(today.getDate() - 6);

      const dateRange = `${sixDaysAgo.getFullYear()}년 ${sixDaysAgo.getMonth() + 1}월 ${sixDaysAgo.getDate()}일 
                          ~ ${today.getFullYear()}년 ${today.getMonth() + 1}월 ${today.getDate()}일`;

      setSalesSummary({
        amount: today_total,
        change: change_rate,
        maxThisWeek: max_day_sales,
        dateRange,
      });
    });

    // 인기 상품 Top 5
    axios.get("/api/dashboard/monthly-top-products").then((res) => {
      const topProducts = res.data.map((p) => ({
        name: p.name,
        image: p.image_url,
        sales: p.total_sold,
      }));
      setPopularProducts(topProducts);
    });

    // 주간 매출 데이터
    axios.get("/api/dashboard/weekly-sales").then((res) => {
      const formatted = res.data.map((row) => {
        const date = new Date(row.date);
        return {
          date: `${date.getMonth() + 1}월 ${date.getDate()}일`,
          sales: row.total,
        };
      });
      setWeeklySales(formatted);
    });
  }, []);

  return (
    <div className="flex w-full min-h-screen">
      <div className="w-[12vw] min-w-[140px] max-w-[200px] bg-white shadow-md">
        <Sidebar />
      </div>

      <main className="flex-1 px-[4vw] py-[3vw] bg-[#f0f4ff]">
        {/* 상단 헤더 */}
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl sm:text-2xl md:text-3xl lg:text-4xl font-bold text-gray-800">
            메인화면
          </h2>

          <div className="flex items-center gap-3">
            {/* ✅ AI 인사이트 버튼 */}
            <div className="flex items-center gap-2">
              <input
                type="month"
                value={targetPeriod}
                onChange={(e) => setTargetPeriod(e.target.value)}
                className="border rounded-lg px-3 py-1 text-sm"
              />
              <button
                onClick={() => setShowInsight(true)}
                className="bg-gradient-to-r from-blue-500 to-indigo-600 text-white px-3 py-2 rounded hover:opacity-90 text-sm font-semibold shadow-sm"
              >
                AI 추천 매출분석 보기
              </button>
            </div>

            {/* 기존 AI 더미 데이터 생성 버튼 */}
            <Link
              to="/ai-generator"
              className="bg-gradient-to-r from-emerald-500 to-emerald-700 text-white px-3 py-2 rounded hover:opacity-90 text-sm font-semibold shadow-sm"
            >
              AI로 더미 데이터 만들기
            </Link>
          </div>
        </div>

        {/* 매출 요약 + 인기상품 */}
        <div className="flex gap-[2vw] items-end">
          <div className="w-[47%] flex flex-col">
            <div className="mt-[6vw]">
              {salesSummary ? (
                <SalesSummary
                  amount={Number(salesSummary.amount).toLocaleString()}
                  change={salesSummary.change}
                  maxThisWeek={Number(salesSummary.maxThisWeek).toLocaleString()}
                  dateRange={salesSummary.dateRange}
                />
              ) : (
                <p className="text-gray-400 text-sm">오늘 매출 데이터를 불러오는 중...</p>
              )}
            </div>
          </div>
          <div className="w-[53%]">
            <PopularProducts products={popularProducts} />
          </div>
        </div>

        {/* 주간 매출 그래프 */}
        <div className="mt-[3vw]">
          <WeeklySalesChart data={weeklySales} />
        </div>
      </main>

      {/* ✅ AI 인사이트 모달 */}
      <AIInsightModal
        show={showInsight}
        onClose={() => setShowInsight(false)}
        period={targetPeriod}
      />
    </div>
  );
}

export default Dashboard;
