// =======================
// Kiosk Front (public/app.js)
// =======================

let wsLocal;  // ★★★ :3000 WS (로컬 컨트롤러/YOLO/라이다)
let wsApi;    // ★★★ :4000/ws WS (결제/세션 브로드캐스트)
let sessionStarted = false;
let __currentScreenId = "screen-start";

// 현재 세션코드(WS SUB용)
window.currentSessionCode = null;

// 상품 목록 / 감지 결과 저장
let storeProducts = [];
let detectedProductName = null;

// 타이머 변수
let receiptTimer = null;
let goodbyeTimer = null;
let basketTimer = null;

const TEST_CARD_AUTOPASS = false; // 서버 준비 전엔 true, 완성되면 false

let isCheckoutInProgress = false;
let lastCardEventAt = 0;

// === 확인화면 API/상태 ===
const API_BASE = "http://13.209.14.101:4000/api";

let itemsState = {
  page: 1,
  pageSize: 3,
  rows: []
};

// 전역 가드 
let visionRequested = false; // ★ 스캔 화면에서 startVision 1회만
let rescanMode = false; // 🔁 '다시 스캔' 단계 여부

const PRODUCT_BY_SPID = Object.create(null);
let   __productMasterLoaded = false;

// 엔드포인트 후보(서버 수정 없이 최대한 유연하게 시도)
const PRODUCT_ENDPOINTS = [
  `${API_BASE}/store-products?store_id=1`,
  `${API_BASE}/store-products`,
  `${API_BASE}/products?store_id=1`,
  `${API_BASE}/products`,
];

let __checkoutLock = false;

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

function onEnterScreenReceipt() {
  console.log("🧾 영수증 화면 진입");
  clearUITimers();
  receiptTimer = setTimeout(() => {
    goToScreen("screen-goodbye");
    goodbyeTimer = setTimeout(() => {
      resetKioskFlow();
    }, 2000);
  }, 3000);
}

function goToScreen(screenId) {
  const screens = document.querySelectorAll(".screen");
  screens.forEach((s) => s.classList.remove("active"));

  const target = document.getElementById(screenId);
  if (target) {
    // ★★★ start로 갈 때 서버에 종료 신호 보강 (중복 전송 방지 가드 포함)
    if (screenId === "screen-start") {
      if (sessionStarted) {
        sessionStarted = false;            // 로컬 플래그 정리
        clearUITimers();
        visionRequested = false;
        if (wsLocal?.readyState === WebSocket.OPEN) {
          wsLocal.send(JSON.stringify({ action: "sessionEnded" })); // 서버가 closeSession 실행
        }
      }
    }

    target.classList.add("active");
    __currentScreenId = screenId;

    if (screenId === "screen-basket") onEnterScreenBasket();
    if (screenId === "screen-scan")   onEnterScreenScan();
    if (screenId === "screen-items")  onEnterScreenItems();
    if (screenId === "screen-rescan") onEnterScreenRescan();
    if (screenId === "screen-card")   onEnterScreenCard();
    if (screenId === "screen-receipt") onEnterScreenReceipt();
  }
}

function clearUITimers() {
  if (receiptTimer) { clearTimeout(receiptTimer); receiptTimer = null; }
  if (goodbyeTimer) { clearTimeout(goodbyeTimer); goodbyeTimer = null; }
}

// === 확인 화면: 데이터 가져오기/렌더 ===
async function fetchReviewSnapshot(sessionCode) {
  if (!sessionCode) throw new Error("no sessionCode");

  // 가능하면 마스터를 잠깐 기다렸다가 보강
  await ensureProductMasterLoaded(1500);

  const r = await fetch(`${API_BASE}/purchase-sessions/${encodeURIComponent(sessionCode)}`, {
    headers: { "Accept": "application/json" }
  });
  if (!r.ok) throw new Error("failed to fetch session");
  const data = await r.json();

  const items = (data.items || []).map(x => {
    const spid = x.store_product_id;
    const m = PRODUCT_BY_SPID[spid] || {};

    const name = x.product_name || m.name || `#${spid}`;
    const img  = x.image_url    || m.image_url || "/assets/placeholder.png";
    const unit = Number(x.unit_price ?? m.price ?? 0);
    const qty  = Number(x.quantity || 1);

    return {
      spid, name, img, qty, unit,
      line: unit * qty,
    };
  });

  const total = Number(data.session?.total_price ?? items.reduce((s, it) => s + it.line, 0));

  return { items, total };
}


