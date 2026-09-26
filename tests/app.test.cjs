const test = require('node:test');
const assert = require('node:assert/strict');

function loadApp() {
  try {
    delete require.cache[require.resolve('../app.js')];
    return require('../app.js');
  } catch {
    return {};
  }
}

function createFakeElement(options = {}) {
  const listeners = new Map();
  const element = {
    attributes: {},
    children: [],
    className: options.className || '',
    checked: options.checked === true,
    dataset: { ...(options.dataset || {}) },
    disabled: false,
    hidden: options.hidden === true,
    id: options.id || '',
    focusCalls: 0,
    parentElement: options.parentElement || null,
    replaceChildrenCalls: 0,
    style: {},
    textContent: options.textContent || '',
    title: '',
    classList: {
      contains(className) {
        return element.className.split(/\s+/).filter(Boolean).includes(className);
      },
      toggle(className, force) {
        const classes = new Set(element.className.split(/\s+/).filter(Boolean));
        const enabled = force === undefined ? !classes.has(className) : Boolean(force);
        if (enabled) classes.add(className);
        else classes.delete(className);
        element.className = [...classes].join(' ');
        return enabled;
      }
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    append(...children) {
      this.children.push(...children);
    },
    closest(selector) {
      return selector === 'label' ? this.label || null : null;
    },
    dispatch(type, event = {}) {
      (listeners.get(type) || []).forEach((listener) => listener({ target: this, type, ...event }));
    },
    focus() {
      this.focusCalls += 1;
    },
    getAttribute(name) {
      return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    replaceChildren(...children) {
      this.replaceChildrenCalls += 1;
      this.children = children;
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }
  };
  return element;
}

function makeUpdatesPayload() {
  return {
    schemaVersion: 2,
    status: 'fresh',
    fetchedAt: '2026-08-24T04:00:00.000Z',
    lastSuccessAt: '2026-08-24T04:00:00.000Z',
    freshness: { state: 'fresh', ageMs: 0, isOverdue: false },
    change: { newCount: 0, newIds: [], changedAt: '2026-08-24T04:00:00.000Z' },
    sources: [{
      id: 'hnu-graduate',
      name: '海南大学研究生院',
      url: 'https://gs.hainanu.edu.cn/yjszs/ssszs.htm',
      ok: true,
      checkedAt: '2026-08-24T04:00:00.000Z',
      lastSuccessAt: '2026-08-24T04:00:00.000Z',
      attempts: 1
    }],
    updates: [{
      id: 'notice-1',
      title: '海南大学 2027 年硕士研究生招生专业目录',
      date: '2026-09-25',
      url: 'https://gs.hainanu.edu.cn/info/1024/9000.htm',
      source: '海南大学研究生院',
      sourceId: 'hnu-graduate',
      category: '简章目录',
      discoveredAt: '2026-08-24T04:00:00.000Z'
    }]
  };
}

function findElementsByClass(element, className) {
  const matches = element.className === className ? [element] : [];
  return element.children.reduce((all, child) => (
    child && Array.isArray(child.children)
      ? all.concat(findElementsByClass(child, className))
      : all
  ), matches);
}

function collectText(element) {
  return [element.textContent || ''].concat(
    element.children.flatMap((child) => child && Array.isArray(child.children) ? collectText(child) : [child?.textContent || ''])
  ).join(' ');
}

function installFakePage(options = {}) {
  const originalDate = global.Date;
  const originalIntersectionObserver = global.IntersectionObserver;
  const originalWindow = global.window;
  const originalDocument = global.document;
  const hadIntersectionObserver = Object.hasOwn(global, 'IntersectionObserver');
  const hadWindow = Object.hasOwn(global, 'window');
  const hadDocument = Object.hasOwn(global, 'document');
  const timers = [];
  const fetchCalls = [];
  const intersectionObservers = [];
  const documentListeners = new Map();
  let timerId = 0;

  const elements = {
    acknowledge: createFakeElement(),
    console: createFakeElement(),
    freshness: createFakeElement(),
    lastSuccess: createFakeElement(),
    newCount: createFakeElement(),
    nextRefresh: createFakeElement(),
    progressCount: createFakeElement(),
    progressText: createFakeElement(),
    refresh: createFakeElement(),
    reset: createFakeElement({ dataset: options.resetScope ? { resetScope: options.resetScope } : {} }),
    sourceHealth: createFakeElement(),
    sourceCount: createFakeElement(),
    statusDetail: createFakeElement(),
    statusTitle: createFakeElement(),
    storageWarning: createFakeElement({ hidden: true }),
    updateAll: createFakeElement({ dataset: { updatesFilter: 'all' } }),
    updateNew: createFakeElement({ dataset: { updatesFilter: 'new' } }),
    yearFilter: createFakeElement(),
    categoryFilter: createFakeElement(),
    updatesList: createFakeElement({ dataset: { updateLimit: options.updateLimit, updatePageSize: options.pageSize } }),
    previous: createFakeElement(),
    next: createFakeElement(),
    pageStatus: createFakeElement(),
    stageDetail: createFakeElement(),
    stageName: createFakeElement(),
    nextDays: createFakeElement(),
    nextName: createFakeElement(),
    navMenu: createFakeElement(),
    navToggle: createFakeElement()
  };
  elements.navToggle.setAttribute('aria-expanded', 'false');
  const checkboxes = options.checkboxes || [];
  const selectorMap = new Map([
    ['#acknowledge-official-updates', elements.acknowledge],
    ['#live-updates-console', elements.console],
    ['#live-freshness', elements.freshness],
    ['#live-last-success', elements.lastSuccess],
    ['#live-new-count', elements.newCount],
    ['#live-next-refresh', elements.nextRefresh],
    ['#live-source-count', elements.sourceCount],
    ['#live-status-detail', elements.statusDetail],
    ['#live-status-title', elements.statusTitle],
    ['#progress-count', elements.progressCount],
    ['#progress-text', elements.progressText],
    ['#refresh-official-updates', elements.refresh],
    ['#live-source-health', elements.sourceHealth],
    ['#official-updates-list', elements.updatesList],
    ['#updates-previous', elements.previous],
    ['#updates-next', elements.next],
    ['#updates-page-status', elements.pageStatus],
    ['#updates-year', elements.yearFilter],
    ['#updates-category', elements.categoryFilter],
    ['#current-stage-detail', elements.stageDetail],
    ['#current-stage-name', elements.stageName],
    ['#next-stage-days', elements.nextDays],
    ['#next-stage-name', elements.nextName],
    ['#reset-progress', elements.reset],
    ['#storage-session-warning', elements.storageWarning]
  ]);
  if (options.includeLiveConsole === false) {
    selectorMap.delete('#live-updates-console');
    selectorMap.delete('#refresh-official-updates');
  }
  if (options.includeNav) {
    selectorMap.set('[data-site-nav-menu]', elements.navMenu);
    selectorMap.set('[data-site-nav-toggle]', elements.navToggle);
  }
  const selectorGroups = new Map([
    ['[data-milestone-id]', options.milestones || []],
    ['.task-check[data-check-id]', checkboxes],
    ['[data-skip-check]', options.skipButtons || []],
    ['[data-filter]', []],
    ['[data-print]', []],
    ['.section-nav a', options.sectionNavLinks || []],
    ['.section-nav a[href^="#"], .page-toc a[href^="#"]', [
      ...(options.sectionNavLinks || []),
      ...(options.pageTocLinks || [])
    ]],
    ['main section[id]', options.sections || []],
    ['[data-updates-filter]', [elements.updateAll, elements.updateNew]],
    ['.verified-date', options.verifiedDates || []],
    ['.site-footer p', options.footerParagraphs || []]
  ]);
  const storage = options.storage || {
    values: new Map(),
    getItem(key) { return this.values.get(key) || null; },
    setItem(key, value) { this.values.set(key, value); }
  };
  const fakeDocument = {
    body: { dataset: { hosting: options.hosting } },
    readyState: 'complete',
    visibilityState: 'visible',
    addEventListener(type, listener) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(listener);
    },
    createElement() { return createFakeElement(); },
    createTextNode(textContent) { return { textContent: String(textContent) }; },
    dispatch(type, event = {}) {
      (documentListeners.get(type) || []).forEach((listener) => listener({ type, ...event }));
    },
    querySelector(selector) { return selectorMap.get(selector) || null; },
    querySelectorAll(selector) { return selectorGroups.get(selector) || []; }
  };
  const fakeWindow = {
    confirm(message) {
      return typeof options.confirm === 'function' ? options.confirm(message) : options.confirm !== false;
    },
    fetch(url, request) {
      let resolve;
      let reject;
      const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      const call = { aborted: false, promise, reject, request, resolve, url };
      request.signal.addEventListener('abort', () => {
        call.aborted = true;
        if (options.autoRejectAbort !== false) reject(new Error('aborted'));
      }, { once: true });
      fetchCalls.push(call);
      return promise;
    },
    localStorage: storage,
    location: { protocol: 'http:' },
    clearTimeout(timer) { timer.cancelled = true; },
    setTimeout(callback, delay) {
      const timer = { callback, cancelled: false, delay, id: ++timerId };
      timers.push(timer);
      return timer;
    }
  };

  if (options.includeIntersectionObserver) {
    class FakeIntersectionObserver {
      constructor(callback, observerOptions) {
        this.callback = callback;
        this.observerOptions = observerOptions;
        this.observed = [];
        intersectionObservers.push(this);
      }
      observe(target) { this.observed.push(target); }
      trigger(entries) { this.callback(entries, this); }
    }
    fakeWindow.IntersectionObserver = FakeIntersectionObserver;
    global.IntersectionObserver = FakeIntersectionObserver;
  }

  global.document = fakeDocument;
  global.window = fakeWindow;
  if (options.today) {
    const fixedTime = new originalDate(`${options.today}T12:00:00`).valueOf();
    global.Date = class FakeDate extends originalDate {
      constructor(...args) { super(...(args.length ? args : [fixedTime])); }
      static now() { return fixedTime; }
    };
  }
  delete require.cache[require.resolve('../app.js')];
  require('../app.js');

  return {
    checkboxes,
    document: fakeDocument,
    elements,
    fetchCalls,
    intersectionObservers,
    settle(call, payload = makeUpdatesPayload()) {
      call.resolve({ ok: true, json: async () => payload });
    },
    async flush() {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    runTimers(delay) {
      timers.filter((timer) => !timer.cancelled && timer.delay === delay).forEach((timer) => {
        timer.cancelled = true;
        timer.callback();
      });
    },
    async restore() {
      fetchCalls.forEach((call) => call.reject(new Error('test cleanup')));
      await this.flush();
      delete require.cache[require.resolve('../app.js')];
      global.Date = originalDate;
      if (hadIntersectionObserver) global.IntersectionObserver = originalIntersectionObserver;
      else delete global.IntersectionObserver;
      if (hadWindow) global.window = originalWindow;
      else delete global.window;
      if (hadDocument) global.document = originalDocument;
      else delete global.document;
    }
  };
}

async function withFakePage(options, assertion) {
  const page = installFakePage(options);
  try {
    await assertion(page);
  } finally {
    await page.restore();
  }
}

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

test('opens the mobile site navigation and closes it on Escape', async () => {
  await withFakePage({ includeNav: true }, async (page) => {
    page.elements.navToggle.dispatch('click');
    assert.equal(page.elements.navToggle.getAttribute('aria-expanded'), 'true');

    page.document.dispatch('keydown', { key: 'Escape' });
    assert.equal(page.elements.navToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(page.elements.navToggle.focusCalls, 1);
  });
});

test('marks the intersecting page-toc hash link as the current location and clears the prior link', async () => {
  const firstLink = createFakeElement();
  firstLink.setAttribute('href', '#programs');
  const secondLink = createFakeElement();
  secondLink.setAttribute('href', '#exam');
  const firstSection = createFakeElement({ id: 'programs' });
  const secondSection = createFakeElement({ id: 'exam' });

  await withFakePage({
    includeIntersectionObserver: true,
    includeLiveConsole: false,
    pageTocLinks: [firstLink, secondLink],
    sections: [firstSection, secondSection]
  }, async (page) => {
    assert.equal(page.intersectionObservers.length, 1);
    const [observer] = page.intersectionObservers;
    assert.deepEqual(observer.observed, [firstSection, secondSection]);

    observer.trigger([{ target: firstSection, isIntersecting: true }]);
    assert.equal(firstLink.classList.contains('is-active'), true);
    assert.equal(firstLink.getAttribute('aria-current'), 'location');
    assert.equal(secondLink.getAttribute('aria-current'), null);

    observer.trigger([{ target: secondSection, isIntersecting: true }]);
    assert.equal(firstLink.classList.contains('is-active'), false);
    assert.equal(firstLink.getAttribute('aria-current'), null);
    assert.equal(secondLink.classList.contains('is-active'), true);
    assert.equal(secondLink.getAttribute('aria-current'), 'location');
  });
});

test('resets all registered checklist state only when the reset scope is all', async () => {
  const checkbox = createFakeElement({ checked: false, dataset: { checkId: 'material-id' } });
  const confirmations = [];
  const storage = {
    value: '{"program-academic":true,"material-id":true}',
    getItem() { return this.value; },
    setItem(key, value) { this.value = value; }
  };
  await withFakePage({
    checkboxes: [checkbox], confirm: (message) => { confirmations.push(message); return true; },
    includeLiveConsole: false, resetScope: 'all', storage
  }, async (page) => {
    page.elements.reset.dispatch('click');
    assert.equal(confirmations[0], '确定清空全部 21 项任务状态（含不适用状态）吗？此操作无法撤销。');
    assert.equal(checkbox.checked, false);
    assert.equal(page.elements.progressCount.textContent, '0 / 21 项');
    assert.equal(JSON.parse(storage.value)['program-academic'], false);
  });
});

test('selects the active milestone and the next future milestone', () => {
  const { getTimelineState } = loadApp();
  assert.equal(typeof getTimelineState, 'function', 'getTimelineState must be exported');

  const milestones = [
    { id: 'prepare', start: '2026-08-01', end: '2026-08-31' },
    { id: 'directory', start: '2026-09-15', end: '2026-09-30' },
    { id: 'apply', start: '2026-10-10', end: '2026-10-27' }
  ];

  assert.deepEqual(getTimelineState(milestones, '2026-08-21'), {
    activeId: 'prepare',
    activeIds: ['prepare'],
    nextId: 'directory',
    daysToNext: 25
  });
});

test('returns every overlapping active milestone in chronological order', () => {
  const { getTimelineState } = loadApp();
  const milestones = [
    { id: 'later', start: '2026-04-01', end: '2026-04-30' },
    { id: 'earlier', start: '2026-03-21', end: '2026-04-15' },
    { id: 'future', start: '2026-05-01', end: '2026-05-10' }
  ];

  assert.deepEqual(getTimelineState(milestones, '2026-04-10'), {
    activeId: 'earlier',
    activeIds: ['earlier', 'later'],
    nextId: 'future',
    daysToNext: 21
  });
});

test('home countdown follows the published 2027 registration dates', async () => {
  for (const [today, active, next, days] of [
    ['2026-10-08', '等待下一节点', '网上预报名', '1 天'],
    ['2026-10-09', '网上预报名 / 材料核验与补交', '全国网上报名', '6 天'],
    ['2026-10-12', '网上预报名 / 材料核验与补交', '全国网上报名', '3 天'],
    ['2026-10-13', '材料核验与补交', '全国网上报名', '2 天'],
    ['2026-10-15', '全国网上报名 / 材料核验与补交', '下载准考证', '56 天'],
    ['2026-10-24', '全国网上报名 / 材料核验与补交', '下载准考证', '47 天'],
    ['2026-10-28', '材料核验与补交', '下载准考证', '43 天']
  ]) {
    await withFakePage({ today, includeLiveConsole: false }, ({ elements }) => {
      assert.equal(elements.stageName.textContent, active, today);
      assert.equal(elements.nextName.textContent, next, today);
      assert.equal(elements.nextDays.textContent, days, today);
    });
  }
});

test('keeps uncompleted material review visible after registration and clears it on completion', async () => {
  const checkbox = createFakeElement({ dataset: { checkId: 'stage-confirm' } });
  await withFakePage({ includeLiveConsole: false, today: '2026-10-25', checkboxes: [checkbox] }, async (page) => {
    assert.match(page.elements.stageName.textContent, /材料核验与补交/);
    assert.match(page.elements.stageDetail.textContent, /报考点/);
    checkbox.checked = true;
    checkbox.dispatch('change');
    assert.doesNotMatch(page.elements.stageName.textContent, /材料核验与补交/);
  });
});

test('includes consultation during its published window and removes it afterward', async () => {
  await withFakePage({ includeLiveConsole: false, today: '2026-09-26' }, async (page) => {
    assert.match(page.elements.stageName.textContent, /研招咨询/);
  });
  await withFakePage({ includeLiveConsole: false, today: '2026-09-30' }, async (page) => {
    assert.doesNotMatch(page.elements.stageName.textContent, /研招咨询/);
  });
});

test('does not silently dismiss an unfinished review after the exam', async () => {
  await withFakePage({ includeLiveConsole: false, today: '2026-12-21' }, async (page) => {
    assert.match(page.elements.stageName.textContent, /材料核验与补交/);
    assert.match(page.elements.stageDetail.textContent, /不得超过/);
  });
});

test('preserves legacy checks and excludes inapplicable tasks from the denominator', () => {
  const { safeReadChecks, mergeChecklistState, countChecklistProgress } = loadApp();
  const stored = safeReadChecks({ getItem: () => '{"material-id":true,"material-special":"na","stage-preapply":"na","unknown":"na"}' }, 'progress');
  const state = mergeChecklistState(stored, { 'stage-apply': true });
  assert.equal(state['material-special'], 'na');
  assert.equal(state.unknown, undefined);
  assert.deepEqual(countChecklistProgress(state), { completed: 2, total: 19, percent: 11 });
  assert.deepEqual(countChecklistProgress(mergeChecklistState(state, { 'material-special': false })), { completed: 2, total: 20, percent: 10 });
});

test('skip controls persist across navigation, print honestly, restore and reset', async () => {
  const storage = { values: new Map(), getItem(key) { return this.values.get(key); }, setItem(key, value) { this.values.set(key, value); } };
  const label = createFakeElement();
  const checkbox = createFakeElement({ dataset: { checkId: 'material-special' } });
  checkbox.label = label;
  const button = createFakeElement({ dataset: { skipCheck: 'material-special' } });
  const options = { includeLiveConsole: false, storage, checkboxes: [checkbox], skipButtons: [button], resetScope: 'all' };
  await withFakePage(options, async (page) => {
    button.dispatch('click');
    assert.equal(checkbox.disabled, true);
    assert.equal(label.getAttribute('data-print-state'), '不适用');
    assert.equal(page.elements.progressCount.textContent, '0 / 20 项（1 项不适用）');
  });
  await withFakePage(options, async (page) => {
    assert.equal(checkbox.disabled, true);
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    button.dispatch('click');
    assert.equal(checkbox.disabled, false);
    assert.equal(page.elements.progressCount.textContent, '0 / 21 项');
    button.dispatch('click');
    page.elements.reset.dispatch('click');
    assert.equal(button.getAttribute('aria-pressed'), 'false');
    assert.equal(checkbox.disabled, false);
  });
});

test('changing year and category resets pagination and retains filters on refresh', async () => {
  const snapshot = makeUpdatesPayload();
  snapshot.updates = Array.from({ length: 10 }, (_, i) => ({
    ...snapshot.updates[0], id: `filter-${i}`, title: `${i < 2 ? '2027' : '2026'} 年报名公告`,
    category: '报名确认', url: `https://gs.hainanu.edu.cn/info/filter-${i}.htm`
  }));
  await withFakePage({ pageSize: '8' }, async (page) => {
    page.settle(page.fetchCalls[0], snapshot);
    await page.flush();
    page.elements.next.dispatch('click');
    assert.match(page.elements.pageStatus.textContent, /2 \/ 2/);
    page.elements.yearFilter.value = '2027';
    page.elements.yearFilter.dispatch('change');
    assert.match(page.elements.pageStatus.textContent, /1 \/ 1.*2 条/);
    page.elements.categoryFilter.value = '简章目录';
    page.elements.categoryFilter.dispatch('change');
    assert.match(collectText(page.elements.updatesList), /没有符合筛选条件/);
    page.elements.refresh.dispatch('click');
    page.settle(page.fetchCalls[1], snapshot);
    await page.flush();
    assert.match(page.elements.pageStatus.textContent, /0 条/);
    page.elements.categoryFilter.value = 'all';
    page.elements.categoryFilter.dispatch('change');
    assert.match(page.elements.pageStatus.textContent, /2 条/);
  });
});

test('combines unread, admission year and category without inferring year from publication date', () => {
  const { selectUpdatesForDisplay } = loadApp();
  const updates = [
    { id: 'a', title: '2027 年报名公告', category: '报名确认' },
    { id: 'b', title: '2026 年报名公告', category: '报名确认' },
    { id: 'c', title: '报名公告', date: '2026-09-26', category: '报名确认' },
    { id: 'd', title: '2027 年招生目录', category: '简章目录' },
    { id: 'e', title: '2026 年与 2027 年报名安排', category: '报名确认' }
  ];
  const unseen = new Set(['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(selectUpdatesForDisplay(updates, unseen, new Set(['a']), 'new', { year: '2027', category: '报名确认' }).updates.map(x => x.id), ['e']);
  assert.deepEqual(selectUpdatesForDisplay(updates, unseen, new Set(), 'all', { year: 'history' }).updates.map(x => x.id), ['b']);
  assert.deepEqual(selectUpdatesForDisplay(updates, unseen, new Set(), 'all', { year: 'unknown' }).updates.map(x => x.id), ['c']);
});

test('treats both milestone boundary dates as active', () => {
  const { getTimelineState } = loadApp();
  assert.equal(typeof getTimelineState, 'function', 'getTimelineState must be exported');

  const milestones = [{ id: 'apply', start: '2026-10-10', end: '2026-10-27' }];
  assert.equal(getTimelineState(milestones, '2026-10-10').activeId, 'apply');
  assert.equal(getTimelineState(milestones, '2026-10-27').activeId, 'apply');
});

test('returns null next values after the final milestone', () => {
  const { getTimelineState } = loadApp();
  assert.equal(typeof getTimelineState, 'function', 'getTimelineState must be exported');

  const milestones = [{ id: 'enrol', start: '2027-09-01', end: '2027-09-15' }];
  assert.deepEqual(getTimelineState(milestones, '2027-10-01'), {
    activeId: null,
    activeIds: [],
    nextId: null,
    daysToNext: null
  });
});

test('returns a rounded and bounded progress percentage', () => {
  const { calculateProgress } = loadApp();
  assert.equal(typeof calculateProgress, 'function', 'calculateProgress must be exported');

  assert.equal(calculateProgress(3, 8), 38);
  assert.equal(calculateProgress(0, 0), 0);
  assert.equal(calculateProgress(-1, 8), 0);
  assert.equal(calculateProgress(12, 8), 100);
});

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

test('filters timeline items without mutating their order', () => {
  const { filterTimeline } = loadApp();
  assert.equal(typeof filterTimeline, 'function', 'filterTimeline must be exported');

  const items = [
    { id: 'a', category: 'apply' },
    { id: 'b', category: 'exam' },
    { id: 'c', category: 'apply' }
  ];

  assert.deepEqual(filterTimeline(items, 'apply').map(item => item.id), ['a', 'c']);
  assert.deepEqual(filterTimeline(items, 'all').map(item => item.id), ['a', 'b', 'c']);
  assert.deepEqual(items.map(item => item.id), ['a', 'b', 'c']);
});

test('reads a stored checklist object and rejects malformed shapes', () => {
  const { safeReadChecks } = loadApp();
  assert.equal(typeof safeReadChecks, 'function', 'safeReadChecks must be exported');

  assert.deepEqual(
    safeReadChecks({ getItem: () => '{"id-card":true,"photo":false}' }, 'progress'),
    { 'id-card': true, photo: false }
  );
  assert.deepEqual(safeReadChecks({ getItem: () => '{bad-json' }, 'progress'), {});
  assert.deepEqual(safeReadChecks({ getItem: () => '["id-card"]' }, 'progress'), {});
  assert.deepEqual(safeReadChecks({ getItem: () => { throw new Error('blocked'); } }, 'progress'), {});
});

test('accepts only HTTPS notice links on configured university and CHSI official domains', () => {
  const { isSafeOfficialUpdateUrl } = loadApp();
  assert.equal(typeof isSafeOfficialUpdateUrl, 'function', 'isSafeOfficialUpdateUrl must be exported');

  assert.equal(isSafeOfficialUpdateUrl('https://gs.hainanu.edu.cn/info/1024/8892.htm'), true);
  assert.equal(isSafeOfficialUpdateUrl('https://cs.hainanu.edu.cn/info/1086/11860.htm'), true);
  assert.equal(isSafeOfficialUpdateUrl('https://yz.chsi.com.cn/kyzx/jybzc/202509/20250924/2293431895.html'), true);
  assert.equal(isSafeOfficialUpdateUrl('http://gs.hainanu.edu.cn/info/1024/8892.htm'), false);
  assert.equal(isSafeOfficialUpdateUrl('https://hainanu.edu.cn.evil.example/notice'), false);
  assert.equal(isSafeOfficialUpdateUrl('https://yz.chsi.com.cn.evil.example/notice'), false);
  assert.equal(isSafeOfficialUpdateUrl('javascript:alert(1)'), false);
});

test('normalizes the updates API and drops malformed or non-official records', () => {
  const { normalizeUpdatesPayload } = loadApp();
  assert.equal(typeof normalizeUpdatesPayload, 'function', 'normalizeUpdatesPayload must be exported');

  const normalized = normalizeUpdatesPayload({
    status: 'fresh',
    fetchedAt: '2026-08-22T04:00:00.000Z',
    lastSuccessAt: '2026-08-22T04:00:00.000Z',
    nextRefreshAt: '2026-08-22T10:00:00.000Z',
    refreshIntervalMs: 21_600_000,
    sources: [
      { id: 'hnu-graduate', name: '海南大学研究生院', url: 'https://gs.hainanu.edu.cn/yjszs/ssszs.htm', ok: true, checkedAt: '2026-08-22T04:00:00.000Z', error: null },
      { id: 42, name: null, url: 'https://evil.example', ok: 'yes' }
    ],
    updates: [
      { id: 'notice-1', title: '海南大学2027年硕士研究生招生专业目录', date: '2026-09-25', url: 'https://gs.hainanu.edu.cn/info/1024/9000.htm', source: '海南大学研究生院', sourceId: 'hnu-graduate', category: '简章目录', isTarget2027: true, isImportant: true },
      { id: 'notice-2', title: '伪造通知', date: '2026-09-26', url: 'https://evil.example/notice', source: '未知', sourceId: 'evil', category: '招生动态' },
      { id: 'notice-3', title: '', date: 'bad-date', url: 'https://gs.hainanu.edu.cn/empty', source: '海南大学研究生院' }
    ],
    error: null
  });

  assert.equal(normalized.status, 'fresh');
  assert.equal(normalized.sources.length, 1);
  assert.deepEqual(normalized.updates, [{
    id: 'notice-1',
    title: '海南大学2027年硕士研究生招生专业目录',
    date: '2026-09-25',
    url: 'https://gs.hainanu.edu.cn/info/1024/9000.htm',
    source: '海南大学研究生院',
    sourceId: 'hnu-graduate',
    category: '简章目录',
    isTarget2027: true,
    isImportant: true,
    discoveredAt: null
  }]);
});

test('normalizes v2 freshness, discovery and national policy fields', () => {
  const { normalizeUpdatesPayload } = loadApp();
  const normalized = normalizeUpdatesPayload({
    schemaVersion: 2,
    status: 'fresh',
    fetchedAt: '2026-08-23T04:00:00.000Z',
    lastSuccessAt: '2026-08-23T04:00:00.000Z',
    freshness: { state: 'fresh', ageMs: 30_000, isOverdue: false },
    change: { newCount: 1, newIds: ['policy-1', 42], changedAt: '2026-08-23T04:00:00.000Z' },
    sources: [{
      id: 'chsi-ministry-policy', name: '研招网 · 教育部政策', url: 'https://yz.chsi.com.cn/kyzx/jybzc/',
      ok: true, checkedAt: '2026-08-23T04:00:00.000Z', lastSuccessAt: '2026-08-23T04:00:00.000Z', attempts: 2
    }],
    updates: [{
      id: 'policy-1', title: '2027年全国硕士研究生招生工作管理规定', date: '2026-09-20',
      url: 'https://yz.chsi.com.cn/kyzx/jybzc/202609/notice.html', source: '研招网 · 教育部政策',
      sourceId: 'chsi-ministry-policy', category: '国家政策', discoveredAt: '2026-08-23T04:00:00.000Z'
    }]
  });

  assert.equal(normalized.schemaVersion, 2);
  assert.deepEqual(normalized.freshness, {
    state: 'fresh', ageMs: 30_000, isOverdue: false,
    overdueSourceIds: [], worstSourceAgeMs: null
  });
  assert.deepEqual(normalized.change, {
    newCount: 1,
    newIds: ['policy-1'],
    updatedCount: 0,
    updatedIds: [],
    changedAt: '2026-08-23T04:00:00.000Z'
  });
  assert.deepEqual(normalized.sources[0], {
    id: 'chsi-ministry-policy', name: '研招网 · 教育部政策', url: 'https://yz.chsi.com.cn/kyzx/jybzc/',
    ok: true, checkedAt: '2026-08-23T04:00:00.000Z', lastSuccessAt: '2026-08-23T04:00:00.000Z', attempts: 2, error: null,
    freshness: null, ageMs: null, isOverdue: false, degraded: false
  });
  assert.equal(normalized.updates[0].discoveredAt, '2026-08-23T04:00:00.000Z');
});

test('preserves the complete v2 freshness, clocks and update-change contract safely', () => {
  const { normalizeUpdatesPayload } = loadApp();
  const normalized = normalizeUpdatesPayload({
    schemaVersion: 2,
    status: 'stale',
    fetchedAt: '2026-08-24T06:00:00.000Z',
    lastAttemptAt: '2026-08-24T06:00:00.000Z',
    lastAnySuccessAt: '2026-08-24T05:45:00.000Z',
    lastAllSuccessAt: '2026-08-24T04:00:00.000Z',
    lastSuccessAt: '2026-08-24T05:45:00.000Z',
    refreshIntervalMs: 900_000,
    freshness: {
      state: 'overdue', ageMs: 2_100_000, isOverdue: true,
      overdueSourceIds: ['graduate', 'unknown-source', 42], worstSourceAgeMs: 2_100_000
    },
    sources: [
      {
        id: 'graduate', name: '海南大学研究生院', url: 'https://gs.hainanu.edu.cn/yjszs/ssszs.htm',
        ok: false, checkedAt: '2026-08-24T06:00:00.000Z', lastSuccessAt: '2026-08-24T04:00:00.000Z', attempts: 2,
        freshness: 'overdue', ageMs: 2_100_000, isOverdue: true, degraded: true, error: '疑似页面结构变化'
      },
      {
        id: 'computer', name: '计算机学院', url: 'https://cs.hainanu.edu.cn/',
        ok: true, checkedAt: '2026-08-24T06:00:00.000Z', lastSuccessAt: '2026-08-24T05:55:00.000Z', attempts: 1,
        freshness: 'fresh', ageMs: 300_000, isOverdue: false, degraded: false
      }
    ],
    updates: [
      { id: 'new-1', title: '新公告', date: '2026-08-24', url: 'https://gs.hainanu.edu.cn/info/1024/9001.htm', source: '海南大学研究生院', sourceId: 'graduate' },
      { id: 'updated-1', title: '修订公告', date: '2026-08-23', url: 'https://cs.hainanu.edu.cn/info/1086/9002.htm', source: '计算机学院', sourceId: 'computer' }
    ],
    change: {
      newCount: 99, newIds: ['new-1', 'missing'], updatedCount: 99, updatedIds: ['updated-1', 'missing'],
      changedAt: '2026-08-24T06:00:00.000Z'
    }
  });

  assert.equal(normalized.lastAttemptAt, '2026-08-24T06:00:00.000Z');
  assert.equal(normalized.lastAnySuccessAt, '2026-08-24T05:45:00.000Z');
  assert.equal(normalized.lastAllSuccessAt, '2026-08-24T04:00:00.000Z');
  assert.deepEqual(normalized.freshness, {
    state: 'overdue', ageMs: 2_100_000, isOverdue: true,
    overdueSourceIds: ['graduate'], worstSourceAgeMs: 2_100_000
  });
  assert.deepEqual(normalized.sources.map((source) => ({
    id: source.id, freshness: source.freshness, ageMs: source.ageMs,
    isOverdue: source.isOverdue, degraded: source.degraded
  })), [
    { id: 'graduate', freshness: 'overdue', ageMs: 2_100_000, isOverdue: true, degraded: true },
    { id: 'computer', freshness: 'fresh', ageMs: 300_000, isOverdue: false, degraded: false }
  ]);
  assert.deepEqual(normalized.change, {
    newCount: 1, newIds: ['new-1'], updatedCount: 1, updatedIds: ['updated-1'],
    changedAt: '2026-08-24T06:00:00.000Z'
  });
});

test('finds only notices discovered after the last page visit', () => {
  const { getUnseenUpdates } = loadApp();
  assert.equal(typeof getUnseenUpdates, 'function', 'getUnseenUpdates must be exported');
  const updates = [
    { id: 'new', discoveredAt: '2026-08-23T05:00:00.000Z' },
    { id: 'old', discoveredAt: '2026-08-23T03:00:00.000Z' },
    { id: 'unknown', discoveredAt: null }
  ];
  assert.deepEqual(getUnseenUpdates(updates, '2026-08-23T04:00:00.000Z').map((item) => item.id), ['new']);
  assert.deepEqual(getUnseenUpdates(updates, null), [], 'first visit establishes a baseline instead of flagging all cache');
});

test('keeps the visit baseline fixed so new badges do not disappear on the next poll', () => {
  const { getUnseenBaseline, getUnseenUpdates } = loadApp();
  assert.equal(typeof getUnseenBaseline, 'function', 'getUnseenBaseline must be exported');
  const baseline = getUnseenBaseline(null, '2026-08-23T04:00:00.000Z');
  const afterNextPoll = getUnseenBaseline(baseline, '2026-08-23T05:00:00.000Z');

  assert.equal(baseline, '2026-08-23T04:00:00.000Z');
  assert.equal(afterNextPoll, baseline);
  assert.deepEqual(getUnseenUpdates([
    { id: 'new', discoveredAt: '2026-08-23T05:00:00.000Z' }
  ], afterNextPoll).map((item) => item.id), ['new']);
});

test('uses a stable snapshot key for identical render data', () => {
  const { createUpdatesSnapshotKey } = loadApp();
  assert.equal(typeof createUpdatesSnapshotKey, 'function', 'createUpdatesSnapshotKey must be exported');

  const first = {
    updates: [{ id: 'notice-1', title: '目录', date: '2026-09-25', source: '研究生院', category: '简章目录', url: 'https://gs.hainanu.edu.cn/notice-1' }],
    sourceCount: '1 / 4 正常'
  };
  const sameDataDifferentPropertyOrder = {
    sourceCount: '1 / 4 正常',
    updates: [{ url: 'https://gs.hainanu.edu.cn/notice-1', category: '简章目录', source: '研究生院', date: '2026-09-25', title: '目录', id: 'notice-1' }]
  };

  assert.equal(createUpdatesSnapshotKey(first), createUpdatesSnapshotKey(sameDataDifferentPropertyOrder));
  assert.notEqual(createUpdatesSnapshotKey(first), createUpdatesSnapshotKey({ ...first, sourceCount: '0 / 4 正常' }));
});

test('keeps new notices selected until explicit acknowledgement', () => {
  const { selectUpdatesForDisplay } = loadApp();
  assert.equal(typeof selectUpdatesForDisplay, 'function', 'selectUpdatesForDisplay must be exported');
  const updates = [
    { id: 'newest', title: '新公告' },
    { id: 'older', title: '旧公告' }
  ];

  assert.deepEqual(
    selectUpdatesForDisplay(updates, new Set(['newest']), new Set(), 'new'),
    { updates: [updates[0]], newIds: ['newest'] }
  );
  assert.deepEqual(
    selectUpdatesForDisplay(updates, new Set(['newest']), new Set(['newest']), 'new'),
    { updates: [], newIds: [] }
  );
});

test('aggregates display notices by normalized URL without changing member identities', () => {
  const { aggregateUpdatesForDisplay } = loadApp();
  assert.equal(typeof aggregateUpdatesForDisplay, 'function', 'aggregateUpdatesForDisplay must be exported');
  const updates = [
    {
      id: 'graduate-notice', title: '招生目录', date: '2026-09-25',
      url: 'https://GS.HAINANU.EDU.CN:443/info/1024/9000.htm', source: '海南大学研究生院', sourceId: 'graduate'
    },
    {
      id: 'computer-notice', title: '招生目录', date: '2026-09-25',
      url: 'https://gs.hainanu.edu.cn/info/1024/9000.htm', source: '计算机学院', sourceId: 'computer'
    }
  ];

  const grouped = aggregateUpdatesForDisplay(updates, new Set(['computer-notice']), new Set());

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].url, 'https://gs.hainanu.edu.cn/info/1024/9000.htm');
  assert.deepEqual(grouped[0].memberIds, ['computer-notice', 'graduate-notice']);
  assert.deepEqual(grouped[0].sourceNames, ['计算机学院', '海南大学研究生院']);
  assert.equal(grouped[0].isNew, true);
  assert.deepEqual(updates.map((update) => update.id), ['graduate-notice', 'computer-notice']);
});

test('ignores URL fragments when aggregating one notice across official sources', () => {
  const { aggregateUpdatesForDisplay } = loadApp();
  const updates = [
    {
      id: 'graduate-fragment', title: '招生目录', date: '2026-09-25',
      url: 'https://gs.hainanu.edu.cn/info/1024/9000.htm#graduate',
      source: '海南大学研究生院', sourceId: 'graduate'
    },
    {
      id: 'computer-fragment', title: '招生目录', date: '2026-09-25',
      url: 'https://gs.hainanu.edu.cn/info/1024/9000.htm#computer',
      source: '计算机学院', sourceId: 'computer'
    }
  ];

  const grouped = aggregateUpdatesForDisplay(updates, new Set(['graduate-fragment']), new Set());

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].url, 'https://gs.hainanu.edu.cn/info/1024/9000.htm');
  assert.equal(grouped[0].id, 'url:https://gs.hainanu.edu.cn/info/1024/9000.htm');
  assert.deepEqual(grouped[0].memberIds, ['computer-fragment', 'graduate-fragment']);
  assert.deepEqual(grouped[0].sourceNames, ['计算机学院', '海南大学研究生院']);
  assert.equal(grouped[0].isNew, true);
});

test('source health detail includes the last successful synchronization time', () => {
  const { formatSourceHealthTitle } = loadApp();
  assert.equal(typeof formatSourceHealthTitle, 'function', 'formatSourceHealthTitle must be exported');
  const detail = formatSourceHealthTitle({
    name: '海南大学研究生院', ok: false, error: '请求超时',
    lastSuccessAt: '2026-08-23T04:00:00.000Z'
  });

  assert.match(detail, /海南大学研究生院/);
  assert.match(detail, /请求超时/);
  assert.match(detail, /最近成功/);
  assert.match(detail, /8(?:月|\/)23/);
});

test('formats freshness using the supplied refresh interval rather than fixed hours', () => {
  const { formatFreshness } = loadApp();
  assert.equal(typeof formatFreshness, 'function', 'formatFreshness must be exported');

  assert.equal(formatFreshness({ state: 'fresh', ageMs: 300_000 }, 900_000), '新鲜 · 少于 1 个刷新周期');
  assert.equal(formatFreshness({ state: 'aging', ageMs: 900_000 }, 900_000), '待补同步 · 1–2 个刷新周期');
  const overdue = formatFreshness({ state: 'overdue', ageMs: 2_100_000 }, 900_000);
  assert.equal(overdue, '已逾期 · 2 个刷新周期');
  assert.doesNotMatch(overdue, /小时/);
});

test('formats configured refresh intervals in whole hours or minutes', () => {
  const { formatRefreshInterval } = loadApp();
  assert.equal(typeof formatRefreshInterval, 'function', 'formatRefreshInterval must be exported');

  assert.equal(formatRefreshInterval(7_200_000), '2 小时');
  assert.equal(formatRefreshInterval(1_800_000), '30 分钟');
  assert.equal(formatRefreshInterval(null), '按刷新周期');
});

test('renders the live freshness metric with the snapshot refresh interval', async () => {
  const snapshot = makeUpdatesPayload();
  snapshot.refreshIntervalMs = 900_000;
  snapshot.freshness = {
    state: 'overdue', ageMs: 2_100_000, isOverdue: true,
    overdueSourceIds: [], worstSourceAgeMs: 2_100_000
  };

  await withFakePage({}, async (page) => {
    page.settle(page.fetchCalls[0], snapshot);
    await page.flush();
    assert.equal(page.elements.freshness.textContent, '已逾期 · 2 个刷新周期');
  });
});

test('renders the configured cadence when the next refresh deadline is missing', async () => {
  const cases = [
    { refreshIntervalMs: 7_200_000, expected: '每 2 小时' },
    { refreshIntervalMs: 1_800_000, expected: '每 30 分钟' },
    { refreshIntervalMs: null, expected: '按刷新周期' }
  ];

  for (const { refreshIntervalMs, expected } of cases) {
    const snapshot = makeUpdatesPayload();
    snapshot.nextRefreshAt = null;
    snapshot.refreshIntervalMs = refreshIntervalMs;

    await withFakePage({}, async (page) => {
      page.settle(page.fetchCalls[0], snapshot);
      await page.flush();
      assert.equal(page.elements.nextRefresh.textContent, expected);
    });
  }
});

test('names an overdue source and exposes its degraded freshness in the live console', async () => {
  const snapshot = makeUpdatesPayload();
  snapshot.status = 'stale';
  snapshot.refreshIntervalMs = 900_000;
  snapshot.freshness = {
    state: 'overdue', ageMs: 2_100_000, isOverdue: true,
    overdueSourceIds: ['hnu-graduate'], worstSourceAgeMs: 2_100_000
  };
  snapshot.sources = [
    {
      id: 'hnu-graduate', name: '海南大学研究生院', url: 'https://gs.hainanu.edu.cn/yjszs/ssszs.htm',
      ok: false, checkedAt: '2026-08-24T06:00:00.000Z', lastSuccessAt: '2026-08-24T04:00:00.000Z', attempts: 2,
      freshness: 'overdue', ageMs: 2_100_000, isOverdue: true, degraded: true, error: '疑似页面结构变化'
    },
    {
      id: 'computer', name: '计算机学院', url: 'https://cs.hainanu.edu.cn/',
      ok: true, checkedAt: '2026-08-24T06:00:00.000Z', lastSuccessAt: '2026-08-24T05:55:00.000Z', attempts: 1,
      freshness: 'fresh', ageMs: 300_000, isOverdue: false, degraded: false
    }
  ];

  await withFakePage({}, async (page) => {
    page.settle(page.fetchCalls[0], snapshot);
    await page.flush();

    assert.match(page.elements.statusTitle.textContent, /海南大学研究生院/);
    assert.match(page.elements.statusDetail.textContent, /海南大学研究生院/);
    const graduateChip = page.elements.sourceHealth.children[0];
    assert.match(graduateChip.className, /is-overdue/);
    assert.match(graduateChip.className, /is-degraded/);
    assert.match(graduateChip.getAttribute('aria-label'), /数据异常，保留旧缓存/);
    assert.match(graduateChip.getAttribute('aria-label'), /数据新鲜度：已逾期/);
  });
});

test('prioritizes cache-backup recovery over unavailable-source messaging', async () => {
  const snapshot = makeUpdatesPayload();
  snapshot.status = 'stale';
  snapshot.error = '主缓存损坏，已从备份恢复。';
  snapshot.freshness = {
    state: 'overdue', ageMs: 2_100_000, isOverdue: true,
    overdueSourceIds: ['hnu-graduate'], worstSourceAgeMs: 2_100_000
  };
  snapshot.sources[0] = {
    ...snapshot.sources[0], ok: false, freshness: 'overdue', ageMs: 2_100_000, isOverdue: true
  };

  await withFakePage({}, async (page) => {
    page.settle(page.fetchCalls[0], snapshot);
    await page.flush();

    assert.equal(page.elements.statusTitle.textContent, '已从缓存备份恢复，等待验证');
    assert.match(page.elements.statusDetail.textContent, /主缓存损坏，已从备份恢复/);
    assert.doesNotMatch(page.elements.statusTitle.textContent, /不可用/);
  });
});

test('renders one stable aggregated notice with every source name when URLs match', async () => {
  const storageWithVisitBaseline = {
    getItem() { return '2026-08-24T03:00:00.000Z'; },
    setItem() {}
  };
  const snapshot = makeUpdatesPayload();
  snapshot.updates = [
    {
      id: 'graduate-notice', title: '2027 年招生目录', date: '2026-09-25',
      url: 'https://GS.HAINANU.EDU.CN:443/info/1024/9000.htm', source: '海南大学研究生院', sourceId: 'graduate',
      category: '简章目录', discoveredAt: '2026-08-24T04:00:00.000Z'
    },
    {
      id: 'computer-notice', title: '2027 年招生目录', date: '2026-09-25',
      url: 'https://gs.hainanu.edu.cn/info/1024/9000.htm', source: '计算机学院', sourceId: 'computer',
      category: '简章目录', discoveredAt: '2026-08-24T04:00:00.000Z'
    }
  ];

  await withFakePage({ storage: storageWithVisitBaseline }, async (page) => {
    page.settle(page.fetchCalls[0], snapshot);
    await page.flush();

    assert.equal(page.elements.updatesList.children.length, 1);
    assert.equal(findElementsByClass(page.elements.updatesList, 'official-update-new').length, 1);
    assert.match(collectText(page.elements.updatesList), /计算机学院/);
    assert.match(collectText(page.elements.updatesList), /海南大学研究生院/);
    const initialReplacements = page.elements.updatesList.replaceChildrenCalls;

    const reversedSnapshot = { ...snapshot, updates: snapshot.updates.slice().reverse() };
    page.elements.refresh.dispatch('click');
    page.settle(page.fetchCalls[1], reversedSnapshot);
    await page.flush();

    assert.equal(page.elements.updatesList.replaceChildrenCalls, initialReplacements);
  });
});

test('does not start a second fetch while a refresh is already in flight', async () => {
  await withFakePage({}, async (page) => {
    assert.equal(page.fetchCalls.length, 1, 'page load starts the first fetch');
    page.elements.refresh.dispatch('click');
    assert.equal(page.fetchCalls.length, 1, 'manual refresh joins the existing request instead of overlapping it');
  });
});

test('aborts an overdue fetch and restores the refresh control after cleanup', async () => {
  await withFakePage({}, async (page) => {
    const firstCall = page.fetchCalls[0];
    assert.equal(page.elements.refresh.disabled, true);
    assert.equal(page.elements.refresh.getAttribute('aria-busy'), 'true');

    page.runTimers(8_000);
    assert.equal(firstCall.aborted, true, 'the real request signal is aborted at eight seconds');
    await page.flush();

    assert.equal(page.elements.refresh.disabled, false);
    assert.equal(page.elements.refresh.getAttribute('aria-busy'), null);
    assert.equal(page.elements.refresh.textContent, '立即同步');
  });
});

test('cloud sync allows cold-start fetching and shows online recovery guidance', async () => {
  await withFakePage({ hosting: 'vercel' }, async (page) => {
    page.runTimers(8_000);
    assert.equal(page.fetchCalls[0].aborted, false);
    page.runTimers(30_000);
    assert.equal(page.fetchCalls[0].aborted, true);
    await page.flush();
    assert.match(page.elements.statusDetail.textContent, /在线/);
    assert.doesNotMatch(page.elements.statusDetail.textContent, /start-guide|npm start|127\.0\.0\.1/);
  });
});

test('resumes immediately after hide then show races with aborted request cleanup', async () => {
  await withFakePage({}, async (page) => {
    const firstCall = page.fetchCalls[0];
    page.document.visibilityState = 'hidden';
    page.document.dispatch('visibilitychange');
    assert.equal(firstCall.aborted, true, 'hiding aborts the active request');

    page.document.visibilityState = 'visible';
    page.document.dispatch('visibilitychange');
    await page.flush();

    assert.equal(page.fetchCalls.length, 2, 'showing the page starts a new fetch as soon as abort cleanup finishes');
  });
});

test('shows a disconnected status while preserving notices and recovers on the next successful refresh', async () => {
  await withFakePage({}, async (page) => {
    page.settle(page.fetchCalls[0]);
    await page.flush();
    assert.equal(page.elements.statusTitle.textContent, '已连接 · 官方数据已同步');
    assert.equal(page.elements.console.dataset.state, 'fresh');

    const retainedList = page.elements.updatesList.children.slice();
    page.elements.refresh.dispatch('click');
    assert.equal(page.fetchCalls.length, 2);
    page.fetchCalls[1].reject(new Error('network failure'));
    await page.flush();

    assert.match(page.elements.statusTitle.textContent, /同步失败/);
    assert.equal(page.elements.console.dataset.state, 'offline');
    assert.equal(page.elements.statusDetail.textContent, '本次同步失败，已保留当前页面中的最近数据。');
    assert.deepEqual(page.elements.updatesList.children, retainedList);
    assert.match(page.elements.freshness.textContent, /未验证/);

    page.elements.refresh.dispatch('click');
    page.settle(page.fetchCalls[2]);
    await page.flush();
    assert.equal(page.elements.console.dataset.state, 'fresh');
    assert.equal(page.elements.statusTitle.textContent, '已连接 · 官方数据已同步');
  });
});

test('a refresh cooldown does not falsely mark a reachable service as disconnected', async () => {
  await withFakePage({}, async (page) => {
    page.settle(page.fetchCalls[0]);
    await page.flush();
    const retainedList = page.elements.updatesList.children.slice();
    page.elements.refresh.dispatch('click');
    page.fetchCalls[1].resolve({ ok: false, status: 429 });
    await page.flush();
    assert.equal(page.elements.console.dataset.state, 'fresh');
    assert.match(page.elements.statusDetail.textContent, /频繁|稍后/);
    assert.deepEqual(page.elements.updatesList.children, retainedList);
    assert.equal(page.elements.refresh.disabled, false);
  });
});

test('hiding the page mid-flight does not overwrite the rendered console status', async () => {
  await withFakePage({}, async (page) => {
    page.settle(page.fetchCalls[0]);
    await page.flush();
    page.runTimers(60_000);
    assert.equal(page.fetchCalls.length, 2, 'the scheduled poll starts before hiding');

    page.document.visibilityState = 'hidden';
    page.document.dispatch('visibilitychange');
    assert.equal(page.fetchCalls[1].aborted, true, 'hiding aborts the active poll');
    await page.flush();

    assert.equal(page.elements.statusTitle.textContent, '已连接 · 官方数据已同步');
    assert.equal(page.elements.console.dataset.state, 'fresh');
  });
});

test('does not replace the rendered update list for an identical later snapshot', async () => {
  await withFakePage({}, async (page) => {
    page.settle(page.fetchCalls[0]);
    await page.flush();
    const initialReplacements = page.elements.updatesList.replaceChildrenCalls;
    assert.equal(initialReplacements, 1, 'the initial snapshot renders the list once');

    page.elements.refresh.dispatch('click');
    assert.equal(page.fetchCalls.length, 2);
    page.settle(page.fetchCalls[1]);
    await page.flush();

    assert.equal(page.elements.updatesList.replaceChildrenCalls, initialReplacements);
  });
});

test('falls back to visible session-only storage when local storage throws', async () => {
  const failingStorage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); }
  };
  await withFakePage({ storage: failingStorage }, async (page) => {
    assert.equal(page.elements.storageWarning.hidden, false);
  });
});

