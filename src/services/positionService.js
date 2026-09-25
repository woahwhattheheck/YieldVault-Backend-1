'use strict';

const store = require('../store');
const { badRequest, notFound } = require('../utils/errors');
const { newPositionId } = require('../utils/ids');
const {
  quoteAssetsToShares,
  quoteSharesToAssets,
  sharesToAssets,
  round,
} = require('../utils/math');
const vaultService = require('./vaultService');
const stellarService = require('./stellarService');
const transactionLifecycle = require('./transactionLifecycleService');
const auditService = require('./auditService');

/**
 * Position service: deposit/withdraw flows and user position queries.
 *
 * A position represents one user's stake in one vault, tracked in shares. The
 * underlying asset value of a position is derived from the vault's current
 * price per share, so it grows automatically as yield accrues.
 */

function serialize(position) {
  const vault = store.vaults.get(position.vaultId);
  vaultService.syncVault(vault);
  const assetValue = sharesToAssets(
    position.shares,
    vault.totalAssets,
    vault.totalShares
  );
  return {
    id: position.id,
    user: position.user,
    vaultId: position.vaultId,
    shares: position.shares,
    assetValue,
    earnings: round(assetValue - position.principal),
    principal: position.principal,
    createdAt: position.createdAt,
    updatedAt: position.updatedAt,
  };
}

function deposit({ user, vaultId, amount, idempotencyKey, correlationId }) {
  return store.runAtomic(() => {
    const vault = vaultService.getVaultRecord(vaultId);
    const before = { totalAssets: vault.totalAssets, totalShares: vault.totalShares };
    let conversion;
    try {
      conversion = quoteAssetsToShares(amount, vault.totalAssets, vault.totalShares);
    } catch (error) {
      throw badRequest(error.message);
    }
    const shares = conversion.shares;
    amount = conversion.assets;

    const tx = stellarService.submitInvocation('deposit', { user, vaultId, amount });
    transactionLifecycle.registerProviderResult({ tx, user, vaultId, idempotencyKey, correlationId });
    store.transactions.set(tx.txHash, { ...tx, user, vaultId, amount });

    vault.totalAssets = round(vault.totalAssets + amount);
    vault.totalShares = round(vault.totalShares + shares);

    // Reuse an existing position for this user/vault pair when present.
    let position = Array.from(store.positions.values()).find(
      (p) => p.user === user && p.vaultId === vaultId
    );

    const now = Date.now();
    if (position) {
      position.shares = round(position.shares + shares);
      position.principal = round(position.principal + amount);
      position.updatedAt = now;
    } else {
      position = {
        id: newPositionId(),
        user,
        vaultId,
        shares,
        principal: amount,
        createdAt: now,
        updatedAt: now,
      };
      store.positions.set(position.id, position);
    }

    const result = { position: serialize(position), tx };
    auditService.record({
      actor: user,
      action: 'vault.deposit',
      target: vaultId,
      correlationId,
      outcome: 'success',
      before,
      after: { totalAssets: vault.totalAssets, totalShares: vault.totalShares, amount, shares },
    });
    return result;
  });
}

function withdraw({ user, vaultId, shares, idempotencyKey, correlationId }) {
  return store.runAtomic(() => {
    const vault = vaultService.getVaultRecord(vaultId);
    const position = Array.from(store.positions.values()).find(
      (p) => p.user === user && p.vaultId === vaultId
    );

    if (!position) {
      throw notFound(`No position found for user ${user} in vault ${vaultId}`);
    }
    if (shares > position.shares) {
      throw badRequest('Withdraw amount exceeds position shares', {
        requested: shares,
        available: position.shares,
      });
    }

    const before = { shares: position.shares, totalAssets: vault.totalAssets, totalShares: vault.totalShares };
    let conversion;
    try {
      conversion = quoteSharesToAssets(shares, vault.totalAssets, vault.totalShares);
    } catch (error) {
      throw badRequest(error.message);
    }
    shares = conversion.shares;
    const assets = conversion.assets;
    const tx = stellarService.submitInvocation('withdraw', { user, vaultId, shares });
    transactionLifecycle.registerProviderResult({ tx, user, vaultId, idempotencyKey, correlationId });
    store.transactions.set(tx.txHash, { ...tx, user, vaultId, shares, assets });

    vault.totalAssets = round(vault.totalAssets - assets);
    vault.totalShares = round(vault.totalShares - shares);

    position.shares = round(position.shares - shares);
    // Reduce principal proportionally to the shares being redeemed.
    const principalFraction =
      position.shares <= 0
        ? 0
        : round(position.principal * (position.shares / (position.shares + shares)));
    position.principal = position.shares <= 0 ? 0 : principalFraction;
    position.updatedAt = Date.now();

    let result;
    if (position.shares <= 0) {
      store.positions.delete(position.id);
      result = { withdrawnAssets: assets, tx, position: null };
    } else {
      result = { withdrawnAssets: assets, tx, position: serialize(position) };
    }

    auditService.record({
      actor: user,
      action: 'vault.withdraw',
      target: vaultId,
      correlationId,
      outcome: 'success',
      before,
      after: { shares: position.shares, totalAssets: vault.totalAssets, totalShares: vault.totalShares, assets },
    });
    return result;
  });
}

function previewDeposit({ vaultId, amount }) {
  const vault = vaultService.getVaultRecord(vaultId);
  try {
    return { vaultId, ...quoteAssetsToShares(amount, vault.totalAssets, vault.totalShares) };
  } catch (error) {
    throw badRequest(error.message);
  }
}

function getPosition(id) {
  const position = store.positions.get(id);
  if (!position) {
    throw notFound(`Position ${id} not found`);
  }
  return serialize(position);
}

function listPositions(user) {
  return Array.from(store.positions.values())
    .filter((p) => !user || p.user === user)
    .map(serialize);
}

function listByVault(vaultId) {
  return Array.from(store.positions.values())
    .filter((p) => p.vaultId === vaultId)
    .map(serialize);
}

/**
 * Aggregate a user's portfolio across every vault they hold a position in:
 * total invested principal, current value and net earnings.
 */
function getUserSummary(user) {
  const positions = listPositions(user);
  const totals = positions.reduce(
    (acc, p) => {
      acc.principal = round(acc.principal + p.principal);
      acc.value = round(acc.value + p.assetValue);
      acc.earnings = round(acc.earnings + p.earnings);
      return acc;
    },
    { principal: 0, value: 0, earnings: 0 }
  );

  return {
    user: user || null,
    positionCount: positions.length,
    vaults: new Set(positions.map((p) => p.vaultId)).size,
    totalPrincipal: totals.principal,
    totalValue: totals.value,
    totalEarnings: totals.earnings,
  };
}

module.exports = {
  serialize,
  deposit,
  previewDeposit,
  withdraw,
  getPosition,
  listPositions,
  listByVault,
  getUserSummary,
};
