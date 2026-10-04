'use strict';

const positionService = require('../services/positionService');
const { serializeTransaction } = require('../services/transactionService');
const { validateResponse } = require('../services/contractValidationService');

/**
 * Position controller: deposit, withdraw and position queries.
 */
function deposit(req, res) {
  const { user, vaultId, amount, idempotencyKey } = req.body;
  const result = positionService.deposit({ user, vaultId, amount, idempotencyKey, correlationId: req.id });
  const response = { ...result, tx: serializeTransaction(result.tx) };
  validateResponse('depositSuccess', response);
  res.status(201).json(response);
}

function withdraw(req, res) {
  const { user, vaultId, shares, idempotencyKey } = req.body;
  const result = positionService.withdraw({ user, vaultId, shares, idempotencyKey, correlationId: req.id });
  const response = { ...result, tx: serializeTransaction(result.tx) };
  validateResponse('withdrawSuccess', response);
  res.json(response);
}

function listPositions(req, res) {
  const positions = positionService.listPositions(req.query.user);
  const response = { count: positions.length, positions };
  validateResponse('positionList', response);
  res.json(response);
}

function getPosition(req, res) {
  const position = positionService.getPosition(req.params.id);
  res.json({ position });
}

function getSummary(req, res) {
  const summary = positionService.getUserSummary(req.query.user);
  res.json({ summary });
}

module.exports = {
  deposit,
  withdraw,
  listPositions,
  getSummary,
  getPosition,
};
