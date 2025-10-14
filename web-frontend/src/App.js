import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import SalesPage from "./pages/SalesPage";
import ProductListPage from "./pages/ProductListPage";
import StockPage from "./pages/StockPage";
import ProductAIGenerator from "./pages/ProductAIGenerator";
import LoginPage from "./pages/LoginPage";              // ✅ 로그인 페이지가 있다면
import RegisterPage from "./pages/RegisterPage";        // ✅ 회원가입 페이지 추가
import ProtectedRoute from "./components/ProtectedRoute"; // ✅ 보호 래퍼(이미 추가했다면 유지)

console.log("✅ API_BASE:", process.env.REACT_APP_API_BASE);

function App() {
  return (
    <Router>
      <Routes>
        {/* 공개 라우트 */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />

        {/* 보호 라우트들 */}
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/sales"
          element={
            <ProtectedRoute>
              <SalesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/products"
          element={
            <ProtectedRoute>
              <ProductListPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/stock"
          element={
            <ProtectedRoute>
              <StockPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/ai-generator"
          element={
            <ProtectedRoute>
              <ProductAIGenerator />
            </ProtectedRoute>
          }
        />

        {/* 존재하지 않는 경로 → 대시보드로 */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  );
}

export default App;
