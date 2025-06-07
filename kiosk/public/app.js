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

let socket; //WebSocket

//키오스크 페이지 로드 시 초기화 작업 수행
window.onload = () => {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("sessionId");
  const expireTime = params.get("expireTime");

  if (sessionId) {
    //세션 시작되면 로그 출력
    console.log("index.html에서 세션 시작됨");
    console.log("  - sessionId:", sessionId);
    console.log("  - expireTime:", expireTime);

    sessionStorage.setItem("sessionId", sessionId);
    //만료 시간 저장
    if (expireTime) {
      sessionStorage.setItem("expireTime", expireTime);

      const expireTimestamp = new Date(expireTime).getTime();
      const now = Date.now();
      const timeRemaining = expireTimestamp - now;

      //남은 시간이 양수인 경우에만 타이머 시작
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


  // WebSocket 연결
  socket = new WebSocket("ws://localhost:3000");
  socket.onopen = () => console.log("WebSocket 연결됨");

  socket.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === "scanResult") {
      console.log("상품 인식 데이터:", data.products);

      // 이후 화면 전환 및 합산 로직 호출
      goToScreen("screen-receipt");

      setTimeout(() => {
        goToScreen("screen-goodbye");
        setTimeout(() => goToScreen("screen-start"), 5000);
      }, 3000);
    }
  };

  // 임시 버튼(스캔 중 페이지)에 이벤트 연결
  document.querySelector(".mock-scan-btn").onclick = () => {
    socket.send(JSON.stringify({ action: "mock-scan" }));
  };
};
