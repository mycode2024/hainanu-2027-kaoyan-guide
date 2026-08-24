# Task 4 Report — Atomic Windows lifecycle and operational retention

## Status

DONE — fix round 3

## Changed files

- `scripts/launch.ps1`
- `scripts/stop.ps1`
- `tests/smoke.test.cjs`
- `.superpowers/sdd/2026-08-24-reliability-hardening/task-4-report.md`

## Implemented behavior

- Lifecycle startup still uses its per-project/per-port mutex. Log allocation and retention now additionally use a separate project-wide `Global\HainanuGuide-<project-hash>-logs` mutex.
- The log mutex covers global retention, port/timestamp/GUID log-name allocation, and `Start-Process`, so two ports cannot race retention or redirect targets. Retention discovers complete stdout/stderr pairs in both legacy `server-<timestamp>.log` and current port-prefixed formats, then keeps the newest 14 pairs across the whole project.
- Stop validates CIM identity, opens and retains the native `System.Diagnostics.Process` plus `SafeHandle`/`Handle`, re-queries CIM, and fails closed unless the second PID, name, exact `argv[1]`, and creation time are all present and equal. It uses the retained object's `Kill()` and waits on that same object.
- Launch cleanup retains a published PID if it cannot confirm its child exited; browser failures remain warnings after readiness; PID removal remains content-ownership conditional.

## RED / GREEN evidence

All lifecycle commands used random high ports and isolated `%TEMP%\\hnu-guide-task4-*` projects. Port 4173 was never bound, stopped, or replaced.

- RED: `node --test --test-name-pattern=mixed tests\\smoke.test.cjs` → FAIL: 16 preseeded mixed legacy/current pairs plus two concurrent launches left `18 !== 14` pairs.
- GREEN: same command → PASS `1/1` after global retention and the project log mutex.
- RED: `node --test --test-name-pattern=creation tests\\smoke.test.cjs` → the new missing-second-creation-time case failed because stop returned `0`.
- GREEN: same command → PASS `2/2` for both changed and missing second creation time. The changed-creation test was already rejected by the prior comparison; the new test verifies the missing-value fail-closed requirement.
- `node --test --test-name-pattern=different-port tests\\smoke.test.cjs` → PASS `2/2` (distinct redirects and mixed global retention).
- `node --test --test-name-pattern=retains tests\\smoke.test.cjs` → PASS `1/1` (standard 14-pair regression).
- `node --test --test-name-pattern=CIM tests\\smoke.test.cjs` → PASS `3/3` (query/absence distinction plus both second-CIM failure modes).
- `node --test --test-name-pattern=removes tests\\smoke.test.cjs` → PASS `1/1` using real CIM and normal native-object shutdown.
- `node --test --test-name-pattern=fixed tests\\smoke.test.cjs` → PASS `1/1`; when the owned child exits in the tiny CIM2→Kill race, the native-object Kill path errors and preserves the PID.
- `node --check tests\\smoke.test.cjs` → exit `0`; Windows PowerShell parser check of both lifecycle scripts → `PowerShell syntax OK`.

`tests/smoke.test.cjs` currently has 26 lifecycle/smoke cases (above the requested 21); this round added the mixed global-retention case and missing-creation-time case, and strengthened the existing creation-change and native-kill-race behaviors. Only the focused matrix above was rerun in this round; no claim is made here about a repository-wide test result while other concurrent task work is in flight.

## Cleanup evidence

- Final elevated audit parsed candidate Node command lines using `CommandLineToArgvW` and would terminate only Node processes whose actual `argv[1]` resolved inside a unique `%TEMP%\\hnu-guide-task4-*` directory.
- Audit result: `Stopped:` (none), `Removed directories: 0`; test teardown had already completed.
- A final `%TEMP%\\hnu-guide-task4-*` scan returned no matches. No unverified process or port 4173 process was touched.

## Self-review and concerns

- The log test uses behavioral concurrent subprocess launches, mixed legacy/current seed pairs, and a fixed clock only to make the original collision scenario deterministic.
- The stop tests use real owned Node children and a CIM wrapper only to simulate the second identity sample; no source-text assertion is used.
- Full-suite verification remains for the main line after concurrent tasks settle; focused Task 4 regressions and syntax checks are green.
