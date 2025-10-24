// scripts/generateMonthlyDummy.js
/**
 * 더미 매출 생성기 (스키마 맞춤: purchases.card_uid_hash 만 사용)
 *
 * 실행 예:
 *   node scripts/generateMonthlyDummy.js
 *   node scripts/generateMonthlyDummy.js --year=2025 --month=8 --min=5 --max=15 --cards=12
 *
 * 특징:
 *  - 이번 달이면 "오늘 날짜"까지만 생성 (미래일 X)
 *  - 실제 고객처럼 동일한 카드 UID가 여러 번 재사용되도록 카드 해시 풀을 만들고 라운드로 돌려 쓴다
 *  - purchases.payment_method는 'RFID' 위주, 가끔 '카드단말기'
 *  - purchases.card_uid_hash에는 NFC UID를 해시한 것처럼 보이는 64자리(hex) 문자열을 저장
 *
 * 전제 스키마 (중요):
 *   INSERT INTO purchases (
 *     store_product_id,
 *     card_uid_hash,
 *     quantity,
 *     unit_price,
 *     total_price,
 *     payment_method,
 *     purchased_at,
 *     store_id,
 *     created_at
 *   ) VALUES ...
 *
 * .env 필요:
 *   DB_HOST=...
 *   DB_USER=...
 *   DB_PASSWORD=...
 *   DB_NAME=...
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const crypto = require('crypto');

/** ─────────────────────────────────────────
 * CLI 인자 파서
 * --year=2025 --month=10 --min=5 --max=15 --cards=12
 * ─────────────────────────────────────────
 */
function getNumArg(name, def) {
  const a = process.argv.find(s => s.startsWith(`--${name}=`));
  if (!a) return def;
  const v = parseInt(a.split('=')[1], 10);
  return Number.isFinite(v) ? v : def;
}

/** ─────────────────────────────────────────
 * 카드 UID 해시 비슷한 문자열 생성
 * - 실제 프로젝트에선 NFC UID -> SHA-256(hex) 식으로 저장했었지?
 * - 그 느낌 그대로 64자리 hex로 만들어서 card_uid_hash처럼 보이게 한다.
 * ─────────────────────────────────────────
 */
function makeFakeCardHash() {
  // crypto.randomBytes(32) -> 32바이트 = 64글자 hex
  return crypto.randomBytes(32).toString('hex');
}

/**
 * 여러 장의 "고객 카드"를 만든다.
 * 실제처럼 동일한 카드가 여러 번 재사용돼야 하니까,
 * 여기서 생성된 해시 배열을 계속 돌려 쓰게 된다.
 */
function prepareCardHashPool(targetCount = 10) {
  const hashes = [];
  for (let i = 0; i < targetCount; i++) {
    hashes.push(makeFakeCardHash());
  }
  return hashes;
}

/** ─────────────────────────────────────────
 * roundRobin(generator)
 * - 카드 해시를 한 장만 계속 쓰지 않고 섞어가며 사용
 * - 가끔 랜덤 점프를 줘서 특정 카드에 몰리지 않게 약간 퍼뜨림
 *   → 진짜 매출처럼 여러 손님이 번갈아 결제한 것처럼 보이도록
 * ─────────────────────────────────────────
 */
function* roundRobin(arr) {
  let i = 0;
  while (true) {
    if (arr.length === 0) {
      yield null;
      continue;
    }
    // 약간 랜덤 점프 섞어서 치우침 방지
    if (Math.random() < 0.25) {
      i = Math.floor(Math.random() * arr.length);
    }
    const value = arr[i % arr.length];
    i++;
    yield value;
  }
}

/** ─────────────────────────────────────────
 * 시간 생성 (운영 시간대 위주)
 * - 11~13시, 17~19시가 살짝 더 몰리도록
 * - "점심/퇴근 후" 피크를 흉내낸다
 * ─────────────────────────────────────────
 */
function timeInBusinessHours(year, month, day) {
  // 가중치 기반 시간대
  const buckets = [
    { h: 10, w: 1 },
    { h: 11, w: 2 },
    { h: 12, w: 3 },
    { h: 13, w: 2 },
    { h: 17, w: 2 },
    { h: 18, w: 3 },
    { h: 19, w: 2 },
    { h: 20, w: 1 },
  ];
  const tot = buckets.reduce((s, b) => s + b.w, 0);

  let r = Math.random() * tot;
  let hour = 9;
  for (const b of buckets) {
    if (r < b.w) {
      hour = b.h;
      break;
    }
    r -= b.w;
  }

  const minute = Math.floor(Math.random() * 60);
  const second = Math.floor(Math.random() * 60);

  // JS Date는 month-1 사용
  return new Date(year, month - 1, day, hour, minute, second);
}

