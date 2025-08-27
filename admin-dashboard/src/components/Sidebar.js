import { useLocation, useNavigate } from "react-router-dom";
import { Home, LineChart, PackageOpen, ClipboardList } from "lucide-react";

const Sidebar = () => {
  const location = useLocation();
  const navigate = useNavigate();

  const menus = [
    { name: "홈", icon: <Home size={18} />, path: "/" },
    { name: "매출 관리", icon: <LineChart size={18} />, path: "/sales" },
    { name: "상품 등록", icon: <PackageOpen size={18} />, path: "/products" },
    { name: "재고 관리", icon: <ClipboardList size={18} />, path: "/stock" },
  ];

  const handleNavigation = (path) => {
    if (location.pathname === path) {
      navigate(0); // 강제로 새로고침
    } else {
      navigate(path); // 경로 이동
    }
  };

  return (
    <div className="flex flex-col justify-between h-full min-h-screen">
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
                    isActive ? "bg-blue-100 text-blue-600 font-semibold" : "text-gray-800 hover:text-blue-500"
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
      <div className="p-4 text-red-500 text-sm font-bold cursor-pointer">로그아웃</div>
    </div>
  );
};

export default Sidebar;
