'use strict';

const store = require('../store');
const { round } = require('../utils/math');
const { parseParams } = require('../utils/pagination');

/**
 * Accounting invariants and a bounded, read-only reconciliation report.
 *
 * The report never mutates financial state. Callers that need repair must act
 * explicitly from the actionable finding identifiers.
 */

const SEVERITY = Object.freeze({
  error: 'error',
  warning: 'warning',
});

const CODES = Object.freeze({
  NEGATIVE_VAULT_ASSETS: 'NEGATIVE_VAULT_ASSETS',
  NEGATIVE_VAULT_SHARES: 'NEGATIVE_VAULT_SHARES',
  NEGATIVE_POSITION_SHARES: 'NEGATIVE_POSITION_SHARES',
  NEGATIVE_POSITION_PRINCIPAL: 'NEGATIVE_POSITION_PRINCIPAL',
  POSITION_VAULT_MISSING: 'POSITION_VAULT_MISSING',
  SHARES_OVERALLOCATED: 'SHARES_OVERALLOCATED',
  TX_VAULT_MISSING: 'TX_VAULT_MISSING',
  TX_LIFECYCLE_MISSING: 'TX_LIFECYCLE_MISSING',
  TX_LIFECYCLE_STATUS_MISMATCH: 'TX_LIFECYCLE_STATUS_MISMATCH',
  LIFECYCLE_TX_MISSING: 'LIFECYCLE_TX_MISSING',
  INVALID_FEE_BPS: 'INVALID_FEE_BPS',
});

const SUCCESS_ALIASES = new Set(['SUCCESS', 'success', 'confirmed', 'CONFIRMED']);

function normalizeTxStatus(status) {
  if (status == null) return null;
  const raw = String(status);
  if (SUCCESS_ALIASES.has(raw)) return 'confirmed';
  return raw.toLowerCase();
}

function finding({ code, severity, entityType, entityId, detail, related }) {
  return {
    id: `${code}:${entityType}:${entityId}`,
    code,
    severity,
    entityType,
    entityId,
    detail,
    related: related || undefined,
  };
}

/**
 * Scan the store for invariant violations. Pure: does not write.
 */
