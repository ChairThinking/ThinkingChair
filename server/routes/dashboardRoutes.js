const express = require("express");
const router = express.Router();
const dashboardController = require("../controllers/dashboardController");

router.get("/today-sales", dashboardController.getTodaySalesInfo);
router.get("/monthly-top-products", dashboardController.getTopProductsThisMonth);
router.get("/weekly-sales", dashboardController.getWeeklySalesGraph);

module.exports = router;
