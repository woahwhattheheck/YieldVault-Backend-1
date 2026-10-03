# Analytics vault-history pagination

## Problem

Offset pagination over a growing deposit/withdraw ledger is both slow (deep
pages rescan the prefix) and incorrect under concurrency: inserts shift the
window so clients see duplicates or gaps between pages.

## Solution

`GET /api/analytics/history` pages the ledger with **signed cursors** backed by
an append-only ordered index:

- Every ledger row gets a dense, immutable sequence number at insert time.
- A cursor encodes `(seq, timestamp, order, filter fingerprint, actor fingerprint)`
  and is HMAC-signed with `ANALYTICS_CURSOR_SECRET`.
- Pages are exclusive of the cursor position, so concurrent inserts only appear
  at the newest edge — never inside a page the client already consumed.
- `limit` above `ANALYTICS_PAGE_MAX_LIMIT` (default 100) is **rejected** with
  `400 LIMIT_TOO_LARGE`, not silently clamped.
- Filters (`vaultId`, `actor`/`user`, `from`, `to`) are applied as indexed
  group scans (vault) plus residual predicates (actor / time range).
- Each scan examines at most `ANALYTICS_PAGE_MAX_SCAN` records so a selective
  filter cannot turn into an unbounded table walk.

Start cursor pagination by omitting both `cursor` and `offset`. The initial
page uses the same scan budget as later cursor pages and does not calculate a
collection-wide `total`. To request the legacy offset response, supply an
explicit `offset` (including `offset=0`); that response includes `total` and
requires an additional full filtered count.

## Request

```http
GET /api/analytics/history?vaultId=vault_…&actor=G…&from=2026-01-01T00:00:00.000Z&to=2026-12-31T23:59:59.999Z&limit=50&order=desc&cursor=…
```

| Param | Notes |
| --- | --- |
| `limit` | Optional. Default 50. Must be `1…maxLimit` or the request is rejected. |
| `order` | `asc` or `desc` (default `desc`). |
| `cursor` | Opaque resume token from a prior page. Mutually exclusive with `offset`. |
| `offset` | Legacy. Rejected when deeper than `maxScan`; prefer cursors. |
| `vaultId` | Restrict to one vault (uses the secondary index). |
| `actor` / `user` | Restrict to one wallet. |
| `from` / `to` | Inclusive ISO-8601 time bounds. |

Pass `X-Wallet-Address` so cursors are bound to the calling actor. A cursor
minted for one wallet is rejected (`403 CURSOR_ACTOR_MISMATCH`) when replayed
by another.

## Response

```json
{
  "count": 50,
  "events": [ { "txHash": "…", "timestamp": "…", "user": "…", "vaultId": "…", "…": "…" } ],
  "pagination": {
    "count": 50,
    "limit": 50,
    "order": "desc",
    "strategy": "cursor",
    "filters": { "vaultId": "vault_…" },
    "maxLimit": 100,
    "pageInfo": {
      "hasMore": true,
      "nextCursor": "…",
      "endCursor": "…",
      "scanned": 50,
      "scanTruncated": false
    }
  }
}
```

Follow `pageInfo.nextCursor` until `hasMore` is false. When `scanTruncated` is
true the page ended because of the work budget, not the end of the collection —
the page is still gap-free; continue with `nextCursor`.

## Compatibility

- Existing `GET /api/transactions?limit=&offset=` offset pagination is unchanged.
- Existing `GET /api/analytics` and `/tvl-history` are unchanged.
- Demo store is in-memory; set `ANALYTICS_CURSOR_SECRET` to the same value on
  every instance before running more than one process behind a load balancer.
  Without it each process mints an ephemeral key and cursors are not portable
  across instances (acceptable for the single-process demo).

## Rollout

1. Deploy with `ANALYTICS_CURSOR_SECRET` set.
2. Point analytics clients at `/api/analytics/history` with cursors.
3. Keep `/api/transactions` offset clients on shallow pages only; deep offsets
   on the new endpoint are rejected with `OFFSET_TOO_DEEP`.
