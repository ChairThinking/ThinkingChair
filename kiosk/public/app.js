// 화면 전환 함수
function goToScreen(screenId) {
  const screens = document.querySelectorAll(".screen");
  screens.forEach((screen) => screen.classList.remove("active"));

  const target = document.getElementById(screenId);
  if (target) target.classList.add("active");
}

// 키오스크 세션 흐름 시작
function startKioskFlow() {
  goToScreen("screen-basket");

  setTimeout(() => {
    goToScreen("screen-scan");

    setTimeout(() => {
      goToScreen("screen-receipt");

      setTimeout(() => {
        goToScreen("screen-goodbye");
      }, 3000);
    }, 3000);
  }, 3000);
}

// 페이지 로드시 초기화
window.onload = () => {
  const sessionId = new URLSearchParams(window.location.search).get(
    "sessionId"
  );

  // 모든 화면 숨기고 시작화면만 표시
  const screens = document.querySelectorAll(".screen");
  screens.forEach((screen) => screen.classList.remove("active"));
  document.getElementById("screen-start").classList.add("active");

  if (sessionId) {
    sessionStorage.setItem("sessionId", sessionId);
    const btn = document.querySelector(".start-btn");
    if (btn) btn.onclick = startKioskFlow;
  } else {
    alert("세션 ID 없음: /test/session-start.html에서 시작해주세요.");
  }
};
