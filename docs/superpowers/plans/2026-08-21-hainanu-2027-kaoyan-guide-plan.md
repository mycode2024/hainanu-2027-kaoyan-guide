# 海南大学 2027 计算机 408 考研导航 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个可离线打开、能跟踪进度并清楚区分官方事实与预计时间的海南大学 2027 计算机 408 考研导航网页。

**Architecture:** 使用零依赖静态 HTML/CSS/JavaScript，内容直接内置，功能逻辑通过可测试的纯函数驱动。`app.js` 在浏览器中初始化交互，在 Node 中导出纯函数；本地静态服务器仅用于验收，不参与成品运行。

**Tech Stack:** HTML5、CSS3、原生 JavaScript、Node.js 内置 `node:test` 与 `http`

**Spec:** `docs/superpowers/specs/2026-08-21-hainanu-2027-kaoyan-guide-design.md`

## Global Constraints

- 页面必须离线可用，无 npm 依赖、远程字体、远程图片或第三方脚本。
- 2027 未官宣日期和招生名额必须显示“预计”或“待确认”。
- 官方事实只引用教育部、研招网、海南大学研究生院与海南大学计算机学院官方页面。
- 不收集或上传个人数据，进度仅保存在浏览器 `localStorage`。
- 默认交付目录为 `D:\DefaultQuickAccessFiles\Desktop\hainanu-2027-kaoyan-guide`。

---

### Task 1: 可测试的时间与进度逻辑

**Files:**
- Create: `tests/app.test.cjs`
- Create: `app.js`

**Interfaces:**
- Consumes: 里程碑数组 `{ id, start, end, label, certainty }[]` 与 `YYYY-MM-DD` 日期字符串。
- Produces: `getTimelineState(milestones, today)`、`calculateProgress(checked, total)`、`filterTimeline(items, category)`、`safeReadChecks(storage, key)`。

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');

function loadApp() {
  try { return require('../app.js'); } catch { return {}; }
}

test('selects the active milestone and the next future milestone', () => {
  const { getTimelineState } = loadApp();
  assert.equal(typeof getTimelineState, 'function');
  const items = [
    { id: 'a', start: '2026-08-01', end: '2026-08-31' },
    { id: 'b', start: '2026-09-15', end: '2026-09-30' }
  ];
  assert.deepEqual(getTimelineState(items, '2026-08-21'), {
    activeId: 'a', nextId: 'b', daysToNext: 25
  });
});

test('returns a bounded integer progress percentage', () => {
  const { calculateProgress } = loadApp();
  assert.equal(calculateProgress(3, 8), 38);
  assert.equal(calculateProgress(0, 0), 0);
  assert.equal(calculateProgress(12, 8), 100);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/app.test.cjs`
Expected: FAIL because the exported functions do not exist.

- [ ] **Step 3: Write minimal implementation**

```js
function toUtcDay(value) {
  return Date.parse(`${value}T00:00:00Z`);
}

function getTimelineState(items, today) {
  const now = toUtcDay(today);
  const active = items.find(item => now >= toUtcDay(item.start) && now <= toUtcDay(item.end));
  const next = items.find(item => toUtcDay(item.start) > now);
  return {
    activeId: active?.id ?? null,
    nextId: next?.id ?? null,
    daysToNext: next ? Math.ceil((toUtcDay(next.start) - now) / 86400000) : null
  };
}

function calculateProgress(checked, total) {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((checked / total) * 100)));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/app.test.cjs`
Expected: PASS with zero failures.

### Task 2: 语义内容与视觉系统

**Files:**
- Create: `index.html`
- Create: `styles.css`

**Interfaces:**
- Consumes: 设计文档中的事实基线、时间轴节点与官方 URL。
- Produces: 具有 `header`、`nav`、`main`、`section`、`footer` 语义结构的响应式离线网页。

- [ ] **Step 1: Build the semantic document**

创建首屏、专业对比、时间轴、报名操作台、材料清单、初复试、风险雷达和来源八个区块。所有 2027 未官宣日期使用可见的“预计”标签，2026 基线使用“参考”标签。

- [ ] **Step 2: Build the visual system**

在 `styles.css` 中定义海岛色彩变量、排版、卡片、时间轴、响应式断点（900px 与 600px）、键盘焦点、打印样式和减少动效规则。

- [ ] **Step 3: Verify offline asset boundaries**

Run: `rg -n "https?://" index.html styles.css app.js`
Expected: 仅 `index.html` 的官方来源 `<a href>` 出现 URL；CSS 与 JavaScript 不包含远程依赖。

### Task 3: 页面交互与成品验收

**Files:**
- Modify: `app.js`
- Create: `scripts/serve.cjs`
- Create: `tests/smoke.test.cjs`

**Interfaces:**
- Consumes: `data-category`、`data-check-id`、`data-milestone-id` 属性和浏览器 DOM API。
- Produces: 当前阶段显示、时间轴筛选、勾选进度保存、重置确认、打印按钮；本地服务器导出 `createServer(root)`。

- [ ] **Step 1: Extend failing behavior tests**

```js
test('filters timeline items without mutating their order', () => {
  const { filterTimeline } = loadApp();
  const items = [{ id: 'a', category: 'apply' }, { id: 'b', category: 'exam' }];
  assert.deepEqual(filterTimeline(items, 'apply').map(x => x.id), ['a']);
  assert.deepEqual(filterTimeline(items, 'all').map(x => x.id), ['a', 'b']);
});

test('invalid stored checklist data falls back to an empty object', () => {
  const { safeReadChecks } = loadApp();
  const storage = { getItem: () => '{bad-json' };
  assert.deepEqual(safeReadChecks(storage, 'progress'), {});
});
```

- [ ] **Step 2: Run tests and confirm the new failures**

Run: `node --test tests/app.test.cjs`
Expected: FAIL because `filterTimeline` and `safeReadChecks` are not implemented.

- [ ] **Step 3: Implement browser behavior and pure helpers**

实现筛选与安全读取函数，然后在 `DOMContentLoaded` 时挂载事件；访问 `localStorage` 的读写必须包在 `try/catch` 中。Node 环境通过 `module.exports` 导出纯函数，且不执行 DOM 初始化。

- [ ] **Step 4: Add and run HTTP smoke test**

`tests/smoke.test.cjs` 启动 `createServer()` 到随机端口，使用 `fetch()` 访问 `/`、`/styles.css`、`/app.js`，断言三个响应均为 200 且 MIME 类型正确。第一次运行在 `scripts/serve.cjs` 不存在时失败，创建服务器后再次运行通过。

Run: `node --test tests/*.test.cjs`
Expected: all tests PASS.

- [ ] **Step 5: Run final checks**

Run: `node --check app.js && node --check scripts/serve.cjs && node --test tests/*.test.cjs`
Expected: exit code 0, zero syntax errors, zero test failures.

- [ ] **Step 6: Render desktop and mobile screenshots**

使用本机可用的无头浏览器访问本地服务器，分别以 1440×1000 与 390×844 截图。检查无横向溢出、无内容遮挡、焦点与状态标签清楚，并在发现问题时按测试优先流程修复。
