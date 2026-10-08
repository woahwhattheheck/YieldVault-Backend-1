'use strict';

const store = require('../store');
const { round } = require('../utils/math');
const { parseParams } = require('../utils/pagination');
const { badRequest } = require('../utils/errors');
const { BoundedFindingPage, MAX_REPORT_WINDOW } = require('./reconciliationPage');

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
  INVALID_VAULT_ASSETS: 'INVALID_VAULT_ASSETS',
  INVALID_VAULT_SHARES: 'INVALID_VAULT_SHARES',
  INVALID_POSITION_SHARES: 'INVALID_POSITION_SHARES',
  INVALID_POSITION_PRINCIPAL: 'INVALID_POSITION_PRINCIPAL',
  NEGATIVE_VAULT_ASSETS: 'NEGATIVE_VAULT_ASSETS',
  NEGATIVE_VAULT_SHARES: 'NEGATIVE_VAULT_SHARES',
  NEGATIVE_POSITION_SHARES: 'NEGATIVE_POSITION_SHARES',
  NEGATIVE_POSITION_PRINCIPAL: 'NEGATIVE_POSITION_PRINCIPAL',
  POSITION_VAULT_MISSING: 'POSITION_VAULT_MISSING',
  SHARES_OVERALLOCATED: 'SHARES_OVERALLOCATED',
  TX_VAULT_MISSING: 'TX_VAULT_MISSING',
  INVALID_TX_IDENTITY: 'INVALID_TX_IDENTITY',
  TX_LIFECYCLE_MISSING: 'TX_LIFECYCLE_MISSING',
  INVALID_LIFECYCLE_IDENTITY: 'INVALID_LIFECYCLE_IDENTITY',
  TX_LIFECYCLE_STATUS_MISMATCH: 'TX_LIFECYCLE_STATUS_MISMATCH',
  TX_ACCOUNTING_UNAPPLIED: 'TX_ACCOUNTING_UNAPPLIED',
  INVALID_TX_STATUS: 'INVALID_TX_STATUS',
  INVALID_LIFECYCLE_STATUS: 'INVALID_LIFECYCLE_STATUS',
  LIFECYCLE_TX_MISSING: 'LIFECYCLE_TX_MISSING',
  INVALID_FEE_BPS: 'INVALID_FEE_BPS',
});

const SUCCESS_ALIASES = new Set(['SUCCESS', 'success', 'confirmed', 'CONFIRMED']);
const TRANSACTION_STATUSES = new Set(['pending', 'submitted', 'confirmed', 'failed', 'unknown']);

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

function checkBalance(findings, { record, entityType, field, invalidCode, negativeCode, related }) {
  const value = record[field];
  let code;
  let detail;
  if (!Number.isFinite(value)) {
    code = invalidCode;
    const received = typeof value === 'number' ? String(value) : value === null ? 'null' : typeof value;
    detail = `${entityType}.${field} must be a finite number; received ${received}`;
  } else if (value < 0) {
    code = negativeCode;
    detail = `${entityType}.${field} is ${value}`;
  } else {
    return;
  }
  findings.push(finding({
    code, severity: SEVERITY.error, entityType, entityId: record.id, detail, related,
  }));
}

/**
 * Scan the store for invariant violations. Pure: does not write.
 */
