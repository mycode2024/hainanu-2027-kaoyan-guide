# Official Updates Backend Implementation Plan

> **Execution choice:** The user explicitly requested autonomous completion in this session, so implement the plan inline without pausing for approval checkpoints.

**Goal:** Upgrade the existing Hainan University 2027 exam guide from static files to a zero-dependency Node.js app that automatically monitors official notices and remains useful during network failure.

**Architecture:** Separate pure HTML parsing, refresh/cache orchestration, and HTTP routing into CommonJS modules. Inject network and storage boundaries in tests. Keep the existing frontend as a progressive enhancement consumer of `/api/updates`.

**Tech Stack:** Node.js 18+ built-ins (`http`, `fs`, `path`, `crypto`), browser JavaScript, HTML/CSS, `node:test`.

---

### Task 1: Specify and test official-list parsing

**Files:**
- Create: `tests/official-scraper.test.cjs`
- Create: `src/official-scraper.cjs`

1. Add hand-written fixtures for both official list structures.
2. Assert title cleanup, entity decoding, absolute URL resolution, date extraction, relevance filtering, categorization, deduplication and ordering.
3. Run the new test and observe the missing-module failure.
4. Implement the smallest pure parser that satisfies the contract.
5. Run the parser test again.

### Task 2: Specify and test refresh/cache behavior

**Files:**
- Create: `tests/update-service.test.cjs`
- Create: `src/update-service.cjs`

1. Test successful multi-source refresh and persisted snapshot.
2. Test partial source failure.
3. Test all-source failure with stale-cache preservation.
4. Test concurrent refresh coalescing.
5. Run the tests and observe failure before implementation.
6. Implement injected fetch/storage/clock boundaries, timeout handling and refresh scheduling data.

### Task 3: Specify and test HTTP behavior

**Files:**
- Create: `tests/server.test.cjs`
- Create: `src/http-app.cjs`
- Create: `server.cjs`
- Modify: `scripts/serve.cjs`

1. Test static assets, `GET /api/updates`, `POST /api/refresh`, unsupported methods and directory traversal behavior against a real ephemeral HTTP server.
2. Run and observe failure.
3. Implement the shared HTTP server and production entry point.
4. Preserve the existing static-server export for prior smoke tests.

### Task 4: Add the live frontend panel

**Files:**
- Modify: `index.html`
- Modify: `styles.css`
- Modify: `app.js`
- Modify: `tests/app.test.cjs`

1. Add tests for payload normalization and official-link validation; observe failure.
2. Add an “官方动态” section, navigation entry, accessible live status and manual refresh control.
3. Fetch and render updates safely using DOM APIs; keep a clear `file://` fallback.
4. Add responsive and print styles without changing the existing visual language.

### Task 5: Package, document and verify

**Files:**
- Create: `package.json`
- Create: `start-guide.cmd`
- Create: `README.md`
- Modify: `.gitignore`

1. Add `start`, `test` and `check` scripts without external dependencies.
2. Document double-click and terminal startup, refresh frequency, cache behavior and limitations.
3. Run the complete test suite.
4. Start the real server on an ephemeral or free local port, exercise the live API and homepage, and confirm cache output.
5. Stop the verification server and report the finished local product.
