# Task 3 brief — Honest timeline, polling, unread controls, and print

Read first. This file is the requirements source for this task.

## Global constraints

- No third-party dependency; preserve static-file fallback and current local-storage checklist data.
- Modify only `app.js`, `index.html`, `styles.css`, and `tests/app.test.cjs`.
- Follow strict TDD for pure behavior before production edits.
- Do not dispatch subagents. Do not stop or restart the live service.

## Required behavior

1. `getTimelineState` returns all overlapping active milestones as `activeIds` in chronological order while preserving compatible `activeId`, `nextId`, and `daysToNext`.
2. Render every concurrent active milestone; dashboard copy may combine their labels/actions. Mark unconfirmed dates as `预计`; static fallback must not permanently claim `进行中`.
3. Add pure helpers for a stable snapshot render key and acknowledged/new selection. Identical update data must not rebuild the update list.
4. Replace fixed `setInterval` with request-completion scheduling, single-flight protection, an 8-second `AbortController` timeout, and pause/resume through `visibilitychange`.
5. Provide accessible `全部`, `只看新`, and `确认已读` controls. New badges stay during the visit until explicit acknowledgement. Avoid claiming all 120 items are visible when only 10 are rendered; either render the selected set or state the displayed count.
6. When local storage is unavailable, show a visible `仅本次会话保存` warning and keep session behavior functional.
7. Print output includes task labels, checked/unchecked state, and latest official-data verification time. Improve undersized/low-contrast secondary text when touching its styles.

## Report contract

Write `.superpowers/sdd/2026-08-24-reliability-hardening/task-3-report.md` with changed files, RED and GREEN evidence, self-review and concerns. Return only status, a one-line test summary and concerns.
