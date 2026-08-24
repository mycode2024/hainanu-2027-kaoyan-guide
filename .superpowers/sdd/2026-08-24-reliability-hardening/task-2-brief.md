# Task 2 brief — Drift gates, bounded history, per-source freshness, retries, cache backup, and health

Read first. This file is the requirements source for this task. Task 1 must already have produced `parseOfficialDocument` with stable IDs and diagnostics.

## Global constraints

- No third-party runtime dependency; retain `schemaVersion: 2` and existing routes.
- Bind/fetch safety rules remain unchanged. Scheduled refresh stays exactly 3,600,000 ms.
- A failed or suspicious source result never replaces that source's trusted cache.
- Modify only `src/update-service.cjs`, `tests/update-service.test.cjs`, `src/http-app.cjs`, `tests/server.test.cjs`, and `server.cjs`; write the named report separately.
- Strict TDD: add one behavioral regression, run and observe the intended failure, implement the minimum, then re-run. Do not dispatch subagents or touch the live service.

## Exact state model

1. Add snapshot fields `lastAttemptAt`, `lastAnySuccessAt`, and `lastAllSuccessAt`; keep `lastSuccessAt` as a backward-compatible alias of `lastAnySuccessAt`.
2. `getSnapshot()` dynamically adds each source `{ freshness, ageMs, isOverdue }` and aggregate `freshness.overdueSourceIds` plus `freshness.worstSourceAgeMs`. Required-source aggregation rules:
   - any source never successful → overall `never`;
   - otherwise any source age `>= 2 * refreshIntervalMs` → `overdue`;
   - otherwise any source age `>= refreshIntervalMs` → `aging`;
   - otherwise `fresh`.
3. `lastAnySuccessAt` advances when at least one trusted source succeeds. `lastAllSuccessAt` advances only when every configured source succeeds without degradation.

## Drift gates and retry

For a source with prior currently-visible records (`missingSince` absent), reject a parse as suspicious when any rule fires:

- prior count is at least 5 and current count is less than `ceil(priorCount * 0.4)`;
- more than 70% of prior URLs disappeared and new URLs are fewer than `ceil(priorCount * 0.5)`;
- newest current publication date is more than 120 days older than newest prior publication date.

A suspicious parse is retryable once. If the second attempt remains suspicious, set the source `ok: false`, `degraded: true`, retain its cache, and expose a bounded Chinese reason. HTTP 200 with zero relevant records is likewise retryable once.

HTTP 429 uses `Retry-After` seconds or HTTP-date, bounded to 10,000 ms. Other retry delay is `retryDelayMs`; add at most 250 ms jitter through injectable `randomImpl` (tests use zero). Return/record the actual delay.

## History, updates, and capacity

- Match previous records first by `sourceId + normalized URL`, not only legacy ID.
- A seen record preserves `discoveredAt`, sets `lastSeenAt`, clears `missingSince/missCount`, and uses the new stable ID.
- If `contentHash` changed, set `updatedAt` to the current fetch and `changeType: "updated"`; `change.updatedCount` and `updatedIds` report it. Otherwise preserve prior `updatedAt` and omit/reset transient change type.
- On a trusted successful source refresh, absent prior records get `missingSince` once and increment `missCount`. Retain until either missing age exceeds 90 days or `missCount > 168`; reappearance clears both.
- Failed/degraded sources carry their cache unchanged.
- Compute discovery/change sets before limiting. Every item discovered in this refresh must survive the 120-item cap. Fill remaining capacity with ranked records and keep a reasonable per-source representation. Sorting must not allow old target-year records to remove a freshly discovered generic notice.

## Cache recovery and observability

- `createFileCacheStore(path)` writes a valid temporary file, preserves the previous primary as `${path}.bak`, and atomically promotes the temporary file.
- On primary JSON corruption, load a valid backup and return a recovery signal the service converts to a visible bounded warning. If neither primary nor backup is valid, throw a cache-corruption error; `initialize()` retains seed state and exposes the error.
- Accept `onRefreshEvent(event)`; emit one completion event per refresh with duration, status, cacheSaved, `newCount`, `updatedCount`, and per-source attempts/count/degraded/error. Logging callback failures must not fail refresh.
- `server.cjs` logs these refresh summaries as one-line JSON and no longer hides scheduled refresh failures.
- `/api/health` remains ready/compatible and adds `uptimeSeconds`, `status`, `lastAttemptAt`, `lastAllSuccessAt`, and `overdueSourceIds` from `getSnapshot()`.

## Required tests

1. Count-drop, URL-disappearance, and 120-day rollback each preserve cache and show degradation after two attempts.
2. One fresh and one two-interval-old source makes aggregate freshness overdue with the exact source ID, even though another source just succeeded.
3. Same-URL title edit is one record with preserved discovery time, updated metadata, and no false new ID.
4. Normal shrink marks missing; reappearance clears it; time/cycle expiry removes it.
5. A capacity fixture proves all current-refresh discoveries survive.
6. Zero-result retries twice; 429 delay respects an injected bounded `Retry-After`.
7. A temporary-directory integration test corrupts primary, recovers backup, and observes warning; corrupt main+backup exposes an error.
8. Health endpoint returns the new operational fields without breaking HEAD or existing APIs.

## Report contract

Write `.superpowers/sdd/2026-08-24-reliability-hardening/task-2-report.md` with changed files, each RED/GREEN command and result, data-migration decisions, self-review and concerns. Return only DONE/DONE_WITH_CONCERNS, a one-line test summary and concerns.
