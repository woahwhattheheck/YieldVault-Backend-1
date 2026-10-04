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
construction, index rebuild and full-result comparison from query timing and do not
measure HTTP serialization, live chain calls, database plans or production
latency. Index-rebuild time is reported separately as a one-time sample.

## Recorded actor-index comparison (2026-10-04)

The comparison uses original PR #84 head
[`6cfc7e78a1021fcb73157ca46fe527231b688322`](https://github.com/woahwhattheheck/YieldVault-Backend-1/commit/6cfc7e78a1021fcb73157ca46fe527231b688322)
as the baseline and tested source
[`7ad92b59435f06f99a81772b0b0728e6d524df24`](https://github.com/woahwhattheheck/YieldVault-Backend-1/commit/7ad92b59435f06f99a81772b0b0728e6d524df24)
as the candidate. The measured script is the candidate's
`scripts/benchmark-analytics-actor-index.cjs` in both cases. A later
documentation-only commit adds this receipt without changing either measured
implementation.

The [successful benchmark job](https://github.com/woahwhattheheck/RemitFlow-Backend/actions/runs/37192573467/job/111407683280)
ran on Ubuntu 24.04 with Node 22.23.3. Its isolated validation branch lives in
the contributor's RemitFlow fork, but explicitly checks out the YieldVault
candidate and fetches the YieldVault baseline by the above SHAs. It measures
YieldVault code. The resolved unchanged manifest was cors 2.8.6, dotenv 16.6.1,
express 4.22.3, morgan 1.12.1 and uuid 9.0.1. Both source roots use that same
dependency installation. The product's CI workflow and manifest are unchanged.

Every cell below is baseline → candidate. Times are medians of seven complete
service walks in milliseconds after warmup; source order alternates between
samples. [Raw measurements and provenance](benchmarks/analytics-actor-index-2026-10-04.json)
retain all samples, exact result hashes, source-root mapping and job links.
Every pair returns the same full event sequence.

| Ledger rows | Query | Rows scanned | Pages | Median service walk (ms) |
| --- | --- | --- | --- | --- |
| 1,000 | Actor (10 results) | 1,000 → 10 | 1 → 1 | 0.133570 → 0.102582 |
| 1,000 | Vault + actor (5 results) | 995 → 5 | 1 → 1 | 0.175939 → 0.063630 |
| 1,000 | Absent actor (0 results) | 1,000 → 0 | 1 → 1 | 0.036268 → 0.022351 |
| 10,000 | Actor (10 results) | 10,000 → 10 | 10 → 1 | 0.728936 → 0.031299 |
| 10,000 | Vault + actor (5 results) | 9,995 → 5 | 10 → 1 | 0.432621 → 0.027351 |
| 10,000 | Absent actor (0 results) | 10,000 → 0 | 10 → 1 | 0.384681 → 0.017883 |
| 50,000 | Actor (10 results) | 50,000 → 10 | 50 → 1 | 1.863572 → 0.031098 |
| 50,000 | Vault + actor (5 results) | 49,995 → 5 | 50 → 1 | 2.070871 → 0.026038 |
| 50,000 | Absent actor (0 results) | 50,000 → 0 | 50 → 1 | 1.489371 → 0.016341 |

At 50,000 rows, the actor query examines only its ten results instead of all
50,000 records and needs one page instead of fifty. The observed median falls
from 1.863572 ms to 0.031098 ms (about 59.9 times faster in this fixture).
The combined query examines five records and the absent actor examines zero.
At 1,000 rows, fixed request overhead is a larger part of the timings; the
raw samples show that small durations vary. The deterministic scanned-row and
page counts provide the scaling evidence. These timings are not production
latency or HTTP throughput estimates.

### Index construction cost

The read improvement adds actor and vault/actor references to the existing
global and vault references. The underlying record objects are shared.
Reference counts below are exact for the fixture, not heap-byte measurements;
rebuild times are one sample per source and size, outside query timing.

| Ledger rows | Rebuild time (ms), baseline → candidate | Retained index references, baseline → candidate |
| --- | --- | --- |
| 1,000 | 0.444713 → 2.077984 | 2,000 → 4,000 |
| 10,000 | 4.482449 → 15.866260 | 20,000 → 40,000 |
| 50,000 | 11.106812 → 55.206476 | 100,000 → 200,000 |

For this read-heavy access pattern, bounded actor reads trade additional
write/rebuild work and two extra references per ordinary ledger row. The
benchmark does not establish a total-memory multiplier or a write-throughput
SLA.

### Test receipt

The candidate's required `npm test -- --test-concurrency=1` step passed
**145/145 tests, with no failures or skips**, on the same Node version in
[this validation job](https://github.com/woahwhattheheck/RemitFlow-Backend/actions/runs/37192479445/job/111407400091).
That includes all nine new actor-index cases and the maintained pagination,
offset, authentication and other backend tests. The residual work-budget tests
now use selective timestamps because actor selection is indexed. They mutate
the stored transaction before rebuilding the index.

The same job then applied the new actor-index test file to the unchanged
baseline: four checks failed and five compatibility controls passed. Its
wrapper had incorrectly expected three failures and six passes, so that job's
**overall conclusion is failure**, despite the required suite passing. The
benchmark was skipped in that job and executed once in the successful
benchmark-only continuation linked above. Neither the passing full suite nor
the baseline control was repeated for that continuation.

The compatibility checks cover old cursors whose global scan frontier belongs
to another actor, both orders, actor/user aliases, combined filters, ties,
concurrent appends and index reset. The cursor format, signing key and global
sequence resolver remain unchanged.
