const db = require('../models/db');

// 카드 UID로 카드 정보 조회
const getCardInfo = async (req, res) => {
  const { uid } = req.query;

  if (!uid) {
    return res.status(400).json({ error: '카드 UID(uid)가 필요합니다.' });
  }

  try {
    const query = `
      SELECT card_id, cardholder_name, card_company, card_number, expiry_date, cvv
      FROM card_info
      WHERE card_id = ?
    `;
    const [rows] = await db.execute(query, [uid]);

    if (rows.length === 0) {
      return res.status(404).json({ error: '카드 정보를 찾을 수 없습니다.' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('[cardInfoController] DB 오류:', err.message);
    res.status(500).json({ error: '서버 오류가 발생했습니다.', details: err.message });
  }
};

module.exports = { getCardInfo };
