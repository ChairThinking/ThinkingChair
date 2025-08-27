// routes/purchaseSessionRoutes.js
const express = require('express');
const router = express.Router();

const {
  createSession,
  getSessionByCode,
  addItem,
  removeItem,
  bindCard,
  checkout,
  cancelSession,
} = require('../controllers/purchaseSessionController');

// POST   /api/purchase-sessions
router.post('/', createSession);

// GET    /api/purchase-sessions/:session_code
router.get('/:session_code', getSessionByCode);

// POST   /api/purchase-sessions/:session_code/items
router.post('/:session_code/items', addItem);

// DELETE /api/purchase-sessions/:session_code/items/:item_id
router.delete('/:session_code/items/:item_id', removeItem);

// PATCH  /api/purchase-sessions/:session_code/bind-card
router.patch('/:session_code/bind-card', bindCard);

// POST   /api/purchase-sessions/:session_code/checkout
router.post('/:session_code/checkout', checkout);

// POST   /api/purchase-sessions/:session_code/cancel
router.post('/:session_code/cancel', cancelSession);

module.exports = router;
