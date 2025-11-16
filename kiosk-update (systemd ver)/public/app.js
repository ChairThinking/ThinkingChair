// =======================
// Kiosk Front (public/app.js)
// =======================

let wsLocal;  // ★★★ :3000 WS (로컬 컨트롤러/YOLO/라이다)
let wsApi;    // ★★★ :4000/ws WS (결제/세션 브로드캐스트)
let sessionStarted = false;
let __currentScreenId = "screen-start";
let __lockAfterCheckout = false; // 결제 이후 WS의 화면전환 간섭 차단용


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

const KIOSK_ID = (window.__ENV && window.__ENV.KIOSK_ID) || "KIOSK-01";
const STORE_ID = Number((window.__ENV && window.__ENV.STORE_ID) || 1);

// === 확인화면 API/상태 ===
const API_BASE = "http://13.209.14.101:4000/api";

let itemsState = {
  page: 1,
  pageSize: 3,
  rows: []
};

// 상단 유틸에 추가
function parseWon(v) {
  if (v == null) return 0;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  // "12,000원", " 12 000 " 등도 전부 정수로
  const n = parseInt(String(v).replace(/[^\d.-]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}


// 전역 가드 
let visionRequested = false; // ★ 스캔 화면에서 startVision 1회만

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

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  const target = document.getElementById(id);
  if (target) target.classList.add("active");
}


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
  // enterReceiptFlow()가 타이머를 관리한다.
  if (__lockAfterCheckout) return;
  // (수동 진입 등 다른 경로일 때만 기본 타이머를 쓰고 싶다면 아래 유지)
  clearUITimers();
  receiptTimer = setTimeout(() => {
    goToScreen("screen-goodbye");
    goodbyeTimer = setTimeout(() => {
      resetKioskFlow();
    }, 2000);
  }, 3000);
}

function goToScreen(screenId, opts = {}) {
  const screens = document.querySelectorAll(".screen");
  screens.forEach((s) => s.classList.remove("active"));
  const fromWs = !!opts.fromWs;   // WS에서 온 호출인지 여부
  console.log("[goToScreen]", screenId, "fromWs=", fromWs);

  showScreen(screenId); // 실제 DOM 전환

  const target = document.getElementById(screenId);
  if (target) {
    // ★★★ start로 갈 때 서버에 종료 신호 보강 (중복 전송 방지 가드 포함)
    if (screenId === "screen-start") {
      if (sessionStarted) {
        sessionStarted = false;            // 로컬 플래그 정리
        clearUITimers();
        visionRequested = false;
        sendSessionEnded('goto_screen_start').catch(()=>{});
      }
    }

    target.classList.add("active");
    __currentScreenId = screenId;

      // ★ WS에서 온 호출이면 다시 서버로 goToScreen을 보내지 않기
      if (!fromWs && wsLocal?.readyState === WebSocket.OPEN) {
        wsLocal.send(JSON.stringify({
          type: "goToScreen",
          screen: screenId,
          ts: Date.now(),
        }));
      }

    if (screenId === "screen-basket") onEnterScreenBasket();
    if (screenId === "screen-scan")   onEnterScreenScan();
    if (screenId === "screen-items")  onEnterScreenItems();
    if (screenId === "screen-card")   onEnterScreenCard();
    if (screenId === "screen-rescan") onEnterScreenRescan();
    if (screenId === "screen-receipt") onEnterScreenReceipt();
  }
}

function clearUITimers() {
  if (receiptTimer) { clearTimeout(receiptTimer); receiptTimer = null; }
  if (goodbyeTimer) { clearTimeout(goodbyeTimer); goodbyeTimer = null; }
}