test('sets printable checked and unchecked task states from live checkbox state', async () => {
  const checkedLabel = createFakeElement();
  const uncheckedLabel = createFakeElement();
  const checked = createFakeElement({ checked: true, dataset: { checkId: 'program-academic' } });
  const unchecked = createFakeElement({ checked: false, dataset: { checkId: 'stage-baseline' } });
  checked.label = checkedLabel;
  unchecked.label = uncheckedLabel;

  const printStorage = {
    getItem() { return '{"program-academic":true,"stage-baseline":false}'; },
    setItem() {}
  };
  await withFakePage({ checkboxes: [checked, unchecked], storage: printStorage }, async () => {
    assert.equal(checkedLabel.getAttribute('data-print-state'), '已完成');
    assert.equal(uncheckedLabel.getAttribute('data-print-state'), '未完成');

    unchecked.checked = true;
    unchecked.dispatch('change');
    assert.equal(uncheckedLabel.getAttribute('data-print-state'), '已完成');
  });
});

test('keeps checkbox progress and printable state usable when local storage throws', async () => {
  const label = createFakeElement();
  const checkbox = createFakeElement({ checked: false, dataset: { checkId: 'material-id' } });
  checkbox.label = label;
  const failingStorage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); }
  };

  await withFakePage({ checkboxes: [checkbox], storage: failingStorage }, async (page) => {
    assert.equal(page.elements.progressCount.textContent, '0 / 21 项');
    assert.equal(label.getAttribute('data-print-state'), '未完成');

    checkbox.checked = true;
    checkbox.dispatch('change');

    assert.equal(page.elements.progressCount.textContent, '1 / 21 项');
    assert.equal(page.elements.progressText.textContent, '5%');
    assert.equal(label.getAttribute('data-print-state'), '已完成');
    assert.equal(page.elements.storageWarning.hidden, false);
  });
});

