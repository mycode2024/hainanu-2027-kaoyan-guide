# Task 1 report — parser recall, identity, and dates

## Changed files

- `src/official-scraper.cjs`
  - Recognizes the HNU `研考考生` notice and the CHSI retired-student-soldier masters policy title while retaining doctoral/training exclusions.
  - Separates stable source-and-normalized-URL identity (`id`) from a title/category/date `contentHash`.
  - Normalizes resolved notice URLs by dropping fragments.
  - Uses the `Asia/Shanghai` calendar to infer short dates and rejects invalid calendar dates.
  - Adds `parseOfficialDocument(html, source, checkedAt)` with diagnostics, while preserving `parseOfficialList` as its updates-only wrapper.
  - Parses announcement-scoped `li` and `div` containers so dates are never borrowed from another container.
- `tests/official-scraper.test.cjs`
  - Adds regressions for every task behavior, including mixed list/non-list markup.
- `.superpowers/sdd/2026-08-24-reliability-hardening/task-1-report.md`
  - This report; permitted by the task's report contract.

## TDD evidence

All targeted commands were run from the project root with `cmd.exe /d /c node --test tests\\official-scraper.test.cjs`.

| Cycle | RED failure observed | GREEN result |
| --- | --- | --- |
| Real HNU and CHSI titles | HNU title produced `[]` instead of the expected notice. | 7/7 parser tests passed after widening the relevant-title rules. |
| Stable identity and content hash | Resolved URL retained `#top`, so normalized URL assertion failed. | 8/8 parser tests passed after source+URL ID, fragment normalization, and `contentHash`. |
| Shanghai short date and invalid dates | `[01-01]` became `2025-01-01`; `2026-02-30` and `[02-30]` were accepted. | 9/9 parser tests passed after Shanghai date parts and calendar validation. |
| Document diagnostics API | `parseOfficialDocument` was `undefined`. | 10/10 parser tests passed after adding the document result and wrapper. |
| Non-list announcement | A dated `div` announcement produced no update. | 11/11 parser tests passed after container-scoped `div` support. |
| Mixed list/non-list page | Unrelated `li` markup hid the valid `div` announcement, producing `[]`. | 12/12 parser tests passed after collecting both container types. |

## Final verification

- Final targeted command `node --test tests\\official-scraper.test.cjs` exited 0: 12 tests passed, 0 failed.
- `npm.cmd run check` ran its syntax checks and showed 33 passing tests (including parser regressions 16–27), but the combined test process produced no further output or exit after 90 seconds of polling. It was deliberately left running rather than terminated.

## Design decisions

- `id` hashes `source.id` (with safe fallbacks) and the normalized official URL. It stays stable when a publisher changes notice text, category, or date.
- `contentHash` hashes exactly title, category, and date, so content changes can be detected independently from identity.
- URL fragments are removed because they identify an in-page location rather than a distinct official notice.
- Short dates derive their year/month from `Intl.DateTimeFormat` with `Asia/Shanghai`, then undergo real calendar validation (including leap years).
- Diagnostics distinguish structurally viable announcement candidates (one visible anchor plus a valid visible date) from final updates: `candidateCount` counts those candidate records, while `relevantCount` counts only safe-URL, relevant, stable-ID-unique updates. `containerTypes` lists only types that produced a candidate. A date must occur in the same extracted container as its anchor.

## Self-review and concerns

- Confirmed every new production behavior had a regression test that was observed failing before its implementation.
- Existing list fixtures and URL safety coverage remain green in the targeted suite and in the observed portion of the combined run.
- No third-party runtime dependency or service lifecycle action was introduced.
- Concern: extraction now uses a token scanner to mask nested and unterminated non-visible regions before balanced `li`/`div` scanning; severely malformed real HTML or additional card tags may warrant fixture-driven expansion if encountered in production.
- Concern: the full project check did not reach an observable exit during final polling, despite 33 visible passes; only the assigned parser suite has a confirmed zero exit code.

## Fix round 1 — filter, card boundaries, diagnostics, and dates

### Root causes

- Normal-source relevance returned `actionable && (graduateContext || !explicitlyOtherLevel)` immediately after returning for `explicitlyOtherLevel`; the second operand was therefore always true.
- National-policy matching had no pre-positive exclusion for masters training/pedagogy policies.
- The non-greedy `div` matcher stopped at the first nested closing tag, and the parser selected only the first anchor/date anywhere in a container.
- Date matching scanned raw HTML, including `href` and `title` attribute values, and returned immediately when the first matched date was invalid.

