# Vault accounting reconciliation

## Purpose

Multi-record mutations (deposit / withdraw) touch vault totals, positions,
transaction ledger rows, lifecycle state, and audit events. This module:

1. Executes those writes **atomically** on the in-memory store (snapshot +
   restore on failure) so a mid-flight exception cannot leave partial balances.
2. Exposes a **read-only** reconciliation report that detects seeded or drifted
   mismatches without repairing financial state.

## Invariants

| Code | Meaning |
| --- | --- |
| `NEGATIVE_VAULT_ASSETS` / `NEGATIVE_VAULT_SHARES` | Vault balances below zero |
| `NEGATIVE_POSITION_SHARES` / `NEGATIVE_POSITION_PRINCIPAL` | Position balances below zero |
| `POSITION_VAULT_MISSING` | Position references a deleted / unknown vault |
| `SHARES_OVERALLOCATED` | Sum of position shares exceeds `vault.totalShares` |
| `TX_VAULT_MISSING` | Ledger tx references a missing vault |
| `TX_LIFECYCLE_MISSING` | Ledger tx has no lifecycle record |
| `TX_LIFECYCLE_STATUS_MISMATCH` | Ledger status disagrees with lifecycle status |
| `LIFECYCLE_TX_MISSING` | Lifecycle row has no ledger tx |
| `INVALID_FEE_BPS` | Fee field outside `[0, 10000]` |

Seed vaults may hold unallocated share supply (no position rows). Over-allocation
is always an error; under-allocation is allowed.

## API

```
GET /api/reconciliation?limit=&offset=&vaultId=
Header: X-Audit-Role: admin|auditor
```

Response fields:

- `status`: `ok` | `mismatches_found`
- `repaired`: always `false` (this endpoint never mutates)
- `findings[]`: actionable `{ id, code, severity, entityType, entityId, detail }`
- `pagination`: bounded page metadata (`limit` capped at 100)

## Atomic mutations

`store.runAtomic(fn)` snapshots `vaults`, `positions`, `transactions`,
`transactionStates`, and `auditEvents`, runs `fn`, and restores the snapshot if
`fn` throws. `positionService.deposit` / `withdraw` run inside this boundary.

## Production notes

The demo store is process-local. A durable deployment should use a real database
transaction (or saga + outbox) with the same invariant set, and treat this report
as an online check — never as an implicit repair job.