test('acknowledges new notices in the current session when local storage cannot persist', async () => {
  const failingStorage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); }
  };
  const newerSnapshot = makeUpdatesPayload();
  newerSnapshot.fetchedAt = '2026-08-24T05:00:00.000Z';
  newerSnapshot.lastSuccessAt = '2026-08-24T05:00:00.000Z';
  newerSnapshot.change.changedAt = '2026-08-24T05:00:00.000Z';
  newerSnapshot.updates[0] = {
    ...newerSnapshot.updates[0],
    id: 'notice-new',
    discoveredAt: '2026-08-24T05:00:00.000Z'
  };

  await withFakePage({ storage: failingStorage }, async (page) => {
    page.settle(page.fetchCalls[0]);
    await page.flush();
    page.elements.refresh.dispatch('click');
    page.settle(page.fetchCalls[1], newerSnapshot);
    await page.flush();

    assert.equal(findElementsByClass(page.elements.updatesList, 'official-update-new').length, 1);
    page.elements.acknowledge.dispatch('click');

    assert.equal(findElementsByClass(page.elements.updatesList, 'official-update-new').length, 0);
    page.elements.updateNew.dispatch('click');
    assert.equal(page.elements.updatesList.children[0].className, 'official-update-empty');
    assert.equal(page.elements.storageWarning.hidden, false);
  });
});

