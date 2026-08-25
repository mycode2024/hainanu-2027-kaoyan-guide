# Multipage Information Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the current long single page into five focused pages while preserving live official updates, all content, global 21-item progress, current-stage guidance, strict static routing, accessibility, and offline serving.

**Architecture:** Keep the zero-dependency static frontend and Node.js service. `app.js` becomes page-independent by using shared milestone/checklist registries and guarded feature initialization; five HTML documents share one stylesheet/script and use explicit navigation. `src/http-app.cjs` remains a strict allowlist and adds only named routes.

**Tech Stack:** Node.js 18+, CommonJS, native `node:test`, static HTML/CSS/JavaScript, localStorage, native HTTP server.

**Spec:** `docs/superpowers/specs/2026-08-25-multipage-information-architecture-design.md`

## Global Constraints

- Do not introduce a frontend framework, build tool, database, or third-party runtime dependency.
- Do not change the official scraper, update service, refresh frequency, API behavior, or cache format.
- Preserve all 21 existing `data-check-id` values and the localStorage key `hainanu-2027-kaoyan-progress-v1`.
- Preserve all 14 milestone IDs and the distinction between confirmed, expected, and reference information.
- Production static serving must remain an explicit allowlist; never derive a file path from an arbitrary request pathname.
- Every page must have one `h1`, static `aria-current="page"`, root-relative shared asset URLs, a skip link, and the shared disclaimer footer.
- Navigation labels are exactly `首页`, `专业与备考`, `全年时间轴`, `报名材料`, `官方动态`.
- Homepage update preview shows at most 3 notices; the updates page shows the full normalized list.
- The current service on port 4173 remains untouched until the feature branch is verified and merged.

---

### Task 1: Page-independent shared state and progressive components

**Files:**
- Modify: `app.js`
- Modify: `tests/app.test.cjs`

**Interfaces:**
- Produces: `CHECKLIST_IDS` (internal immutable 21-ID registry).
- Produces: `mergeChecklistState(stored, pageValues)` returning a filtered global boolean object.
- Produces: `countChecklistProgress(state)` returning `{ completed, total, percent }` with `total === 21`.
- Produces: milestone entries containing `id`, `start`, `end`, `label`, and `action`.
- Produces: guarded mobile menu behavior for `[data-site-nav-toggle]` and `[data-site-nav-menu]`.
- Produces: update rendering that honors positive integer `data-update-limit` on `#official-updates-list`.
- Consumes: existing storage key, `calculateProgress`, update normalization, timeline filters, and DOM guards.

- [ ] **Step 1: Write failing unit tests for global checklist merge and counting**

Add tests with hand-derived expectations:

```js
test('merges current-page checks without deleting other registered page state', () => {
  const { mergeChecklistState } = loadApp();
  assert.deepEqual(
    mergeChecklistState(
      { 'program-academic': true, 'stage-baseline': true, unknown: true },
      { 'material-id': true, 'stage-baseline': false }
    ),
    { 'program-academic': true, 'stage-baseline': false, 'material-id': true }
  );
});

test('counts global checklist progress against all 21 registered tasks', () => {
  const { countChecklistProgress } = loadApp();
  assert.deepEqual(countChecklistProgress({
    'program-academic': true,
    'stage-baseline': true,
    'material-id': true
  }), { completed: 3, total: 21, percent: 14 });
});
```

The production mutation caught is replacing the saved object with only the current DOM subset or using the current page checkbox count as the denominator.

- [ ] **Step 2: Run the new focused tests and verify RED**

Run: `node --test --test-name-pattern="merges current-page|counts global" tests/app.test.cjs`

Expected: FAIL because `mergeChecklistState` and `countChecklistProgress` are not exported.

- [ ] **Step 3: Implement the registry, filtering, merging, and global rendering**

Add the exact 21 IDs from the spec. Make `safeReadChecks` optionally filter to those IDs or filter in the new helper. In `initPage`, retain a session state object, merge only current-page checkbox values before storage writes, and derive progress from the full registry. When storage throws, mutate the same in-memory state so progress remains usable. Update label `data-print-state` only for checkboxes present in the current document.

Update existing checkbox test fixtures from synthetic IDs such as `complete`, `pending`, and `session-only` to registered IDs, so the tests exercise the real allowlist contract.

For `[data-reset-scope="all"]`, confirm with `确定清空全部 21 项已勾选进度吗？此操作无法撤销。`, set all registered values false, update current-page controls, persist, and rerender. A button without that attribute retains current-page-only semantics.

- [ ] **Step 4: Run focused checklist tests and verify GREEN**

Run: `node --test --test-name-pattern="checklist|checkbox progress|printable|stored checklist|merges current-page|counts global" tests/app.test.cjs`

Expected: PASS.

- [ ] **Step 5: Write failing integration tests for a page without timeline/live DOM and for a 3-item preview**

Extend `installFakePage` with `includeLiveConsole`, `milestones`, stage elements, update list dataset, a reset button, configurable `confirm`, and a deterministic `today` option that temporarily replaces global `Date` and restores it during cleanup. Add:

