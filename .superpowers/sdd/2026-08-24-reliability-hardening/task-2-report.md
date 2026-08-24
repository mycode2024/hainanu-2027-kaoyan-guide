# Task 2 report — data service reliability

## Status

DONE_WITH_CONCERNS. All required Task 2 behaviors are implemented within the five permitted product/test files. The assigned target suites and syntax checks pass. No parser, frontend, PowerShell, README, dependency, or live port/service change was made.

## Changed files

- `src/update-service.cjs`
  - Adds the success/attempt clocks, per-source and aggregate freshness, three drift gates, bounded retry timing, URL-first history reconciliation, update detection, missing-history expiry, discovery-protected capacity limiting, backup recovery, refresh events, and scheduled-error reporting.
- `tests/update-service.test.cjs`
  - Adds real behavioral coverage for every required service reliability scenario, including temporary-directory cache integration.
- `src/http-app.cjs`
  - Extends `/api/health` from the live snapshot while retaining readiness, compatibility, and HEAD behavior.
- `tests/server.test.cjs`
  - Covers operational health fields, health HEAD compatibility, and one-line JSON refresh summaries.
- `server.cjs`
  - Logs refresh completion/failure records as one-line JSON and wires scheduled errors to an explicit callback.
- `.superpowers/sdd/2026-08-24-reliability-hardening/task-2-report.md`
  - This report.

## TDD evidence

All commands ran from the project root through `cmd.exe`.

| Cycle | RED command and intended failure | GREEN command and result |
| --- | --- | --- |
| Baseline | `node --test tests\\update-service.test.cjs tests\\server.test.cjs` | Baseline exited 0: 20 tests passed. |
| Per-source freshness | `node --test --test-name-pattern freshness.is.aggregated tests\\update-service.test.cjs` — source freshness fields were `undefined`. | Same command exited 0: 1/1 passed after dynamic source/aggregate freshness. |
| Drift gates | `node --test --test-name-pattern drift.gate tests\\update-service.test.cjs` — all three fixtures fetched once instead of retrying twice. | Same command exited 0: count-drop, URL-disappearance, and publication-rollback subtests all passed; trusted cache remained visible. |
| Same-URL edits | `node --test --test-name-pattern same.source.URL tests\\update-service.test.cjs` — discovery time reset to the fetch time. | Same command exited 0: 1/1 passed with stable URL reconciliation and update metadata. |
| Missing history | `node --test --test-name-pattern trusted.shrink tests\\update-service.test.cjs` — the absent record was discarded, so `missingSince` was unavailable. | Same command exited 0: 1/1 passed for missing, reappearance, 90-day expiry, and 169th-cycle expiry. |
| Capacity | `node --test --test-name-pattern capacity.cap tests\\update-service.test.cjs` — the new generic notice was displaced by 120 old target-year records. | Same command exited 0: 1/1 passed after reserving current discoveries before ranked filling. |
| Zero-result retry | `node --test --test-name-pattern recognizable tests\\update-service.test.cjs` — HTTP 200/zero-result fetched once, not twice. | Same command exited 0: 1/1 passed after making zero-result retryable once. |
| Retry-After | `node --test --test-name-pattern 429 tests\\update-service.test.cjs` — actual delay was the default 750 ms instead of bounded 10,000 ms. | Same command exited 0: 1/1 passed with injected delay/random and recorded actual delay. |
| Cache backup recovery | `node --test --test-name-pattern file.cache.recovers tests\\update-service.test.cjs` — corrupt primary loaded no trusted record. | Same command exited 0: 1/1 passed for backup recovery warning and main+backup corruption error. |
| Completion events/clocks | `node --test --test-name-pattern completion.events tests\\update-service.test.cjs` — `lastAttemptAt` was absent. | Same command exited 0: 1/1 passed for partial/all success clocks, event payload, cacheSaved, counts, and callback isolation. |
| Health | `node --test --test-name-pattern live.snapshot tests\\server.test.cjs` — `uptimeSeconds` and operational fields were absent. | Same command exited 0: 1/1 passed with GET fields and empty-body HEAD. |
| JSON log format | `node --test --test-name-pattern summaries.are.formatted tests\\server.test.cjs` — `formatRefreshLog` did not exist. | Same command exited 0: 1/1 passed with parseable single-line JSON. |
| Compatibility regression | `node --test tests\\update-service.test.cjs tests\\server.test.cjs` — 3 old exact-object assertions rejected the deliberately added freshness/change fields. | Assertions were migrated to schema v2's expanded contract; the later target run exited 0. |
| Degraded event count | `node --test --test-name-pattern drift.gate tests\\update-service.test.cjs` — suspicious parses reported count 0 rather than their parsed counts (3/3/1). | Same command exited 0: all 3 subtests and parent passed with actual parsed counts. |
| Seed change model | `node --test --test-name-pattern completion.events tests\\update-service.test.cjs` — seed change lacked `updatedCount`/`updatedIds`. | Same command exited 0: 1/1 passed with the complete change shape from seed onward. |
| Scheduled failure visibility | `node --test --test-name-pattern scheduled.refresh.failures tests\\update-service.test.cjs` — the error callback received `[]`. | Same command exited 0: 1/1 passed after scheduled refresh rejection forwarding. |

