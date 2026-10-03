# Rate limits and abuse controls

YieldVault Backend applies two layers of fixed-window rate limiting.

## Global API quota

| Setting | Env | Default |
| --- | --- | --- |
| Window | `RATE_LIMIT_WINDOW_MS` | `60000` (1 minute) |
| Max requests / client | `RATE_LIMIT_MAX` | `120` |
| Max tracked client keys | `RATE_LIMIT_MAX_KEYS` | `10000` |

Applied to every `/api/*` request. The client identity is the trusted IP (see
below). Responses include `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
`X-RateLimit-Reset` (seconds), and on 429 a `Retry-After` header.

## Wallet-sensitive mutation quotas

The same configured quotas are enforced independently for these route scopes:

- `POST /api/positions/deposit` (`deposit` scope)
- `POST /api/positions/withdraw` (`withdraw` scope)

`positionRoutes` supplies these scope names to `walletRateLimit`. Each scope has
its own counter Map, so requests to one mutation route do not consume the
other route's wallet budget. The global API quota still covers both routes
and every other `/api/*` request.

| Setting | Env | Default |
| --- | --- | --- |
| Window | `WALLET_RATE_LIMIT_WINDOW_MS` | `60000` (1 minute) |
| Max / actor+client pair / route | `WALLET_RATE_LIMIT_MAX_PER_ACTOR` | `20` |
| Max / trusted client / route | `WALLET_RATE_LIMIT_MAX_PER_CLIENT` | `40` |
| Max tracked keys / route | `WALLET_RATE_LIMIT_MAX_KEYS` | `5000` |

Within its route scope, each request consumes:

1. A **client** bucket (`client:<trusted-ip>`) — bounds floods from one IP
   regardless of claimed wallet.
2. An **actor+client** bucket (`actor:<wallet>:client:<trusted-ip>`) — keeps each
   actor/client pair's budget separate. Different actors on the same client
   still share that route's client bucket.

### Actor resolution

1. `X-Wallet-Address` request header (preferred mock-auth signal)
2. Else validated `body.user`
3. Else `anonymous`

Malformed or oversized actor values collapse to `anonymous` so they cannot
inflate key cardinality. 429 bodies use a generic `Too many requests` message
with `{ code: "RATE_LIMITED", retryAfter }` and never echo the wallet or
whether an account exists.

### Retry metadata

`X-RateLimit-Reset` and `Retry-After` are seconds from the response time,
rounded up to the next whole second with a minimum of 1; they are not epoch
timestamps. Accepted requests report the bucket with fewer remaining requests
(the actor bucket wins a tie).

On a wallet quota rejection, `X-RateLimit-Limit`, zero remaining, and
`X-RateLimit-Reset` describe the exhausted bucket with the latest reset.
`Retry-After` and `error.details.retryAfter` use that same interval. Both
counters include the rejected request, so a bucket exactly at its limit also
counts as exhausted: the next attempt would exceed it. A later window with
remaining capacity does not extend the retry delay. Equal reset times retain
the actor bucket when both budgets are exhausted.

For example, with a 60-second window, actor limit 2 and client limit 3, an
initial actor A request starts the client window. If actor B makes three
requests 30 seconds later, the third is rejected. The client resets in 30
seconds but B resets in 60, so the response advises waiting 60 seconds. New
requests can consume shared capacity during that delay; admission is checked
again on retry. Storage-capacity rejections follow the separate policy below.

## Proxy / header trust assumptions

| Setting | Env | Default |
| --- | --- | --- |
| Trust proxy | `TRUST_PROXY` | unset / false |

- **`TRUST_PROXY` unset/false (default):** client identity is the direct TCP
  peer (`req.socket.remoteAddress`). `X-Forwarded-For` and friends are
  **ignored**. Safe for local development and direct exposure.
- **`TRUST_PROXY=true`:** Express `trust proxy` is set to `1` and `req.ip`
  (derived from the trusted hop) is used. Enable **only** behind a reverse
  proxy that strips/overwrites incoming forwarded headers. Otherwise clients
  can spoof identity and bypass per-client limits.

`X-Wallet-Address` is treated as a **rate-limit partition key**, consistent
with other mock headers such as `X-Audit-Role`. It is not cryptographic proof
of wallet ownership; production deployments should replace it with a real
authn signal and keep the same partition shape.

## Storage bounds and multi-instance note

The global limiter has one client-counter Map. The wallet limiter has a
separate Map for each route scope, with `WALLET_RATE_LIMIT_MAX_KEYS` applied
to each Map. Both keep counters in process memory. Expired windows are pruned
on access, and active counters are retained until their windows expire. When a
new identity would exceed `maxKeys`, the request receives 429 without adding
keys or changing existing counters. This keeps identity churn from resetting
an exhausted quota while bounding storage during abusive bursts.

The wallet limiter reserves space for both its client and actor+client keys
before updating either. A new client in a route scope normally needs two free
slots, so set `WALLET_RATE_LIMIT_MAX_KEYS` to at least 2. Tracked identities
continue to use their existing quotas while new admissions are blocked. If the wallet cap is
reduced at runtime, retained counters expire naturally before new keys can
be admitted under the smaller cap.

Capacity rejections report zero remaining requests and a finite `Retry-After`
and reset interval based on the next tracked window expiry (or one configured
window if the store is empty). Retry after that interval; admission still
depends on available capacity at that time.

For multi-instance production, replace the in-memory Maps with a shared store
(Redis, etc.) using the same key layout and quotas documented above. Retry
semantics (`Retry-After`, reset headers) stay identical.

## Legitimate caller guidance

With default settings, each actor+client pair may make **20 deposits and
20 withdrawals per 60-second window**, using separate windows for the two
routes. Each client IP is capped at **40 deposits and 40 withdrawals per
window across all actors**, again in separate route scopes. These are maximum
wallet-route allowances; the **120-request global API quota** also counts
these requests along with all other `/api/*` calls. On 429, honour
`Retry-After` (seconds) before retrying; idempotency keys on deposit/withdraw
remain safe to replay after the window resets.

## Staggered-window verification

The maintained wallet suite covers later actor/client resets, a bucket exactly
at its cap, an available later bucket, equal deadlines, and rounded-up seconds
at the expiry boundary. The focused suite passes 25 tests; the full
`npm test -- --test-concurrency=1` run passes 138 with no skips. Substituting the
unchanged `0c4d39d` parent middleware into the focused run gives 3 failures and
22 passes. All eight contract fixtures also pass `npm run validate:contracts`.

A separate native HTTP check used actual `createApp` and mounted deposit
routes, with a controlled clock and a valid request shape naming a nonexistent
vault. Its 12 requests per phase reached the real 404 handler when admitted and
429 when limited. Before repair, both staggered schedules reported a 30-second
retry despite a 60-second actor deadline; afterward, retry headers and body
consistently report 60. The early retry remains blocked, and expiry restores
admission. The in-memory store stayed empty; no provider invocation was needed.

Checks used Node 24.19.0 and retained Express 4.22.2, cors 2.8.6, dotenv 16.6.1,
morgan 1.11.0 and uuid 9.0.1, without installation or dependency changes. This
repository has no committed lockfile. The CI Node 22 environment and any live
wallet, provider, or multi-instance deployment were not exercised locally.