```js
test('renders current stage from shared milestone data without timeline DOM', async () => {
  await withFakePage({ includeLiveConsole: false, today: '2026-08-25' }, async (page) => {
    assert.equal(page.fetchCalls.length, 0);
    assert.equal(page.elements.stageName.textContent, '锁定专业基线');
    assert.equal(page.elements.nextName.textContent, '招生章程与目录观察窗');
  });
});

test('limits the compact homepage feed without truncating the full payload', async () => {
  const snapshot = makeUpdatesPayload();
  snapshot.updates = [1, 2, 3, 4].map((n) => ({
    ...snapshot.updates[0], id: `notice-${n}`,
    url: `https://gs.hainanu.edu.cn/info/1024/900${n}.htm`
  }));
  await withFakePage({ updateLimit: '3' }, async (page) => {
    page.settle(page.fetchCalls[0], snapshot);
    await page.flush();
    assert.equal(page.elements.updatesList.children.length, 3);
  });
});
```

Expected RED causes: stage copy currently depends on timeline elements and all four updates render.

- [ ] **Step 6: Implement shared milestone copy and compact update limit**

Put `label` and `action` on each milestone entry. Resolve active and next display data from the registry, while still locating optional timeline DOM elements only for styling. Parse `updatesList.dataset.updateLimit` as a positive integer, slice only the rendered aggregated list, and leave unseen/update calculations unchanged.

- [ ] **Step 7: Write RED tests, then implement mobile menu keyboard behavior**

Add fake nav button/menu elements and event objects. Assert click changes `aria-expanded` from `false` to `true`, Escape returns it to `false`, and focus returns to the toggle. Run the focused test before implementation and observe the expected false/undefined mismatch. Then add an `initSiteNavigation()` function called by `initPage`; no elements means a no-op.

- [ ] **Step 8: Run the complete app test file and syntax check**

Run: `node --check app.js && node --test tests/app.test.cjs`

Expected: all app tests pass with no warnings.

- [ ] **Step 9: Commit Task 1**

```bash
git add app.js tests/app.test.cjs
git commit -m "feat: make shared UI state page independent"
```

---

### Task 2: Strict multi-page production routes

**Files:**
- Modify: `src/http-app.cjs`
- Modify: `tests/server.test.cjs`

**Interfaces:**
- Consumes: files `index.html`, `programs.html`, `timeline.html`, `application.html`, `updates.html` (created in Task 3; tests may create a temporary site root with marker files so this task remains independently testable).
- Produces: explicit mappings for `/programs(.html)`, `/timeline(.html)`, `/application(.html)`, and `/updates(.html)`.
- Preserves: existing API dispatch, security headers, method handling, traversal rejection, content types, and no-store behavior.

- [ ] **Step 1: Write a failing table-driven route test using a temporary site root**

Create five minimal marker HTML files in a test-owned temporary directory, start `createHttpServer` with that directory, and verify each pair:

```js
const pages = [
  ['/', 'index.html', 'page-home'],
  ['/programs', 'programs.html', 'page-programs'],
  ['/programs.html', 'programs.html', 'page-programs'],
  ['/timeline', 'timeline.html', 'page-timeline'],
  ['/timeline.html', 'timeline.html', 'page-timeline'],
  ['/application', 'application.html', 'page-application'],
  ['/application.html', 'application.html', 'page-application'],
  ['/updates', 'updates.html', 'page-updates'],
  ['/updates.html', 'updates.html', 'page-updates']
];
```

For every path assert GET 200, `text/html; charset=utf-8`, marker body, `cache-control: no-store`; assert HEAD 200 with an empty body. Also assert POST `/timeline` returns 405 with `Allow: GET, HEAD`.

- [ ] **Step 2: Run the focused server test and verify RED**

Run: `node --test --test-name-pattern="named guide page" tests/server.test.cjs`

Expected: FAIL with 404 for the first new route.

- [ ] **Step 3: Add only the named routes to `PUBLIC_FILES`**

Extend the existing map with the eight exact route aliases. Do not change path construction or introduce fallback serving.

- [ ] **Step 4: Verify GREEN and security regression coverage**

Run: `node --check src/http-app.cjs && node --test tests/server.test.cjs`

Expected: all server tests pass, including `/server.cjs` 404 and encoded traversal 403.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/http-app.cjs tests/server.test.cjs
git commit -m "feat: serve named guide pages safely"
```

---

### Task 3: Five-page content, shared navigation, responsive styling, and offline coverage

**Files:**
- Modify: `index.html`
- Create: `programs.html`
- Create: `timeline.html`
- Create: `application.html`
- Create: `updates.html`
- Modify: `styles.css`
- Modify: `tests/app.test.cjs`
- Modify: `tests/smoke.test.cjs`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1 shared state, milestone copy, compact update limit, mobile navigation hooks.
- Consumes: Task 2 named route mappings.
- Produces: five complete HTML documents with shared root-relative `/styles.css` and `/app.js`.
- Produces: exactly one occurrence of each of the 21 task IDs across the four task-bearing pages.
- Produces: static page markers `data-page="home|programs|timeline|application|updates"`.

