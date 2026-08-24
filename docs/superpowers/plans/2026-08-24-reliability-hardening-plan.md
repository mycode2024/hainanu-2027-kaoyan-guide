# Reliability Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make official-notice completeness, source freshness, cache preservation, browser state, and Windows lifecycle behavior trustworthy under partial failure and upstream change.

**Architecture:** Keep the dependency-free parser and update service, but add stable URL identity, parse diagnostics, drift gates, bounded history, source-level freshness and explicit observability. The frontend consumes the compatible extended v2 payload, while PowerShell owns an atomic single-process lifecycle.

**Tech Stack:** Node.js built-ins, CommonJS, browser JavaScript, PowerShell 5.1+, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-24-reliability-hardening-design.md`

## Global Constraints

- No third-party runtime dependency.
- Bind only to `127.0.0.1`; fetch only configured HTTPS official hosts.
- Keep `schemaVersion: 2` and all existing HTTP routes backward compatible.
- The scheduled refresh interval remains exactly 3,600,000 ms.
- A suspicious or failed source result must preserve that source's trusted cache.
- Static-file fallback and existing checklist storage remain functional.

---

### Task 1: Parser recall, stable identity, and Shanghai dates

**Files:**
- Modify: `src/official-scraper.cjs`
- Modify: `tests/official-scraper.test.cjs`

**Interfaces:**
- Produce `parseOfficialDocument(html, source, checkedAt) -> { updates, diagnostics }`.
- Preserve `parseOfficialList(...) -> updates` as a compatibility wrapper.
- Each update produces stable `id` and `contentHash`.

- [ ] Add literal fixtures for `海南大学海甸校区考点致参加2026年研考考生的一封信` and `关于做好2026年退役大学生士兵专项硕士研究生招生计划招生工作的通知`; verify both are returned.
- [ ] Add a test where one URL changes title; verify `id` stays equal and `contentHash` changes.
- [ ] Add a test at `2025-12-31T16:30:00.000Z`; verify `[01-01]` becomes `2026-01-01` in Shanghai, plus reject `02-30`.
- [ ] Add a `<div>`-based dated announcement fixture and assert diagnostics name a non-list container.
- [ ] Run `node --test tests/official-scraper.test.cjs` and observe failures caused by missing behavior.
- [ ] Implement source-specific positive/exclusion rules, stable URL normalization, content hash, Shanghai calendar handling and diagnostics.
- [ ] Re-run the parser suite and require zero failures.

### Task 2: Drift gates, bounded history, per-source freshness, retries, and cache backup

**Files:**
- Modify: `src/update-service.cjs`
- Modify: `tests/update-service.test.cjs`
- Modify: `server.cjs`
- Modify: `src/http-app.cjs`
- Modify: `tests/server.test.cjs`

**Interfaces:**
- `getSnapshot()` returns `lastAttemptAt`, `lastAnySuccessAt`, `lastAllSuccessAt`, aggregate freshness details and dynamic per-source freshness.
- Refresh uses parser diagnostics and returns change counts for new and updated records.
- `createFileCacheStore` keeps `<cache>.bak` and signals backup recovery.
- `createUpdateService` accepts `onRefreshEvent` and deterministic delay/random injection for tests.

- [ ] Add a test whose successful-looking refresh drops 80% of a source; assert `degraded: true` and preservation of cached items.
- [ ] Add tests for URL disappearance and 120-day newest-date rollback gates.
- [ ] Add a test where one source is fresh and one is older than two intervals; assert overall `overdue` and the exact `overdueSourceIds`.
- [ ] Add a two-refresh title-edit test; assert one stable record, preserved `discoveredAt`, populated `updatedAt`, and `updatedCount: 1`.
- [ ] Add a normal shrink test; assert `missingSince`/`missCount`, reappearance clearing, and expiry after the configured bounds.
- [ ] Add capacity fixtures proving every newly discovered record survives the snapshot limit.
- [ ] Add zero-result retry and bounded `Retry-After` tests.
- [ ] Add a real temporary-file cache test: corrupt primary, load backup, and expose a recovery warning.
- [ ] Run targeted tests and observe the new assertions fail for the intended missing branches.
- [ ] Implement the minimum state transitions and gates, preserving URL-based compatibility for old cached IDs.
- [ ] Emit refresh summary events and extend `/api/health` with uptime, attempt/all-success times and overdue sources.
- [ ] Re-run update-service and server suites; require zero failures.

### Task 3: Honest timeline, non-overlapping polling, unread controls, and print output

**Files:**
- Modify: `app.js`
- Modify: `index.html`
- Modify: `styles.css`
- Modify: `tests/app.test.cjs`

**Interfaces:**
- `getTimelineState` additionally returns `activeIds` without removing `activeId` compatibility.
- Pure helpers produce a snapshot render key and acknowledged/new selection.
- DOM polling uses one request at a time, an 8-second abort timeout, recursive scheduling and `visibilitychange`.

- [ ] Add overlapping milestone tests and verify all active IDs are returned in chronological order.
- [ ] Add pure-helper tests proving equal snapshots do not require a list rebuild and acknowledged IDs stop being new.
- [ ] Run app tests and observe failures for the missing helpers/fields.
- [ ] Implement parallel-current rendering, expected/confirmed copy and a non-committal static fallback.
- [ ] Replace `setInterval` with completion-based scheduling, abort timeout, visibility pause and a single-flight guard.
- [ ] Add “全部/只看新/确认已读”, a visible storage-degraded note, and accessible live-count text.
- [ ] Preserve checkbox labels and checked state in print CSS, including the latest verification time.
- [ ] Re-run app tests; require zero failures.

### Task 4: Atomic Windows lifecycle and operational retention

**Files:**
- Modify: `scripts/launch.ps1`
- Modify: `scripts/stop.ps1`
- Modify: `start-guide.cmd`
- Modify: `stop-guide.cmd`
- Modify: `tests/smoke.test.cjs`
- Modify: `README.md`

**Interfaces:**
- `launch.ps1 -Port 4173 -NoBrowser` owns a named mutex and passes the same port to the child.
- PID replacement is atomic and cleanup checks ownership.
- Stop waits up to 10 seconds for the owned process and health endpoint to disappear.

- [ ] Replace source-text assertions with Windows behavioral subprocess tests when PowerShell is available; skip with an explicit reason elsewhere.
- [ ] Add tests for duplicate/concurrent start, inherited conflicting `PORT`, stale PID, and stop confirmation using an isolated temporary data directory/port.
- [ ] Run the lifecycle tests and observe failures for current races/port mismatch.
- [ ] Implement mutex acquisition/release, unified port inheritance, atomic PID updates and 14-pair log retention.
- [ ] Make CIM query errors fatal without deleting PID; wait for termination before cleanup.
- [ ] Treat browser launch failure as a warning after readiness succeeds.
- [ ] Update README with source-level freshness, cache backup, logs and lifecycle behavior.
- [ ] Re-run lifecycle tests and require zero failures.

### Task 5: Integrated verification and independent review

**Files:**
- Modify only when a reproducible verification or review defect requires it.

- [ ] Run `npm.cmd run check`; require zero syntax errors and zero failed tests.
- [ ] Start the final service, call `/api/health`, `/api/updates`, and protected `/api/refresh`, and require four configured sources plus honest per-source freshness.
- [ ] Confirm primary and backup cache files are valid JSON after a refresh.
- [ ] Request an independent read-only review against this plan; fix every Critical/Important finding with a new failing regression test first.
- [ ] Re-run the complete verification after review fixes and record exact results.
