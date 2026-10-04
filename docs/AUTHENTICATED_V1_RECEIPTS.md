# Authenticated v1 transaction receipts

## Result

Authorized position deposits now return HTTP 201, and partial/full withdrawals
and transaction pages return HTTP 200 with valid v1 receipts. The original PR80
authentication and service authorization remain in place.

This composes the already completed serializer correction from
[`e45ca72d`](https://github.com/woahwhattheheck/YieldVault-Backend-1/commit/e45ca72d87e0d0749e4a1e4d4ff87242cb8e6cbb)
with the position-credential implementation at
[`fcb73610`](https://github.com/woahwhattheheck/YieldVault-Backend-1/commit/fcb73610d3252b61280a279df7c49b617d17e703).
Both histories are parents of the tested integration commit
[`e5ac9060`](https://github.com/woahwhattheheck/YieldVault-Backend-1/commit/e5ac9060f1fd771f1a91b89ad6c55823b9dcfef7).

The serializer maps the mock provider's exact `SUCCESS` value to `confirmed`
and omits the provider-only `network` and `ledger` fields from HTTP responses.
Stored provider receipts and lifecycle records retain their original values.
All other fields still reach the existing strict response validator.

## Native execution on 2026-10-04

[Run 37193117137](https://github.com/woahwhattheheck/RemitFlow-Backend/actions/runs/37193117137)
and [job 111409297443](https://github.com/woahwhattheheck/RemitFlow-Backend/actions/runs/37193117137/job/111409297443)
completed successfully. The public validation carrier explicitly checked out
`woahwhattheheck/YieldVault-Backend-1` at `e5ac9060`; it did not execute
RemitFlow product source.

Environment: Ubuntu 24.04.5, Node 22.23.3. The unchanged manifest resolved
Express 4.22.3, cors 2.8.6, dotenv 16.6.1, morgan 1.12.1 and uuid 9.0.1.
This branch has no dependency lockfile.

| Execution | Result |
| --- | --- |
| Parent production `fcb73610` with the final contract test file | 13 passed, 4 failed; exit 1 |
| Integrated source: `npm test -- --test-concurrency=1` | 150 passed, 0 failed, 0 skipped; exit 0 |
| `npm run validate:contracts` | All 8 unchanged response fixtures validated |

The four baseline failures were the existing integration repair's actual HTTP
deposit, partial withdrawal, full withdrawal and transaction-page cases.
They reached the mock provider and then failed strict response validation
because the receipt carried `SUCCESS`, `network` and `ledger`.

| Actual loopback request | Parent | Integration |
| --- | ---: | ---: |
| Authorized deposit | 500 | 201 |
| Authorized partial withdrawal | 500 | 200 |
| Authorized full withdrawal | 500 | 200 |
| First transaction-history page | 500 | 200 |
| Next transaction-history page | Unreached after first-page assertion | 200 |

The integration's 17 contract cases preserve canonical transaction states,
unknown-field rejection, unsupported-status rejection, amount precision and
required fields. Successful mutation cases also check the stored receipt and
confirmed lifecycle status; full withdrawal returns a null position. The
unchanged 21-case position-policy/HTTP suite and 8 credential-helper cases
pass in the same full run, including spoofed-header and unauthorized-mutation
denials.

The reused HTTP fixture provisions a fresh opaque token for the synthetic
`alice` subject, submits it through the real Bearer middleware, and restores
the original credential configuration after each case. No production
authentication branch is bypassed.

## Source identity and reproduction

| Executed file | Git blob |
| --- | --- |
| `src/controllers/positionController.js` | `323aae23549b775510ace61de2169a8e6705fd4a` |
| `src/controllers/transactionController.js` | `6df93012869ab1387b45e5fa89b090f3e9ef245f` |
| `src/services/transactionService.js` | `c3a6fe96d2dc2a168f87c900b2c9b38d9121c888` |
| `test/contractValidation.test.js` | `f6903bf5ef7956d6ff28c846aac144b13ff2f849` |

The transaction controller and serializer are byte-identical to the prior
repair. Position-controller composition preserves every `accessFrom(req)`
binding. The original credential, policy, provider, accounting, lifecycle,
schema and fixture files are unchanged.

Check out `e5ac9060f1fd771f1a91b89ad6c55823b9dcfef7`, install the original
manifest, and run the two commands above. To reproduce the baseline, use
production `fcb73610d3252b61280a279df7c49b617d17e703` with the integration's
`test/contractValidation.test.js`, then run that one test file. The
[exact one-job workflow](https://github.com/woahwhattheheck/RemitFlow-Backend/blob/59c9b6c3385bdcc38f4a29e7dbf05e0bf0220d00/.github/workflows/ci.yml)
records these commands.

[Artifact 11300145963](https://github.com/woahwhattheheck/RemitFlow-Backend/actions/runs/37193117137/artifacts/11300145963)
contains the baseline/candidate TAP, fixture output and environment receipt.
GitHub's upload step reports 12,671 bytes and SHA256
`2dd6340dd9999bca420ce9eb243f785afc5573bf78e09311e58d0e6cae3d0e65`.
The ZIP was not independently downloaded and rehashed during this integration.

## Scope of the result

This is execution of the repository's actual Express application and
in-memory mock provider. It establishes the composed HTTP response and
authorization behavior, with no live wallet, Stellar transaction, frontend
browser session or production deployment. The original contribution,
separate main-repair publication and sponsor acceptance remain distinct
records; this integration does not establish an award or payment.