// === 확인 화면: 데이터 가져오기/렌더 ===
// 그대로 교체: 세션 스냅샷을 더 탄탄하게
async function fetchReviewSnapshot(sessionCode) {
  if (!sessionCode) throw new Error("no sessionCode");

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

  // 🔴 여기! session.total_price는 신경 안 쓰고, 무조건 items에서 재계산
  const total = items.reduce((sum, it) => sum + it.line, 0);

  console.log("[review] session.total_price =", data.session?.total_price,
              "/ items.length =", items.length,
              "/ recomputed =", total,
              "/ items =", items);

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


//추가 -------------------------
async function getSessInfo(code) {
  try {
    const r = await fetch(`${API_BASE}/purchase-sessions/${encodeURIComponent(code)}`, { headers: {Accept:"application/json"} });
    const obj = await r.json().catch(()=>({}));
    return {
      status: obj?.session?.status,
      uidHash: obj?.session?.card_uid_hash || obj?.session?.uid_hash_hex || null
    };
  } catch { return {}; }
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
    const url = `${API_BASE}/purchase-sessions/${encodeURIComponent(code)}/checkout`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approve: true })
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error || `checkout failed: ${res.status}`);

    // ✅ 표준화: 서버가 status를 안 줘도 ok:true면 PAID로 취급
    const paid =
      json?.status === 'PAID' ||
      json?.session?.status === 'PAID' ||
      json?.ok === true;

    const normalized = {
      ok: !!paid,
      status: paid ? 'PAID' : (json?.status || json?.session?.status || null),
      total_price: json?.session?.total_price ?? json?.total ?? null,
      raw: json
    };

    console.log("✅ checkout ok (normalized):", normalized);
    return normalized;
  } catch (e) {
    console.error("❌ checkout error:", e);
    return null;
  } finally {
    __checkoutLock = false;
  }
}


function enterReceiptFlow() {
  __lockAfterCheckout = true;     // 이후 wsLocal의 goToScreen 간섭 무시
  clearUITimers();
  goToScreen('screen-receipt');
  receiptTimer = setTimeout(() => {
    goToScreen('screen-goodbye');
    goodbyeTimer = setTimeout(() => {
      resetKioskFlow();
      __lockAfterCheckout = false; // 새 라운드에서 다시 해제
    }, 2000);
  }, 3000);
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
    wsLocal.send(JSON.stringify({ action: "sessionstarted" }));
  }

  goToScreen("screen-basket");
}

function resetKioskFlow() {
  // 세션 종료 신호 (sid 포함, type=sessionEnded), 여기서만 
  sendSessionEnded('reset_flow').catch(()=>{});
  sessionStarted = false;

  clearUITimers();
  goToScreen("screen-start");
  sessionStorage.clear();
  visionRequested = false;
}

