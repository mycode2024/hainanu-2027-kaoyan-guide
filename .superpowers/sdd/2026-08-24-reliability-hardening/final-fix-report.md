# Final fix wave report — 2026-08-24

## Outcome

The single final fix wave closed all five Important findings and the four requested low-risk Minor findings. The existing service on port 4173 was not started, stopped, or replaced during this wave; lifecycle tests used random high ports only.

## RED evidence

The following focused tests were added first and observed failing against the prior implementation:

- `node --test --test-name-pattern=production tests\official-scraper.test.cjs` — 0/1 passed; production `hnu-master` returned no short retest notice.
- `node --test --test-name-pattern=numeric tests\official-scraper.test.cjs` — 0/1 passed; `&#x110000;` threw `RangeError`.
- `node --test --test-name-pattern=structurally tests\update-service.test.cjs` — 0/1 passed; `{}` was accepted instead of recovering the backup.
- `node --test --test-name-pattern=diagnostics tests\update-service.test.cjs` — 0/4 passed; the injected parser was unused and diagnostics were absent from source state/events.
- `node --test --test-name-pattern=missing.history tests\update-service.test.cjs` — 0/1 passed; missing history retained transient `changeType`.
- `node --test --test-name-pattern=new-id tests\update-service.test.cjs` — 0/1 passed; 125 IDs were reported after a 120-record cap.
- `node --test --test-name-pattern=manual.refresh.rejects tests\server.test.cjs` — 0/1 passed; attacker-controlled equal Host/Origin was accepted.
- `node --test --test-name-pattern=health.distinguishes tests\server.test.cjs` — 0/1 passed; health had no `live` field and always claimed ready.
- `node --test --test-name-pattern=static.printable tests\app.test.cjs` — 0/1 passed; static labels had no default print state.

The first Windows RED attempts reached the old 15-second readiness behavior but their teardown was then blocked by sandboxed CIM permissions. The two exact temporary projects and one verified test-owned Node process were cleaned with normal Windows permissions before GREEN. The API health RED above independently captured the underlying `live`/`ready` defect.

## Implementation

### I1 — production source recall

- Added explicit short-action policies for `hnu-master`, `hnu-home`, and `hnu-computer`, while retaining the legacy `graduate-admissions-list` policy.
- Added `网上确认` categorization/recall.
- Kept explicit rejection of undergraduate/doctoral notices, training-management notices, campus traffic, and non-actionable campus content.
- Tests import the real `OFFICIAL_SOURCES` contexts from `server.cjs` and cover `网上确认公告`, `复试名单公示`, `调剂公告`, and `拟录取公示`.
- Stable source+URL IDs and content hashes are unchanged.

### I2 — semantic cache trust

- Cache files are trusted only when the parsed root is a non-array object with an `updates` array.
- Parseable invalid primaries (`{}`, arrays, non-array `updates`) now fall back to `.bak`.
- If both files are syntactically or structurally invalid, load throws `CACHE_CORRUPTION`; initialization exposes the failure in snapshot error text.
- Legacy `{ updates: [...] }` snapshots remain migratable.
- Save copies the old primary to backup only after the same structural trust check, preventing a parseable bad primary from replacing the only good backup.

### I3 — parser diagnostics as a trust gate

- `createUpdateService` now accepts a testable `parseDocument` injection and defaults to production `parseOfficialDocument`.
- Diagnostics require consistent non-negative integer counts, `relevantCount === updates.length`, `relevantCount <= candidateCount`, unique supported container types, and a container when relevant records exist.
- A malformed diagnostic result or complete container-type drift from the last trusted shape retries once; a repeated anomaly is degraded, retains source cache, and does not advance that source success time.
- Every source attempt has a `diagnostics` field; successful diagnostics become `lastTrustedDiagnostics` and survive cache migration.
- Completion summaries include per-source diagnostics.
- Zero-result and existing count/URL/date drift gates remain covered by the full related test group.

### I4 — local refresh abuse boundary

- `POST /api/refresh` now requires all of: marker header, non-cross-site fetch context, exact `127.0.0.1:<actual local port>` Host, and an exact matching HTTP Origin.
- Missing Origin, Host/Origin mismatch, and attacker-controlled rebinding names are rejected.
- Added an in-memory, injectable-clock manual cooldown (10 seconds by default, bounded to at most 60 seconds). Throttled calls return `429` and a bounded `Retry-After`.
- README now documents browser/CLI requirements and provides a valid PowerShell example.

### I5 — honest health and Windows lifecycle

- Health now always reports `live: true` for the responding, identity-verified service.
- `ready` is true only for `fresh`/`stale` snapshots that contain trusted updates; a seed/no-cache snapshot reports `ready: false`.
- Health intentionally remains HTTP 200 while unready. PowerShell 5.1 `HttpWebRequest.GetResponse()` throws on 503, which would make the launcher conflate a correctly identified live seed service with a refused/unrelated endpoint unless it added fragile exception-body parsing. The task explicitly allowed HTTP 200 when launcher behavior is proven through `live`.
- Launch and stop probes require exact product/schema identity plus `live`; launch also verifies the static page marker. A live seed process is no longer killed or duplicated because an official site is offline. Stop also refuses to discard a stale PID when the identified guide still occupies the port.

### Requested Minors

- Numeric entities call `String.fromCodePoint` only for integers in `0..0x10FFFF`; invalid entities remain literal.
- Missing-history records drop transient `changeType`.
- `change.newIds`/`newCount` now refer only to retained records; over-cap discoveries expose `discardedNewCount`.
- Every static task label starts with `data-print-state="未完成"` before JavaScript runs.

## GREEN evidence

- Focused RED commands above all passed after implementation.
- Related JavaScript integration group:
  - `node --test tests\official-scraper.test.cjs tests\update-service.test.cjs tests\server.test.cjs tests\app.test.cjs`
  - Result: **113 tests passed, 0 failed**.
- Windows lifecycle focus, run with normal CIM permission and random high ports:
  - `node --test --test-name-pattern "live seed|stale PID" tests\smoke.test.cjs`
  - Result: **2 tests passed, 0 failed**.
- `node --check` passed for `app.js`, `server.cjs`, all three `src/*.cjs` files, and every modified test file.
- No `hnu-guide-task4-*` temporary test directory remained after GREEN.

## Files changed

- `src/official-scraper.cjs`
- `src/update-service.cjs`
- `src/http-app.cjs`
- `scripts/launch.ps1`
- `scripts/stop.ps1`
- `index.html`
- `README.md`
- `tests/official-scraper.test.cjs`
- `tests/update-service.test.cjs`
- `tests/server.test.cjs`
- `tests/smoke.test.cjs`
- `tests/app.test.cjs`

## Residual risk / intentional trade-offs

- A genuine official redesign that completely replaces all trusted `li` containers with `div` containers is deliberately held as degraded after retry rather than silently accepted. This maximizes cache safety but requires a parser/rule review for a full structural redesign.
- The manual cooldown is process-local and resets after a service restart; Host/Origin checks remain in force across restarts.
- Only `127.0.0.1` is accepted for manual refresh. `localhost` aliases are intentionally not accepted, avoiding alias/port ambiguity.
- Larger deferred Minor items explicitly excluded from this wave (CSS visual polish, cross-login-session mutex nuance, orphan single-sided logs, alternate launcher copies) were not expanded.
