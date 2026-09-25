'use strict';

const express = require('express');
const reconciliationController = require('../controllers/reconciliationController');
const asyncHandler = require('../utils/asyncHandler');
const requireAuditRole = require('../middleware/requireAuditRole');

const router = express.Router();

// GET /api/reconciliation — bounded accounting invariant report (admin/auditor)
router.get('/', requireAuditRole, asyncHandler(reconciliationController.getReport));

module.exports = router;