### TDD evidence

All commands below were run from the project root with `cmd.exe /d /c node --test tests\\official-scraper.test.cjs`.

| Cycle | RED failure observed | GREEN result |
| --- | --- | --- |
| Normal-source context | A generic campus source returned both `海南大学海甸校区考点交通管理通知` and a short `复试名单公示`, rather than `[]`. | 13/13 passed after requiring graduate context, except for known short actions from `graduate-admissions-list`. |
| National training policy | `关于做好2026年硕士研究生招生培养工作的通知` was included beside the intended soldier-plan policy. | 14/14 passed after a cultivation-policy exclusion before the national positive match. |
| Nested cards and multi-link containers | The nested `div.card` notice was missed and the first link in a two-link `li` was incorrectly paired with its date. | 15/15 passed after balanced `li`/`div` scanning, single-anchor card selection, deepest-card selection, and stable-ID deduplication. |
| Visible dates | The valid card was skipped because the first raw `href` date was invalid, while another card was emitted solely from a URL/title-attribute date. | 16/16 passed after sequential validation of dates from visible text only. |
| Non-visible dates | A script-local `2026-01-01` was selected before the card's visible `2026-10-05` date. | 18/18 passed after excluding comment, script, style, and template content from visible-date extraction. |

The diagnostics edge coverage verified candidate records separately from safe, relevant, stable-ID-unique updates (17/17), and remains green in the final 18-test suite.

### Fix-round final verification

- `node --check src\\official-scraper.cjs` exited 0.
- `node --test tests\\official-scraper.test.cjs` exited 0: 18 tests passed, 0 failed.

## Fix round 2 — hidden markup isolation

### Root cause

The balanced `li`/`div` scanner and anchor matcher still read raw HTML. Although visible-date extraction excluded non-visible regions, literal tags within comments, `script`, `style`, and `template` regions could form synthetic cards. An unclosed pseudo `div` inside a script could also consume the closing tag of a surrounding real card.

### TDD evidence

The targeted command was `cmd.exe /d /c node --test tests\\official-scraper.test.cjs`.

| Cycle | RED failure observed | GREEN result |
| --- | --- | --- |
| Complete hidden pseudo notices | Fake notices from hidden markup (`9120`, `9121`) were emitted before the lone real `9122` notice. | 20/20 passed after equal-length masking of comments, script, style, and template regions for scanning, anchor extraction, and visible text. |
| Unclosed hidden pseudo tag | An unclosed script-local `div` left the real `9131` card unparsed, yielding `[]`. | 20/20 passed; the mask preserves source offsets so the real card's balanced boundary and diagnostics remain intact. |

### Fix-round final verification

- `node --test tests\\official-scraper.test.cjs` passed 20 tests, 0 failures after the implementation.

## Fix round 3 — nested and unterminated hidden regions

### Root cause

The equal-length masker was still a non-greedy whole-region regex. It stopped an outer `template` at its first nested closing tag and matched no region at all when a comment, script, style, or template lacked its closing marker. The remaining literal markup then reached candidate scanning and diagnostics.

### TDD evidence

The targeted command was `cmd.exe /d /c node --test tests\\official-scraper.test.cjs`.

| Cycle | RED failure observed | GREEN result |
| --- | --- | --- |
| Nested template | A valid-looking `9140` card inside a case-varied, attributed nested template escaped masking and was emitted. | 22/22 passed after a linear tag scanner counted nested `template` depth, respecting quoted attributes and case. |
| Unterminated hidden regions | An unclosed comment exposed fake notice `9141`; the same end-to-end table covered unclosed comment, script, style, and template cases. | 22/22 passed after comments mask through `-->` or EOF and script/style/template regions mask through a matching close or EOF. |

### Design and final verification

- The scanner preserves exact string length and leaves CR/LF intact while replacing other hidden-region characters with spaces, so balanced-card offsets continue to address the original document.
- `node --check src\\official-scraper.cjs` exited 0.
- `node --test tests\\official-scraper.test.cjs` passed 22 tests, 0 failures after the implementation.
