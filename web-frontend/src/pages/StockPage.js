import { useEffect, useState } from "react";
import axios from "axios";
import Sidebar from "../components/Sidebar";

export default function StockPage() {
  const [products, setProducts] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchType, setSearchType] = useState("상품명");
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [inputPrice, setInputPrice] = useState("");
  const [inputQuantity, setInputQuantity] = useState("");
  const [selectedIds, setSelectedIds] = useState([]);
  const itemsPerPage = 10;

  // 재고 목록 불러오기
  useEffect(() => {
    axios
      .get("/api/store-products")
      .then((res) => {
        setProducts(
          res.data.map((p) => ({
            id: p.id,
            product_id: p.product_id,
            name: p.name,
            barcode: p.barcode,
            category: p.category,
            manufacturer: p.manufacturer,
            brand: p.brand,
            origin: p.origin_country,
            price: p.sale_price,
            quantity: p.quantity,
            image: p.image_url || "/images/default.jpg",
          }))
        );
      })
      .catch((err) => console.error("재고 불러오기 실패:", err));
  }, []);

  const filtered = products.filter((p) => {
    const value =
      searchType === "상품명"
        ? p.name
        : searchType === "제조사"
        ? p.manufacturer
        : p.barcode;
    return value.toLowerCase().includes(searchQuery.toLowerCase());
  });

  const totalPages = Math.ceil(filtered.length / itemsPerPage);
  const paginated = filtered.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  const handleCheckboxChange = (id) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    );
  };

  const handleDeleteSelected = async () => {
    if (selectedIds.length === 0) return;
    if (!window.confirm("선택한 상품을 삭제하시겠습니까?")) return;

    try {
      for (const id of selectedIds) {
        await axios.delete(`/api/store-products/${id}`);
      }

      setProducts((prev) => prev.filter((p) => !selectedIds.includes(p.id)));
      setSelectedIds([]);
      alert("삭제 완료!");
    } catch (err) {
      console.error("삭제 실패:", err);
      alert("삭제 중 오류 발생");
    }
  };

  const handleSave = async () => {
    if (
      inputPrice === "" ||
      inputPrice === null ||
      inputPrice === undefined ||
      inputQuantity === "" ||
      inputQuantity === null ||
      inputQuantity === undefined
    ) {
      alert("판매가격과 재고수량을 모두 입력해주세요.");
      return;
    }

    const newPrice = Number(inputPrice);
    const newQty = Number(inputQuantity);

    if (isNaN(newPrice) || isNaN(newQty)) {
      alert("숫자 형식이 잘못되었습니다.");
      return;
    }
    if (newQty < 0) {
      alert("재고 수량은 0보다 작을 수 없습니다.");
      return;
    }

    try {
      await axios.put(`/api/store-products/${selectedProduct.id}`, {
        sale_price: newPrice,
        quantity: newQty,
      });

      setProducts((prev) =>
        prev.map((item) =>
          item.id === selectedProduct.id
            ? {
                ...item,
                price: newPrice,
                quantity: newQty,
              }
            : item
        )
      );

      setSelectedProduct(null);
      alert("수정되었습니다.");
    } catch (err) {
      console.error("수정 실패:", err);
      alert("수정 중 오류가 발생했습니다.");
    }
  };

  return (
    <div className="flex min-h-screen relative">
      {/* 사이드바 */}
      <div className="w-[12vw] min-w-[140px] max-w-[200px] bg-white shadow-md">
        <Sidebar />
      </div>

      {/* 메인 */}
      <main className="flex-1 bg-[#e9f0ff] px-[4vw] py-[3vw]">
        <h2 className="text-2xl font-bold text-gray-800 mb-6">재고관리</h2>

        {/* 검색 */}
        <div className="flex items-center gap-4 mb-6">
          <select
            value={searchType}
            onChange={(e) => setSearchType(e.target.value)}
            className="border px-3 py-2 rounded bg-gray-100"
          >
            <option value="상품명">상품명</option>
            <option value="제조사">제조사</option>
            <option value="바코드">바코드</option>
          </select>
          <input
            type="text"
            placeholder="검색어를 입력하세요."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="border px-3 py-2 rounded flex-1"
          />
        </div>

        {/* 테이블 */}
        <table className="w-full text-sm bg-white rounded-xl overflow-hidden shadow">
          <thead className="border-b text-left">
            <tr>
              <th className="px-4 py-3">
                <input type="checkbox" disabled />
              </th>
              <th className="px-4 py-3">No.</th>
              <th className="px-4 py-3">상품명</th>
              <th className="px-4 py-3">판매가</th>
              <th className="px-4 py-3">분류</th>
              <th className="px-4 py-3 text-center">재고량</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {paginated.map((item) => (
              <tr
                key={item.id}
                className="border-t cursor-pointer hover:bg-gray-50"
                onClick={() => {
                  setSelectedProduct(item);
                  setInputPrice(item.price);
                  setInputQuantity(item.quantity);
                }}
              >
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(item.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => handleCheckboxChange(item.id)}
                  />
                </td>
                <td className="px-4 py-3">
                  {String(item.id).padStart(3, "0")}
                </td>

                {/* 상품명: 전체 표시, 자연 줄바꿈 */}
                <td className="px-4 py-3 flex items-start gap-3">
                  <img
                    src={item.image}
                    alt="상품 이미지"
                    className="w-12 h-12 flex-shrink-0"
                  />
                  <div>
                    <div className="text-xs text-gray-500">{item.barcode}</div>
                    <div className="font-semibold text-gray-800 whitespace-normal break-words">
                      {item.name}
                    </div>
                    <div className="text-xs text-gray-500">
                      {item.manufacturer}
                    </div>
                  </div>
                </td>

                <td className="px-4 py-3">
                  {item.price.toLocaleString()} 원
                </td>
                <td className="px-4 py-3">{item.category}</td>
                <td className="px-4 py-3 font-bold text-center">
                  {item.quantity}
                </td>
                <td className="px-4 py-3"></td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* 하단 버튼 */}
        <div className="flex justify-between items-center mt-6">
          <div></div>
          <div className="flex gap-4">
            <button
              onClick={handleDeleteSelected}
              className="bg-red-500 text-white px-4 py-2 rounded"
            >
              선택 삭제
            </button>
          </div>
        </div>

        {/* 페이지네이션 */}
        <div className="flex justify-center items-center gap-4 mt-4">
          <button
            onClick={() =>
              setCurrentPage((prev) => Math.max(prev - 1, 1))
            }
            disabled={currentPage === 1}
            className="px-2 text-lg text-gray-700 disabled:opacity-50"
          >
            &lt;
          </button>

          {[...Array(totalPages)].map((_, i) => (
            <button
              key={i + 1}
              onClick={() => setCurrentPage(i + 1)}
              className={`px-3 py-1 rounded ${
                currentPage === i + 1
                  ? "bg-blue-500 text-white"
                  : "text-gray-700"
              }`}
            >
              {i + 1}
            </button>
          ))}

          <button
            onClick={() =>
              setCurrentPage((prev) =>
                Math.min(prev + 1, totalPages)
              )
            }
            disabled={currentPage === totalPages}
            className="px-2 text-lg text-gray-700 disabled:opacity-50"
          >
            &gt;
          </button>
        </div>

        {/* 수정 모달 */}
        {selectedProduct && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white p-8 rounded-lg w-[700px] grid grid-cols-2 gap-6 relative">
              <button
                onClick={() => setSelectedProduct(null)}
                className="absolute top-4 right-4 text-2xl"
              >
                ×
              </button>

              {/* 상품명 (두 줄까지만 표시) */}
              <div
                className="col-span-2 text-center text-base font-semibold leading-snug px-4"
                style={{
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  wordBreak: "keep-all",
                }}
              >
                {selectedProduct.name}
              </div>

              {/* 왼쪽 정보 */}
              <div className="col-span-1 space-y-4">
                <div className="flex justify-between border-b py-2">
                  <span>생산지</span>
                  <span className="text-right max-w-[50%] break-keep">
                    {selectedProduct.origin}
                  </span>
                </div>
                <div className="flex justify-between border-b py-2">
                  <span>브랜드</span>
                  <span className="text-right max-w-[50%] break-keep">
                    {selectedProduct.brand}
                  </span>
                </div>
                <div className="flex justify-between border-b py-2">
                  <span>제조사</span>
                  <span className="text-right max-w-[50%] break-keep">
                    {selectedProduct.manufacturer}
                  </span>
                </div>
                <div className="flex justify-between border-b py-2">
                  <span>분류</span>
                  <span className="text-right max-w-[50%] break-keep">
                    {selectedProduct.category}
                  </span>
                </div>
                <div className="flex justify-between border-b py-2">
                  <span>바코드</span>
                  <span className="text-right max-w-[50%] break-all">
                    {selectedProduct.barcode}
                  </span>
                </div>
                <div className="flex justify-between border-b py-2">
                  <span>판매가격</span>
                  <input
                    type="number"
                    value={inputPrice}
                    onChange={(e) => setInputPrice(e.target.value)}
                    className="border px-2 py-1 w-40 rounded text-right"
                  />
                </div>
                <div className="flex justify-between border-b py-2">
                  <span>재고수량</span>
                  <input
                    type="number"
                    value={inputQuantity}
                    onChange={(e) => setInputQuantity(e.target.value)}
                    className="border px-2 py-1 w-40 rounded text-right"
                  />
                </div>
              </div>

              {/* 오른쪽 이미지 */}
              <div className="col-span-1 flex items-center justify-center">
                <img
                  src={selectedProduct.image || "/images/default.jpg"}
                  alt="상품 이미지"
                  className="w-40 h-40 object-contain"
                />
              </div>

              {/* 버튼 */}
              <div className="col-span-2 flex justify-end gap-4 mt-4">
                <button
                  onClick={handleSave}
                  className="bg-blue-500 text-white px-4 py-2 rounded"
                >
                  저장
                </button>
                <button
                  onClick={() => setSelectedProduct(null)}
                  className="bg-red-100 text-red-600 px-4 py-2 rounded"
                >
                  취소
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
