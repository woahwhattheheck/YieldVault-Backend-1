# V1 receipt composition for the analytics contribution

## Included source

This change composes the existing v1 receipt repair
[`e45ca72d87e0d0749e4a1e4d4ff87242cb8e6cbb`](https://github.com/woahwhattheheck/YieldVault-Backend-1/commit/e45ca72d87e0d0749e4a1e4d4ff87242cb8e6cbb)
with the original analytics PR's actor-index head
[`aaa6760ce7ed2ddbdb0f9798629e8cd53ef69a51`](https://github.com/woahwhattheheck/YieldVault-Backend-1/commit/aaa6760ce7ed2ddbdb0f9798629e8cd53ef69a51).
Both are parents of the tested composition
[`efb3ca93916e889bd50384fb68425c10da38b68e`](https://github.com/woahwhattheheck/YieldVault-Backend-1/commit/efb3ca93916e889bd50384fb68425c10da38b68e).
This preserves the original repair's history and contribution provenance.

The existing mock provider stores `SUCCESS`, `network` and `ledger` fields.
Validating that raw receipt against the v1 HTTP contract can reject the
response after a mutation has already succeeded. The reused repair serializes
only the outward transaction receipt: `SUCCESS` becomes `confirmed`, and the
provider-only `network` and `ledger` fields are omitted. The stored evidence
and lifecycle registration remain unchanged. Other unknown fields, unsupported
states and invalid amounts still reach strict response validation.

The two controllers, transaction-service serializer and eight HTTP regressions
are byte-identical to the original repair:

| File | Git blob |
| --- | --- |
| `src/controllers/positionController.js` | `f6fa66233f1b5ef8e8cef1424c0ab0a360cd6f38` |
| `src/controllers/transactionController.js` | `6df93012869ab1387b45e5fa89b090f3e9ef245f` |
| `src/services/transactionService.js` | `c3a6fe96d2dc2a168f87c900b2c9b38d9121c888` |
| `test/contractValidation.test.js` | `4ffe3beabecfcedc4cce33d7c410c62c54aee0da` |

The README retains its analytics content and gains the original repair's
six-line contract explanation. The composed source changes only these five
existing files; the other 175 tracked files are unchanged from `aaa6760c`.
The final documentation successor adds this receipt without changing the
tested implementation.

## Required-suite result

[One successful native job](https://github.com/woahwhattheheck/RemitFlow-Backend/actions/runs/37193941124/job/111411778295)
checked out exact source `efb3ca93916e889bd50384fb68425c10da38b68e` and ran:

```sh
npm install --no-audit --no-fund
npm test -- --test-concurrency=1
```

Result on 2026-10-04: **153 tests passed, 0 failed, 0 skipped**.
The complete test process reported 1496.895029 ms. This is test-suite duration,
not an API performance measurement.

The runner used Node 22.23.3 and the unchanged dependency manifest, resolving
cors 2.8.6, dotenv 16.6.1, express 4.22.3, morgan 1.12.1 and uuid 9.0.1.
The isolated validation workflow is hosted in the contributor's RemitFlow
fork at carrier commit
[`d5f8c732a8fced6daec061f72b3aebdea2e941ef`](https://github.com/woahwhattheheck/RemitFlow-Backend/commit/d5f8c732a8fced6daec061f72b3aebdea2e941ef);
its checkout explicitly selects the YieldVault repository and source SHA.
The product's original CI workflow and manifest are unchanged.

All eight reused HTTP cases pass on the complete Express application:

- Deposit returns 201 with a v1 receipt.
- Partial and full withdrawal return 200 with the correct remaining or null
  position.
- Paginated transaction history returns 200 and preserves its count, offset,
  filtering and stored provider evidence.
- Canonical pending, submitted, confirmed and failed states are retained.
- Undocumented fields, unsupported states, excess precision and missing
  required fields still fail response validation.

These tests use the existing mock provider and process-local store. They do
not contact a live wallet or chain. No baseline proof was repeated for this
composition; the original repair retains its earlier reproduction evidence.

## Analytics and policy boundary

The serializer changes mutation receipts and legacy `/api/transactions`
responses. It does not change `/api/analytics/history` event representation,
actor buckets, global sequence positions, cursor codec, scan budget, defaults,
offset handling or authentication policy. No PR80-specific policy or fixture
adaptation is imported.

The existing actor/cursor cases also pass within the 153-test suite. The eight
donor HTTP cases exercise mutation and legacy transaction routes, so they are
not separate evidence for analytics index reset or cursor behavior.

The [actor-index benchmark and raw results](ANALYTICS_PAGINATION.md#recorded-actor-index-comparison-2026-10-04)
remain tied to their original measured source and job. The analytics service,
ordered index and benchmark script are byte-identical in this composition.
That benchmark was not rerun.