function collectFindings({ vaultId } = {}) {
  const findings = [];
  const sharesByVault = new Map();

  for (const vault of store.vaults.values()) {
    if (vaultId && vault.id !== vaultId) continue;

    if (typeof vault.totalAssets === 'number' && vault.totalAssets < 0) {
      findings.push(
        finding({
          code: CODES.NEGATIVE_VAULT_ASSETS,
          severity: SEVERITY.error,
          entityType: 'vault',
          entityId: vault.id,
          detail: `vault.totalAssets is ${vault.totalAssets}`,
        })
      );
    }
    if (typeof vault.totalShares === 'number' && vault.totalShares < 0) {
      findings.push(
        finding({
          code: CODES.NEGATIVE_VAULT_SHARES,
          severity: SEVERITY.error,
          entityType: 'vault',
          entityId: vault.id,
          detail: `vault.totalShares is ${vault.totalShares}`,
        })
      );
    }
    if (
      vault.managementFeeBps != null &&
      (!Number.isFinite(vault.managementFeeBps) ||
        vault.managementFeeBps < 0 ||
        vault.managementFeeBps > 10000)
    ) {
      findings.push(
        finding({
          code: CODES.INVALID_FEE_BPS,
          severity: SEVERITY.warning,
          entityType: 'vault',
          entityId: vault.id,
          detail: `managementFeeBps out of range: ${vault.managementFeeBps}`,
        })
      );
    }
  }

  for (const position of store.positions.values()) {
    if (vaultId && position.vaultId !== vaultId) continue;

    if (typeof position.shares === 'number' && position.shares < 0) {
      findings.push(
        finding({
          code: CODES.NEGATIVE_POSITION_SHARES,
          severity: SEVERITY.error,
          entityType: 'position',
          entityId: position.id,
          detail: `position.shares is ${position.shares}`,
          related: { vaultId: position.vaultId, user: position.user },
        })
      );
    }
    if (typeof position.principal === 'number' && position.principal < 0) {
      findings.push(
        finding({
          code: CODES.NEGATIVE_POSITION_PRINCIPAL,
          severity: SEVERITY.error,
          entityType: 'position',
          entityId: position.id,
          detail: `position.principal is ${position.principal}`,
          related: { vaultId: position.vaultId, user: position.user },
        })
      );
    }

    if (!store.vaults.has(position.vaultId)) {
      findings.push(
        finding({
          code: CODES.POSITION_VAULT_MISSING,
          severity: SEVERITY.error,
          entityType: 'position',
          entityId: position.id,
          detail: `position references missing vault ${position.vaultId}`,
          related: { vaultId: position.vaultId, user: position.user },
        })
      );
    } else {
      const prev = sharesByVault.get(position.vaultId) || 0;
      sharesByVault.set(
        position.vaultId,
        round(prev + (Number(position.shares) || 0))
      );
    }
  }

  for (const [id, allocated] of sharesByVault.entries()) {
    const vault = store.vaults.get(id);
    if (!vault) continue;
    const supply = Number(vault.totalShares) || 0;
    // Seed vaults may hold unallocated supply; over-allocation is never ok.
    if (round(allocated - supply) > 1e-6) {
      findings.push(
        finding({
          code: CODES.SHARES_OVERALLOCATED,
          severity: SEVERITY.error,
          entityType: 'vault',
          entityId: id,
          detail: `allocated shares ${allocated} exceed vault.totalShares ${supply}`,
          related: { allocated, supply },
        })
      );
    }
  }

  for (const tx of store.transactions.values()) {
    if (vaultId && tx.vaultId && tx.vaultId !== vaultId) continue;

    if (tx.vaultId && !store.vaults.has(tx.vaultId)) {
      findings.push(
        finding({
          code: CODES.TX_VAULT_MISSING,
          severity: SEVERITY.error,
          entityType: 'transaction',
          entityId: tx.txHash,
          detail: `transaction references missing vault ${tx.vaultId}`,
          related: { vaultId: tx.vaultId },
        })
      );
    }

    const life = store.transactionStates.get(tx.txHash);
    if (!life) {
      findings.push(
        finding({
          code: CODES.TX_LIFECYCLE_MISSING,
          severity: SEVERITY.warning,
          entityType: 'transaction',
          entityId: tx.txHash,
          detail: 'transaction has no lifecycle record',
        })
      );
      continue;
    }

    const ledgerStatus = normalizeTxStatus(tx.status);
    const lifeStatus = normalizeTxStatus(life.status);
    if (ledgerStatus && lifeStatus && ledgerStatus !== lifeStatus) {
      findings.push(
        finding({
          code: CODES.TX_LIFECYCLE_STATUS_MISMATCH,
          severity: SEVERITY.error,
          entityType: 'transaction',
          entityId: tx.txHash,
          detail: `ledger status ${tx.status} disagrees with lifecycle status ${life.status}`,
          related: { ledgerStatus, lifeStatus },
        })
      );
    }
  }

  for (const life of store.transactionStates.values()) {
    if (vaultId && life.vaultId && life.vaultId !== vaultId) continue;
    if (!store.transactions.has(life.txHash)) {
      findings.push(
        finding({
          code: CODES.LIFECYCLE_TX_MISSING,
          severity: SEVERITY.warning,
          entityType: 'transactionState',
          entityId: life.txHash,
          detail: 'lifecycle record has no matching ledger transaction',
          related: { vaultId: life.vaultId, status: life.status },
        })
      );
    }
  }

  findings.sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    if (a.entityId !== b.entityId) return a.entityId < b.entityId ? -1 : 1;
    return 0;
  });

  return findings;
}

/**
 * Build a bounded reconciliation report. Never repairs financial state.
 */
function generateReport(query = {}) {
  const { limit, offset } = parseParams(query);
  const vaultId =
    typeof query.vaultId === 'string' && query.vaultId.length > 0
      ? query.vaultId
      : undefined;

  const all = collectFindings({ vaultId });
  const page = all.slice(offset, offset + limit);

  return {
    generatedAt: new Date().toISOString(),
    status: all.length === 0 ? 'ok' : 'mismatches_found',
    repaired: false,
    filters: { vaultId: vaultId || null },
    checked: {
      vaults: vaultId ? (store.vaults.has(vaultId) ? 1 : 0) : store.vaults.size,
      positions: store.positions.size,
      transactions: store.transactions.size,
      transactionStates: store.transactionStates.size,
    },
    findings: page,
    pagination: {
      total: all.length,
      limit,
      offset,
      hasMore: offset + limit < all.length,
    },
  };
}

module.exports = {
  CODES,
  SEVERITY,
  collectFindings,
  generateReport,
  normalizeTxStatus,
};
