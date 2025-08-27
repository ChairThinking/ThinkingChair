const db = require('../models/db');

// 전체 상품 조회
exports.getAllProducts = async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM products');
    res.json(rows);
  } catch (err) {
    console.error('DB 에러:', err);
    res.status(500).send('서버 오류');
  }
};

// 개별 상품 조회
exports.getProductById = async (req, res) => {
  try {
    const productId = req.params.id;
    const [rows] = await db.query('SELECT * FROM products WHERE id = ?', [productId]);

    if (rows.length === 0) {
      return res.status(404).json({ message: '상품을 찾을 수 없습니다.' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('DB 에러:', err);
    res.status(500).send('서버 오류');
  }
};

// 상품 등록
exports.createProduct = async (req, res) => {
  const {
    name, brand, price, category, barcode,
    origin_country, manufacturer, image_url
  } = req.body;

  if (!name || !price) {
    return res.status(400).json({ message: '상품명과 가격은 필수입니다.' });
  }

  try {
    const [result] = await db.query(
      `INSERT INTO products 
       (name, brand, price, category, barcode, origin_country, manufacturer, image_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, brand, price, category, barcode, origin_country, manufacturer, image_url]
    );

    res.status(201).json({ message: '상품 등록 완료', id: result.insertId });
  } catch (err) {
    console.error('상품 등록 오류:', err);
    res.status(500).send('서버 오류');
  }
};

// 상품 수정
exports.updateProduct = async (req, res) => {
  const productId = req.params.id;
  const {
    name, brand, price, category, barcode,
    origin_country, manufacturer, image_url
  } = req.body;

  try {
    const [result] = await db.query(
      `UPDATE products SET 
        name = ?, brand = ?, price = ?, category = ?, 
        barcode = ?, origin_country = ?, manufacturer = ?, image_url = ?
       WHERE id = ?`,
      [name, brand, price, category, barcode, origin_country, manufacturer, image_url, productId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: '수정할 상품이 없습니다.' });
    }

    res.json({ message: '상품 수정 완료' });
  } catch (err) {
    console.error('상품 수정 오류:', err);
    res.status(500).send('서버 오류');
  }
};

// 상품 삭제
exports.deleteProduct = async (req, res) => {
  const productId = req.params.id;

  try {
    console.log('삭제 시도 ID:', productId);

    const [result] = await db.query(
      'DELETE FROM products WHERE id = ?',
      [productId]
    );
    // console.log('쿼리 결과:', result);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: '삭제할 상품이 없습니다.' });
    }

    res.json({ message: '상품 삭제 완료' });
  } catch (err) {
    console.error('상품 삭제 오류:', err);
    res.status(500).send('서버 오류');
  }
};
