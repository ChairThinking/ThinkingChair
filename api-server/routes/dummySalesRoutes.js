// server/routes/dummySalesRoutes.js
const express = require('express');
const router = express.Router();
const { generateDummySales } = require('../controllers/dummySalesController');

// (선택) 운영 차단: 운영이면 403
const blockInProd = (req, res, next) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'dummy-sales routes are disabled in production' });
  }
  next();
};

// POST /api/dummy-sales/generate
router.post('/generate', blockInProd, generateDummySales);

module.exports = router;
