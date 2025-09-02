let ws;
let sessionStarted = false;
let __currentScreenId = "screen-start";

// 상품 목록 / 감지 결과 저장
let storeProducts = [];
let detectedProductName = null;

// 타이머 변수
let receiptTimer = null;
let goodbyeTimer = null;

const TEST_CARD_AUTOPASS = true; // 서버 준비 전엔 true, 완성되면 false

// ----------------------
// 화면 전환 함수
// ----------------------

function setupBasketImageAdvance() {
  const img = document.querySelector(".basket-img");
  if (!img) {
    console.warn("⚠️ .basket-img 이미지를 찾을 수 없습니다.");
    return;
  }  
  if (img.dataset.bound) return;

  // 접근성: 키보드 포커스/역할 부여
  img.setAttribute("tabindex", "0");
  img.setAttribute("role", "button");
  img.style.cursor = "pointer";

  const goScanManually = (e) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();

    // 세션이 아직이면 먼저 시작
    if (!sessionStarted) {
      console.log("▶️ 수동 진행(이미지): 세션 시작");
      startKioskFlow(); // 내부에서 sessionStarted 송신 + basket 화면 진입
    }

    // 바로 스캔 화면으로
    console.log("⏭️ 수동 진행(이미지): screen-scan으로 전환");
    goToScreen("screen-scan");
    
    // 비전 시작 신호
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: "startVision", by: "manual", ts: new Date().toISOString() }));
    } else {
      console.warn("⚠️ WS 미연결 상태에서 수동 진행 실행됨");
    }
  };
  
  img.addEventListener("click", goScanManually);
  img.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") goScanManually(e);
  });
  
  img.dataset.bound = "true"
}

function goToScreen(screenId) {
  const screens = document.querySelectorAll(".screen");
  screens.forEach((s) => s.classList.remove("active"));

  const target = document.getElementById(screenId);
  if (target) {
    target.classList.add("active");
    __currentScreenId = screenId;

    if (screenId === "screen-basket") onEnterScreenBasket();
    if (screenId === "screen-scan") onEnterScreenScan();
    if (screenId === "screen-card") onEnterScreenCard(); // 테스트용, 나중에 삭제 
  }
}

// 카드 태깅 자동 전환 (테스트용)
function clearUITimers() {
  if (receiptTimer) { clearTimeout(receiptTimer); receiptTimer = null; }
  if (goodbyeTimer) { clearTimeout(goodbyeTimer); goodbyeTimer = null; }
}

// 카드 태깅 자동 전환 (테스트용)
function scheduleAutoAdvanceFromCard() {
  // 중복 방지
  if (receiptTimer) clearTimeout(receiptTimer);
  if (goodbyeTimer) clearTimeout(goodbyeTimer);

  console.log("⏳ 7초 뒤 영수증 → 3초 뒤 종료 화면으로 자동 전환");

  receiptTimer = setTimeout(() => {
    goToScreen("screen-receipt");

    goodbyeTimer = setTimeout(() => {
      goToScreen("screen-goodbye");
      resetKioskFlow(); // 세션/상태 초기화
    }, 3000);

  }, 7000);
}

// ----------------------
// 세션 제어
// ----------------------
function startKioskFlow() {
  if (sessionStarted) {
    console.log("⚠️ 이미 세션 진행 중");
    return;
  }
  sessionStarted = true;

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "sessionStarted" }));
  }

  goToScreen("screen-basket");
}

function resetKioskFlow() {
  sessionStarted = false;

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "sessionEnded" }));
  }

  // 타이머 정리
  if (receiptTimer) { clearTimeout(receiptTimer); receiptTimer = null; }
  if (goodbyeTimer) { clearTimeout(goodbyeTimer); goodbyeTimer = null; }

  goToScreen("screen-start");
  sessionStorage.clear();
}

// ----------------------
// 화면 진입 이벤트
// ----------------------
function onEnterScreenBasket() {
  console.log("🛑 Pi의 basketStable 신호 대기중…");
}

function onEnterScreenScan() {
  console.log("📤 startVision 전송");
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "startVision" }));
  }
}

// 카드 태깅 자동 전환 핸들러 (테스트용)
function onEnterScreenCard() {
  console.log("💳 카드 태깅 화면 진입");
  clearUITimers();
  scheduleAutoAdvanceFromCard(); // 7초 → 3초 자동 전환
}

// ----------------------
// 버튼 이벤트 바인딩
// ----------------------
function setupStartButton() {
  // id 또는 class 둘 다 허용
  const btn = document.querySelector("#start-btn, .start-btn");
  if (!btn) {
    console.warn("⚠️ 시작 버튼을 찾을 수 없습니다. (#start-btn 또는 .start-btn)");
    return;
  }
  if (btn.dataset.bound) return;

  btn.addEventListener("click", (e) => {
    // 폼 안에 있으면 새로고침 막기
    e.preventDefault?.();
    e.stopPropagation?.();
    console.log("▶️ 시작 버튼 클릭 → 세션 시작");
    startKioskFlow();
  });
  btn.dataset.bound = "true";
}

// ----------------------
// WebSocket 연결
// ----------------------
function connectWS() {
  ws = new WebSocket(`ws://${window.location.hostname}:3000`);

  ws.onopen = () => {
    console.log("✅ WS 연결됨");
  };

  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);
    const kind = data.type || data.action;

    if (kind === "startKioskByLidar") {
      console.log("📡 라이다 감지 → 세션 시작");
      startKioskFlow();
    }

    if (kind === "basketStable" && __currentScreenId === "screen-basket") {
      console.log("✅ 안정 판정 → scan 화면으로 전환");
      goToScreen("screen-scan");
    }

    if (kind === "objectDetected") {
      console.log("🎯 YOLO 탐지:", data.product_name);
      detectedProductName = data.product_name;
    }

    if (kind === "scanResult") {
      console.log("🧺 스캔 결과:", data);
    }

    if (kind === "rfidDetected") {
      console.log("💳 RFID UID:", data.uid);

      if (TEST_CARD_AUTOPASS) {
        goToScreen("screen-card");
        // onEnterScreenCard()에서 자동 전환 스케줄링 수행
      } else {
        // 원래 카드 바인딩 API 호출 로직을 여기다 넣으면 됨
        goToScreen("screen-card");
      }
    }

    // 자동 전환 테스트용, 나중에 삭제 
    if (kind === "rfidTagged") {
      console.log("💳 RFID Tagged:", data.uid);
      goToScreen("screen-card");
    }

    if (kind === "scanComplete") {
      console.log("🔚 스캔 완료(reason:", data.reason, ") → screen-card로 전환");
      if (ws?.readyState === WebSocket.OPEN){
        ws.send(JSON.stringify({ action: "stopVision" })); 
      }
      goToScreen("screen-card");
    }
  };

  ws.onclose = () => {
    console.log("❌ WS 연결 종료, 재시도 중…");
    setTimeout(connectWS, 2000);
  };
}

// ----------------------
// 실행 시작
// ----------------------
window.onload = () => {
  connectWS();
  setupStartButton();
  setupBasketImageAdvance();
  goToScreen("screen-start");
};