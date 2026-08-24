# Task 4 brief — Atomic Windows lifecycle and operational retention

Read first. This file is the requirements source for this task.

## Global constraints

- PowerShell 5.1+ and Node.js built-ins only.
- Modify only `scripts/launch.ps1`, `scripts/stop.ps1`, `start-guide.cmd`, `stop-guide.cmd`, `tests/smoke.test.cjs`, and `README.md`.
- Do not stop, kill, replace, or bind the live user service on port 4173 during development tests. Use isolated high ports and temporary directories; clean up only verified child processes created by the test.
- Use behavioral subprocess tests instead of source-text assertions where Windows PowerShell is available.
- Follow strict TDD and do not dispatch subagents.

## Required behavior

1. `launch.ps1` accepts `-Port 4173`, uses a per-project/per-port named mutex around probe → start → PID → ready, and passes the same port to the Node child even when the parent inherited another `PORT`.
2. PID replacement is atomic and cleanup removes a PID only when it still belongs to the process this invocation created.
3. Concurrent or duplicate starts produce one owned service process and both callers finish successfully once ready.
4. Retain only the newest 14 stdout/stderr log pairs. Browser launch failure after service readiness is a warning, not launch failure.
5. `stop.ps1` distinguishes CIM query errors from absence, verifies Node plus exact server script ownership, waits up to 10 seconds for exit, confirms the service is no longer healthy, then removes the PID. Keep PID on query/termination failure.
6. Batch wrappers pass through exit codes. README documents source-level freshness, backup cache, logs and safe start/stop.

## Report contract

Write `.superpowers/sdd/2026-08-24-reliability-hardening/task-4-report.md` with changed files, RED/GREEN commands and results, cleanup evidence, self-review and concerns. Return only status, a one-line test summary and concerns.
