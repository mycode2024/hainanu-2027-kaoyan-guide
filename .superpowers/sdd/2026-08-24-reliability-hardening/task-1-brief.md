# Task 1 brief — Parser recall, stable identity, and Shanghai dates

Read first. This file is the requirements source for this task.

## Global constraints

- No third-party runtime dependency.
- Only configured HTTPS official hosts are accepted.
- Preserve the existing `parseOfficialList` API.
- Modify only `src/official-scraper.cjs` and `tests/official-scraper.test.cjs`.
- Follow strict TDD: write each regression first, run it and capture the expected failure, then implement the minimum production change.
- Do not dispatch subagents. Do not stop or restart the live service.

## Required behavior

1. Parse the real HNU title `海南大学海甸校区考点致参加2026年研考考生的一封信`.
2. Parse the real CHSI title `关于做好2026年退役大学生士兵专项硕士研究生招生计划招生工作的通知` while continuing to reject unrelated doctoral/training policy.
3. Produce a stable notice `id` from source identity plus normalized official URL, independent of title. Produce a separate `contentHash` that changes when title/category/date content changes.
4. Infer `[MM-DD]` using the `Asia/Shanghai` calendar. At `2025-12-31T16:30:00.000Z`, `[01-01]` is `2026-01-01`. Reject impossible dates such as `02-30`.
5. Add `parseOfficialDocument(html, source, checkedAt) -> { updates, diagnostics }`; diagnostics include `candidateCount`, `relevantCount`, and `containerTypes`. Keep `parseOfficialList` as a wrapper returning only updates.
6. Support a dated announcement in a non-`li` block without pairing an anchor to an unrelated distant date. Existing list fixtures and URL safety tests must remain green.

## Report contract

Write a full report to `.superpowers/sdd/2026-08-24-reliability-hardening/task-1-report.md`: changed files, each RED command/failure, GREEN command/result, design decisions, self-review and concerns. Return only status, a one-line test summary and concerns.
