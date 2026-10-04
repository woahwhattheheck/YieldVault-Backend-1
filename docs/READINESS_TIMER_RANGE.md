# Readiness timer range — 4 October 2026

Configuration, readiness overrides, and direct `runCheck` calls now use the
same representable timer budget. Invalid overrides use the configured budget;
invalid configuration uses the existing 1000ms default. Positive supported
values retain Node's integer truncation and 1ms minimum. Values above
2147483647ms and non-finite values no longer silently become 1ms deadlines.
The returned `timeoutMs` reports the effective normalized budget.

The normalization is reused from RemitFlow-Backend commit
`ed96c565f24ecf3b95ea001415049f786639e568`; the existing YieldVault vault-seed
gate, queue/chain probes, shared unfinished work, adapter identity, redaction,
and completed-probe recovery remain unchanged.

Node timer contract: https://nodejs.org/api/timers.html#settimeoutcallback-delay-args

## Focused evidence

Baseline: `a9c4792e7b4cbca2ad28b79409dabc7b22f98741`.
Baseline service blob: `a56f6dd7b3f89ffbde83700a90dec11afbd9c686`.
Changed service blob: `ec68b3035b7cb64a5944c7bc5b7d6976bfb724fc`.
Unchanged pool blob: `5dfabe9ed6437b00e336b0eb8e3dca58e9bc5279`.
Regression blob: `912c92c85eab87ea63b7aaeac40bb3def5beb29d`.

Node 22.16.0 ran the complete service and unchanged pool with real promises
and timers. With a configured 200ms budget and a healthy probe resolving after
20ms, independent baseline calls using Infinity and 2147483648 returned false
CHAIN_TIMEOUT results at observed 5ms and 1ms. The same calls after the repair
both returned ready, reported 200ms, and observed 21ms probe latency. This is
correctness evidence, not a performance benchmark or exact scheduling promise.

Exactly one maintained regression was run once per version: baseline 0 passed,
1 failed, exit 1; changed source 1 passed, 0 failed, exit 0. No skipped tests.
It covers fallback values, supported boundaries, numeric strings, fractional
resolution, direct calls, genuine timeout, and recovery. Existing tests and
workflows are unchanged; no full suite or build was run.

This offline execution used a task-local CommonJS preload providing only three
explicit collaborators: mutable health config, a seeded in-memory store with
vault/position/transaction/state Maps, and an unused successful chain ping.
The test replaces probes using the existing service hook. Service, probe-pool,
Promise races and timer code were loaded from the complete source above.
This is not HTTP routing, actual provider integration, or full-application CI.

In an installed checkout, run:

```sh
node --test test/dependencyHealthTimeout.test.js
```

Historical results remain pinned to their original source. No deployment,
maintainer acceptance, award, or payment is established by this continuation.
