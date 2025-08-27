// src/components/SalesSummary.jsx
const SalesSummary = ({ amount, change, maxThisWeek, dateRange }) => {
  const isPositive = (change ?? 0) >= 0;
  const changeColor = isPositive ? "text-green-500" : "text-red-500";
  const changeSymbol = isPositive ? "▲" : "▼";

  return (
    <div className="bg-white rounded-xl shadow-lg p-6 w-full border border-gray-100">
      <h2 className="text-xl font-semibold text-gray-700 mb-4">오늘의 매출</h2>
      <p className="text-4xl font-extrabold text-gray-900 mb-1">
        ₩{(amount ?? 0).toLocaleString()}
      </p>
      <p className={`text-sm font-medium ${changeColor} mb-3`}>
        {changeSymbol} {Math.abs(change ?? 0)}%
        <span className="text-gray-500"> (전일 대비)</span>
      </p>
      <hr className="my-2" />
      <div className="text-sm text-gray-500">
        <p>
          이번주 최고 매출:{" "}
          <span className="font-semibold text-gray-700">
            ₩{(maxThisWeek ?? 0).toLocaleString()}
          </span>
        </p>
        <p className="mt-1">기간: {dateRange}</p>
      </div>
    </div>
  );
};

export default SalesSummary;
