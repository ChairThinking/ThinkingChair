const db = require('../models/db');

exports.autoRefund = async (req, res) => {
  const { prepayment_id } = req.body;

  if (!prepayment_id) {
    return res.status(400).json({ message: 'prepayment_id가 필요합니다.' });
  }

  const connection = await db.getConnection(); // 트랜잭션을 위한 connection 획득
  try {
    await connection.beginTransaction();

    const [[alreadyRefunded]] = await connection.query(
      `SELECT COUNT(*) AS count FROM prepayment_refunds 
       WHERE prepayment_id = ? AND reason = '자동 환불'`,
      [prepayment_id]
    );

    if (alreadyRefunded.count > 0) {
      await connection.release();
      return res.status(400).json({ message: '이미 자동 환불이 처리된 건입니다.' });
    }

    const [[prepayment]] = await connection.query(
      `SELECT amount, status, store_id FROM prepayments WHERE id = ?`,
      [prepayment_id]
    );

    if (!prepayment) {
      await connection.release();
      return res.status(404).json({ message: '선결제 내역이 없습니다.' });
    }

    if (prepayment.status === 'refunded') {
      await connection.release();
      return res.status(400).json({ message: '이미 환불된 건입니다.' });
    }

    const [[purchase]] = await connection.query(
      `SELECT IFNULL(SUM(total_price), 0) AS used FROM purchases WHERE prepayment_id = ?`,
      [prepayment_id]
    );

    const [[refund]] = await connection.query(
      `SELECT IFNULL(SUM(refunded_amount), 0) AS refunded FROM prepayment_refunds WHERE prepayment_id = ?`,
      [prepayment_id]
    );

    const balance = prepayment.amount - purchase.used - refund.refunded;

    if (balance <= 0) {
      await connection.rollback();
      await connection.release();
      return res.status(400).json({ message: '환불 가능한 금액이 없습니다.', balance });
    }

    await connection.query(
      `INSERT INTO prepayment_refunds (prepayment_id, refunded_amount, reason, store_id)
       VALUES (?, ?, ?, ?)`,
      [prepayment_id, balance, '자동 환불', prepayment.store_id]
    );

    await connection.query(
      `UPDATE prepayments SET status = 'refunded' WHERE id = ?`,
      [prepayment_id]
    );

    await connection.commit();
    await connection.release();

    res.status(201).json({
      message: '자동 환불 완료',
      refunded_amount: balance,
      store_id: prepayment.store_id,
      used_amount: purchase.used
    });
  } catch (err) {
    if (connection) {
      await connection.rollback();
      await connection.release();
    }
    console.error('자동 환불 오류:', err);
    res.status(500).send('서버 오류');
  }
};

exports.manualRefund = async (req, res) => {
  const { prepayment_id, refunded_amount, reason } = req.body;

  if (!prepayment_id || !refunded_amount || refunded_amount <= 0) {
    return res.status(400).json({ message: '환불 ID와 금액은 필수입니다.' });
  }

  try {
    // 선결제 내역 확인
    const [[prepayment]] = await db.query(
      'SELECT amount, store_id FROM prepayments WHERE id = ?',
      [prepayment_id]
    );

    if (!prepayment) {
      return res.status(404).json({ message: '선결제 내역을 찾을 수 없습니다.' });
    }

    // 기존 환불 금액과 사용 금액 확인
    const [[used]] = await db.query(
      'SELECT IFNULL(SUM(total_price), 0) AS used FROM purchases WHERE prepayment_id = ?',
      [prepayment_id]
    );

    const [[alreadyRefunded]] = await db.query(
      'SELECT IFNULL(SUM(refunded_amount), 0) AS refunded FROM prepayment_refunds WHERE prepayment_id = ?',
      [prepayment_id]
    );

    const currentBalance = prepayment.amount - used.used - alreadyRefunded.refunded;

    if (refunded_amount > currentBalance) {
      return res.status(400).json({ message: '환불 요청 금액이 환불 가능 금액을 초과합니다.', currentBalance });
    }

    // 환불 기록 삽입
    await db.query(
      `INSERT INTO prepayment_refunds (prepayment_id, refunded_amount, reason, store_id)
       VALUES (?, ?, ?, ?)`,
      [prepayment_id, refunded_amount, reason || '수동 환불', prepayment.store_id]
    );

    res.status(201).json({
      message: '수동 환불 완료',
      refunded_amount,
      reason: reason || '수동 환불',
      store_id: prepayment.store_id
    });
  } catch (err) {
    console.error('수동 환불 오류:', err);
    res.status(500).send('서버 오류');
  }
};
