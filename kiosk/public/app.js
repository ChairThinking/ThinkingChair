// 화면 전환 함수
function goToScreen(screenId) {
  const screens = document.querySelectorAll(".screen");
  screens.forEach((screen) => screen.classList.remove("active"));

  const target = document.getElementById(screenId);
  if (target) target.classList.add("active");
}

// 시뮬레이션 버튼 바인딩 함수
function setupSimulateButton() {
  const btn = document.getElementById("simulate-scan-btn");
  if (btn && !btn.dataset.bound) {
    // 이미 바인딩됐는지 확인
    btn.addEventListener("click", () => {
      console.log("시뮬레이션 버튼 클릭됨");
      socket.send(JSON.stringify({ action: "simulateScan" }));
    });
    btn.dataset.bound = "true"; // 중복 방지 플래그 추가
  }
}

// 키오스크 세션 흐름 시작 (바구니 -> 스캔중까지)
function startKioskFlow() {
  goToScreen("screen-basket");

  setTimeout(() => {
    goToScreen("screen-scan");

    // 시뮬레이션 버튼 이벤트 연결
    setTimeout(() => {
      setupSimulateButton();
    }, 100); // 약간의 지연 추가로 DOM이 확실히 렌더링되도록 함
  }, 3000);
}

// 키오스크 페이지 로드 시 초기화 작업 수행

let socket;
window.onload = () => {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("sessionId");
  const expireTime = params.get("expireTime");

  if (sessionId) {
    // 세션 시작되면 로그 출력
    console.log("index.html에서 세션 시작됨");
    console.log("  - sessionId:", sessionId);
    console.log("  - expireTime:", expireTime);

    sessionStorage.setItem("sessionId", sessionId);

    // 세션 만료 타이머 설정
    if (expireTime) {
      sessionStorage.setItem("expireTime", expireTime);

      const expireTimestamp = new Date(expireTime).getTime();
      const now = Date.now();
      const timeRemaining = expireTimestamp - now;

      // 남은 시간이 양수인 경우에만 타이머 시작
      if (timeRemaining > 0) {
        setTimeout(() => {
          alert("세션이 만료되었습니다. 처음 화면으로 돌아갑니다.");
          // 콘솔에 만료 로그 출력
          console.log("세션 만료됨");
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

    // 시작 버튼 클릭 시 키오스크 흐름 시작
    document.querySelector(".start-btn").onclick = startKioskFlow;
  } else {
    alert("세션 ID 없음: /test/session-start.html에서 먼저 시작해주세요.");
  }

  // WebSocket 연결
  socket = new WebSocket("ws://localhost:3000");

  socket.onopen = () => {
    console.log("WebSocket 연결됨");
    setupSimulateButton(); // 여기서 호출해야 연결 후 이벤트가 정상 작동
  };

  socket.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === "scanResult") {
      console.log("상품 인식 결과:", data);
      sessionStorage.setItem("refundAmount", data.refund);

      // 1초 대기 후 영수증 출력 화면으로 전환
      setTimeout(() => {
        goToScreen("screen-receipt");

        // 3초 후 종료 인사 화면으로
        setTimeout(() => {
          goToScreen("screen-goodbye");

          // 5초 후 초기 화면으로 복귀
          setTimeout(() => {
            goToScreen("screen-start");

            // 세션 초기화
            sessionStorage.clear();
          }, 5000);
        }, 3000);
      }, 1000);
    }
  };
};
