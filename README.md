# YieldVault Backend

Backend REST API for **YieldVault**, a Soroban DeFi yield vault application on
the Stellar network. The service exposes vaults, user positions, analytics and a
mock yield-accrual engine. All on-chain / Stellar interactions are mocked, and
state is held in an in-memory store, so the API runs standalone with no database
or live network.

## Stack

- Node.js + Express
- In-memory store (no database)
- cors, dotenv, morgan, uuid
- Mock Stellar / Soroban service

## Getting started

```bash
npm install
cp .env.example .env
npm start
```

The server boots on `http://localhost:3000` and seeds a few demo vaults.

The in-memory store now includes a lightweight migration scaffold so schema
changes can be added incrementally without changing the public API.

## API contracts

Response contracts are versioned under `src/contracts`. The dependency-free
validator checks required fields, enums, numeric precision, pagination bounds,
and unknown fields. CI can run `npm run validate:contracts` to validate the
deterministic success, pending, validation, authorization, provider-failure,
and paginated-transaction fixtures without a live chain.

## API endpoints

All routes are namespaced under `/api`.

| Method | Path                            | Description                                  |
| ------ | ------------------------------- | -------------------------------------------- |
| GET    | `/api/health`                   | Full service health report                   |
| GET    | `/api/health/live`              | Cheap liveness probe                         |
| GET    | `/api/health/ready`             | Readiness probe (503 until seeded)           |
| GET    | `/api/version`                  | Service and API release metadata             |
| GET    | `/api/vaults`                   | List vaults (TVL, APY, total shares)         |
| GET    | `/api/vaults/top`               | Top vaults by `?sort=tvl\|apy&limit=`        |
| GET    | `/api/vaults/:id`               | Vault detail                                 |
| GET    | `/api/vaults/:id/stats`         | Per-vault summary statistics                 |
| GET    | `/api/vaults/:id/positions`     | Positions held in a vault                    |
| GET    | `/api/vaults/:id/apy-history`   | Mock historical APY series (`?days=`)        |
| GET    | `/api/vaults/:id/projection`    | Yield projection (`?amount=&days=`)          |
| GET    | `/api/analytics`                | Aggregate TVL and average APY                |
| GET    | `/api/analytics/tvl-history`    | Mock protocol TVL series (`?days=`)          |
| GET    | `/api/vaults/:id/deposit-preview` | Canonical deposit/share quote (`?amount=`) |
| POST   | `/api/positions/deposit`        | Deposit assets into a vault                  |
| POST   | `/api/positions/withdraw`       | Redeem shares from a vault                   |
| GET    | `/api/positions?user=`          | List positions, optionally filtered by user  |
| GET    | `/api/positions/summary?user=`  | Aggregate portfolio totals for a user        |
| GET    | `/api/positions/:id`            | Position detail                              |
| GET    | `/api/transactions`             | Mock transaction history (paginated)         |
| GET    | `/api/transactions/:txHash`     | Durable transaction lifecycle status        |

Transaction orchestration uses a durable in-memory lifecycle record with
`pending`, `submitted`, `confirmed`, `failed`, and `unknown` states. A caller
must provide an idempotency key; provider transaction identifiers are bound to
the first submission, unknown outcomes use bounded exponential retry, and
terminal states are never submitted again. `transactionLifecycleService` is
provider-agnostic so fault-injection tests can run without Soroban access.
Mutation requests may include an `idempotencyKey` (8–128 safe characters),
and the status endpoint exposes provider transaction identity, attempt counts,
retry timing, correlation id, and safe terminal errors.
| GET    | `/api/audit`                    | Authorized structured vault audit history    |

## Position credentials

Every `/api/positions` route and `GET /api/vaults/:id/positions` requires
`Authorization: Bearer <opaque-token>`. The server maps the token's SHA-256
digest to a subject and role from `POSITION_CREDENTIALS`. `X-Wallet-Address`
and `X-Audit-Role` do not establish identity or elevate position access.

The subject is the exact in-memory user identifier. Ordinary users can access
only their own positions; missing and foreign position IDs return the same
404. The existing `admin` and `auditor` operator roles can inspect other
positions and act for an explicit target user. Assign those roles only to
trusted operators. Other role identifiers remain scoped to their own subject.
Trusted in-process service callers retain their explicit-user interface.

Generate a 32-byte token and its digest locally with Node's built-in crypto:

```bash
node -e "const c=require('node:crypto'); const token=c.randomBytes(32).toString('base64url'); console.log(JSON.stringify({token,tokenSha256:c.createHash('sha256').update(token).digest('hex')}))"
```

Give the raw token to its intended client through a secure channel. Store only
the digest in the server configuration, replacing the placeholder below:

```dotenv
POSITION_CREDENTIALS=[{"subject":"wallet_owner","role":"user","tokenSha256":"<64 hex SHA-256 digest>"}]
```

