'use strict';

const express = require('express');
const analyticsController = require('../controllers/analyticsController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

// GET /api/analytics - aggregate TVL and average APY
router.get('/', asyncHandler(analyticsController.getAnalytics));

// GET /api/analytics/tvl-history?days= - mock protocol-wide TVL series
router.get('/tvl-history', asyncHandler(analyticsController.getTvlHistory));

// GET /api/analytics/history - cursor-paginated vault ledger history
router.get('/history', asyncHandler(analyticsController.listHistory));

module.exports = router;
