'use strict';

const express = require('express');
const positionController = require('../controllers/positionController');
const asyncHandler = require('../utils/asyncHandler');
const { validateBody } = require('../middleware/validate');
const requireWallet = require('../middleware/requireWallet');

const router = express.Router();

// Every position path requires a bound wallet principal (#65).
router.use(requireWallet);

// Mock user identifiers are loose Stellar-style addresses: bounded length and
// an alphanumeric character set to reject obviously malformed input.
const userRule = {
  type: 'string',
  required: true,
  minLength: 5,
  maxLength: 64,
  pattern: /^[A-Za-z0-9_]+$/,
};

const vaultIdRule = { type: 'string', required: true, minLength: 5, maxLength: 64 };

const depositSchema = {
  user: userRule,
  vaultId: vaultIdRule,
  // Cap a single deposit to guard against absurd amounts in the mock.
  amount: { type: 'number', required: true, positive: true, max: 1e12 },
};

const withdrawSchema = {
  user: userRule,
  vaultId: vaultIdRule,
  shares: { type: 'number', required: true, positive: true },
};

const idempotencyRule = {
  type: 'string', minLength: 8, maxLength: 128, pattern: /^[A-Za-z0-9._:-]+$/,
};
depositSchema.idempotencyKey = idempotencyRule;
withdrawSchema.idempotencyKey = idempotencyRule;

// POST /api/positions/deposit - deposit assets into a vault
router.post(
  '/deposit',
  validateBody(depositSchema),
  asyncHandler(positionController.deposit)
);

// POST /api/positions/withdraw - redeem shares from a vault
router.post(
  '/withdraw',
  validateBody(withdrawSchema),
  asyncHandler(positionController.withdraw)
);

// GET /api/positions?user= - list positions, optionally filtered by user
router.get('/', asyncHandler(positionController.listPositions));

// GET /api/positions/summary?user= - aggregate portfolio totals for a user.
// Registered before /:id so the literal path is not treated as an id.
router.get('/summary', asyncHandler(positionController.getSummary));

// GET /api/positions/:id - position detail
router.get('/:id', asyncHandler(positionController.getPosition));

module.exports = router;
