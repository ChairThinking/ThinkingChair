// scripts/generateMonthlyDummy.js
/**
 * 더미 매출 생성기 (스키마 맞춤: purchases.card_id -> card_info.id(FK))
 *
 * 실행:
 *   node scripts/generateMonthlyDummy.js
 *   node scripts/generateMonthlyDummy.js --year=2025 --month=8 --min=5 --max=15 --cards=12
 *
 * 특징:
 *  - 이번 달이면 "오늘 날짜"까지만 생성 (미래일 X)
 *  - card_info에 카드가 적으면 자동 시드(카드 목표 개수 --cards)
 *  - purchases.payment_method는 'RFID' 위주, 가끔 '카드단말기'
 *  - purchases.card_id에는 **card_info.id(정수 PK)**를 넣음  ← 중요!
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

function getNumArg(name, def) {
  const a = process.argv.find(s => s.startsWith(`--${name}=`));
  if (!a) return def;
  const v = parseInt(a.split('=')[1], 10);
  return Number.isFinite(v) ? v : def;
}

function randomExpiry() {
  // MM/YY 형태 (예: 08/28)
  const now = new Date();
  const plusYears = 2 + Math.floor(Math.random() * 3); // 2~4년 후
  const mm = String(1 + Math.floor(Math.random() * 12)).padStart(2, '0');
  const yy = String((now.getFullYear() + plusYears) % 100).padStart(2, '0');
  return `${mm}/${yy}`;
}

function randomDigits(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
  return s;
}

async function ensureCards(pool, targetCount = 10) {
  // card_info(id PK, card_id varchar unique, cardholder_name not null,
  // card_company nullable, card_number char(16) not null,
  // expiry_date char(5) not null, cvv char(3) not null)
  const [rows] = await pool.query(`SELECT id FROM card_info ORDER BY id ASC`);
  let ids = rows.map(r => r.id);
  const need = Math.max(0, targetCount - ids.length);
  if (need === 0) return ids;

  console.log(`💳 카드가 ${ids.length}장 → ${targetCount}장 목표, ${need}장 더 생성합니다.`);
  const companies = ['비자', '마스터', '국민', '신한', '현대', '농협', '우리', '롯데'];

  for (let i = 0; i < need; i++) {
    const random16 = randomDigits(16);
    const dummyCardId = 'TAG-' + randomDigits(10); // 외부용 식별자(고유)
    const holder = `DummyUser${ids.length + i + 1}`;
    const company = companies[Math.floor(Math.random() * companies.length)];
    const expiry = randomExpiry();
    const cvv = randomDigits(3);

    // card_info에 한 행 추가 (PK id는 AUTO_INCREMENT로 생성됨)
    const [res] = await pool.execute(
      `INSERT INTO card_info
         (card_id, cardholder_name, card_company, card_number, expiry_date, cvv)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [dummyCardId, holder, company, random16, expiry, cvv]
    );
    ids.push(res.insertId);
  }

  return ids;
}

function* roundRobin(arr) {
  let i = 0;
  while (true) {
    // 약간 랜덤 점프 섞어서 치우침 방지
    if (Math.random() < 0.25) i = Math.floor(Math.random() * arr.length);
    yield arr[i % arr.length];
    i++;
  }
}

function timeInBusinessHours(year, month, day) {
  // 가중치: 11~13시, 17~19시 약간 우세
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
    if (r < b.w) { hour = b.h; break; }
    r -= b.w;
  }
  const minute = Math.floor(Math.random() * 60);
  const second = Math.floor(Math.random() * 60);
  return new Date(year, month - 1, day, hour, minute, second);
}

(async () => {
  const pool = await mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
  });

  try {
    const now = new Date();
    const year  = getNumArg('year',  now.getFullYear());
    const month = getNumArg('month', now.getMonth() + 1);
    const perDayMin = Math.max(1, getNumArg('min', 8));
    const perDayMax = Math.max(perDayMin, getNumArg('max', 18));
    const targetCards = Math.max(3, getNumArg('cards', 12));

    const daysInMonth = new Date(year, month, 0).getDate();
    const lastDay = (year === now.getFullYear() && month === (now.getMonth() + 1))
      ? now.getDate()
      : daysInMonth;

    console.log(`➡️ ${year}-${String(month).padStart(2, '0')} 1~${lastDay}일 생성 (하루 ${perDayMin}~${perDayMax}건)`);

    // 1) 카드 확보: **id(PK) 목록**을 사용 (FK가 이걸 참조)
    let cardPkList = await ensureCards(pool, targetCards);
    if (!cardPkList.length) {
      throw new Error('card_info에 카드가 없습니다. 스키마를 확인하고 최소 1장 이상 생성해 주세요.');
    }
    console.log(`💳 사용할 카드( card_info.id ) 개수: ${cardPkList.length}`);

    // 2) 상품 목록: products.price 기준 (필요시 sp.price로 바꿔도 됨)
    const [items] = await pool.query(`
      SELECT sp.id AS store_product_id,
             sp.store_id,
             p.price AS unit_price
        FROM store_products sp
        JOIN products p ON p.id = sp.product_id
       WHERE p.price IS NOT NULL
       LIMIT 100
    `);
    if (!items.length) {
      throw new Error('사용 가능한 상품이 없습니다. store_products / products.price를 확인해 주세요.');
    }
    console.log(`📦 상품 ${items.length}개 로드`);

    // 3) 카드 라운드로빈 준비
    const cardPicker = roundRobin(cardPkList);

    // 4) 날짜 루프
    for (let d = 1; d <= lastDay; d++) {
      const isWeekend = [0,6].includes(new Date(year, month - 1, d).getDay());
      const minToday = Math.max(1, Math.round(perDayMin * (isWeekend ? 1.2 : 0.9)));
      const maxToday = Math.max(minToday, Math.round(perDayMax * (isWeekend ? 1.3 : 0.95)));
      const salesCount = Math.floor(Math.random() * (maxToday - minToday + 1)) + minToday;

      for (let i = 0; i < salesCount; i++) {
        const pick = items[Math.floor(Math.random() * items.length)];
        const quantity = Math.random() < 0.75 ? 1 : (Math.random() < 0.9 ? 2 : 3);
        const unit_price = Number(pick.unit_price) || 0;
        const total_price = unit_price * quantity;
        const purchased_at = timeInBusinessHours(year, month, d);

        // **중요**: purchases.card_id <- card_info.id (정수 PK)
        const cardIdPk = cardPicker.next().value;

        // 스키마에 맞춤: payment_method enum('RFID','카드단말기')
        const pm = Math.random() < 0.9 ? 'RFID' : '카드단말기';

        await pool.execute(
          `INSERT INTO purchases
             (store_product_id, card_id, quantity, unit_price, total_price,
              payment_method, purchased_at, store_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
          [
            pick.store_product_id,
            cardIdPk,          // ← card_info.id
            quantity,
            unit_price,
            total_price,
            pm,
            purchased_at,
            pick.store_id,
          ]
        );
      }

      console.log(`✅ ${String(d).padStart(2, '0')}일: ${salesCount}건 생성 완료${isWeekend ? ' (주말)' : ''}`);
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