function checkoutOnce(sessionCode) {
  if (isCheckoutInProgress) return;
  isCheckoutInProgress = true;
    (async () => {
      try {
        const out = await checkoutSession(sessionCode);   // normalized 반환
        if (out?.ok) {
          // 서버가 status 안 줘도 프론트에서 즉시 영수증 플로우 진입
          enterReceiptFlow();
          // (옵션) 조용한 백그라운드 확인 3~5초
          const started = Date.now();
          while (Date.now() - started < 5000) {
            await new Promise(r => setTimeout(r, 500));
            try {
              const pr = await fetch(`${API_BASE}/purchase-sessions/${encodeURIComponent(sessionCode)}`, { headers: { "Accept":"application/json" }});
              const pobj = await pr.json().catch(()=> ({}));
              if (pobj?.session?.status === 'PAID') break;
            } catch(_) {}
          }
          return; // 화면은 이미 영수증 플로우로 이동
        }
        console.warn("⚠️ checkout ok but not confirmed; stay on card screen");
      } catch (e) {
        console.warn(e);
      } finally {
        setTimeout(() => { isCheckoutInProgress = false; }, 3000);
      }
    })();
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
  // // ★ 카드 바인딩 대기 창 오픈 (60초)
  // (async () => {
  //   try {
  //     const code = window.currentSessionCode || localStorage.getItem('sessionCode');
  //     if (!code) { console.warn("no sessionCode for bind-card-tags"); return; }
  //     await startBindCardTags(code, 60); // 아래 새 함수
  //     console.log("⏳ bind-card-tags armed (60s)");
  //   } catch (e) {
  //     console.warn("bind-card-tags arm failed:", e);
  //   }
  // })();

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



function onEnterScreenRescan() {
  console.log("🔁 다시 스캔 화면 진입");
  // 필요 시 타이머/가드 초기화
  // visionRequested = false;  // (선택) 일반 스캔 가드 초기화
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
  const payBtn    = document.querySelector("#btn-pay, #go-card");// 확인 화면의 "결제하기"
  const rescanBtn = document.querySelector("#btn-rescan"); //재스캔 버튼
  const prev   = document.querySelector("#items-prev");  // 이전 페이지
  const next   = document.querySelector("#items-next");  // 다음 페이지
  // 버튼마다 개별적으로 바인딩 (하나 없다고 전체 return 하지 않기)

  if (payBtn && !payBtn.dataset.bound) {
    payBtn.addEventListener("click", (e) => {
      e.preventDefault?.();
      e.stopPropagation?.();
      console.log("🧾 결제하기 클릭 → 카드 태깅 화면으로");
      goToScreen("screen-card");
    });
    payBtn.dataset.bound = "true";
  }

  // 다시 스캔하기
  if (rescanBtn && !rescanBtn.dataset.bound) {
  rescanBtn.addEventListener("click", (e) => {
    e.preventDefault?.();
    e.stopPropagation?.();
    console.log("🔁 [다시 스캔 하기] 클릭");

    // 1) 재스캔 모드 표시
    window.rescanMode = true;

    // 2) 서버(kioskSocket)에게 재스캔 시작 요청
    if (wsLocal?.readyState === WebSocket.OPEN) {
      wsLocal.send(JSON.stringify({
        type: "rescanStart",
        ts: Date.now(),
      }));
    }

    // 3) 화면을 먼저 전환
    goToScreen("screen-rescan");
  });
  rescanBtn.dataset.bound = "true";
}


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
const FRONT_CHECKOUT_FALLBACK = false; // 서버가 bind→checkout까지 처리하면 false

// 결제 전에 "카드 바운드가 DB에 반영됐는지" 확인 + 로그
async function waitBoundAndAllowed(sessionCode, timeoutMs = 3000, gapMs = 200) {
  const t0 = Date.now();
  let n = 0;
  while (Date.now() - t0 < timeoutMs) {
    n++;
    try {
      const r = await fetch(`${API_BASE}/purchase-sessions/${encodeURIComponent(sessionCode)}`, {
        headers: { Accept: 'application/json' }
      });
      const j = await r.json().catch(() => ({}));

      const sess   = j?.session || j;
      const status = (sess?.status || '').toUpperCase();
      const hash   = sess?.card_uid_hash || sess?.card_uid_hash_hex || null;

      // 🔎 LOG: 각 폴링 시도마다 상태/해시 표시
      console.log(
        `[bound-check] try#${n}`,
        { status, hasHash: !!hash, hashPreview: hash ? (hash.slice(0,8) + '…') : null }
      );

      // ✅ 해시가 생겼거나, 상태가 CARD_BOUND/PAID면 성공으로 간주
      if (hash || status === 'CARD_BOUND' || status === 'PAID') {
        console.log(
          `[bound-check] ok`,
          { hasHash: !!hash, status, elapsedMs: Date.now() - t0, hash }
        );
        return { ok: true, hash, status };
      }
    } catch (e) {
      console.warn('[bound-check] fetch error:', e?.message || e);
    }
    await new Promise(r => setTimeout(r, gapMs));
  }

  console.warn('[bound-check] timeout', { sessionCode, elapsedMs: Date.now() - t0 });
  return { ok: false, hash: null, status: null };
}






function connectApiWS() {
  // EC2 결제 서버 WS 허브
  wsApi = new WebSocket(`ws://13.209.14.101:4000/ws`);

  wsApi.onopen = () => {
    console.log("✅ wsApi 연결됨 (4000/ws)");
    // 이미 세션코드를 알고 있으면 즉시 SUB
    if (window.currentSessionCode) {
      wsApi.send(JSON.stringify({ type: "SUB", session_code: window.currentSessionCode }));
      console.log("[wsApi] SUB sent after open:", window.currentSessionCode);
    }
  };

  wsApi.onmessage = async (e) => {
    const data = JSON.parse(e.data);
    const rawType = data.type || data.action || '';
    const kind    = String(rawType).toLowerCase();
    const T       = String(rawType).toUpperCase();

    // === 카드 바운드 푸시 → 자동 결제 ===
    if (T === 'SESSION_CARD_BOUND' || T === 'CARD_BOUND' || T === 'CARD_EVENT_BOUND') {
      const code =
        data.session?.session_code ||
        data.session_code ||
        window.currentSessionCode ||
        localStorage.getItem('sessionCode');

      if (!code) { console.warn('[WS] cardBound but no session code'); return; }

      const res = await waitBoundAndAllowed(code, 3000, 200);
      if (!res.ok) { console.warn('[WS] cardBound received but not ready for checkout'); return; }

      // 🔎 최종 확인 로그 (결제 직전)
      console.log('[bound-check] final', { hasHash: !!res.hash, status: res.status, hash: res.hash });

      if (__currentScreenId !== 'screen-card') goToScreen('screen-card');
      checkoutOnce(code);
      return;
    }




    // 결제 서버가 세션 시작을 브로드캐스트하는 경우 → 코드 저장 + SUB
    if (kind === "sessionstarted" && data.session?.session_code) {
      window.currentSessionCode = data.session.session_code;
      localStorage.setItem("sessionCode", window.currentSessionCode);
      if (wsApi?.readyState === WebSocket.OPEN) {
        wsApi.send(JSON.stringify({ type: "SUB", session_code: window.currentSessionCode }));
      }
      return;
    }


    if (rawType === "SUB_OK") {
      console.log("[wsApi] SUB_OK:", data.session_code || data.code);
      // 혹시 아직 없다면 여기서도 저장
      if (!window.currentSessionCode && (data.session_code || data.code)) {
        window.currentSessionCode = data.session_code || data.code;
        console.log("✅ currentSessionCode set by wsApi:", window.currentSessionCode);
      }
      return;
    }

  };

  wsApi.onclose = () => {
    console.log("❌ wsApi 연결 종료, 재시도 예정…");
    setTimeout(connectApiWS, 2000);
  };
}

async function sendSessionEnded(reason='front_return_start') {
  const sid = 'default'; // 지금 구조상 WS sid는 'default'를 씀
  if (!(wsLocal && wsLocal.readyState === WebSocket.OPEN)) {
    console.warn('skip sessionEnded: ws not open'); return;
  }
  wsLocal.send(JSON.stringify({
    type: 'sessionEnded',   // ★ action 아님
    role: 'front',
    sessionId: sid,
    reason,
    ts: Date.now()
  }));
  console.log('[FRONT] sessionEnded sent', sid, reason);
  await new Promise(r => setTimeout(r, 80)); // 유실 방지 소량 대기
}


// ----------------------
// Local WS(3000) : 라이다/YOLO/진행 제어 전용
// ----------------------
function connectLocalWS() {
  wsLocal = new WebSocket(`ws://${window.location.hostname}:3000`);

  wsLocal.onopen = () => {
    console.log("✅ wsLocal 연결됨 (3000)");

    // 프론트 자신을 서버에 등록
    wsLocal.send(JSON.stringify({
      type: "hello",
      role: "front",
      sessionId: "default"
    }));
    
    console.log(`[HELLO] sent to local WS (role=front, sid=default)`);

  };

  wsLocal.onmessage = (e) => {
    const data = JSON.parse(e.data);
    const msg = data;
    const kindRaw = data.type || data.action || data.event || data.kind || "";
    const kind = String(kindRaw).toLowerCase();
    // 디버깅용 로그
    // console.log("[wsApi] evt:", { kind: kindRaw, data });

    // if (msg.type === "goToScreen" && msg.screen) {
    //   console.log("[wsLocal] goToScreen:", msg.screen);
    //   goToScreen(msg.screen, { fromWs: true });   // ★ 여기 중요
    //   return;
    // }

    if (kind === 'sessionstarted') {
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
    if (kind === "gotoscreen" && data.screen) {
      if (__lockAfterCheckout && (data.screen === 'screen-items' || data.screen === 'screen-scan' || data.screen === 'screen-basket')) {
        console.log('[wsLocal] ignore goToScreen after checkout:', data.screen);
        return; // 결제 이후 역행 전환 금지
      }  
      // 1) 세션코드가 오면 먼저 저장
      if (data.sessionCode) {
        window.currentSessionCode = data.sessionCode;
        localStorage.setItem('sessionCode', data.sessionCode);
      }
      if (__currentScreenId !== data.screen) {
        console.log("[wsLocal] goToScreen:", data.screen);
        goToScreen(data.screen, { fromWs: true });   // ★ 여기 중요
      }
    return;
  }


    if (kind === "startkioskbylidar") {
      console.log("📡 라이다 감지 → 세션 시작");
      startKioskFlow();
    }

    if (kind === "basketstable" && __currentScreenId === "screen-basket") {
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

    

    if (kind === "objectdetected") {
      console.log("🎯 YOLO 탐지:", data.product_name);
      detectedProductName = data.product_name;
    }

    if (kind === "scanresult") {
      console.log("🧺 스캔 결과:", data);
    }

    if (kind === "rfiddetected" || kind === "rfidtagged") {
      console.log("💳 RFID UID:", data.uid);
      goToScreen("screen-card");
    }

    // 스캔 종료 신호 → 확인 화면으로
    if (kind === "scancomplete") {
      if (data.sessionCode) {
        window.currentSessionCode = data.sessionCode;
        localStorage.setItem('sessionCode', data.sessionCode);
        console.log("[FRONT] sessionCode set from scanComplete:", window.currentSessionCode);
      }
      if (wsLocal?.readyState === WebSocket.OPEN) {
        wsLocal.send(JSON.stringify({ action: "stopVision" }));
      }

      visionRequested = false;
      return;
    }


    // “카드 태깅 대기” 신호 → 카드 화면 유지/진입
    if (kind === "awaitingcard") {
      console.log("⏳ 카드 태깅 대기중…");
      if (__currentScreenId !== "screen-card") goToScreen("screen-card");
      return;
    }

    // (서버) 카드 UID 바인딩 완료
    if (kind === "cardbound") {
      console.log("💳 cardBound:", data.session_code);
      if (__currentScreenId !== "screen-card") goToScreen("screen-card");
      return;
    }

    // (서버) 결제 완료 → 영수증 → 굿바이 → 초기화(타이머)
    // if (kind === "purchasecompleted") {
    //   console.log("✅ purchaseCompleted:", data);
    //   goToScreen("screen-receipt");

    //   // 타이머(원하는 시간으로 조절 가능)
    //   clearUITimers();  // 기존 유틸 재사용
    //   receiptTimer = setTimeout(() => {
    //     goToScreen("screen-goodbye");
    //     goodbyeTimer = setTimeout(() => {
    //       sendSessionEnded('receipt_flow_to_start').finally(() => resetKioskFlow());
    //     }, 2000);                // 굿바이 유지 시간
    //   }, 3000);                  // 영수증 유지 시간
    //   return;
    // }

  };

  wsLocal.onclose = () => {
    console.log("❌ wsLocal 연결 종료, 재시도 예정…");
    setTimeout(connectLocalWS, 2000);
  };
}

// ----------------------
let __pollTimer = null;

function startSessionPoll() {
  // 세션 시작할 때마다 새로 켜야 하므로 항상 초기화 가능하게
  if (__pollTimer) clearInterval(__pollTimer);

  __pollTimer = setInterval(async () => {
    const sid = window.currentSessionCode;
    if (!sid) return;

    try {
      const r = await fetch(`${API_BASE}/purchase-sessions/${encodeURIComponent(sid)}`);
      if (!r.ok) return;
      const data = await r.json();
      const status = data?.session?.status;

      // ✅ 결제 완료시 영수증 플로우 실행
      if (status === 'PAID') {
        console.log('[POLL] detected PAID status → receipt flow');
        clearInterval(__pollTimer);
        __pollTimer = null;
      }

      // ✅ 혹시 서버가 상태를 안 주는 경우, fallback
      else if (data?.ok === true && !status) {
        console.log('[POLL] fallback ok:true → receipt flow');
        clearInterval(__pollTimer);
        __pollTimer = null;
      }

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

