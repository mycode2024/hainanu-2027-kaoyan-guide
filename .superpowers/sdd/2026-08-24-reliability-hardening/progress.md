# SDD ledger — plan: docs/superpowers/plans/2026-08-24-reliability-hardening-plan.md

Baseline: `npm.cmd run check` passed 41/41 tests on 2026-08-24 before implementation.

Ruling: The project directory is not a Git repository, so a Git worktree, commit ranges, and diff packages are unavailable — use non-overlapping file ownership, persistent reports, independent read-only whole-file review, and fresh full-suite verification instead — cost if wrong: review has less precise change attribution than a Git diff.

## Pre-flight interface scan

| Tasks | Producer / consumer | Result |
|---|---|---|
| 1 → 2 | Task 1 produces stable IDs, content hashes and parse diagnostics; Task 2 consumes them | Ordered dependency; Task 2 starts after Task 1 review. |
| 2 → 3 | Task 2 extends compatible v2 freshness/source fields; Task 3 normalizes them | Additive optional fields; frontend remains compatible with old snapshots. |
| 2 ↔ 4 | Task 2 may extend server health; Task 4 owns PowerShell lifecycle | No shared source files; runtime integration is Task 5. |
| 3 ↔ 4 | Browser UI versus Windows scripts/docs | `README.md` belongs only to Task 4; no edit collision. |
| 1 | Tests name real missed titles, stable identity, Shanghai boundary, alternate container | Internally consistent with parser interfaces. |
| 2 | Tests cover drift, history, freshness, retry, backup and health | Internally consistent; drift tests consume Task 1 diagnostics. |
| 3 | Tests cover pure state helpers; browser behavior is verified in integrated review | Internally consistent; no DOM test dependency introduced. |
| 4 | Behavioral lifecycle tests use isolated ports and must not touch live port 4173 | Internally consistent and protects current user service. |
| 5 | Consumes all tasks and may modify only for reproducible defects | No new interface. |

Task 3 review: Spec compliance ❌; quality With fixes — visibility hide/show can miss immediate resume while the aborted request is still in `finally`; polling/visibility/storage/print integration behavior lacks regression coverage.

Task 3 minor (deferred): static HTML lacks a default `data-print-state="未完成"` when JavaScript never runs.

Task 3 minor (deferred): several secondary labels remain below the intended readable size/contrast floor.

Task 1 review: Spec compliance ❌; quality With fixes — normal-source relevance can accept unrelated campus traffic notices; national policy lacks explicit training-policy exclusion; regex div extraction can truncate nested cards, duplicate nested li/div records, or associate an anchor with another date; diagnostics count raw containers rather than valid candidate records; raw HTML date scanning can use href/title/unrelated or stop at an invalid early date.

Task 1 minor (deferred): malformed numeric HTML entities above Unicode maximum can throw during decoding.

Task 3: fix round 1/5 (visibility race addressed; storage-degraded session behavior still open — current test checks warning only).

Task 3 minor (deferred): report changed-files section still describes tests as pure-helper coverage after fake-DOM tests were added.

Task 3: fix round 2/5 (storage-degraded checkbox/print and in-session acknowledgement behavior addressed; 0 open).

Task 3: complete (no Git range available; scoped review clean; fresh controller run 23/23 tests passed).

Task 3 integration review: reopened — frontend normalizer drops source/aggregate freshness, degraded and update-change metadata; UI does not name overdue sources; cache-recovery title is misleading; same URL from multiple source identities renders twice; freshness copy hardcodes one-hour thresholds.

Task 3: integration fix round 3 (extended v2 contract, overdue/degraded/recovery UI, same-URL display aggregation, dynamic cadence addressed; fragment-only URL variants and deadline-missing cadence remained open).

Task 3: integration fix round 4 (fragment-free display canonicalization and unified interval formatter addressed; 0 open).

Task 3: complete after integration re-review (fresh controller run 33/33 tests passed).

Task 1: fix round 1/5 (normal-context false positives and national training policy addressed; nested visible-card association improved; hidden script/comment/style/template pseudo-elements still contaminate extraction and diagnostics).

Task 1 minor (deferred): report description of `relevantCount` is stale after its semantics changed to valid unique updates.

Task 1: fix round 2/5 (closed hidden regions addressed; nested template and unclosed comment/script/style/template still leak pseudo-announcements and contaminate diagnostics).

Task 1: fix round 3/5 (nested template and unclosed hidden-region scanner addressed; 0 open).

Task 1: complete (no Git range available; scoped review clean; fresh controller run 22/22 tests passed).

Task 4 review: Spec compliance ❌; quality With fixes — stop can mistake an exact `server.cjs` ordinary argument for Node's entry script; different ports share one PID file; mutex is session-local and stop does not join it; PID compare/delete has a managed-writer race; PID publication failure can orphan Node; test cleanup uses the same imprecise substring ownership and lacks unconditional cleanup; ephemeral ports are not explicitly guaranteed distinct/non-4173.

