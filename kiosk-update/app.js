// =======================
// Kiosk Front (public/app.js)
// =======================

let wsLocal;  // ★★★ :3000 WS (로컬 컨트롤러/YOLO/라이다)
let wsApi;    // ★★★ :4000/ws WS (결제/세션 브로드캐스트)
let sessionStarted = false;
let __currentScreenId = "screen-start";

// 현재 세션코드(WS SUB용)
let currentSessionCode = null;

// 상품 목록 / 감지 결과 저장
let storeProducts = [];
let detectedProductName = null;

// 타이머 변수
let receiptTimer = null;
let goodbyeTimer = null;

const TEST_CARD_AUTOPASS = false; // 서버 준비 전엔 true, 완성되면 false

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

    if (!sessionStarted) {
      console.log("▶️ 수동 진행(이미지): 세션 시작");
      startKioskFlow(); // 내부에서 sessionStarted 송신 + basket 화면 진입
    }

    console.log("⏭️ 수동 진행(이미지): screen-scan으로 전환");
    goToScreen("screen-scan");
    
    // 비전 시작 신호 → 로컬 컨트롤러에 보냄
    if (wsLocal?.readyState === WebSocket.OPEN) {
      wsLocal.send(JSON.stringify({ action: "startVision", by: "manual", ts: new Date().toISOString() }));
    } else {
      console.warn("⚠️ wsLocal 미연결 상태에서 수동 진행 실행됨");
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
    if (screenId === "screen-scan")   onEnterScreenScan();
    if (screenId === "screen-card")   onEnterScreenCard(); // 테스트용, 나중에 삭제 
  }
}

function clearUITimers() {
  if (receiptTimer) { clearTimeout(receiptTimer); receiptTimer = null; }
  if (goodbyeTimer) { clearTimeout(goodbyeTimer); goodbyeTimer = null; }
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

  // 세션 시작 알림 → 로컬 컨트롤러에 보냄
  if (wsLocal?.readyState === WebSocket.OPEN) {
    wsLocal.send(JSON.stringify({ action: "sessionStarted" }));
  }

  goToScreen("screen-basket");
}

function resetKioskFlow() {
  sessionStarted = false;

  // 세션 종료 알림 → 로컬 컨트롤러에 보냄
  if (wsLocal?.readyState === WebSocket.OPEN) {
    wsLocal.send(JSON.stringify({ action: "sessionEnded" }));
  }

  clearUITimers();
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
  console.log("📤 startVision 전송 (로컬)");
  if (wsLocal?.readyState === WebSocket.OPEN) {
    wsLocal.send(JSON.stringify({ action: "startVision" }));
  }
}

function onEnterScreenCard() {
  console.log("💳 카드 태깅 화면 진입");
  clearUITimers();
}

// ----------------------
// 버튼 이벤트 바인딩
// ----------------------
function setupStartButton() {
  const btn = document.querySelector("#start-btn, .start-btn");
  if (!btn) {
    console.warn("⚠️ 시작 버튼을 찾을 수 없습니다. (#start-btn 또는 .start-btn)");
    return;
  }
  if (btn.dataset.bound) return;

  btn.addEventListener("click", (e) => {
    e.preventDefault?.();
    e.stopPropagation?.();
    console.log("▶️ 시작 버튼 클릭 → 세션 시작");
    startKioskFlow();
  });
  btn.dataset.bound = "true";
}

