# Issue 66: bounded report selection

The original `generateReport` collected every finding and sorted the entire array before returning a small page. This follow-up retains at most `offset + limit` findings with a stable max-heap selector and caps that online window at 10,000. All findings are still counted. The existing full collector remains available for its explicit in-process callers; authentication and financial writes are unchanged.

## Focused result

One command executed the added pagination cases and a matched before/after report comparison on October 4, 2026:

```sh
RECONCILIATION_BASELINE_DIR=/path/to/be292abb-checkout \
  node --expose-gc --test test/reconciliationPagination.test.js
# 6 passed; 0 failed; 0 skipped; 1.383s total
```

The behavior cases cover stable equal-key ordering, bounded retained entries, filtered and unfiltered page equivalence with the existing collector, unchanged accounting state, empty/beyond-end pages, default/maximum limits, and rejection of oversized or unsafe windows before store traversal. The actual controller's response path is exercised in-process. No existing test was weakened or removed.

## Measured report comparison

Each revision ran in a separate fresh Node v22.16.0 process against the same 100,000 synthetic position records. Each record produced three findings. Both calls used `generateReport({ limit: 20, offset: 40 })` and returned the same 20 findings and exact total of 300,000.

| Observation | Baseline | Bounded selector |
| --- | ---: | ---: |
| Report elapsed time | 685.963496 ms | 133.203652 ms |
| Sampled peak heap increase over seeded/GC baseline | 121,306,512 bytes | 18,834,128 bytes |
| Process maximum resident set | 189,664 KiB | 84,448 KiB |

This single matched comparison was about 5.1 times faster, with about 84% less sampled additional heap. These are service-function results for this fixture, not a production HTTP throughput or worst-case-memory guarantee. Sampling checks heap every 1,024 visited positions and at return; transient peaks between samples may be missed. V8 garbage collection affects the figures. Fixture construction is outside report timing. Both revisions use identical sampling instrumentation.

The complete response excluding only `generatedAt` has identical SHA-256 on both revisions:

```text
978e7595d82b4aba2fb90c678680d2b224735c93e271596dafd6e625d366fa37
```

The page retains 60 findings for this request rather than all 300,000. The scan still visits records and maintains per-vault aggregation state; the source store and total scan work are not constant-sized.

## Source and reproduction

Baseline: `be292abb19520ce7555b576d1ef6d19ba966bb7a`, tree `a76ecf6d9650ae4237e89971f15105a6bcd7d6cd`.

Measured follow-up SHA-256 file identities:

```text
621379506ceb021b9681fde28df327c9a2ea35568a6d8265bf169f139c49a027  src/services/reconciliationService.js
5d0ecd0ef1564df435bf21278d0949da04bb83bb7bf219a2741796508f6e6a0d  src/services/reconciliationPage.js
585cbf9d698fd0a17552f1f9b88793ec70787248004fa3429498b1c4edd6fff4  test/reconciliationPagination.test.js
cb11fa29068a2dad75ced425efe77e033ded99fb7f79006ac18fa512672396f0  scripts/benchmark-reconciliation-page.js
```

For separate measurements, run the committed benchmark with `node --expose-gc scripts/benchmark-reconciliation-page.js /path/to/revision 100000`. It uses the real report implementation and process-local store with only Node built-ins. It does not contact a backend, install dependencies, use credentials or start an HTTP server.

## Compatibility and limits

Normal pages, finding content, exact totals, stable ordering and filtering are preserved. An online `offset + effective limit` above 10,000 now returns a typed HTTP 400 error rather than retaining an arbitrary prefix; see `RECONCILIATION.md` for migration guidance. The existing full collector is intentionally unbounded for explicit in-process use. This measurement did not rerun the full repository suite or its HTTP authentication tests and does not establish sponsor acceptance, an award or payment.
