import Sidebar from "../components/Sidebar";
import AIDummyDataGenerator from "../components/AIDummyDataGenerator";

const ProductAIGenerator = () => {
  return (
    <div className="flex">
      <Sidebar />
      <main className="flex-1 min-h-screen bg-slate-50 p-8">
        <h2 className="text-2xl font-semibold mb-6">AI 기반 더미 매출 데이터 생성</h2>
        <AIDummyDataGenerator />
      </main>
    </div>
  );
};

export default ProductAIGenerator;
