import React, { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";

export default function ProtectedRoute({ children }) {
  const API_BASE = process.env.REACT_APP_API_BASE;
  const [checking, setChecking] = useState(true);
  const [ok, setOk] = useState(false);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/auth/me`, {
          credentials: "include",
        });
        if (!cancel) setOk(res.ok);
      } catch {
        if (!cancel) setOk(false);
      } finally {
        if (!cancel) setChecking(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [API_BASE]);

  if (checking) return <div style={{ padding: 24 }}>로그인 상태 확인 중...</div>;
  if (!ok) return <Navigate to="/login" replace />;
  return children;
}
