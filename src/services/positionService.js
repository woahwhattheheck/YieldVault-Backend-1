'use strict';

const store = require('../store');
const { badRequest, notFound } = require('../utils/errors');
const {
  resolveActingUser,
  assertPositionAccess,
  resolveListScope,
} = require('../auth/positionAccess');
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

function deposit({ user, vaultId, amount, idempotencyKey, correlationId, actor, isOperator = false }) {
  user = resolveActingUser({ user, actor, isOperator });
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
}

function withdraw({ user, vaultId, shares, idempotencyKey, correlationId, actor, isOperator = false }) {
  user = resolveActingUser({ user, actor, isOperator });
  const vault = vaultService.getVaultRecord(vaultId);
  const position = Array.from(store.positions.values()).find(
    (p) => p.user === user && p.vaultId === vaultId
  );

  if (!position) {
    // Identical to a missing direct-id lookup so callers cannot tell whether
    // the vault/user pair exists under another principal.
    throw notFound('Position not found');
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
}

function previewDeposit({ vaultId, amount }) {
  const vault = vaultService.getVaultRecord(vaultId);
  try {
    return { vaultId, ...quoteAssetsToShares(amount, vault.totalAssets, vault.totalShares) };
  } catch (error) {
    throw badRequest(error.message);
  }
}

function getPosition(id, access = {}) {
  const position = store.positions.get(id);
  assertPositionAccess(position, access, { action: 'read' });
  return serialize(position);
}

function listPositions(user, access = {}) {
  const scope = resolveListScope(user, access);
  if (scope.empty) {
    return [];
  }
  return Array.from(store.positions.values())
    .filter((p) => !scope.filter || p.user === scope.filter)
    .map(serialize);
}

function listByVault(vaultId, access = {}) {
  const positions = Array.from(store.positions.values()).filter((p) => p.vaultId === vaultId);
  // Vault-wide listing is an administrative path: operators see every row,
  // unprivileged callers only see their own positions in that vault.
  if (access.isOperator) {
    return positions.map(serialize);
  }
  const actor = typeof access.actor === 'string' ? access.actor.trim() : '';
  if (!actor) {
    // Legacy direct callers without an HTTP binding still need an explicit
    // actor; otherwise refuse the unscoped dump.
    assertPositionAccess(null, access, { action: 'list' });
  }
  return positions.filter((p) => p.user === actor).map(serialize);
}

/**
 * Aggregate a user's portfolio across every vault they hold a position in:
 * total invested principal, current value and net earnings.
 *
 * Ownership is enforced through {@link listPositions}, so a caller cannot
 * request another wallet's summary unless they are an operator.
 */
function getUserSummary(user, access = {}) {
  const scope = resolveListScope(user, access);
  if (scope.empty) {
    return {
      user: scope.filter,
      positionCount: 0,
      vaults: 0,
      totalPrincipal: 0,
      totalValue: 0,
      totalEarnings: 0,
    };
  }

  const positions = Array.from(store.positions.values())
    .filter((p) => !scope.filter || p.user === scope.filter)
    .map(serialize);

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
    user: scope.filter || (typeof user === 'string' ? user : null),
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