The registry accepts at most 100 entries. Subjects must be nonempty, trimmed,
at most 128 characters, and contain no C0/C1 control characters. Roles are
lowercase identifiers; every digest must be unique. Missing or empty
configuration denies position access with 401. Malformed configuration stops
startup without echoing its contents. Position responses include
`Cache-Control: private, no-store`; authentication failures also include the
Bearer challenge. Clients must replace the old header-only requests with a
provisioned credential when deploying this change.

Configuration is loaded at startup. For rotation, provision another token for
the same subject and role, restart with both digests during the transition,
then remove the old digest and restart to revoke it. There is no automatic
expiry. Keep raw tokens out of source, URLs and logs, and use HTTPS beyond
localhost. This mechanism authenticates server-provisioned identities for the
mock service; it does not prove control of a Stellar wallet or provide an
external identity provider. Public vault metadata and unrelated routes retain
their existing access rules.

## Example requests

Use the token provisioned for `wallet_owner` as `POSITION_TOKEN`, and replace
`vault_...` with an ID returned by `/api/vaults`.

Deposit into a vault:

```bash
curl -X POST http://localhost:3000/api/positions/deposit \
  -H "Authorization: Bearer $POSITION_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"user":"wallet_owner","vaultId":"vault_...","amount":1000}'
```

Withdraw shares:

```bash
curl -X POST http://localhost:3000/api/positions/withdraw \
  -H "Authorization: Bearer $POSITION_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"user":"wallet_owner","vaultId":"vault_...","shares":500}'
```

List a user's positions:

```bash
curl 'http://localhost:3000/api/positions?user=wallet_owner' \
  -H "Authorization: Bearer $POSITION_TOKEN"
```

## Pagination

List endpoints that can grow unbounded accept `limit` and `offset` query
parameters. `limit` defaults to 20 and is capped at 100. Responses include a
`pagination` object with `total`, `limit`, `offset` and `hasMore`:

```bash
curl 'http://localhost:3000/api/transactions?limit=10&offset=20'
```

## Rate limiting

All `/api` routes are rate limited per client IP using a fixed window. Limits
are configurable via `RATE_LIMIT_WINDOW_MS` and `RATE_LIMIT_MAX`. Each response
carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`
headers; exceeding the limit returns `429` with a `Retry-After` header.

## Security and limits

Every response carries a conservative set of security headers
(`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
`Content-Security-Policy`). Requests are aborted with `503` after
`REQUEST_TIMEOUT_MS`, and JSON bodies larger than `BODY_LIMIT` are rejected.
Audit history requires `X-Audit-Role: admin` or `X-Audit-Role: auditor` and
supports `actor`, `target`, `correlationId`, `limit`, and `offset` filters.

## Configuration

Configuration is read from environment variables (see `.env.example`):

| Variable               | Default                                 | Description                                  |
| ---------------------- | --------------------------------------- | -------------------------------------------- |
| `PORT`                 | `3000`                                  | HTTP port                                    |
| `NODE_ENV`             | `development`                           | Environment name                             |
| `LOG_LEVEL`            | `info`                                  | Minimum log level                            |
| `CORS_ORIGINS`         | `*`                                     | Comma-separated origin allowlist, or `*`     |
| `STELLAR_NETWORK`      | `testnet`                               | Mock Stellar network                         |
| `DEFAULT_APY`          | `0.08`                                  | Fallback vault APY (decimal)                 |
| `RATE_LIMIT_WINDOW_MS` | `60000`                                 | Rate limit window in milliseconds            |
| `RATE_LIMIT_MAX`       | `120`                                   | Max requests per window per IP               |
| `REQUEST_TIMEOUT_MS`   | `15000`                                 | Abort requests slower than this (503)        |
| `BODY_LIMIT`           | `64kb`                                  | Maximum accepted JSON request body size      |
| `POSITION_CREDENTIALS` | `[]`                                    | JSON subject/role/token-digest registry for position access |

## Testing

Unit tests use Node's built-in test runner (no extra dependencies):

```bash
npm test
```

## Yield model

Each vault tracks `totalAssets` (underlying tokens) and `totalShares`
(ownership units). Price per share is `totalAssets / totalShares`. The mock
yield engine grows `totalAssets` over time based on the vault APY while shares
stay constant, so every position appreciates automatically. Accrual is applied
lazily whenever a vault or position is read.

## Amount and rounding policy

Asset and share amounts use six decimal places (`0.000001`) and round to
nearest at that precision. Inputs above `1e12` or with smaller units are
rejected. Deposit previews and execution share the same conversion helper and
return the policy metadata so clients can explain boundary results.

## Project structure

```
src/
  app.js            Express app wiring
  server.js         Entrypoint
  config/           Environment configuration
  routes/           Express routers
  controllers/      HTTP request handlers
  services/         Business logic (vault, position, yield, analytics, stellar)
  middleware/       Logger, validation, error handling
  store/            In-memory store and seed data
  utils/            Logger, ids, math, finance, fees, time, errors, pagination
test/               Node test runner specs
```

## License

MIT
