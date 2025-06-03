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

        //5초 후 초기화면으로 이동
        setTimeout(() => {
          goToScreen("screen-start");

          // 세션 초기화가 필요하다면 여기서 localStorage.clear() 같은 처리도 가능
          // 추후 세션 정보 제거 필요
        }, 5000);
      }, 3000);
    }, 3000);
  }, 3000);
}

//키오스크 페이지 로드 시 초기화 작업 수행
window.onload = () => {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("sessionId");
  const expireTime = params.get("expireTime");

  if (sessionId) {
    console.log("index.html에서 세션 시작됨");
    console.log("  - sessionId:", sessionId);
    console.log("  - expireTime:", expireTime);

    sessionStorage.setItem("sessionId", sessionId);

    if (expireTime) {
      sessionStorage.setItem("expireTime", expireTime);

      const expireTimestamp = new Date(expireTime).getTime();
      const now = Date.now();
      const timeRemaining = expireTimestamp - now;

      if (timeRemaining > 0) {
        setTimeout(() => {
          alert("세션이 만료되었습니다. 처음 화면으로 돌아갑니다.");
          // 콘솔에 만료 로그 출력
          console.log("⏰ 세션 만료됨");
          console.log("  - expireTime:", expireTime);
          console.log("  - 현재 시각:", new Date().toISOString());

          sessionStorage.clear();
          goToScreen("screen-start");
        }, timeRemaining);
      } else {
        alert("세션이 이미 만료되었습니다.");
        goToScreen("screen-start");
      }
    }

    document.querySelector(".start-btn").onclick = startKioskFlow;
  } else {
    alert("세션 ID 없음: /test/session-start.html에서 먼저 시작해주세요.");
  }
};
