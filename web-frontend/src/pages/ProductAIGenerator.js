// src/pages/ProductAIGenerator.js
import Sidebar from "../components/Sidebar";
import AIDummyDataGenerator from "../components/AIDummyDataGenerator";

const ProductAIGenerator = () => {
  return (
    <div className="flex min-h-screen bg-white">
      {/* 왼쪽 사이드바 */}
      <aside className="w-[12vw] min-w-[140px] max-w-[200px] bg-white shadow-md flex-shrink-0">
        <Sidebar />
      </aside>

      {/* 오른쪽 본문 */}
      <main className="flex-1 bg-[#f0f4ff] overflow-y-auto px-[4vw] py-[3vw]">
        {/* 페이지 타이틀 */}
        <h2 className="text-xl sm:text-2xl md:text-3xl lg:text-4xl font-bold text-gray-800 mb-6">
          AI 기반 더미 매출 데이터 생성
        </h2>

        {/* 카드 컨테이너 안에 실제 생성 폼 */}
        <section className="bg-white p-4 rounded-xl shadow max-w-5xl">
          <AIDummyDataGenerator />
        </section>
      </main>
    </div>
  );
};

export default ProductAIGenerator;
