# Task 3 report — frontend reliability

## Changed files

- `app.js` — overlapping active milestones, stable list render keys, explicit unread acknowledgement, storage fallback warning, completion-scheduled polling with timeout/single-flight/visibility handling, printable task states, v2 freshness/change normalization, source-health presentation, and normalized-URL display aggregation.
- `index.html` — accessible update controls, session-only storage warning, honest static timeline label, and revised polling copy.
- `styles.css` — update-control/warning presentation, more legible secondary text, and printable task states.
- `tests/app.test.cjs` — pure-helper coverage plus executable fake-DOM, timer, fetch, storage-fallback, acknowledgement, and printable-state behavior coverage.

## RED evidence

`node --test tests\\app.test.cjs` failed before production edits: 10 passing and 5 failing tests. The failures showed missing `activeIds`, an incorrect single active milestone for overlap, and missing `createUpdatesSnapshotKey` and `selectUpdatesForDisplay` exports.

## GREEN evidence

After implementation, `node --test tests\\app.test.cjs && node --check app.js` exited 0: 15 tests passed, 0 failed, and the syntax check produced no errors.

## Self-review

- Repeated normalized snapshot data leaves the update list intact through a stable render key.
- Automatic polling schedules only after request completion, rejects overlapping loads, aborts after 8 seconds, and pauses/resumes with document visibility.
- All selected notices are rendered rather than claiming a larger visible count.
- Read badges remain for the visit until the explicit acknowledgement control is activated.
- Static fallback no longer labels a projected milestone as in progress; print includes task labels, their state, and the live verification metric.

## Concerns

The new lightweight fake-DOM coverage exercises the relevant behavior without a third-party browser harness. Actual browser rendering and print-preview visual layout remain outside this task's test environment.

## Fix round 1 — reviewer findings

### Root cause and change

The `visibilitychange` handler attempted an immediate reload while the aborted request still held the single-flight lock. That call was dropped, and its `finally` block only scheduled the 60-second poll. `resumePending` now records that a visible-page resume was requested and starts the next fetch immediately after the old request releases the lock.

### RED evidence

After adding a fake DOM, real `AbortController`, fake timers, and controlled `fetch` boundary to `tests/app.test.cjs`, `node --test tests\\app.test.cjs` produced 20 passing tests and 1 expected failure. The hide → abort → visible test expected two fetches after cleanup but observed one (`1 !== 2`).

### GREEN evidence

After the minimal `resumePending` change, `node --test tests\\app.test.cjs && node --check app.js` exited 0: 21 tests passed, 0 failed, and the syntax check produced no errors.

### Added executable behavior coverage

- Single-flight refresh does not overlap an active request.
- An 8-second timer aborts the real request signal and returns the refresh control to its usable state.
- A hide/show race resumes immediately after abort cleanup.
- Repeating an identical successful snapshot does not call `replaceChildren` again for the update list.
- Throwing local storage exposes the session-only warning.
- Current checkbox state drives the printable completed/pending labels.

## Fix round 2 — session-only storage verification

### Added behavior coverage

- When both local-storage reads and writes throw, changing a checkbox still updates the visible progress count, percentage, and printable task state for the current page.
- After a later snapshot introduces a notice with `discoveredAt`, confirmation still clears its current-page new badge and makes “只看新” empty even when the persistence write throws.

### RED evidence

Both new scenarios already matched the implementation, so their effectiveness was verified with temporary branch mutations. Removing the post-change `renderProgress()` call made the full suite fail with `0 / 1 项` rather than `1 / 1 项` (and left the printable state stale). Removing the in-memory acknowledged-ID update made the acknowledgement scenario fail with one new badge remaining rather than zero. Both mutations were immediately restored.

### GREEN evidence

After restoring the verified branches, `node --test tests\\app.test.cjs && node --check app.js` exited 0: 23 tests passed, 0 failed, and the syntax check produced no errors.

## Integration fix round 3 — Task 2 contract alignment

### 1. Complete v2 normalization

- RED: adding the complete contract assertion made `node --test tests\\app.test.cjs` report 22 passing and 2 failing tests because top-level attempt/success clocks, per-source freshness metadata, aggregate overdue metadata, and update-change IDs were dropped.
- GREEN: `normalizeUpdatesPayload` now safely preserves valid `lastAttemptAt`, `lastAnySuccessAt`, `lastAllSuccessAt`, `overdueSourceIds`, `worstSourceAgeMs`, source `freshness`/`ageMs`/`isOverdue`/`degraded`, and `updatedCount`/`updatedIds`; 24 tests passed.