test('paginates notices after date sorting and resets filters and shrinking snapshots safely', async () => {
  const snapshot = makeUpdatesPayload();
  snapshot.updates = Array.from({ length: 19 }, (_, i) => ({
    ...snapshot.updates[0], id: `page-${i}`, title: `招生通知 ${i}`,
    date: `2026-09-${String(i + 1).padStart(2, '0')}`,
    url: `https://gs.hainanu.edu.cn/info/1024/${9100 + i}.htm`
  }));
  await withFakePage({ pageSize: '8' }, async (page) => {
    const { updatesList, previous, next, pageStatus, updateNew, updateAll } = page.elements;
    const dates = () => findElementsByClass(updatesList, 'official-update-date').map((el) => el.textContent);
    page.settle(page.fetchCalls[0], snapshot);
    await page.flush();
    assert.equal(updatesList.children.length, 8);
    assert.equal(dates()[0], '2026.09.19');
    assert.equal(previous.disabled, true);
    assert.match(pageStatus.textContent, /1 \/ 3/);
    next.dispatch('click');
    assert.equal(dates()[0], '2026.09.11');
    previous.dispatch('click');
    assert.equal(dates()[0], '2026.09.19');
    next.dispatch('click');
    next.dispatch('click');
    assert.equal(updatesList.children.length, 3);
    assert.equal(next.disabled, true);
    assert.deepEqual(dates(), ['2026.09.03', '2026.09.02', '2026.09.01']);
    updateNew.dispatch('click');
    assert.match(pageStatus.textContent, /1 \/ 1.*0 条/);
    assert.equal(next.disabled, true);
    updateAll.dispatch('click');
    assert.equal(dates()[0], '2026.09.19');
    next.dispatch('click');
    page.elements.refresh.dispatch('click');
    page.settle(page.fetchCalls[1], snapshot);
    await page.flush();
    assert.match(pageStatus.textContent, /2 \/ 3/);
    page.elements.refresh.dispatch('click');
    page.settle(page.fetchCalls[2], { ...snapshot, updates: snapshot.updates.slice(-2) });
    await page.flush();
    assert.equal(updatesList.children.length, 2);
    assert.match(pageStatus.textContent, /1 \/ 1.*2 条/);
    assert.equal(previous.disabled, true);
  });
});