## Final verification

- `node --test tests\\update-service.test.cjs tests\\server.test.cjs` exited 0: 33 tests passed, 0 failed.
- `node --check src\\update-service.cjs && node --check src\\http-app.cjs && node --check server.cjs` exited 0.

## Data migration decisions

- `schemaVersion` remains 2. Legacy `lastSuccessAt` migrates conservatively to `lastAnySuccessAt`, and the alias is always kept equal. Legacy caches do not invent `lastAllSuccessAt`; it remains null until a verified all-source refresh.
- Legacy records without `discoveredAt` retain the existing publication-date fallback. Existing `contentHash`, `lastSeenAt`, `updatedAt`, `missingSince`, and positive `missCount` are sanitized and retained when valid.
- A legacy/title-derived ID is not trusted for reconciliation. The first successful sighting matches by `sourceId + normalized URL`, preserves history, and adopts Task 1's new stable ID.
- A legacy record without a content hash does not produce a false update during migration; a later verified hash-to-hash change does.
- Missing history is part of the persisted snapshot. Null/invalid missing metadata migrates as visible history; successful reappearance emits the current record without stale missing fields.
- Cache recovery returns a wrapper signal only at the store/service boundary; the persisted snapshot schema remains unchanged. The service converts that signal to a bounded visible Chinese warning.

## Boundaries and self-review

- Fetch/bind safety, redirect host checks, response size/type limits, route names, `schemaVersion: 2`, and the default 3,600,000 ms schedule remain unchanged.
- Suspicious/failed sources are excluded from successful-source reconciliation, so neither new parse output nor missing-history mutation can replace their trusted cache.
- Discovery and update sets are calculated before the 120-item limit. Discoveries are reserved first; one high-ranked item from each otherwise unrepresented source is then reserved before general ranked fill.
- The three drift comparisons use only currently visible prior records. The thresholds are strict where required: `< ceil(40%)`, `> 70%`, new `< ceil(50%)`, and date rollback `> 120 days`.
- `Retry-After` accepts seconds or an HTTP date and clamps to 0–10,000 ms. Other retries use configured delay plus injected jitter clamped to 0–250 ms.
- The cache writer serializes and parses the exact temporary payload before promotion, copies the prior primary to `.bak`, and then renames the temporary primary.
- Refresh event callback failures are swallowed by design; scheduled refresh failures use a separate explicit error callback and are logged by `server.cjs`.

## Concerns

- The 120-item cap can mathematically retain every current discovery only while a single refresh discovers at most 120 unique records; if an official source ever emits more than 120 genuinely new records in one run, the fixed cap and the absolute-survival requirement conflict. The implementation deterministically retains the top-ranked 120 in that impossible-to-satisfy case.
- File replacement uses the platform's `rename` semantics after creating and validating a same-directory temporary file. The temporary promotion is atomic on the supported local filesystem, but durability across abrupt power loss still depends on filesystem write-cache behavior.

