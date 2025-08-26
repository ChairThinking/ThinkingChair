const db = require('../models/db');

// 선결제 등록
exports.createPrepayment = async (req, res) => {
  const { card_id } = req.body;
  const store_id = 1; // 매장 하나만 있다고 가정

  if (!card_id) {
    return res.status(400).json({ message: '카드 ID가 필요합니다.' });
  }

  try {
    // 카드 존재 여부 확인
    const [[card]] = await db.query(
      'SELECT * FROM card_info WHERE card_id = ?',
      [card_id]
    );

    if (!card) {
      return res.status(404).json({ message: '해당 카드가 존재하지 않습니다.' });
    }

    // 선결제 삽입
    const [result] = await db.query(
      `INSERT INTO prepayments (card_id, amount, status, store_id)
       VALUES (?, ?, 'active', ?)`,
      [card_id, 100000, store_id]
    );

    res.status(201).json({
      message: '선결제 등록 완료',
      prepayment_id: result.insertId,
      cardholder_name: card.cardholder_name,
      amount: 100000
    });
  } catch (err) {
    console.error('선결제 등록 오류:', err);
    res.status(500).send('서버 오류');
  }
};

// 전체 선결제 조회
exports.getAllPrepayments = async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT p.id, p.card_id, p.amount, p.status, p.approved_at, c.cardholder_name
      FROM prepayments p
      JOIN card_info c ON p.card_id = c.card_id
      ORDER BY p.approved_at DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error('선결제 조회 오류:', err);
    res.status(500).send('서버 오류');
  }
};