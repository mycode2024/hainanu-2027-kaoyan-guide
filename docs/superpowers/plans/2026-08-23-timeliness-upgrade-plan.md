# Information Timeliness Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce official-notice discovery latency, expand authoritative coverage, expose honest freshness/change metadata, and make the local app reliably start before the browser opens.

**Architecture:** Extend the existing pure parser and injected update service rather than adding dependencies. The HTTP layer performs stale-while-revalidate on reads, the browser polls the local snapshot every minute, and a PowerShell launcher handles Windows process readiness.

**Tech Stack:** Node.js 18+ built-ins, CommonJS, browser JavaScript, PowerShell 5.1+, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-23-timeliness-upgrade-design.md`

## Global Constraints

- No third-party runtime dependency.
- Bind only to `127.0.0.1` and fetch only configured HTTPS official hosts.
- Backend refresh interval is exactly 3,600,000 ms; frontend snapshot interval is exactly 60,000 ms.
- Every source gets at most two attempts per refresh, separated by 750 ms in production.
- Preserve stale cache on partial or total upstream failure.
- Existing static timeline and direct-file fallback remain functional.

---

### Task 1: Expand source-aware parsing

**Files:**
- Modify: `src/official-scraper.cjs`
- Modify: `tests/official-scraper.test.cjs`
- Modify: `server.cjs`

**Interfaces:**
- Consumes: source records `{ id, name, url, allowedHosts, context }`.
- Produces: `isAllowedOfficialUrl(url, source)`, `parseOfficialList(html, source, checkedAt)` and four configured sources.

- [ ] Add a failing parser test proving an HNU-home `[10-28]` item checked in August 2026 becomes `2025-10-28`, while a `[09-30]` item checked in October 2026 becomes `2026-09-30`.
- [ ] Add a failing parser test proving the CHSI policy source accepts a national master-admissions regulation, rejects general postgraduate training policy, and resolves the link on `yz.chsi.com.cn`.
- [ ] Run `node --test tests/official-scraper.test.cjs`; expect the new records to be absent.
- [ ] Implement source-aware allowlists, short-date inference and national-policy relevance/category logic.
- [ ] Add the HNU homepage and CHSI policy source records in `server.cjs`.
- [ ] Rerun the parser tests; expect all to pass.

### Task 2: Add retry, discovery and freshness semantics

**Files:**
- Modify: `src/update-service.cjs`
- Modify: `tests/update-service.test.cjs`

**Interfaces:**
- Produces: `refreshIfDue() -> { started: boolean, promise: Promise | null }` and snapshot v2 fields from the spec.
- `createUpdateService` additionally accepts `delayImpl` and `retryDelayMs` for deterministic tests.

- [ ] Add a failing test where the first source request throws and the second succeeds; assert a fresh snapshot and exactly two attempts.
- [ ] Add a failing test where the same notice appears in two refreshes; assert `discoveredAt` is preserved and the second `change.newCount` is zero.
- [ ] Add a failing test advancing the injected clock beyond `nextRefreshAt`; assert `refreshIfDue()` starts only once and `getSnapshot().freshness.state` becomes `overdue` before completion.
- [ ] Run `node --test tests/update-service.test.cjs`; expect missing retry/change/freshness behavior.
- [ ] Implement one retry, source `lastSuccessAt`, cache v2 sanitization, discovery comparison, dynamic freshness and due-refresh coalescing.
- [ ] Change `DEFAULT_REFRESH_INTERVAL_MS` to `3_600_000`.
- [ ] Rerun update-service tests; expect all to pass.

### Task 3: Trigger stale-while-revalidate at the API boundary

**Files:**
- Modify: `src/http-app.cjs`
- Modify: `tests/server.test.cjs`

**Interfaces:**
- Consumes optional `updateService.refreshIfDue()`.
- `GET /api/updates` still returns the current snapshot immediately.

- [ ] Add a failing server test with a deferred `refreshIfDue`; assert the GET response returns immediately and the due-refresh method is invoked once.
- [ ] Run `node --test tests/server.test.cjs`; expect zero due-refresh calls.
- [ ] Invoke `refreshIfDue()` without awaiting it before serializing the current snapshot; swallow/log no upstream detail to the client.
- [ ] Rerun server tests; expect all to pass.

### Task 4: Show freshness and newly discovered notices

**Files:**
- Modify: `app.js`
- Modify: `index.html`
- Modify: `styles.css`
- Modify: `tests/app.test.cjs`

**Interfaces:**
- Payload normalization accepts schema v2 fields while remaining compatible with v1.
- Produces `getUnseenUpdates(updates, lastSeenAt)` for testable new-item selection.

- [ ] Add failing tests proving CHSI HTTPS links are accepted, malicious lookalikes remain rejected, v2 timestamps are normalized, and only post-baseline `discoveredAt` items are unseen.
- [ ] Run `node --test tests/app.test.cjs`; expect missing v2 fields/helper.
- [ ] Implement payload normalization and unseen-item helper.
- [ ] Render freshness age, dynamic refresh cadence, `NEW` badges and four source states; establish a first-visit baseline in local storage.
- [ ] Reduce frontend polling from 15 minutes to 60 seconds and update explanatory copy.
- [ ] Rerun app tests; expect all to pass.

### Task 5: Make Windows startup readiness-based

**Files:**
- Create: `scripts/launch.ps1`
- Modify: `start-guide.cmd`
- Create: `../海南大学2027考研导航.cmd`
- Modify: `.gitignore`
- Modify: `README.md`

**Interfaces:**
- `scripts/launch.ps1 -NoBrowser` starts or reuses port 4173 and exits 0 only after `/api/updates` responds.

- [ ] Implement the launcher with exact project-root resolution, existing-service reuse, hidden Node startup, condition polling for at most 15 seconds, and log output on failure.
- [ ] Replace the fixed two-second batch flow with a call to the PowerShell launcher.
- [ ] Add the desktop wrapper and ignore runtime logs.
- [ ] Run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/launch.ps1 -NoBrowser`; expect exit 0 and working API.
- [ ] Update README with the one-click entry, one-hour cadence, four sources and local-only availability boundary.

### Task 6: Complete review and live verification

**Files:**
- Modify only if review or verification finds a reproducible defect.

**Interfaces:**
- Consumes the complete project.
- Produces a verified running local product at `http://127.0.0.1:4173/`.

- [ ] Run `npm run check`; require zero syntax errors and zero failed tests.
- [ ] Request an independent read-only code review against the spec and fix every Critical/Important finding with TDD.
- [ ] Stop only the verified project-owned old 4173 process, start the final launcher, and wait for readiness.
- [ ] Call `GET /api/updates` and protected `POST /api/refresh`; require four successful sources, `schemaVersion: 2`, fresh status and a persisted cache.
- [ ] Open the final page once after the non-browser checks pass.
