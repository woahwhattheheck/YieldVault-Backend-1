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
| `INVALID_VAULT_ASSETS` / `INVALID_VAULT_SHARES` | Vault balance is missing, not a number, or not finite |
| `INVALID_POSITION_SHARES` / `INVALID_POSITION_PRINCIPAL` | Position balance is missing, not a number, or not finite |
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

Assets, shares, and principal must be finite JavaScript numbers. `NaN`, positive
or negative infinity, absent values, `null`, strings, and booleans produce a
field-specific error finding with the affected entity ID. The report does not
coerce these values to zero or rewrite the stored record. Finite zero and
fractional values remain valid; finite negative values retain their existing
`NEGATIVE_*` codes.

The share-allocation comparison runs only when the vault supply and every
position's shares for that vault are finite. Invalid share inputs have their own
findings; omitting them from a partial total must not produce a misleading
`SHARES_OVERALLOCATED` result. Independent vaults are still checked. The new
findings use the existing stable ordering, filters, and bounded pagination.

## API

```
GET /api/reconciliation?limit=&offset=&vaultId=
Authorization: Bearer <reader-token>
```

Response fields:

- `status`: `ok` | `mismatches_found`
- `repaired`: always `false` (this endpoint never mutates)
- `findings[]`: actionable `{ id, code, severity, entityType, entityId, detail }`
- `pagination`: bounded page metadata (`limit` capped at 100)

## Online report resource bounds

`generateReport` scans the same records and returns the same exact finding count,
status, stable code/entity ordering and `vaultId` filter as the full collector.
It retains only the earliest `offset + limit` findings, rather than materializing
and sorting all findings for a small response. Equal sort keys retain scan order.

The online page window is capped at **10,000** (`offset + effective limit`). A
larger or unsafe-integer offset receives HTTP 400 with
`error.details.code = REPORT_WINDOW_TOO_LARGE` and `maxWindow = 10000` before
any store traversal. The existing limit defaults to 20 and remains capped at 100.
This is an explicit compatibility limit, not a silent truncation. Narrow large
reports with `vaultId`; bulk exports beyond this window need a separate offline
workflow. Existing in-process `collectFindings` still deliberately returns all
findings for its current callers.

A `vaultId` filter selects the vault through its existing Map key, without
walking unrelated vault records. An unknown key requires no vault traversal.
The position, transaction and lifecycle collections still receive their existing
filtered scans, including missing-vault findings; unfiltered reports retain the
complete vault traversal. No new index or stored state is introduced.

A bounded execution on 2026-10-04 compared the actual service at `804e5113`
with the keyed lookup at `d57f8960` (source blob `161aa2d7`). Ubuntu 24.04,
Node 22.23.3; three alternating timed pairs after one warm call per version:

| Stored vaults | Vault records iterated before / after | Median report time before / after |
| --- | --- | --- |
| 1,000 | 1,000 / 0 | 0.051254 / 0.050493 ms |
| 10,000 | 10,000 / 0 | 0.402177 / 0.021779 ms |

The selected vault still receives its normal invariant checks through one keyed
lookup. Both versions returned identical normalized three-finding reports.
Unfiltered reports and an unknown-key report containing a missing-vault position
also matched. These are in-memory service measurements, not HTTP or production
throughput; the 1,000-vault timings do not establish a latency improvement.
The original bounded-selector workload was not rerun.

