'use strict';

const vaultService = require('../services/vaultService');
const positionService = require('../services/positionService');
const { validateResponse } = require('../services/contractValidationService');

/**
 * Vault controller: exposes vault listing and detail endpoints.
 */
function listVaults(req, res) {
  const vaults = vaultService.listVaults();
  const response = { count: vaults.length, vaults };
  validateResponse('vaultList', response);
  res.json(response);
}

function getVault(req, res) {
  const vault = vaultService.getVault(req.params.id);
  res.json({ vault });
}

function getTopVaults(req, res) {
  const vaults = vaultService.topVaults({
    sort: req.query.sort,
    limit: req.query.limit,
  });
  res.json({ count: vaults.length, sort: req.query.sort || 'tvl', vaults });
}

function getVaultPositions(req, res) {
  // Ensure the vault exists (throws 404 otherwise) before listing positions.
  vaultService.getVault(req.params.id);
  const access = { actor: req.wallet, isOperator: Boolean(req.isOperator) };
  const positions = positionService.listByVault(req.params.id, access);
  res.json({ count: positions.length, positions });
}

function getVaultApyHistory(req, res) {
  const days = parseInt(req.query.days, 10) || 30;
  const history = vaultService.getApyHistory(req.params.id, days);
  res.json({ vaultId: req.params.id, count: history.length, history });
}

function getVaultStats(req, res) {
  const stats = vaultService.getVaultStats(req.params.id);
  res.json({ stats });
}

function getVaultProjection(req, res) {
  const amount = parseFloat(req.query.amount) || 1000;
  const days = parseInt(req.query.days, 10) || 365;
  const projection = vaultService.projectDeposit(req.params.id, amount, days);
  res.json({ projection });
}

function getDepositPreview(req, res) {
  const preview = positionService.previewDeposit({
    vaultId: req.params.id,
    amount: Number(req.query.amount),
  });
  res.json({ preview });
}

module.exports = {
  listVaults,
  getTopVaults,
  getVault,
  getVaultPositions,
  getVaultApyHistory,
  getVaultStats,
  getVaultProjection,
  getDepositPreview,
};
