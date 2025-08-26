const db = require('../models/db');

// 오늘 매출 정보
exports.getTodaySalesInfo = async (req, res) => {
  try {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    const format = (d) => d.toISOString().slice(0, 10);

    // 오늘 매출
    const [[todaySales]] = await db.query(
      `SELECT IFNULL(SUM(total_price), 0) AS total FROM purchases 
       WHERE DATE(purchased_at) = ?`,
      [format(today)]
    );

    // 어제 매출
    const [[yesterdaySales]] = await db.query(
      `SELECT IFNULL(SUM(total_price), 0) AS total FROM purchases 
       WHERE DATE(purchased_at) = ?`,
      [format(yesterday)]
    );

    // 주간 최고 매출일
    const [weekMax] = await db.query(
      `SELECT DATE(purchased_at) AS date, SUM(total_price) AS total
       FROM purchases 
       WHERE purchased_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
       GROUP BY DATE(purchased_at)
       ORDER BY total DESC LIMIT 1`
    );

    const diff = todaySales.total - yesterdaySales.total;
    const changeRate = yesterdaySales.total > 0
      ? ((diff / yesterdaySales.total) * 100).toFixed(1)
      : 100.0;

    res.json({
      today_total: todaySales.total,
      change_rate: Number(changeRate),
      max_day: weekMax[0]?.date || null,
      max_day_sales: weekMax[0]?.total || 0
    });
  } catch (err) {
    console.error('오늘 매출 정보 오류:', err);
    res.status(500).send('서버 오류');
  }
};

// 이달 인기 상품 Top5
exports.getTopProductsThisMonth = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT p.name, p.image_url, SUM(pr.quantity) AS total_sold
       FROM purchases pr
       JOIN store_products sp ON pr.store_product_id = sp.id
       JOIN products p ON sp.product_id = p.id
       WHERE MONTH(pr.purchased_at) = MONTH(CURDATE())
         AND YEAR(pr.purchased_at) = YEAR(CURDATE())
       GROUP BY p.id
       ORDER BY total_sold DESC
       LIMIT 5`
    );

    res.json(rows);
  } catch (err) {
    console.error('Top 상품 오류:', err);
    res.status(500).send('서버 오류');
  }
};

// 주간 매출 그래프 데이터
exports.getWeeklySalesGraph = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT DATE(purchased_at) AS date, SUM(total_price) AS total
       FROM purchases
       WHERE purchased_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
       GROUP BY DATE(purchased_at)
       ORDER BY date`
    );

    res.json(rows);
  } catch (err) {
    console.error('주간 매출 그래프 오류:', err);
    res.status(500).send('서버 오류');
  }
};
