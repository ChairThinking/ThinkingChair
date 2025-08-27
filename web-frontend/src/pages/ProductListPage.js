import { useEffect, useState } from "react";
import axios from "axios";
import Sidebar from "../components/Sidebar";

function ProductListPage() {
  const [products, setProducts] = useState([]);
  const [searchType, setSearchType] = useState("상품명");
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [inputPrice, setInputPrice] = useState("");
  const [inputQuantity, setInputQuantity] = useState("");

  const itemsPerPage = 10;
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;

  // 상품 목록 가져오기
  useEffect(() => {
    axios.get("/api/products")
      .then(res => {
        setProducts(res.data.map(p => ({
          id: p.id,
          name: p.name,
          barcode: p.barcode,
          category: p.category,
          manufacturer: p.manufacturer,
          brand: p.brand,
          origin: p.origin_country,
          price: p.price || 0,
          quantity: 0,
          image: p.image_url || "/images/default.jpg"
        })));
      })
      .catch(err => {
        console.error("상품 불러오기 실패:", err);
      });
  }, []);

  const filteredProducts = products.filter((product) => {
    const value =
      searchType === "상품명"
        ? product.name
        : searchType === "제조사"
        ? product.manufacturer
        : product.barcode;
    return value.toLowerCase().includes(searchQuery.toLowerCase());
  });

  const paginatedProducts = filteredProducts.slice(startIndex, endIndex);
  const totalPages = Math.ceil(filteredProducts.length / itemsPerPage);

  // 등록 API 호출
  const handleRegister = async () => {
    if (!inputPrice || !inputQuantity || !selectedProduct) return;

    console.log("등록 시도:", {
      product_id: selectedProduct.id,
      sale_price: Number(inputPrice),
      quantity: Number(inputQuantity)
    });

    try {
      const response = await axios.post("/api/store-products", {
        product_id: selectedProduct.id,
        sale_price: Number(inputPrice),
        quantity: Number(inputQuantity)
      });

      console.log("등록 성공 응답:", response.data);
      alert("상품 등록 완료!");
      setSelectedProduct(null);
      setInputPrice("");
      setInputQuantity("");
    } catch (err) {
      console.error("상품 등록 실패:", err.response ? err.response.data : err.message);
      alert("상품 등록 실패: " + (err.response?.data?.message || "서버 오류"));
    }
  };

  return (
    <div className="flex min-h-screen relative">
      <div className="w-[12vw] min-w-[140px] max-w-[200px] bg-white shadow-md">
        <Sidebar />
      </div>
      <main className="flex-1 bg-[#e9f0ff] px-[4vw] py-[3vw] overflow-y-auto">
        <h2 className="text-2xl font-bold text-gray-800 mb-6">상품등록</h2>
        <div className="flex items-center gap-4 mb-6">
          <select
            value={searchType}
            onChange={(e) => setSearchType(e.target.value)}
            className="border px-3 py-2 rounded bg-gray-100"
          >
            <option>상품명</option>
            <option>제조사</option>
            <option>바코드</option>
          </select>
          <input
            type="text"
            placeholder="검색어를 입력하세요."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="border px-3 py-2 rounded flex-1"
          />
        </div>

        <table className="w-full text-sm bg-white rounded-xl overflow-hidden shadow">
          <thead className="border-b text-left">
            <tr>
              <th className="px-4 py-3"><input type="checkbox" /></th>
              <th className="px-4 py-3">No.</th>
              <th className="px-4 py-3">상품명</th>
              <th className="px-4 py-3">판매가</th>
              <th className="px-4 py-3">분류</th>
            </tr>
          </thead>
          <tbody>
            {paginatedProducts.map((item, i) => (
              <tr key={item.id} className="border-t cursor-pointer" onClick={() => {
                setSelectedProduct(item);
                setInputPrice(item.price);
                setInputQuantity(item.quantity);
              }}>
                <td className="px-4 py-3">
                  <input type="checkbox" onClick={(e) => e.stopPropagation()} />
                </td>
                <td className="px-4 py-3">{String(item.id).padStart(3, "0")}</td>
                <td className="px-4 py-3 flex items-center gap-3">
                  <img src={item.image} alt="상품 이미지" className="w-12 h-12" />
                  <div>
                    <div className="text-xs text-gray-500">{item.barcode}</div>
                    <div className="font-semibold text-gray-800">{item.name}</div>
                    <div className="text-xs text-gray-400">{item.manufacturer}</div>
                  </div>
                </td>
                <td className="px-4 py-3 font-semibold text-gray-900">{item.price.toLocaleString()} 원</td>
                <td className="px-4 py-3">{item.category}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="flex justify-center items-center gap-4 mt-6">
          <button onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))} disabled={currentPage === 1} className="px-2 text-lg text-gray-700 disabled:opacity-50">&lt;</button>
          {[...Array(totalPages)].map((_, i) => (
            <button key={i + 1} onClick={() => setCurrentPage(i + 1)} className={`px-3 py-1 rounded ${currentPage === i + 1 ? "bg-blue-500 text-white" : "text-gray-700"}`}>{i + 1}</button>
          ))}
          <button onClick={() => setCurrentPage((prev) => Math.min(prev + 1, totalPages))} disabled={currentPage === totalPages} className="px-2 text-lg text-gray-700 disabled:opacity-50">&gt;</button>
        </div>

        {selectedProduct && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white p-8 rounded-lg w-[700px] grid grid-cols-2 gap-6 relative">
              <button onClick={() => setSelectedProduct(null)} className="absolute top-4 right-4 text-2xl">×</button>
              <div className="col-span-1 space-y-4">
                <div className="flex justify-between border-b py-2"><span>상품명</span><span>{selectedProduct.name}</span></div>
                <div className="flex justify-between border-b py-2"><span>생산지</span><span>{selectedProduct.origin}</span></div>
                <div className="flex justify-between border-b py-2"><span>브랜드</span><span>{selectedProduct.brand}</span></div>
                <div className="flex justify-between border-b py-2"><span>제조사</span><span>{selectedProduct.manufacturer}</span></div>
                <div className="flex justify-between border-b py-2"><span>분류</span><span>{selectedProduct.category}</span></div>
                <div className="flex justify-between border-b py-2"><span>바코드</span><span>{selectedProduct.barcode}</span></div>
                <div className="flex justify-between border-b py-2">
                  <span>판매가격</span>
                  <input type="number" value={inputPrice} onChange={(e) => setInputPrice(e.target.value)} className="border px-2 py-1 w-40 rounded" />
                </div>
                <div className="flex justify-between border-b py-2">
                  <span>입고수량</span>
                  <input type="number" value={inputQuantity} onChange={(e) => setInputQuantity(e.target.value)} className="border px-2 py-1 w-40 rounded" />
                </div>
              </div>
              <div className="col-span-1 flex items-center justify-center">
                <img src={selectedProduct.image} alt="상품 이미지" className="w-48 h-48 object-contain" />
              </div>
              <div className="col-span-2 flex justify-end gap-4 mt-4">
                <button onClick={handleRegister} className="bg-blue-500 text-white px-4 py-2 rounded">등록</button>
                <button onClick={() => setSelectedProduct(null)} className="bg-red-100 text-red-600 px-4 py-2 rounded">취소</button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default ProductListPage;