test('old section bookmarks point to their new pages including file-mode paths', () => {
  const { getLegacyPageDestination } = loadApp();
  for (const prefix of ['', '/local/guide']) {
    assert.equal(getLegacyPageDestination(`${prefix}/programs.html`, '#scores'), 'scores.html#scores');
    assert.equal(getLegacyPageDestination(`${prefix}/programs`, '#exam'), 'preparation.html#exam');
    assert.equal(getLegacyPageDestination(`${prefix}/programs.html`, '#risks'), 'preparation.html#risks');
    assert.equal(getLegacyPageDestination(`${prefix}/application.html`, '#materials'), 'materials.html#materials');
    assert.equal(getLegacyPageDestination(`${prefix}/updates.html`, '#sources'), 'sources.html#sources');
  }
  assert.equal(getLegacyPageDestination('/programs.html', '#programs'), null);
  assert.equal(getLegacyPageDestination('/scores.html', '#scores'), null);
});

test('every static printable task label starts with an honest unfinished state', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = ['index.html', 'programs.html', 'scores.html', 'preparation.html', 'timeline.html', 'application.html', 'materials.html', 'updates.html', 'sources.html']
    .map((fileName) => fs.readFileSync(path.resolve(__dirname, '..', fileName), 'utf8'))
    .join('\n');
  const taskLabels = [...html.matchAll(/<label\b([^>]*)>\s*<input\b[^>]*class="task-check"/g)];

  assert.equal(taskLabels.length, 21, 'the nine static guide pages must contain all 21 printable task labels exactly once');
  for (const [, attributes] of taskLabels) {
    assert.match(attributes, /\bdata-print-state="未完成"/);
  }
});