## Fix round 1 — recovery integrity, identity, retry edges, initialization, and event completion

### Verified root causes

- `save()` copied the primary to `.bak` without parsing it first. After backup recovery, a corrupt primary could therefore destroy the only valid backup before promotion; if promotion then failed, no trusted cache remained.
- Capacity limiting delegated its first dedupe pass to Task 1's globally URL-deduplicating ranker and tracked `selectedUrls`. That contradicted the service identity key (`sourceId + normalized URL`) and allowed one configured source to erase another source's record and leave a `newIds` entry absent from the final snapshot.
- `Number(retryAfter)` converted a missing header (`null`) to numeric zero, incorrectly bypassing the configured retry delay.
- `initialized = true` was set before asynchronous cache loading completed. A second `initialize()` or `refresh()` could immediately observe seed state and race the eventual trusted cache load.
- Completion emission was located after `Promise.all`, so a rejected retry wait produced no event. The callback isolation caught only synchronous throws; an async callback rejection became an unhandled rejection.
- Aggregate freshness calculated a numeric worst age from successful sources even when another required source had never succeeded, making overall `never` appear to have a known age.

### Fix-round TDD evidence

| Cycle | RED command and observed failure | GREEN command and result |
| --- | --- | --- |
| Recovery-safe backup | `node --test --test-name-pattern recovered.cache.never tests\\update-service.test.cjs` — injected promotion failure did not reject because the store had no injection seam; the old path would first overwrite `.bak` with corrupt primary bytes. | Same command exited 0: 1/1 passed after parsing the existing primary before backup and using the injected promotion operation. Failure preserves the only good backup; later successful promotion leaves both primary and backup parseable/trusted. |
| Source-aware identity/capacity | `node --test --test-name-pattern capacity.identity tests\\update-service.test.cjs` — only the list-source copy of the shared URL survived; the homepage copy was globally URL-deduplicated. | Same command exited 0: 1/1 passed after service-local ranking/dedupe and selected tracking adopted `sourceId + normalized URL` identity. Both discoveries survive, every `newId` exists, and the cached third source remains represented. |
| Retry-After distinctions | `node --test --test-name-pattern distinguishes.missing tests\\update-service.test.cjs` — missing header delayed 0 ms instead of configured 625 ms; HTTP-date and explicit-zero characterization subtests passed. | `node --test --test-name-pattern 429 tests\\update-service.test.cjs` exited 0: 5 assertions/subtests passed, including missing/default, HTTP-date, explicit 0, and 10,000 ms cap. |
| Initialization coalescing | `node --test --test-name-pattern concurrent.initialization tests\\update-service.test.cjs` — the two initialize promises differed and one resolved seed while the delayed load resolved cached state. | Same command exited 0: 1/1 passed with one shared `initializationPromise`; refresh made zero fetches before load release and retained trusted cache on failure. |
| Fatal completion event | `node --test --test-name-pattern every.refresh.emits tests\\update-service.test.cjs` — a rejected retry wait emitted 0 events. | Same command exited 0 after central one-shot completion emission and fatal fallback; retry-wait rejection and upstream rejection emit exactly once. A follow-up RED showed fatal attempts as 0 instead of 1; the final same command passed 3/3 with retry telemetry retained. |
| Async event isolation | `node --test --test-name-pattern async.refresh.event tests\\update-service.test.cjs` — Node reported `failureType: unhandledRejection` from the async logger. | Same command exited 0: 1/1 passed after `Promise.resolve(callbackResult).catch(...)` isolation. |
| Never-age semantics | `node --test --test-name-pattern aggregate.never tests\\update-service.test.cjs` — overall `never` exposed `worstSourceAgeMs: 0` and `ageMs: 0` from the fresh peer. | Same command exited 0: 1/1 passed with both aggregate ages null while per-source ages remain precise. |

### Fix-round design decisions

