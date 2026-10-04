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
- Filters (`vaultId`, `actor`/`user`, `from`, `to`) use vault, actor, or combined
  vault-and-actor index buckets plus a residual time-range predicate. An actor
  query never spends its scan budget on another actor's ledger rows.
- Each scan examines at most `ANALYTICS_PAGE_MAX_SCAN` records so a selective
  filter cannot turn into an unbounded table walk.

Start cursor pagination by omitting both `cursor` and `offset`. The initial
page uses the same scan budget as later cursor pages and does not calculate a
collection-wide `total`. To request the legacy offset response, supply an
explicit `offset` (including `offset=0`); that response includes `total` and
requires an additional full filtered count.

An omitted or empty `limit` uses the smaller of `ANALYTICS_PAGE_DEFAULT_LIMIT`
(default 50) and `ANALYTICS_PAGE_MAX_LIMIT` (default 100). Lowering the maximum
therefore also bounds initial, resumed and legacy-offset default pages, even
when the configured default is larger. Explicit limits above the maximum
still return `400 LIMIT_TOO_LARGE`; they are not silently clamped.

A legacy offset must be fully reached within the scan budget. A selective
time filter can make even a numerically small offset too expensive: with a
three-record budget, alternating in-range/out-of-range timestamps and `offset=3`, the scan cannot skip
three matching records. That request returns `400 OFFSET_TOO_DEEP` with
`details.maxScan` and no continuation cursor. Restart without `offset` and
follow cursor pages. Returning a cursor before finishing the skip would lose
the remaining offset and include rows the caller asked to omit.

Offsets reached exactly at the budget remain resumable. An offset beyond the
matching collection still returns an empty last page when the scan reaches
the collection's end within the budget.

## Request

```http
GET /api/analytics/history?vaultId=vault_…&actor=G…&from=2026-01-01T00:00:00.000Z&to=2026-12-31T23:59:59.999Z&limit=50&order=desc&cursor=…
```

| Param | Notes |
| --- | --- |
| `limit` | Optional. Configured default (50), capped by `maxLimit`. Explicit values must be `1…maxLimit` or the request is rejected. |
| `order` | `asc` or `desc` (default `desc`). |
| `cursor` | Opaque resume token from a prior page. Mutually exclusive with `offset`. |
| `offset` | Legacy. Rejected when greater than `maxScan` or when the scan budget cannot reach that many matching records; prefer cursors. |
| `vaultId` | Restrict to one vault (uses the secondary index). |
| `actor` / `user` | Restrict to one wallet using its actor or vault-and-actor bucket. |
| `from` / `to` | Inclusive ISO-8601 time bounds. |

Keep the same `X-Wallet-Address` value throughout a cursor walk. The codec trims
that header and binds its value into the cursor; a different value returns
`403 CURSOR_ACTOR_MISMATCH`. An omitted or blank header uses the shared
`anonymous` context.

This header is a client-supplied demo selector, not proof of wallet ownership.
The `actor` / `user` query filter selects rows independently of it, and this
history route has no wallet-authentication or ownership gate. Cursor signing
prevents editing a cursor; it does not authenticate the supplied wallet header.

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
- Actor buckets reuse the global sequence and record objects; no new cursor
  format or key is required. Older cursors may point at a scanned row belonging
  to another actor. That global position remains valid, and the selected bucket
  resumes at the next qualifying sequence in the requested direction.
- Each ordinary ledger row adds two bucket references (actor and vault/actor)
  beyond the existing global/vault references. Rebuild and writes do more index
  work in exchange for reading only the selected actor's history. The returned
  rows are not copied. Legacy exact totals still require a filtered pass over
  the selected bucket; time bounds remain residual filters under the scan cap.
- The demo ledger and analytics index are process-local. `analyticsHistoryService`
  builds its `OrderedIndex` from that process's transaction Map and assigns local
  sequence positions. Use a single backend process for one demo ledger.
- A shared `ANALYTICS_CURSOR_SECRET` only shares cursor-signature verification.
  It does not share transactions, sequence positions or the index. Independent
  in-memory replicas behind a load balancer do not provide one consistent
  history, even when their signing keys match. A multi-process implementation
  needs shared durable ledger/index semantics before it can offer that behavior.

## Cursor lifecycle and rollout

1. Start the single-process demo with the intended `ANALYTICS_CURSOR_SECRET`
   already in its environment. The codec captures it when the module loads;
   an absent or empty value creates a random key for that process.
2. Begin at `/api/analytics/history` without `cursor` or `offset`. Retain the
   same wallet-header value, filters and order while following
   `pagination.pageInfo.nextCursor`; a changed query starts a new walk.
3. After a process restart, index reset or signing-key rotation, discard saved
   cursors and begin a new walk. Changing the environment of a running process
   does not replace its captured key; apply a new key on restart. A configured
   stable key does not make the in-memory ledger survive that restart.
4. Keep existing `/api/transactions` offset clients unchanged. On the new history
   endpoint, an explicit offset remains the legacy mode and may return
   `OFFSET_TOO_DEEP`; recover by starting without `offset` and following cursors.

An invalid signature (including a different signing key) returns
`400 INVALID_CURSOR`. If a signed cursor's sequence position no longer has its
recorded timestamp, the history adapter returns `400 STALE_CURSOR`. This
position check is not a shared-store or index-generation guarantee: do not
treat an accepted signature as evidence that another process has the same
ledger. Neither error supplies a usable continuation; restart the walk against
the intended current process.

## Reproducing actor-index performance

Run `node scripts/benchmark-analytics-actor-index.cjs` after installing the
ordinary manifest dependencies. Optional positional source-root arguments
compare multiple checkouts in the same process. It imports the actual
store, history service, cursor codec and configuration from that source.

The fixture sizes are 1,000, 10,000 and 50,000 ledger rows, each with ten rows
for one actor across two vaults. It walks actor-only, combined and absent-actor
queries completely with a 1,000-record per-request budget. Seven timed samples
follow one warmup and alternate source order; complete returned rows must match the expected sequence in
every sample. Output includes raw durations, median, pages, scanned records,
result hashes, index-rebuild time and retained reference count.

These are synthetic in-process service measurements. They exclude fixture
construction, index rebuild and verification from query timing and do not
measure HTTP serialization, live chain calls, database plans or production
latency. Index-rebuild time is reported separately as a one-time sample.