function scanFindings({ vaultId } = {}, findings) {
  const sharesByVault = new Map();
  const invalidSharesByVault = new Set();

  const vaults = vaultId
    ? [store.vaults.get(vaultId)].filter(Boolean)
    : store.vaults.values();
  for (const vault of vaults) {
    if (vaultId && vault.id !== vaultId) continue;

    for (const [field, invalidCode, negativeCode] of [
      ['totalAssets', CODES.INVALID_VAULT_ASSETS, CODES.NEGATIVE_VAULT_ASSETS],
      ['totalShares', CODES.INVALID_VAULT_SHARES, CODES.NEGATIVE_VAULT_SHARES],
    ]) {
      checkBalance(findings, { record: vault, entityType: 'vault', field, invalidCode, negativeCode });
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

    for (const [field, invalidCode, negativeCode] of [
      ['shares', CODES.INVALID_POSITION_SHARES, CODES.NEGATIVE_POSITION_SHARES],
      ['principal', CODES.INVALID_POSITION_PRINCIPAL, CODES.NEGATIVE_POSITION_PRINCIPAL],
    ]) {
      checkBalance(findings, {
        record: position, entityType: 'position', field, invalidCode, negativeCode,
        related: { vaultId: position.vaultId, user: position.user },
      });
    }
    if (!Number.isFinite(position.shares)) invalidSharesByVault.add(position.vaultId);

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
    } else if (Number.isFinite(position.shares)) {
      const prev = sharesByVault.get(position.vaultId) || 0;
      sharesByVault.set(
        position.vaultId,
        round(prev + position.shares)
      );
    }
  }

  for (const [id, allocated] of sharesByVault.entries()) {
    const vault = store.vaults.get(id);
    if (!vault || !Number.isFinite(vault.totalShares) || invalidSharesByVault.has(id)) continue;
    // Invalid inputs already have actionable findings. A partial sum or a
    // coerced zero would misrepresent the allocation comparison for this vault.
    const supply = vault.totalShares;
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

  for (const [txKey, tx] of store.transactions.entries()) {
    const txId = String(txKey);
    if (vaultId && tx.vaultId && tx.vaultId !== vaultId) continue;

    if (tx.txHash !== txKey) {
      findings.push(
        finding({
          code: CODES.INVALID_TX_IDENTITY,
          severity: SEVERITY.error,
          entityType: 'transaction',
          entityId: txId,
          detail: tx.txHash == null
            ? `transaction txHash is missing; store key is ${txId}`
            : `transaction txHash ${String(tx.txHash)} does not match store key ${txId}`,
          related: { storedTxHash: tx.txHash == null ? null : String(tx.txHash) },
        })
      );
    }

    if (tx.vaultId && !store.vaults.has(tx.vaultId)) {
      findings.push(
        finding({
          code: CODES.TX_VAULT_MISSING,
          severity: SEVERITY.error,
          entityType: 'transaction',
          entityId: txId,
          detail: `transaction references missing vault ${tx.vaultId}`,
          related: { vaultId: tx.vaultId },
        })
      );
    }

    if (tx.accountingApplied === false) {
      findings.push(
        finding({
          code: CODES.TX_ACCOUNTING_UNAPPLIED,
          severity: SEVERITY.error,
          entityType: 'transaction',
          entityId: txId,
          detail: 'provider transaction completed but local accounting rolled back; reconcile before retry',
          related: { vaultId: tx.vaultId, operation: tx.operation },
        })
      );
    }

    const life = store.transactionStates.get(txKey);
    if (!life) {
      findings.push(
        finding({
          code: CODES.TX_LIFECYCLE_MISSING,
          severity: SEVERITY.warning,
          entityType: 'transaction',
          entityId: txId,
          detail: 'transaction has no lifecycle record',
        })
      );
      continue;
    }

    const ledgerStatus = normalizeTxStatus(tx.status);
    const lifeStatus = normalizeTxStatus(life.status);
    const ledgerStatusValid = TRANSACTION_STATUSES.has(ledgerStatus);
    const lifeStatusValid = TRANSACTION_STATUSES.has(lifeStatus);

    if (!ledgerStatusValid) {
      findings.push(
        finding({
          code: CODES.INVALID_TX_STATUS,
          severity: SEVERITY.error,
          entityType: 'transaction',
          entityId: txId,
          detail: `transaction status is missing or unrecognized: ${String(tx.status)}`,
        })
      );
    }
    if (!lifeStatusValid) {
      findings.push(
        finding({
          code: CODES.INVALID_LIFECYCLE_STATUS,
          severity: SEVERITY.error,
          entityType: 'transactionState',
          entityId: txId,
          detail: `lifecycle status is missing or unrecognized: ${String(life.status)}`,
        })
      );
    }
    if (ledgerStatusValid && lifeStatusValid && ledgerStatus !== lifeStatus) {
      findings.push(
        finding({
          code: CODES.TX_LIFECYCLE_STATUS_MISMATCH,
          severity: SEVERITY.error,
          entityType: 'transaction',
          entityId: txId,
          detail: `ledger status ${tx.status} disagrees with lifecycle status ${life.status}`,
          related: { ledgerStatus, lifeStatus },
        })
      );
    }
  }

  for (const [lifeKey, life] of store.transactionStates.entries()) {
    const lifeId = String(lifeKey);
    if (vaultId && life.vaultId && life.vaultId !== vaultId) continue;

    if (life.txHash !== lifeKey) {
      findings.push(
        finding({
          code: CODES.INVALID_LIFECYCLE_IDENTITY,
          severity: SEVERITY.error,
          entityType: 'transactionState',
          entityId: lifeId,
          detail: life.txHash == null
            ? `lifecycle txHash is missing; store key is ${lifeId}`
            : `lifecycle txHash ${String(life.txHash)} does not match store key ${lifeId}`,
          related: { storedTxHash: life.txHash == null ? null : String(life.txHash) },
        })
      );
    }

    if (!store.transactions.has(lifeKey)) {
      findings.push(
        finding({
          code: CODES.LIFECYCLE_TX_MISSING,
          severity: SEVERITY.warning,
          entityType: 'transactionState',
          entityId: lifeId,
          detail: 'lifecycle record has no matching ledger transaction',
          related: { vaultId: life.vaultId, status: life.status },
        })
      );
    }
  }

}

function compareFindings(a, b) {
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  if (a.entityId !== b.entityId) return a.entityId < b.entityId ? -1 : 1;
  return 0;
}

/** Explicit full collection for existing in-process callers, not the HTTP page. */
function collectFindings(options = {}) {
  const findings = [];
  scanFindings(options, findings);
  return findings.sort(compareFindings);
}

/**
 * Build a bounded reconciliation report. Never repairs financial state.
 */
function generateReport(query = {}) {
  const { limit, offset } = parseParams(query);
  // Reject before traversing the store; never let offset turn a small page
  // into an arbitrarily large retained prefix.
  if (!Number.isSafeInteger(offset) || offset + limit > MAX_REPORT_WINDOW) {
    throw badRequest('Reconciliation page window is too large', {
      code: 'REPORT_WINDOW_TOO_LARGE',
      maxWindow: MAX_REPORT_WINDOW,
    });
  }
  const vaultId =
    typeof query.vaultId === 'string' && query.vaultId.length > 0
      ? query.vaultId
      : undefined;

  const selected = new BoundedFindingPage(offset + limit, compareFindings);
  scanFindings({ vaultId }, selected);
  const page = selected.page(offset, limit);

  return {
    generatedAt: new Date().toISOString(),
    status: selected.total === 0 ? 'ok' : 'mismatches_found',
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
      total: selected.total,
      limit,
      offset,
      hasMore: offset + limit < selected.total,
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