- Backup safety is validation-based rather than dependent on process-local recovery history. Any store instance skips backup replacement when the current primary is absent or syntactically corrupt, so recovery remains safe across store recreation and after a failed promotion.
- The optional `renameImpl` exists only as a narrow promotion-boundary injection seam; all integration-test reads, writes, copies, and cleanup use the real temporary directory and filesystem.
- Service ranking retains the prior ranking order but deduplicates only the service identity key. It no longer imports the parser's globally URL-deduplicating helper.
- A Retry-After value is numeric only after confirming a non-empty header exists. Explicit string `"0"` remains distinguishable from absence.
- `initialize()` is deliberately non-`async` and returns the stored promise directly, preserving promise identity as well as load coalescing.
- Completion emission has a one-shot guard. Fatal refresh errors retain trusted data, update attempt/error observability, emit a status `error` completion with available per-source telemetry, and then rethrow so scheduled error handling remains visible.
- Event callbacks remain fire-and-forget; both synchronous throws and returned-promise rejections are isolated from refresh state.

### Fix-round final verification

- `node --test tests\\update-service.test.cjs tests\\server.test.cjs` exited 0: 45 tests passed, 0 failed.
- `node --check src\\update-service.cjs && node --check src\\http-app.cjs && node --check server.cjs` exited 0.

### Fix-round self-review and concerns

- Rechecked the original required drift, missing-history, update, capacity, cache, health, logging, and scheduled-failure tests alongside all fix-round regressions; no compatibility failures remain in the assigned suites.
- The pre-existing hard-cap conflict for more than 120 simultaneous unique discoveries remains unchanged and is documented above; this review round ensures that source overlap does not consume identities incorrectly below that boundary.
- Atomic rename durability continues to depend on the host filesystem, but a corrupt primary can no longer replace a valid backup before either a failed or successful promotion.

## Fix round 2 — multi-source fatal settlement barrier

### Root cause

The per-source boundary correctly converted a fatal retry-wait rejection into source telemetry and rethrew it, but `performRefresh()` aggregated those promises with fail-fast `Promise.all`. A fast fatal source therefore entered the outer catch immediately while another source was still pending. This emitted completion, rejected the public refresh promise, and cleared `inFlight`; a second refresh could then start overlapping fetches. Because the pending source had not populated its result slot, completion also fabricated `attempts: 0` and copied the fatal peer's error instead of reporting the pending source's eventual security result.

### TDD evidence

- RED: `node --test --test-name-pattern fatal.multi-source tests\\update-service.test.cjs` failed because `completionCountBeforeComputer` was 1 instead of 0. The controlled computer source was still blocked while the graduate source's retry delay had already failed.
- GREEN: the same command exited 0 after replacing fail-fast aggregation with `Promise.allSettled`, retaining each source-boundary result, and throwing the first fatal reason only after every source settled.
- The regression also proves that before the controlled source settles: the first promise remains pending, the second `refresh()` is strictly the same promise, and fetch counts stay exactly one per source. After settlement it proves exactly one completion, graduate telemetry `{ attempts: 1, error: "graduate retry wait failed" }`, and the computer source's real safety error `{ attempts: 1, error: "官网重定向指向非官方域名，已拒绝" }`.

### Design and boundary

- Source fetches remain concurrent; only fatal aggregation changes from fail-fast to an all-settled barrier.
- Safety errors are not converted into the fatal peer's error and are not dropped. Each source slot is populated at its own boundary before its promise settles.
- The selected fatal reason remains deterministic by configured source order, matching `Promise.allSettled`'s ordered result array.
- `inFlight.finally` now runs only after all source work settles, so no overlapping refresh can begin through the public coalescing API.

### Fix-round final verification

- `node --test tests\\update-service.test.cjs tests\\server.test.cjs` exited 0: 46 tests passed, 0 failed.
- `node --check src\\update-service.cjs && node --check src\\http-app.cjs && node --check server.cjs` exited 0.

### Concerns

- The all-settled barrier intentionally means a fatal refresh waits for the slowest configured source (still bounded by each source request timeout) before rejecting and logging completion. This is required for truthful telemetry and non-overlapping refreshes.
- The previously documented hard-cap conflict above remains the only unrelated data-model boundary.