Raw milliseconds (before; after): 1,000 vaults
`[0.061998, 0.051254, 0.043440]; [0.050493, 0.023103, 0.317691]`;
10,000 vaults `[0.627729, 0.330518, 0.402177]; [0.024961, 0.017315, 0.021779]`.
[Executed workflow and source](https://github.com/woahwhattheheck/YieldVault-Backend-1/actions/runs/37201901750)
retain the command and normalized output hashes.

This bounds retained finding objects, not total scan time or the existing store.
For N scanned findings and page window K, selection costs O(N log K) and retains
O(K) findings. The accounting scan still maintains its per-vault share totals and
visits the selected store collections to produce an exact overall count. A
production database-backed scan/cursor remains a separate rollout concern.

## Authenticated report readers

Both `/api/reconciliation` and `/api/audit` authenticate an opaque Bearer token
against `AUDIT_READER_CREDENTIALS`. This server-owned JSON array maps each token's
SHA-256 digest to a named `subject` and `role`. Only the configured `admin` and
`auditor` roles can read reports. Request headers such as `X-Audit-Role` cannot
assign identity or privileges. The shared middleware attaches the verified
identity as `req.auditPrincipal` for server-side consumers.

Generate a separate 256-bit random token for each reader with Node's built-in
crypto module. Run this locally and store the printed token securely for the
reader; put only the digest-based configuration in the server environment:

```bash
node <<'NODE'
const { randomBytes, createHash } = require('node:crypto');
const token = randomBytes(32).toString('base64url');
const entry = {
  subject: 'operations-auditor',
  role: 'auditor',
  tokenSha256: createHash('sha256').update(token).digest('hex'),
};
console.log('Reader token: ' + token);
console.log('AUDIT_READER_CREDENTIALS=' + JSON.stringify([entry]));
NODE
```

Copy the generated `AUDIT_READER_CREDENTIALS` value to the server environment
or its local `.env`, then restart the service. Do not commit reader tokens or
deployment credential configuration. Tokens must contain 43–128 URL-safe
base64 characters; generate them randomly rather than using passwords. The
stored digest is not accepted as a Bearer token.

With the raw reader token stored in a client variable named `YV_AUDIT_TOKEN`:

```bash
curl 'http://localhost:3000/api/reconciliation?limit=20' \
  -H "Authorization: Bearer $YV_AUDIT_TOKEN"
```

Use HTTPS outside local development. Send credentials only in the
`Authorization` header, never in URLs or query parameters. The application's
request and error loggers do not log this header.

| Request/configuration | Result |
| --- | --- |
| Missing, malformed or unknown Bearer token | `401` with a Bearer challenge |
| Valid token assigned a role other than `admin` or `auditor` | `403` |
| Valid token assigned `admin` or `auditor` | Report returned with `200` |
| Unset, empty or `[]` credential configuration | All report reads denied |
| Malformed registry or duplicate token digest | Startup fails with a generic configuration error |

Report responses, including authentication errors, carry
`Cache-Control: private, no-store`. The registry accepts at most 100 entries;
each entry contains exactly `subject`, `role`, and `tokenSha256`. Subjects are
non-empty, trimmed strings of at most 128 characters without control characters;
roles are lowercase identifiers, and digests are 64 hexadecimal characters.

Configuration is loaded once at startup. To rotate a credential, add a new
digest for the same subject, restart, distribute the new token, then remove the
old digest and restart again. Remove a reader's digest and restart to revoke
access. Tokens do not have automatic expiry in this dependency-free mock
service; an external identity provider is not required or integrated.

This boundary authenticates report readers. Mutation routes still use the
demo's caller-supplied `user` field, which is the recorded audit event actor;
reader credentials do not authenticate those mutation actors.

## Atomic mutations

`store.runAtomic(fn)` snapshots `vaults`, `positions`, `transactions`,
`transactionStates`, and `auditEvents`, runs `fn`, and restores the snapshot if
`fn` throws. `positionService.deposit` / `withdraw` run inside this boundary.

Snapshots use Node's built-in structured clone to preserve stored numeric
values and explicit `undefined` fields. A failed operation must not convert
unrelated `NaN` or infinite balances to `null`, or erase evidence needed by
reconciliation. Rollback retains the collection Map identities and rethrows
the original error; it does not validate or repair the restored records.

## Production notes

The demo store is process-local. A durable deployment should use a real database
transaction (or saga + outbox) with the same invariant set, and treat this report
as an online check — never as an implicit repair job.