### 2. Source-specific overdue status

- RED: the live-console DOM test produced 24 passing and 1 failing test because the status did not name the one overdue source or expose its degraded freshness in the source chip.
- GREEN: the title/detail now list overdue source names, and source chips expose freshness/degraded state through class names and accessible tooltips including “数据异常，保留旧缓存”; 25 tests passed.

### 3. Cache-backup recovery priority

- RED: the cache-recovery DOM test produced 25 passing and 1 failing test because generic source-unavailable copy won over the recovery error.
- GREEN: cache recovery now has priority and renders “已从缓存备份恢复，等待验证” with the recovery detail; 26 tests passed.

### 4. URL-normalized display aggregation

- RED: aggregation helper and DOM tests produced 26 passing and 2 failing tests because matching notices were rendered separately and no aggregation helper was available.
- GREEN: display-only aggregation groups normalized URLs, keeps backend member identities/new IDs intact, lists every source, propagates any member’s new state, and supplies a stable aggregate render key; 28 tests passed and `node --check app.js` succeeded.

### 5. Refresh-cycle freshness wording

- RED: the final two tests produced 28 passing and 2 failing tests: `formatFreshness` was not exported and the live metric said “2 小时” despite a 15-minute snapshot interval.
- GREEN: freshness text and source tooltips now use supplied `refreshIntervalMs` and refresh-cycle wording (for example “少于 1 个刷新周期”, “1–2 个刷新周期”, and “2 个刷新周期”). `node --test tests\\app.test.cjs` reports 30 passing, 0 failing; `node --check app.js` succeeds.

### Round-3 self-review

- URL aggregation is intentionally presentation-only: API update IDs, `newIds`, and acknowledgement IDs remain member-level.
- Invalid optional v2 fields are discarded rather than propagated into DOM rendering.
- No freshness display uses a hard-coded hourly threshold; overdue cycle counts derive from the snapshot interval when it is valid.

## Integration fix round 4 — fragment identity and refresh-cadence copy

### 1. Fragment-free display aggregation

- RED: `node --test --test-name-pattern=fragments tests\app.test.cjs` ran the new cross-source regression and failed with `2 !== 1`; `new URL(...).href` had preserved `#graduate` / `#computer` as distinct display keys.
- GREEN: the display-only canonicalization now clears `URL.hash` before reading `href`. The same command passed 1/1 while asserting one group, a fragment-free URL/render ID, deterministic `memberIds` and `sourceNames`, and member-level new semantics.

### 2. One refresh-interval formatter

- RED: `node --test --test-name-pattern=configured tests\app.test.cjs` failed because `formatRefreshInterval` was undefined.
- GREEN: `node --test --test-name-pattern=intervals tests\app.test.cjs` passed 1/1 after adding and exporting the formatter. Exact whole-hour and whole-minute configurations render as `2 小时` and `30 分钟`; missing, non-positive, or sub-minute/non-integral-minute values conservatively render as `按刷新周期`.

### 3. Deadline-missing live metric and static copy

- RED: `node --test --test-name-pattern=cadence tests\app.test.cjs` failed because a two-hour snapshot still rendered the hard-coded `启动后每 1 小时`.
- GREEN: the deadline-missing branch now consumes `formatRefreshInterval`; the same command passed 1/1 across two-hour, 30-minute, and unknown-interval snapshots (`每 2 小时`, `每 30 分钟`, `按刷新周期`).
- The two human-facing static explanations in `index.html` now say the backend checks/fetches on its configured cycle instead of promising an hourly cadence.

### Final verification and self-review

- `node --test tests\app.test.cjs && node --check app.js` exited 0: 33 tests passed, 0 failed, and the syntax check produced no errors.
- Fragment removal occurs only at the display aggregation boundary. Backend identities, acknowledgement membership, source names, and the stable aggregate key remain intact.
- The interval formatter is the sole conversion path for the deadline-missing metric; an explicit `nextRefreshAt` still renders its actual timestamp.

### Concerns

- Cadences that are not exact whole minutes intentionally fall back to `按刷新周期` rather than display rounded timing.
- Per task instruction, no service or browser was started; the executable fake-DOM suite covers the changed rendering contract, while visual browser inspection remains outside this fix round.
