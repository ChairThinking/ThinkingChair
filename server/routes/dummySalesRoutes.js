// server/routes/dummySalesRoutes.js
const express = require('express');
const router = express.Router();
const { generateDummySales } = require('../controllers/dummySalesController');

// POST /api/dummy-sales/generate
router.post('/generate', generateDummySales);

module.exports = router;
