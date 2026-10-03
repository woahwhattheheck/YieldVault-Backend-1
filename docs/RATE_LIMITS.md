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

Applied to:

- `POST /api/positions/deposit`
- `POST /api/positions/withdraw`

| Setting | Env | Default |
| --- | --- | --- |
| Window | `WALLET_RATE_LIMIT_WINDOW_MS` | `60000` (1 minute) |
| Max / authenticated actor | `WALLET_RATE_LIMIT_MAX_PER_ACTOR` | `20` |
| Max / trusted client | `WALLET_RATE_LIMIT_MAX_PER_CLIENT` | `40` |
| Max tracked keys | `WALLET_RATE_LIMIT_MAX_KEYS` | `5000` |

Each request consumes:

1. A **client** bucket (`client:<trusted-ip>`) — bounds floods from one IP
   regardless of claimed wallet.
2. An **actor+client** bucket (`actor:<wallet>:client:<trusted-ip>`) — isolates
   authenticated actors so one wallet cannot starve another from a different
   client, and one client cannot burn many wallets without hitting the client
   cap.

### Actor resolution

1. `X-Wallet-Address` request header (preferred mock-auth signal)
2. Else validated `body.user`
3. Else `anonymous`

Malformed or oversized actor values collapse to `anonymous` so they cannot
inflate key cardinality. 429 bodies use a generic `Too many requests` message
with `{ code: "RATE_LIMITED", retryAfter }` and never echo the wallet or
whether an account exists.

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

Both limiters keep counters in process memory. Expired windows are pruned on
access, and active counters are retained until their windows expire. When a
new identity would exceed `maxKeys`, the request receives 429 without adding
keys or changing existing counters. This keeps identity churn from resetting
an exhausted quota while bounding storage during abusive bursts.

The wallet limiter reserves space for both its client and actor+client keys
before updating either. A new client normally needs two free slots, so set
`WALLET_RATE_LIMIT_MAX_KEYS` to at least 2. Tracked identities continue to use
their existing quotas while new admissions are blocked. If the wallet cap is
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

A well-behaved authenticated client should stay within **20 deposit or
withdraw mutations per wallet per minute** and **40 combined mutations per
client IP per minute**. On 429, honour `Retry-After` (seconds) before retrying;
idempotency keys on deposit/withdraw remain safe to replay after the window
resets.
