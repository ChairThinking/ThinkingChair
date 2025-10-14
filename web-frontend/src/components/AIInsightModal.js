import { useEffect, useState } from "react";
import axios from "axios";
import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function AIInsightModal({ show, onClose, period }) {
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (!show) return;
    let alive = true;
    (async () => {
      try {
        setLoading(true);
        const qs = period ? `?period=${period}` : "";
        const { data } = await axios.get(
          `${process.env.REACT_APP_API_BASE}/api/ai-insight/insight${qs}`
        );
        if (alive)
          setMsg(
            data?.insight ||
              "AI 분석 결과를 불러오지 못했습니다. 데이터가 없을 수 있습니다."
          );
      } catch {
        if (alive) setMsg("AI 분석 중 오류가 발생했습니다.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [show, period]);

  if (!show) return null;

  return React.createElement(
    "div",
    {
      className: "fixed inset-0 bg-black/40 flex items-center justify-center z-50",
    },
    React.createElement(
      "div",
      {
        className:
          "bg-white rounded-2xl shadow-lg p-6 w-[92%] max-w-3xl animate-fadeIn overflow-y-auto max-h-[90vh]",
      },
      // 헤더 영역
      React.createElement(
        "div",
        { className: "flex items-center justify-between mb-4" },
        React.createElement("h2", { className: "text-lg font-bold" }, "AI 매출 분석 결과"),
        React.createElement(
          "button",
          {
            onClick: onClose,
            className: "text-gray-500 hover:text-gray-800",
          },
          "닫기"
        )
      ),

      // 본문 영역
      loading
        ? React.createElement(
            "p",
            { className: "text-gray-500" },
            "AI가 데이터를 분석 중입니다..."
          )
        : React.createElement(
            "div",
            {
              className:
                "prose prose-sm max-w-none text-gray-800 leading-relaxed",
            },
            React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, msg)
          ),

      
    )
  );
}
