import React, { useState } from "react";
import { useNavigate } from "react-router-dom";

export default function LoginPage() {
  const API_BASE = process.env.REACT_APP_API_BASE;
  const nav = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleLogin(e) {
    e.preventDefault();
    setError("");

    if (!email || !password) {
      setError("이메일과 비밀번호를 입력하세요.");
      return;
    }

    try {
      setBusy(true);
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include", // ✅ 쿠키 포함
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "로그인 실패");

      // ✅ 로그인 성공 시 대시보드 이동
      nav("/", { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-md bg-white shadow-xl rounded-2xl p-8">
        <h1 className="text-2xl font-bold text-center mb-6">관리자 로그인</h1>

        {error && (
          <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">
            {error}
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">이메일</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring focus:border-blue-400"
              placeholder="admin@kiosk.com"
              autoComplete="username"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">비밀번호</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 focus:outline-none focus:ring focus:border-blue-400"
              placeholder="••••••••"
              autoComplete="current-password"
            />
          </div>

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-xl py-2 font-semibold bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-60"
          >
            {busy ? "로그인 중..." : "로그인"}
          </button>
        </form>

        {/* ✅ 회원가입 버튼 추가 구간 */}
        <div className="text-center text-sm mt-4 text-gray-600">
          계정이 없으신가요?{" "}
          <button
            onClick={() => nav("/register")}
            className="text-blue-600 font-semibold hover:underline"
          >
            회원가입
          </button>
        </div>
      </div>
    </div>
  );
}
