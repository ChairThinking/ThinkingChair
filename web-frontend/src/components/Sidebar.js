import { useLocation, useNavigate } from "react-router-dom";
import { useState } from "react";
import { Home, LineChart, PackageOpen, ClipboardList, LogOut } from "lucide-react";

const Sidebar = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const API_BASE = process.env.REACT_APP_API_BASE;
  const [showModal, setShowModal] = useState(false); // ✅ 모달 열림 상태

  const menus = [
    { name: "홈", icon: <Home size={18} />, path: "/" },
    { name: "매출 관리", icon: <LineChart size={18} />, path: "/sales" },
    { name: "상품 등록", icon: <PackageOpen size={18} />, path: "/products" },
    { name: "재고 관리", icon: <ClipboardList size={18} />, path: "/stock" },
  ];

  const handleNavigation = (path) => {
    if (location.pathname === path) {
      navigate(0);
    } else {
      navigate(path);
    }
  };

  // ✅ 로그아웃 API 호출 함수
  const handleLogout = async () => {
    try {
      await fetch(`${API_BASE}/api/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
    } catch (e) {
      console.warn("Logout failed:", e);
    } finally {
      setShowModal(false);
      navigate("/login", { replace: true });
    }
  };

  return (
    <div className="flex flex-col justify-between h-full min-h-screen">
      {/* 상단 메뉴 */}
      <div className="flex flex-col items-center pt-[5vh]">
        <h1 className="text-2xl font-extrabold text-blue-600 mb-6">생각의자</h1>
        <ul className="space-y-4 text-sm w-full px-4">
          {menus.map((menu) => {
            const isActive = location.pathname === menu.path;
            return (
              <li key={menu.name}>
                <div
                  onClick={() => handleNavigation(menu.path)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-xl cursor-pointer transition ${
                    isActive
                      ? "bg-blue-100 text-blue-600 font-semibold"
                      : "text-gray-800 hover:text-blue-500"
                  }`}
                >
                  <div className={isActive ? "text-blue-600" : "text-black"}>{menu.icon}</div>
                  {menu.name}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {/* ✅ 로그아웃 버튼 */}
      <div
        onClick={() => setShowModal(true)}
        className="p-4 text-red-500 text-sm font-bold cursor-pointer hover:text-red-600 transition flex items-center justify-center gap-1"
      >
        <LogOut size={16} /> 로그아웃
      </div>

      {/* ✅ 로그아웃 확인 모달 */}
      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-lg p-6 w-[90%] max-w-sm text-center animate-fadeIn">
            <h2 className="text-lg font-bold mb-4">정말 로그아웃하시겠습니까?</h2>
            <div className="flex justify-center gap-3">
              <button
                onClick={() => setShowModal(false)}
                className="px-4 py-2 rounded-xl border border-gray-300 hover:bg-gray-100 transition"
              >
                취소
              </button>
              <button
                onClick={handleLogout}
                className="px-4 py-2 rounded-xl bg-red-500 text-white font-semibold hover:bg-red-600 transition"
              >
                로그아웃
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Sidebar;
