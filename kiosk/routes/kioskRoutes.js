const express = require("express"); //
const router = express.Router();
const kioskController = require("../controllers/kioskController");

router.post("/session/start", kioskController.startSession);
router.post("/api/refund", kioskController.processRefund);

module.exports = router;