// ----------------------
// API WS(4000) : 결제/세션 이벤트 전용
// ----------------------
function connectApiWS() {
  // EC2 결제 서버 WS 허브
  wsApi = new WebSocket(`ws://43.201.105.163:4000/ws`);

  wsApi.onopen = () => {
    console.log("✅ wsApi 연결됨 (4000/ws)");
    // 이미 세션코드를 알고 있으면 즉시 SUB
    if (currentSessionCode) {
      wsApi.send(JSON.stringify({ type: "SUB", session_code: currentSessionCode }));
      console.log("[wsApi] SUB sent after open:", currentSessionCode);
    }
  };

  wsApi.onmessage = (e) => {
    const data = JSON.parse(e.data);
    const kind = data.type || data.action;

    // 결제 서버가 세션 시작을 브로드캐스트하는 경우 → 코드 저장 + SUB
    if (kind === "sessionStarted" && data.session?.session_code) {
      currentSessionCode = data.session.session_code;
      console.log("[wsApi] sessionStarted:", currentSessionCode);
      if (wsApi?.readyState === WebSocket.OPEN) {
        wsApi.send(JSON.stringify({ type: "SUB", session_code: currentSessionCode }));
        console.log("[wsApi] SUB sent:", currentSessionCode);
      }
      return;
    }

    if (kind === "SUB_OK") {
      console.log("[wsApi] SUB_OK:", data.session_code);
      return;
    }

    if (kind === "SESSION_CARD_BOUND" && data.session_code === currentSessionCode) {
    console.log("[wsApi] SESSION_CARD_BOUND:", data.session_code);
      // 1) 화면은 카드로 고정(사용자 피드백)
      if (__currentScreenId !== "screen-card") goToScreen("screen-card");
  
      // 2) 결제 확정 호출
      fetch(`http://43.201.105.163:4000/api/purchase-sessions/${encodeURIComponent(currentSessionCode)}/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approve: true })
      })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.error || `checkout failed: ${res.status}`);
        console.log("✅ checkout ok:", json);
  
        // 3) 영수증 화면으로 전환 + 자동 타이머
        goToScreen("screen-receipt");
        clearUITimers();
        receiptTimer = setTimeout(() => {
          goToScreen("screen-goodbye");
          goodbyeTimer = setTimeout(() => resetKioskFlow(), 2000);
        }, 3000);
      })
      .catch((err) => {
        console.error("❌ checkout error:", err);
        // 실패 시 카드 화면 유지(사용자에게 에러 안내 가능)
      });
      return;
    }

    // (선택) 결제 완료/실패 등 추가 이벤트
    if (kind === "paymentCompleted") {
      console.log("[wsApi] paymentCompleted:", data);
      // goToScreen("screen-receipt");
      return;
    }
  };

  wsApi.onclose = () => {
    console.log("❌ wsApi 연결 종료, 재시도 예정…");
    setTimeout(connectApiWS, 2000);
  };
}

// ----------------------
// Local WS(3000) : 라이다/YOLO/진행 제어 전용
// ----------------------
function connectLocalWS() {
  wsLocal = new WebSocket(`ws://${window.location.hostname}:3000`);

  wsLocal.onopen = () => {
    console.log("✅ wsLocal 연결됨 (3000)");
  };

  wsLocal.onmessage = (e) => {
    const data = JSON.parse(e.data);
    const kind = data.type || data.action;

    // 서버 주도 화면 전환
    if (kind === "goToScreen" && data.screen) {
      console.log("[wsLocal] goToScreen:", data.screen);
      goToScreen(data.screen);
      return;
    }

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

    if (kind === "rfidDetected" || kind === "rfidTagged") {
      console.log("💳 RFID UID:", data.uid);
      goToScreen("screen-card");
    }

    // 스캔 종료 신호 → 카드 화면으로
    if (kind === "scanComplete") {
      console.log("🔚 스캔 완료 → 카드화면으로");
      if (wsLocal?.readyState === WebSocket.OPEN){
        wsLocal.send(JSON.stringify({ action: "stopVision" })); // 파이썬 YOLO 중지 지시(안전)
      }
      goToScreen("screen-card");
      return;
    }

    // “카드 태깅 대기” 신호 → 카드 화면 유지/진입
    if (kind === "awaitingCard") {
      console.log("⏳ 카드 태깅 대기중…");
      if (__currentScreenId !== "screen-card") goToScreen("screen-card");
      return;
    }

    // (서버) 카드 UID 바인딩 완료
    if (kind === "cardBound") {
      console.log("💳 cardBound:", data.session_code);
      if (__currentScreenId !== "screen-card") goToScreen("screen-card");
      return;
    }

    // (서버) 결제 완료 → 영수증 → 굿바이 → 초기화(타이머)
    if (kind === "purchaseCompleted") {
      console.log("✅ purchaseCompleted:", data);
      goToScreen("screen-receipt");

      // 타이머(원하는 시간으로 조절 가능)
      clearUITimers();  // 기존 유틸 재사용
      receiptTimer = setTimeout(() => {
        goToScreen("screen-goodbye");
        goodbyeTimer = setTimeout(() => {
          resetKioskFlow();      // 세션/화면 초기화
        }, 2000);                // 굿바이 유지 시간
      }, 3000);                  // 영수증 유지 시간
      return;
    }


    // ★ 로컬 서버가 세션코드를 알려줄 수 있는 경우(있을 때만):
    if (kind === "sessionStarted" && data.session?.session_code) {
      currentSessionCode = data.session.session_code;
      console.log("[wsLocal] sessionStarted:", currentSessionCode);
      // 코드 알게 되면 wsApi에 SUB
      if (wsApi?.readyState === WebSocket.OPEN) {
        wsApi.send(JSON.stringify({ type: "SUB", session_code: currentSessionCode }));
        console.log("[wsApi] SUB sent via local sessionStarted:", currentSessionCode);
      }
      return;
    }
  };

  wsLocal.onclose = () => {
    console.log("❌ wsLocal 연결 종료, 재시도 예정…");
    setTimeout(connectLocalWS, 2000);
  };
}

// ----------------------
// (옵션) 폴백: WS가 꼬여도 1초마다 상태 폴링해서 전환
// ----------------------
let __pollTimer = null;
function startSessionPoll() {
  if (__pollTimer) return;
  __pollTimer = setInterval(async () => {
    if (!currentSessionCode) return;
    try {
      const r = await fetch(`http://43.201.105.163:4000/api/purchase-sessions/${currentSessionCode}`);
      if (!r.ok) return;
      const data = await r.json();
      const status = data?.session?.status;
      if (status === 'CARD_BOUND' || status === 'PAID') {
        console.log('[POLL] status =', status, '→ 화면 전환');
        goToScreen('screen-receipt'); // 필요 시 변경
        clearInterval(__pollTimer);
        __pollTimer = null;
      }
    } catch {}
  }, 1000);
}

// ----------------------
// 실행 시작
// ----------------------
window.onload = () => {
  connectLocalWS(); // :3000
  connectApiWS();   // :4000/ws
  setupStartButton();
  setupBasketImageAdvance();
  goToScreen("screen-start");

  // (선택) 폴백도 켜두면 더 안전
  startSessionPoll();
};
