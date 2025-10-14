/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./public/index.html", // 👈 추가
    "./src/**/*.{js,jsx,ts,tsx}", // 기존 유지
  ],
  theme: {
    extend: {},
  },
  plugins: [
    require("@tailwindcss/typography"), // 👈 플러그인 추가
  ],
};