function updateTotal(won) {
  const el = document.getElementById("items-total");
  if (el) el.textContent = `${Number(won).toLocaleString()} 원`;
}

function renderItemsTable() {
  const wrap = document.getElementById("items-table");
  if (!wrap) return;

  const { page, pageSize, rows } = itemsState;
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const view = rows.slice((page - 1) * pageSize, page * pageSize);

  wrap.innerHTML = view.map(r => `
    <div class="item-row" data-spid="${r.spid}">
      <img class="item-thumb" src="${r.img}" alt="">
      <div class="item-name">${r.name}</div>
      <div class="qty-box readonly">
        <span class="qty-val">${r.qty}</span>
      </div>
      <div class="item-price">${(r.unit * r.qty).toLocaleString()} 원</div>
    </div>
  `).join("");

  const pageEl = document.getElementById("items-page");
  if (pageEl) pageEl.textContent = `${page} / ${totalPages}`;

  const prev = document.getElementById("items-prev");
  const next = document.getElementById("items-next");
  if (prev) prev.disabled = (page <= 1);
  if (next) next.disabled = (page >= totalPages);
}

function onEnterScreenRescan() {
  console.log("🔁 다시 스캔 화면 진입");
  // '다시 스캔'은 이전 startVision 여부와 상관없이 즉시 재시작
  if (wsLocal?.readyState === WebSocket.OPEN) {
    wsLocal.send(JSON.stringify({
      action: "startVision",
      type: "startVision",
      mode: "rescan",
      ts: Date.now()
    }));
  } else {
    console.warn("⚠️ wsLocal 미연결 상태에서 재스캔 진입");
  }
}

async function preloadStoreProducts() {
  for (const url of PRODUCT_ENDPOINTS) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      if (!r.ok) continue;
      const arr = await r.json();

      // 다양한 스키마를 관용적으로 흡수
      (arr || []).forEach(p => {
        const id    = p.id ?? p.store_product_id ?? p.spid;
        if (!id) return;
        const name  = p.name ?? p.product_name ?? p.title ?? `#${id}`;
        const img   = p.image_url ?? p.image ?? p.thumb ?? null;
        const price = Number(p.price ?? p.unit_price ?? p.cost ?? 0);

        PRODUCT_BY_SPID[id] = { name, image_url: img, price };
      });

      __productMasterLoaded = true;
      console.log("[PRODUCT] master loaded:", Object.keys(PRODUCT_BY_SPID).length, "items from", url);
      return; // 첫 성공점에서 종료
    } catch (_) { /* 다음 후보로 */ }
  }
  console.warn("[PRODUCT] master load failed (all endpoints)");
}

// 필요 시 기다리는 헬퍼(최대 1.5s)
async function ensureProductMasterLoaded(timeoutMs = 1500) {
  if (__productMasterLoaded) return;
  const start = Date.now();
  while (!__productMasterLoaded && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 100));
  }
}