test('preserves the actual static review date when the page is opened on a later day', async () => {
  const verifiedSpan = createFakeElement({ textContent: '静态内容复核至 2026-09-11' });
  const footerP = createFakeElement({ textContent: '个人备考导航。静态内容复核日期：2026-09-11；动态通知由本地服务另行同步。' });
  await withFakePage({
    today: '2026-09-22',
    verifiedDates: [verifiedSpan],
    footerParagraphs: [footerP]
  }, async () => {
    assert.equal(verifiedSpan.textContent, '静态内容复核至 2026-09-11');
    assert.equal(footerP.textContent, '个人备考导航。静态内容复核日期：2026-09-11；动态通知由本地服务另行同步。');
  });
});

test('sorts official updates strictly by publication date descending first', () => {
  const { aggregateUpdatesForDisplay } = loadApp();
  const input = [
    { id: '1', title: '2027年招生联系方式', date: '2025-10-17', url: 'https://gs.hainanu.edu.cn/1', source: '研招办', sourceId: 'hnu-grad', category: '动态', isTarget2027: true, isImportant: false },
    { id: '2', title: '复试细则挂网网址汇总', date: '2026-09-20', url: 'https://gs.hainanu.edu.cn/2', source: '研招办', sourceId: 'hnu-grad', category: '动态', isTarget2027: false, isImportant: false },
    { id: '3', title: '推免生接收公告', date: '2026-09-11', url: 'https://cs.hainanu.edu.cn/3', source: '计院', sourceId: 'hnu-cs', category: '推免', isTarget2027: true, isImportant: false }
  ];
  const result = aggregateUpdatesForDisplay(input, new Set(), new Set());
  assert.deepEqual(result.map((item) => item.id), ['url:https://gs.hainanu.edu.cn/2', 'url:https://cs.hainanu.edu.cn/3', 'url:https://gs.hainanu.edu.cn/1']);
});

test('always shows a full publication year and distinguishes previous admission cycles', async () => {
  const snapshot = makeUpdatesPayload();
  snapshot.updates[0].title = '2026年硕士研究生招生预报名提醒';
  snapshot.updates[0].date = '2025-09-30';
  snapshot.updates.push({ ...snapshot.updates[0], id: 'current', url: 'https://gs.hainanu.edu.cn/info/1024/9001.htm', title: '2027年硕士研究生招生简章', date: '2026-09-20', isTarget2027: true });
  await withFakePage({ today: '2026-09-23' }, async (page) => {
    page.settle(page.fetchCalls[0], snapshot);
    await page.flush();
    assert.deepEqual(findElementsByClass(page.elements.updatesList, 'official-update-date').map((item) => item.textContent), ['2026.09.20', '2025.09.30']);
    assert.match(collectText(page.elements.updatesList), /2026 招生 · 往年参考/);
    assert.match(collectText(page.elements.updatesList), /2027 招生/);
  });
});