- [ ] **Step 1: Write failing served-page smoke tests**

Expand the offline cases to fetch all files and assert user-visible identity:

```js
const pages = [
  ['/', '首页', 'data-page="home"'],
  ['/programs.html', '专业与备考', 'data-page="programs"'],
  ['/timeline.html', '全年时间轴', 'data-page="timeline"'],
  ['/application.html', '报名材料', 'data-page="application"'],
  ['/updates.html', '官方动态', 'data-page="updates"']
];
```

For each response assert 200, HTML content type, page marker, exactly one `<h1`, root-relative stylesheet/script references, and the matching static `aria-current="page"` navigation link. Add a combined assertion that the served HTML contains 21 unique `data-check-id` values and that the values equal the registry listed in the spec.

Update the printable-label test to read all five HTML files and assert all 21 task labels begin with `data-print-state="未完成"`.

- [ ] **Step 2: Run the focused smoke/static tests and verify RED**

Run: `node --test --test-name-pattern="offline site|printable task|five guide pages" tests/smoke.test.cjs tests/app.test.cjs`

Expected: FAIL because four files do not exist and the homepage still contains the entire single-page content.

- [ ] **Step 3: Build the shared document shell on every page**

Use the exact global navigation order and labels from Global Constraints. Each page gets a skip link, brand link to `/`, mobile toggle with `data-site-nav-toggle`, menu with `data-site-nav-menu`, one static current-page link, print action, unique title/description/h1, and shared footer disclaimer. All internal links and assets are root-relative.

- [ ] **Step 4: Move content according to the spec without rewriting facts**

- `index.html`: concise hero, status panel, truth banner, five destination cards, compact live console with `data-update-limit="3"`, and links to the detailed pages. Remove the full long-form sections.
- `programs.html`: move the complete original `programs`, `exam`, and `risks` sections and the 3 program checkboxes.
- `timeline.html`: move the complete original `timeline` section, filters, 14 milestones, and 10 stage checkboxes.
- `application.html`: move the complete original `apply-guide` and `materials` sections and 8 material checkboxes.
- `updates.html`: move the complete original `updates` and `sources` sections, without a display limit.

Do not duplicate a task checkbox on the homepage. Keep every baseline/expected/reference disclaimer adjacent to the content it qualifies.

- [ ] **Step 5: Add responsive global navigation and page layouts**

Reuse existing design tokens. Add `.site-nav`, `.site-nav-toggle`, `.site-nav-menu`, `.site-nav-link[aria-current="page"]`, `.page-hero`, `.page-map`, `.page-map-card`, `.compact-updates`, `.page-toc`, and `.page-progress` rules. Desktop shows the menu inline. At `max-width: 900px`, the toggle appears and the closed menu is hidden; an open menu is a full-width single column. All interactive targets are at least 44px. At 320px, cards and long strings wrap without horizontal overflow.

Update print rules to hide global navigation/menu controls and interactive buttons, keep task state text, and avoid three-column print layouts where content has only two cards.

- [ ] **Step 6: Update README launch and page map documentation**

Document the five local URLs, state that official updates are live only while the Node service runs, explain the shared 21-item local progress, and keep both `start-guide.cmd` and `npm start` launch paths.

- [ ] **Step 7: Verify the focused static and server suites**

Run: `node --test tests/app.test.cjs tests/server.test.cjs tests/smoke.test.cjs`

Expected: all focused tests pass.

- [ ] **Step 8: Run syntax and full automated verification**

Run: `npm.cmd run check`

Expected: Node syntax checks pass and all tests pass with 0 failures.

- [ ] **Step 9: Browser acceptance at desktop and mobile widths**

Start the worktree service on a non-production port. Visit all five pages at 1440×900 and 390×844, then spot-check 320px. Verify direct refresh, no console errors, correct current-page navigation, menu click/Escape/focus, timeline filters, live preview limit, full updates list, print buttons, no horizontal overflow, and cross-page progress persistence (`program + timeline + material` produces `3 / 21`).

- [ ] **Step 10: Commit Task 3**

```bash
git add index.html programs.html timeline.html application.html updates.html styles.css tests/app.test.cjs tests/smoke.test.cjs README.md
git commit -m "feat: split the guide into focused pages"
```

---

## Final verification and review

- [ ] Run `npm.cmd run check` with the permissions required by Windows lifecycle tests.
- [ ] Start the branch service on a temporary port and request `/api/health`, all canonical pages, all extensionless aliases, and one forbidden internal path.
- [ ] Complete browser acceptance with no console errors and save desktop/mobile screenshots to `artifacts/`.
- [ ] Request an independent whole-branch code review against the spec; fix all Critical and Important findings and re-review the fix range.
- [ ] Merge the verified branch into `main`, rerun verification on `main`, replace the old 4173 service, and verify health plus all five pages.
