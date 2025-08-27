import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

const formatWon = (v) => `₩${Number(v || 0).toLocaleString()}`;

const WeeklySalesChart = ({ data = [] }) => {
  // 1) sales를 확실히 숫자로 변환하고, 잘못된 값은 null로
  const normalized = (data || []).map((d) => {
    const n = typeof d.sales === 'string' ? Number(d.sales.replace(/,/g, '')) : Number(d.sales);
    return { ...d, sales: Number.isFinite(n) ? n : null };
  });

  // 2) 유효한 값들만 모아서 min/max 계산 (없으면 0~1로 안전하게)
  const valid = normalized.filter((d) => Number.isFinite(d.sales));
  const rawMin = valid.length ? Math.min(...valid.map((d) => d.sales)) : 0;
  const rawMax = valid.length ? Math.max(...valid.map((d) => d.sales)) : 1;

  // 3) 여유 패딩(상하 5%) + 최소 간격 보장
  const pad = Math.max(1000, Math.round((rawMax - rawMin) * 0.05));
  let yMin = rawMin - pad;
  let yMax = rawMax + pad;
  if (yMax - yMin < 5000) {
    // 범위가 너무 좁으면 최소 5천원 폭으로
    const mid = (rawMin + rawMax) / 2;
    yMin = Math.floor(mid - 2500);
    yMax = Math.ceil(mid + 2500);
  }
  if (yMin < 0) yMin = 0; // 음수 방지

  return (
    <div className="bg-white rounded-xl shadow-md p-6 w-full">
      <h2 className="text-xl font-semibold text-gray-700 mb-4">주간 매출 그래프</h2>

      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={normalized} margin={{ top: 20, right: 20, bottom: 5, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" />

          <XAxis
            dataKey="date"
            tick={{ fontSize: 12, fontWeight: 'bold' }}
            tickLine={false}
            axisLine={{ stroke: '#ccc' }}
          />

          <YAxis
            domain={[yMin, yMax]}                 // ✅ 직접 계산한 올바른 범위
            tickFormatter={formatWon}
            allowDecimals={false}
            tick={{ fontSize: 12 }}
            tickLine={false}
            axisLine={{ stroke: '#ccc' }}
            width={80}
          />

          <Tooltip
            formatter={(value) => formatWon(value)}
            labelFormatter={(label) => `${label}`}
          />

          <Line
            type="monotone"
            dataKey="sales"
            stroke="#4F75FF"
            strokeWidth={3}
            dot={{ r: 5 }}
            activeDot={{ r: 6 }}
            connectNulls                 // ✅ 중간에 null이 있어도 라인 연결
            isAnimationActive={false}    // 디버깅 시 애니 끄면 확인 쉬움 (원하면 true)
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

export default WeeklySalesChart;
