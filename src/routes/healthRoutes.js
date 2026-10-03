'use strict';

const express = require('express');
const healthController = require('../controllers/healthController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

// GET /api/health - full service health report (process info, not a gate)
router.get('/', asyncHandler(healthController.getHealth));

// GET /api/health/ready - dependency-aware readiness (503 when degraded)
router.get('/ready', asyncHandler(healthController.getReadiness));

module.exports = router;
