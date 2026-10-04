'use strict';

const positionService = require('../services/positionService');
const { serializeTransaction } = require('../services/transactionService');
const { validateResponse } = require('../services/contractValidationService');

/**
 * Position controller: deposit, withdraw and position queries.
 *
 * Authorization is bound at the service boundary using `req.wallet` from
 * {@link requireWallet}. Controllers never trust a client-supplied `user`
 * field for ownership decisions (#65).
 */

function accessFrom(req) {
  return { actor: req.wallet, isOperator: Boolean(req.isOperator) };
}

function deposit(req, res) {
  const { user, vaultId, amount, idempotencyKey } = req.body;
  const result = positionService.deposit({
    user,
    vaultId,
    amount,
    idempotencyKey,
    correlationId: req.id,
    ...accessFrom(req),
  });
  const response = { ...result, tx: serializeTransaction(result.tx) };
  validateResponse('depositSuccess', response);
  res.status(201).json(response);
}

function withdraw(req, res) {
  const { user, vaultId, shares, idempotencyKey } = req.body;
  const result = positionService.withdraw({
    user,
    vaultId,
    shares,
    idempotencyKey,
    correlationId: req.id,
    ...accessFrom(req),
  });
  const response = { ...result, tx: serializeTransaction(result.tx) };
  validateResponse('withdrawSuccess', response);
  res.json(response);
}

function listPositions(req, res) {
  const positions = positionService.listPositions(req.query.user, accessFrom(req));
  const response = { count: positions.length, positions };
  validateResponse('positionList', response);
  res.json(response);
}

function getPosition(req, res) {
  const position = positionService.getPosition(req.params.id, accessFrom(req));
  res.json({ position });
}

function getSummary(req, res) {
  const summary = positionService.getUserSummary(req.query.user, accessFrom(req));
  res.json({ summary });
}

module.exports = {
  deposit,
  withdraw,
  listPositions,
  getSummary,
  getPosition,
};
