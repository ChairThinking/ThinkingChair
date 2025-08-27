import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import SalesPage from "./pages/SalesPage";
import ProductListPage from "./pages/ProductListPage";
import StockPage from "./pages/StockPage";
import ProductAIGenerator from './pages/ProductAIGenerator';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/sales" element={<SalesPage />} />
        <Route path="/products" element={<ProductListPage />} />
        <Route path="/stock" element={<StockPage />} />
        <Route path="/ai-generator" element={<ProductAIGenerator />} />
      </Routes>
    </Router>
  );
}

export default App;