Task 4 minor (deferred): concurrency tests do not cover cross-session/PID publish failure/real delete race.

Task 4 minor (deferred): incomplete orphan log files are not covered by 14-pair retention.

Task 4: fix round 1/5 (actual entry argv, per-port PID, Global shared start/stop mutex, managed delete serialization, publish-failure cleanup, exact test cleanup and safe ports addressed; shared cross-port logs, cleanup-failure PID retention, and CIM-to-handle PID reuse remain open; report stale).

Task 4 minor (deferred): mutex test opens the named object but does not prove another process cannot acquire it before readiness.

Task 4: fix round 2/5 (cross-port unique log names, child-cleanup PID retention, and second identity check added; global 14-pair retention and native-handle/creation continuity remain open).

Task 4: fix round 3/5 (project-global mixed-format 14-pair retention and fixed native process identity addressed; 0 open).

Task 4: complete (no Git range available; scoped review clean; focused lifecycle matrix and syntax passed; full suite pending final integration verification).

Task 2 review: Spec compliance ❌; quality With fixes — backup recovery followed by save can overwrite the good backup with corrupt primary; final capacity/global sorting dedupes by URL instead of source+URL; absent Retry-After becomes zero delay; initialize is not coalesced; delay failure and async event callback rejection break the one-completion-event/isolation contract; mixed never+fresh sources report a misleading numeric worst age.

Task 2 minor (deferred): a missing-history record can retain transient `changeType: updated`.

Task 2 minor (deferred): due-refresh errors triggered by `/api/updates` are still silently swallowed at the HTTP boundary.

Task 2: fix round 1/5 (backup recovery-save, source identity, Retry-After variants, initialization coalescing, completion callback isolation, and never-age semantics addressed; multi-source fatal refresh still completes/releases before all sources settle).

Task 2: fix round 2/5 (multi-source fatal settlement barrier and in-flight coalescing addressed; 0 open).

Task 2: complete (no Git range available; scoped review clean; fresh controller run 46/46 target tests passed).

## Final integration audit and fix wave

Final whole-project audit: NOT APPROVED initially — 3 reliability Important findings (production HNU context mismatch, semantically invalid cache recovery, unused parser diagnostics) plus 2 runtime Important findings (DNS rebinding/manual-refresh abuse and health readiness semantics).

Final fix wave: complete — one fixer used RED/GREEN coverage for all 5 Important findings and the four selected low-risk minors. Evidence and exact targeted commands are recorded in `final-fix-report.md`; non-Windows integration tests passed 113/113 and focused Windows live/readiness tests passed 2/2.

Final post-fix read-only re-review: APPROVED — no open Critical or Important findings. Production contexts, semantic cache recovery, diagnostic retry/degradation, loopback Host/Origin/cooldown enforcement, and live-versus-ready Windows lifecycle contracts were all independently checked against current whole files.

Fresh full-suite verification under normal Windows CIM permissions: `npm.cmd run check` exited 0 on 2026-08-24 with 141/141 tests passing, 0 failures, 0 skipped, and all configured JavaScript syntax checks passing (`# duration_ms 257000.4238`). An earlier sandbox attempt was discarded because Windows denied `Get-CimInstance`; it was not treated as product evidence.

Fresh production switch and live verification:

- Old managed PID 20360 was stopped through the validated stop script; its PID file was removed.
- New managed PID 23984 was started through the validated launcher on `127.0.0.1:4173`.
- `/api/health` reports `live: true`, `ready: true`, `status: fresh`, and no overdue sources.
- A protected real refresh completed HTTP 200 with all 4/4 sources `ok: true`, `degraded: false`, `attempts: 1`; diagnostics were present for every source and the immediate stable repeat reported 0 new and 0 updated notices.
- The same live endpoint rejected a missing-Origin refresh with HTTP 403 and rate-limited a valid immediate repeat with HTTP 429 plus bounded `Retry-After`.
- Primary and backup cache files both parsed as schema v2 fresh snapshots with 4 sources and 60 retained updates; the active error log was empty.
- Browser reload showed 4/4 sources normal, 50 displayed notice links, 16 in the new-only filter, working sync disable/restore behavior, reversible 0% -> 5% -> 0% task progress, and no warning/error console entries. The live tab was kept open as the user-facing deliverable.
- The failed sandbox lifecycle run left 26 exact `hnu-guide-task4-*` test directories under the system temp root; all 26 resolved directly under that root, no matching Node process remained, and the test-only directories were removed.

Accepted remaining Minor hardening edges: shallow validation can still accept an array containing only malformed cached records before sanitization; a complete real upstream `li` to `div` structure switch intentionally remains fail-closed until reviewed; port 80 can falsely reject a browser Origin because of default-port elision; launcher user-facing wording still says “ready” where the implementation now means “live”; small secondary text contrast/size, cross-login-session mutex testing, single-sided orphan-log retention, and duplicate-project-instance identity remain future hardening work. None is an open Critical/Important or an honesty/timeliness blocker for the default 4173 deployment.

Final status: complete.