(async () => {
  // ───────────────── DB 풀 생성 ─────────────────
  const pool = await mysql.createPool({
    host:     process.env.DB_HOST,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
  });

  try {
    // ───────── 기본 파라미터 계산 ─────────
    const now = new Date();
    const defaultYear  = now.getFullYear();
    const defaultMonth = now.getMonth() + 1;

    const year        = getNumArg('year',  defaultYear);
    const month       = getNumArg('month', defaultMonth);
    const perDayMin   = Math.max(1, getNumArg('min',   8));   // 하루 최소 거래수
    const perDayMax   = Math.max(perDayMin, getNumArg('max', 18)); // 하루 최대 거래수
    const targetCards = Math.max(3, getNumArg('cards', 12));  // "고객 카드" 몇 명처럼 보일지

    // 이번 달이면 미래일(내일 이후)은 생성 안 함
    const daysInMonth = new Date(year, month, 0).getDate();
    const lastDay = (year === now.getFullYear() && month === (now.getMonth() + 1))
      ? now.getDate()
      : daysInMonth;

    console.log(
      `➡️ ${year}-${String(month).padStart(2, '0')} 1~${lastDay}일 생성 (하루 ${perDayMin}~${perDayMax}건)`
    );

    // ───────── 카드 해시 풀 준비 ─────────
    // card_uid_hash로 저장할 "손님 카드들"
    const cardHashPool = prepareCardHashPool(targetCards);
    if (!cardHashPool.length) {
      throw new Error('카드 해시 풀 생성 실패 (cardHashPool이 비었습니다).');
    }
    console.log(`💳 사용할 카드 UID 해시 개수: ${cardHashPool.length}`);

    const cardPicker = roundRobin(cardHashPool);

    // ───────── 판매 가능한 상품 목록 로드 ─────────
    // store_products(매장에서 파는 실제 상품 단위), products(마스터 상품)
    // unit_price는 products.price를 기준 (네 구조에 맞춰 사용)
    const [items] = await pool.query(`
      SELECT
        sp.id      AS store_product_id,
        sp.store_id,
        p.price    AS unit_price
      FROM store_products sp
      JOIN products p ON p.id = sp.product_id
      WHERE p.price IS NOT NULL
      LIMIT 100
    `);

    if (!items.length) {
      throw new Error('사용 가능한 상품이 없습니다. store_products / products.price를 확인해 주세요.');
    }
    console.log(`📦 상품 ${items.length}개 로드`);

    // ───────── 날짜 루프 시작 ─────────
    for (let d = 1; d <= lastDay; d++) {
      // 주말이면 매출이 조금 더 늘거나 줄도록 가중치
      const isWeekend = [0, 6].includes(new Date(year, month - 1, d).getDay());
      const minToday = Math.max(1, Math.round(perDayMin * (isWeekend ? 1.2 : 0.9)));
      const maxToday = Math.max(minToday, Math.round(perDayMax * (isWeekend ? 1.3 : 0.95)));
      const salesCount = Math.floor(Math.random() * (maxToday - minToday + 1)) + minToday;

      for (let i = 0; i < salesCount; i++) {
        // 상품 하나 랜덤 선택
        const pick = items[Math.floor(Math.random() * items.length)];

        // 수량: 1이 제일 많고 가끔 2~3
        const quantity = Math.random() < 0.75
          ? 1
          : (Math.random() < 0.9 ? 2 : 3);

        const unit_price   = Number(pick.unit_price) || 0;
        const total_price  = unit_price * quantity;
        const purchased_at = timeInBusinessHours(year, month, d);

        // 카드 UID 해시 (한 "고객" 카드 해시가 여러 번 재사용되도록)
        const cardUidHash = cardPicker.next().value;

        // 결제수단 - RFID가 대부분, 가끔 '카드단말기'
        const payment_method = (Math.random() < 0.9) ? 'RFID' : '카드단말기';

        // DB INSERT
        await pool.execute(
          `INSERT INTO purchases
             (store_product_id,
              card_uid_hash,
              quantity,
              unit_price,
              total_price,
              payment_method,
              purchased_at,
              store_id,
              created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
          [
            pick.store_product_id,
            cardUidHash,     // ← 이제 card_uid_hash 컬럼에 저장
            quantity,
            unit_price,
            total_price,
            payment_method,
            purchased_at,
            pick.store_id,
          ]
        );
      }

      console.log(
        `✅ ${String(d).padStart(2, '0')}일: ${salesCount}건 생성 완료${isWeekend ? ' (주말)' : ''}`
      );
    }

    console.log('🎉 더미 매출 데이터 생성 완료!');
    process.exit(0);
  } catch (err) {
    console.error('❌ 에러:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