async function checkoutSession(code) {
  if (!code || __checkoutLock) return null;
  __checkoutLock = true;
  try {
    const res = await fetch(`http://13.209.14.101:4000/api/purchase-sessions/${encodeURIComponent(code)}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approve: true })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error || `checkout failed: ${res.status}`);
    console.log("✅ checkout ok:", json);
    return json;
  } catch (e) {
    console.error("❌ checkout error:", e);
    return null;
  } finally {
    __checkoutLock = false;
  }
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
  visionRequested = false; // 초기화
}

// ----------------------
// 화면 진입 이벤트
// ----------------------
function onEnterScreenBasket() {
  console.log("🛑 Pi의 basketStable 신호 대기중…");

  // 기존 타이머 있으면 해제
  if (basketTimer) { clearTimeout(basketTimer); basketTimer = null; }

  // 3초 후 자동 진행
  basketTimer = setTimeout(() => {
    const payload = { ts: Date.now(), synthetic: true, sessionId: window.sessionId || 'default' };

    // // 1) (선택) 안정 신호 합성 → 서버/다른 클라이언트에도 알리기
    // if (wsLocal?.readyState === WebSocket.OPEN) {
    //   wsLocal.send(JSON.stringify({ type: "basketStable", ...payload }));
    // }

    // 2) 스캔 화면으로 전환 (→ onEnterScreenScan에서 startVision 전송)
    console.log("⏱️ 3초 경과 → scan으로 전환");
    goToScreen("screen-scan");
  }, 3000);
  
  console.log("⏱️ basketTimer 3s armed");
}

function onEnterScreenScan() {
  // ★ 혹시 남아있으면 정리
  if (basketTimer) { clearTimeout(basketTimer); basketTimer = null; }

//   console.log("📤 startVision 전송 (로컬)");
//   if (wsLocal?.readyState === WebSocket.OPEN) {
//     wsLocal.send(JSON.stringify({ action: "startVision" }));
//   }
// }

  if (!visionRequested) {
    visionRequested = true;
    console.log("📤 startVision 전송(1회) (로컬)");
    if (wsLocal?.readyState === WebSocket.OPEN) {
      // 호환을 위해 action과 type 둘 다 함께 보냄
      wsLocal.send(JSON.stringify({ action: "startVision", type: "startVision", ts: Date.now() }));
    }
  }
}

function onEnterScreenCard() {
  console.log("💳 카드 태깅 화면 진입");
  clearUITimers();
}

// 확인 화면 진입 훅
async function onEnterScreenItems() {
  console.log("🧾 확인 화면 진입 → 세션 스냅샷 요청");
  const code = window.currentSessionCode || localStorage.getItem('sessionCode');
  if (!code) {
    console.warn("Error: no sessionCode (cannot fetch review snapshot)");
    return;
  }
  try {
    itemsState.page = 1;
    const snap = await fetchReviewSnapshot(code);
    itemsState.rows = snap.items;
    renderItemsTable();
    updateTotal(snap.total);
  } catch (e) {
    console.warn("fetchReviewSnapshot 실패", e);
  }
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

function setupItemsButtons() {
  const payBtn = document.querySelector("#go-card");     // 확인 화면의 "결제하기"
  const prev   = document.querySelector("#items-prev");  // 이전 페이지
  const next   = document.querySelector("#items-next");  // 다음 페이지
  // ──다시 스캔 하기 ───────────────────────────────
  const rescanBtn = document.getElementById("btn-rescan");
  if (rescanBtn && !rescanBtn.dataset.bound) {
    rescanBtn.addEventListener("click", (e) => {
      e.preventDefault?.();
      e.stopPropagation?.();

      console.log("🔁 [다시 스캔 하기] 클릭");
      rescanMode = true;         // 재스캔 단계 플래그 ON
      visionRequested = false;   // 필요 시 일반 스캔 가드 초기화
      // (선택) 확인표에서 임시 데이터 리셋하고 싶으면 여기서 처리
      // itemsState.rows = []; renderItemsTable(); updateTotal(0);

      showScreen?.("screen-rescan"); // 프로젝트에 showScreen 없으면:
      goToScreen("screen-rescan");
    });
    rescanBtn.dataset.bound = "true";
  }

  if (!payBtn || payBtn.dataset.bound) return;

  payBtn.addEventListener("click", (e) => {
    e.preventDefault?.();
    e.stopPropagation?.();
    console.log("🧾 결제하기 클릭 → 카드 태깅 화면으로");
    goToScreen("screen-card");
    // 필요 시 로컬/서버에 “카드 대기” 알림을 보낼 수도 있음:
    // wsLocal?.readyState === WebSocket.OPEN &&
    //   wsLocal.send(JSON.stringify({ action: "awaitingCard" }));
  });
  payBtn.dataset.bound = "true";

    // 페이지 버튼 리스너
    if (prev && !prev.dataset.bound) {
      prev.addEventListener("click", () => {
        if (itemsState.page > 1) { itemsState.page--; renderItemsTable(); }
      });
      prev.dataset.bound = "true";
    }
    if (next && !next.dataset.bound) {
      next.addEventListener("click", () => {
        const totalPages = Math.max(1, Math.ceil(itemsState.rows.length / itemsState.pageSize));
        if (itemsState.page < totalPages) { itemsState.page++; renderItemsTable(); }
      });
      next.dataset.bound = "true";
  }
}

// ----------------------
// API WS(4000) : 결제/세션 이벤트 전용
// ----------------------
function connectApiWS() {
  // EC2 결제 서버 WS 허브
  wsApi = new WebSocket(`ws://13.209.14.101:4000/ws`);

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
      console.log("[wsApi] SUB_OK:", data.session_code || data.code);
      // 혹시 아직 없다면 여기서도 저장
      if (!window.currentSessionCode && (data.session_code || data.code)) {
        window.currentSessionCode = data.session_code || data.code;
        console.log("✅ currentSessionCode set by wsApi:", window.currentSessionCode);
      }
      return;
    }

    // let checkoutInFlight = false;
    if (
      (kind === "SESSION_CARD_BOUND" && data.session_code === currentSessionCode) ||
      kind === "cardBound"
    ) {
      const now = Date.now();
      if (now - lastCardEventAt < 1500) return; // 1.5초 내 중복 무시
      lastCardEventAt = now;

      if (isCheckoutInProgress) return;          // 이미 결제 중이면 무시
      isCheckoutInProgress = true;

      (async () => {
        try {
          if (__currentScreenId !== "screen-card") goToScreen("screen-card");

          const code = window.currentSessionCode || localStorage.getItem('sessionCode');
          if (!code) {
            console.warn("⚠️ no sessionCode for checkout");
            return;
          }

          // 1) 체크아웃 호출 (이미 만들어둔 함수 재사용 권장)
          console.log("🧾 calling checkout…", code);
          const json = await checkoutSession(code);  // ← 위에 정의된 checkoutSession 사용
          if (json && (json?.session?.status === 'PAID' || json?.status === 'PAID' || json?.ok === true)) {
            goToScreen('screen-receipt');
            clearUITimers();
            receiptTimer = setTimeout(() => {
              goToScreen('screen-goodbye');
              goodbyeTimer = setTimeout(() => resetKioskFlow(), 2000);
            }, 3000);
            return;
          }

          // 2) 상태가 모호하면 짧게 폴링해서 PAID 확인
          console.log("☑️ checkout ok(HTTP) but status unclear → short poll");
          const started = Date.now();
          while (Date.now() - started < 3000) {
            await new Promise(r => setTimeout(r, 500));
            const pr = await fetch(`${API_BASE}/purchase-sessions/${encodeURIComponent(code)}`, {
              headers: { "Accept": "application/json" }
            });
            const pobj = await pr.json().catch(() => ({}));
            const pstatus = pobj?.session?.status;
            console.log("[poll] after checkout status:", pstatus);
            if (pstatus === "PAID") {
              goToScreen("screen-receipt");
              clearUITimers();
              receiptTimer = setTimeout(() => {
                goToScreen("screen-goodbye");
                goodbyeTimer = setTimeout(() => resetKioskFlow(), 2000);
              }, 3000);
              return;
            }
          }

          console.warn("⚠️ checkout ok but PAID not confirmed; stay on card screen");
        } catch (err) {
          console.error("❌ checkout error:", err);
        } finally {
          // 3초 뒤 락 해제(중복 결제 방지)
          setTimeout(() => (isCheckoutInProgress = false), 3000);
        }
      })();

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

    const sid = window.currentSessionCode || localStorage.getItem('sessionCode') || 'default';

    // 프론트 자신을 서버에 등록
    wsLocal.send(JSON.stringify({
      type: "hello",
      role: "front",
      sessionId: sid
    }));
    
    console.log(`[HELLO] sent to local WS (role=front, sid=${sid})`);

  };

  wsLocal.onmessage = (e) => {
    const data = JSON.parse(e.data);
    const kind = data.type || data.action;

    if (kind === 'sessionStarted') {
      const sid =
        data.session?.session_code ||
        data.session_code ||
        data.sessionCode ||
        data.code;
      if (!sid) return;
      window.currentSessionCode = sid;
      localStorage.setItem('sessionCode', sid);
      console.log(`[SESSION] started: ${sid}`);
      // 여기서 바로 wsApi SUB
      if (wsApi?.readyState === WebSocket.OPEN) {
        wsApi.send(JSON.stringify({ type: 'SUB', session_code: sid }));
        console.log('[wsApi] SUB sent via local sessionStarted:', sid);
      }
      return;
    }

    // 서버 주도 화면 전환
    if (kind === "goToScreen" && data.screen) {
      // 1) 세션코드가 오면 먼저 저장
      if (data.sessionCode) {
        window.currentSessionCode = data.sessionCode;
        localStorage.setItem('sessionCode', data.sessionCode);
      }
    // 2) 화면 전환
    if (__currentScreenId !== data.screen) {
      console.log("[wsLocal] goToScreen:", data.screen);
      goToScreen(data.screen);
    }
    return;
  }


    if (kind === "startKioskByLidar") {
      console.log("📡 라이다 감지 → 세션 시작");
      startKioskFlow();
    }

    if (kind === "basketStable" && __currentScreenId === "screen-basket") {
      // ★ 합성/실신호 구분 없이 타이머 취소
      if (basketTimer) { clearTimeout(basketTimer); basketTimer = null; }

      console.log("✅ 안정 판정 → scan 화면으로 전환");
      goToScreen("screen-scan");
      return;
    }

    // // ── basketStable 자동 합성 타이머 ──────────────────────────────
    // if (kind === 'goToScreen' && parsed.screen === 'screen-basket') {
    //   const sessionId = parsed.sessionId || ws.sessionId || 'default';
    //   armBasketTimer(sessionId, 3000);     // ← 세션별 타이머
    //   console.log(`[AUTO] arm 3s for basket sid=${sessionId}`);
    //   return;
    // }

    // // 화면 이탈 시 정리
    // if (kind === 'goToScreen' && parsed.screen !== 'screen-basket') {

    //   if (basketTimer) { clearTimeout(basketTimer); basketTimer = null; }
    //     console.log('✅ 안정 판정 → scan 화면으로 전환');
    //     goToScreen('screen-scan');
    //     return;
    // }

    

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

    // 스캔 종료 신호 → 확인 화면으로
    if (kind === "scanComplete") {
      if (data.sessionCode) {
        window.currentSessionCode = data.sessionCode;
        localStorage.setItem('sessionCode', data.sessionCode);
        console.log("[FRONT] sessionCode set from scanComplete:", window.currentSessionCode);
      }
      if (wsLocal?.readyState === WebSocket.OPEN) {
        wsLocal.send(JSON.stringify({ action: "stopVision" }));
      }

      // 🔁 재스캔이면 바로 카드화면으로, 아니면 확인화면으로
      if (rescanMode) {
        rescanMode = false;     // 한 번 쓰고 끔
        goToScreen("screen-card");
      } else {
        goToScreen("screen-items");
      }

      visionRequested = false;
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
    if (kind === "sessionStarted") {
      // 다양한 키를 수용
      const code =
        data.session?.session_code ||
        data.session_code ||
        data.sessionCode ||
        data.code;
      if (!code) return; // 로컬 신호에 코드가 없는 경우도 있음

      // 전역(window)에 저장해야 화면/API에서 동일 값 사용
      window.currentSessionCode = code;
      console.log("[wsLocal] sessionStarted:", window.currentSessionCode);

      // 코드 알게 되면 wsApi에 SUB
      if (wsApi?.readyState === WebSocket.OPEN) {
        wsApi.send(JSON.stringify({ type: "SUB", session_code: window.currentSessionCode }));
        console.log("[wsApi] SUB sent via local sessionStarted:", window.currentSessionCode);
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
let __pollTimer = null;
function startSessionPoll() {
  if (__pollTimer) return;
  __pollTimer = setInterval(async () => {
    if (!currentSessionCode) return;
    try {
      const r = await fetch(`http://13.209.14.101:4000/api/purchase-sessions/${encodeURIComponent(currentSessionCode)}`);
      if (!r.ok) return;
      const data = await r.json();
      const status = data?.session?.status;
      // console.log('[POLL] status =', status);

      // ✅ 여기서는 PAID에서만 넘어가게
      if (status === 'PAID') {
        goToScreen('screen-receipt');
        clearInterval(__pollTimer);
        __pollTimer = null;
      }
      // CARD_BOUND 에서는 아무 것도 하지 않음 (체크아웃은 wsApi쪽에서)
    } catch (e) {
      console.warn('[POLL] error', e);
    }
  }, 1000);
}

// ----------------------
// 실행 시작
// ----------------------
window.onload = () => {
  preloadStoreProducts(); 
  connectLocalWS(); // :3000
  connectApiWS();   // :4000/ws
  setupStartButton();
  setupBasketImageAdvance();
  setupItemsButtons();
  goToScreen("screen-start");

  // (선택) 폴백도 켜두면 더 안전
  startSessionPoll();
};
