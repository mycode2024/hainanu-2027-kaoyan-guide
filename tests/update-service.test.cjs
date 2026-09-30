const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('cache restoration rejects impossible dates while retaining valid leap days', async () => {
  const { createUpdateService } = loadService();
  const dates = ['2026-02-30', '2026-02-29', '2026-04-31', '2026-00-10', '2026-13-01', '2024-02-29', '2026-09-27'];
  const updates = dates.map(date => ({ id: date, title: '2027年硕士研究生招生公告', date,
    url: `https://gs.hainanu.edu.cn/info/${date}.htm`, source: sources[0].name, sourceId: sources[0].id }));
  const service = createUpdateService({ sources: [sources[0]],
    cacheStore: createMemoryStore({ updates }), now: () => new Date('2026-09-27T04:00:00Z') });
  await service.initialize();
  assert.deepEqual(service.getSnapshot().updates.map(item => item.date), ['2026-09-27', '2024-02-29']);
});

function loadService() {
  try {
    delete require.cache[require.resolve('../src/update-service.cjs')];
    return require('../src/update-service.cjs');
  } catch {
    return {};
  }
}

const sources = [
  { id: 'hnu-graduate', name: '海南大学研究生院', url: 'https://gs.hainanu.edu.cn/yjszs/ssszs.htm' },
  { id: 'hnu-computer', name: '海南大学计算机科学与技术学院', url: 'https://cs.hainanu.edu.cn/zsgz/yjszs.htm' }
];

const htmlByHost = {
  'gs.hainanu.edu.cn': '<li><a href="../info/1024/9000.htm">海南大学2027年硕士研究生招生专业目录</a><span>2026-09-25</span></li>',
  'cs.hainanu.edu.cn': '<li><span><a href="../info/1086/11860.htm">海南大学计算机科学与技术学院2026年硕士研究生复试录取工作实施细则</a></span><i>2026-03-24</i></li>'
};

function makeResponse(url, body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Service Unavailable',
    url,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    text: async () => body
  };
}

function createMemoryStore(initial = null) {
  const writes = [];
  return {
    writes,
    async load() { return initial; },
    async save(value) { writes.push(structuredClone(value)); }
  };
}

test('restoring a cache preserves its due time instead of granting another refresh interval', async (t) => {
  const { createUpdateService } = loadService();
  for (const [name, cachedTimes, expectedDue] of [
    ['expired', { lastAttemptAt: '2026-09-25T03:40:00Z', nextRefreshAt: '2026-09-25T03:50:00Z' }, true],
    ['recent', { lastAttemptAt: '2026-09-25T03:55:00Z', nextRefreshAt: '2026-09-25T04:05:00Z' }, false],
    ['legacy', { fetchedAt: '2026-09-25T03:40:00Z' }, true],
    ['untrusted future deadline', { lastAttemptAt: '2026-09-25T03:40:00Z', nextRefreshAt: '2027-01-01T00:00:00Z' }, true],
    ['unknown age', {}, true]
  ]) {
    await t.test(name, async () => {
      let requests = 0;
      const service = createUpdateService({
        sources: [sources[0]], now: () => new Date('2026-09-25T04:00:00Z'),
        cacheStore: createMemoryStore({ updates: [], ...cachedTimes }),
        fetchImpl: async url => { requests++; return makeResponse(url, htmlByHost[new URL(url).hostname]); }
      });
      await service.initialize();
      const result = service.refreshIfDue();
      assert.equal(result.started, expectedDue);
      await result.promise;
      assert.equal(requests, expectedDue ? 1 : 0);
    });
  }
});

test('a script comparison does not prevent discovery and caching of a new notice', async () => {
  const { createUpdateService } = loadService();
  const card = number => `<li><a href="/info/1024/${9200 + number}.htm">2027年硕士研究生招生公告第${number}号</a><time>2026-09-28</time></li>`;
  let html = card(1);
  let currentTime = '2026-09-28T04:00:00Z';
  const store = createMemoryStore();
  const service = createUpdateService({
    sources: [sources[0]], cacheStore: store,
    now: () => new Date(currentTime), delayImpl: async () => {},
    fetchImpl: async url => makeResponse(url, html)
  });
  const initial = await service.refresh();
  assert.equal(initial.status, 'fresh');
  html = '<script>const a=1,b=2;if(a < b) console.log(a);</script>' + card(1) + card(2);
  currentTime = '2026-09-28T04:10:00Z';
  const refreshed = await service.refresh();
  assert.equal(refreshed.status, 'fresh');
  assert.equal(refreshed.sources[0].ok, true);
  assert.deepEqual(refreshed.updates.map(item => item.url), [
    'https://gs.hainanu.edu.cn/info/1024/9201.htm',
    'https://gs.hainanu.edu.cn/info/1024/9202.htm'
  ]);
  assert.equal(refreshed.change.newCount, 1);
  assert.equal(store.writes.length, 2);
  assert.deepEqual(store.writes[1].updates.map(item => item.url), refreshed.updates.map(item => item.url));
});

test('a successful refresh combines both sources and persists a fresh snapshot', async () => {
  const { createUpdateService } = loadService();
  assert.equal(typeof createUpdateService, 'function', 'createUpdateService must be exported');

  const store = createMemoryStore();
  const fetchImpl = async (url) => makeResponse(url, htmlByHost[new URL(url).hostname]);
  const service = createUpdateService({
    sources,
    fetchImpl,
    cacheStore: store,
    now: () => new Date('2026-08-22T04:00:00.000Z'),
    refreshIntervalMs: 21_600_000
  });

  await service.initialize();
  const snapshot = await service.refresh();

  assert.equal(snapshot.status, 'fresh');
  assert.deepEqual(snapshot.freshness, {
    state: 'fresh', overdueSourceIds: [], worstSourceAgeMs: 0, ageMs: 0, isOverdue: false
  });
  assert.equal(snapshot.lastSuccessAt, '2026-08-22T04:00:00.000Z');
  assert.equal(snapshot.nextRefreshAt, '2026-08-22T10:00:00.000Z');
  assert.deepEqual(snapshot.sources.map(({ id, ok }) => ({ id, ok })), [
    { id: 'hnu-graduate', ok: true },
    { id: 'hnu-computer', ok: true }
  ]);
  assert.deepEqual(snapshot.updates.map((item) => item.title), [
    '海南大学2027年硕士研究生招生专业目录',
    '海南大学计算机科学与技术学院2026年硕士研究生复试录取工作实施细则'
  ]);
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].status, 'fresh');
});

test('a partial source failure retains that source cache and marks the snapshot stale', async () => {
  const { createUpdateService } = loadService();
  const cached = {
    status: 'fresh',
    fetchedAt: '2026-08-21T04:00:00.000Z',
    lastSuccessAt: '2026-08-21T04:00:00.000Z',
    nextRefreshAt: '2026-08-21T10:00:00.000Z',
    refreshIntervalMs: 21_600_000,
    sources: [],
    updates: [{
      id: 'cached-computer', title: '海南大学计算机学院2026年硕士复试旧缓存', date: '2026-03-20',
      url: 'https://cs.hainanu.edu.cn/info/1086/11111.htm', source: '海南大学计算机科学与技术学院',
      sourceId: 'hnu-computer', category: '复试录取', isTarget2027: false, isImportant: true
    }]
  };
  const store = createMemoryStore(cached);
  const fetchImpl = async (url) => {
    if (new URL(url).hostname === 'cs.hainanu.edu.cn') throw new Error('network offline');
    return makeResponse(url, htmlByHost['gs.hainanu.edu.cn']);
  };
  const service = createUpdateService({
    sources, fetchImpl, cacheStore: store,
    now: () => new Date('2026-08-22T04:00:00.000Z')
  });

  await service.initialize();
  const snapshot = await service.refresh();

  assert.equal(snapshot.status, 'stale');
  assert.equal(snapshot.lastSuccessAt, '2026-08-22T04:00:00.000Z');
  assert.deepEqual(snapshot.sources.map(({ id, ok }) => ({ id, ok })), [
    { id: 'hnu-graduate', ok: true },
    { id: 'hnu-computer', ok: false }
  ]);
  assert.deepEqual(snapshot.updates.map((item) => item.id), [
    snapshot.updates[0].id,
    'cached-computer'
  ]);
  assert.equal(store.writes.length, 1, 'partial success should become the new recoverable cache');
});

test('an all-source failure serves the last success without overwriting its disk cache', async () => {
  const { createUpdateService } = loadService();
  const cached = {
    status: 'fresh', fetchedAt: '2026-08-21T04:00:00.000Z', lastSuccessAt: '2026-08-21T04:00:00.000Z',
    nextRefreshAt: '2026-08-21T10:00:00.000Z', refreshIntervalMs: 21_600_000, sources: [],
    updates: [{ id: 'last-good', title: '海南大学2027年硕士研究生招生专业目录', date: '2026-09-25', url: 'https://gs.hainanu.edu.cn/info/1024/9000.htm', source: '海南大学研究生院', sourceId: 'hnu-graduate', category: '简章目录', isTarget2027: true, isImportant: true }]
  };
  const store = createMemoryStore(cached);
  const service = createUpdateService({
    sources,
    fetchImpl: async () => { throw new Error('timeout'); },
    cacheStore: store,
    now: () => new Date('2026-08-22T04:00:00.000Z')
  });

  await service.initialize();
  const snapshot = await service.refresh();

  assert.equal(snapshot.status, 'stale');
  assert.equal(snapshot.lastSuccessAt, '2026-08-21T04:00:00.000Z');
  assert.deepEqual(snapshot.updates.map((item) => item.id), ['last-good']);
  assert.match(snapshot.error, /2 个官方来源暂时不可用/);
  assert.equal(store.writes.length, 0);
});

test('concurrent refresh calls share one upstream request per source', async () => {
  const { createUpdateService } = loadService();
  const store = createMemoryStore();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async (url) => {
    calls += 1;
    await gate;
    return makeResponse(url, htmlByHost[new URL(url).hostname]);
  };
  const service = createUpdateService({ sources, fetchImpl, cacheStore: store });
  await service.initialize();

  const first = service.refresh();
  const second = service.refresh();
  assert.strictEqual(second, first);
  release();
  await Promise.all([first, second]);

  assert.equal(calls, 2);
  assert.equal(store.writes.length, 1);
});

test('concurrent initialization and refresh await one cache load before using state', async () => {
  const { createUpdateService } = loadService();
  let releaseLoad;
  const loadGate = new Promise((resolve) => { releaseLoad = resolve; });
  let loadCalls = 0;
  let fetchCalls = 0;
  const trustedCache = {
    schemaVersion: 2, fetchedAt: '2026-08-23T04:00:00.000Z', lastSuccessAt: '2026-08-23T04:00:00.000Z',
    sources: [{ id: sources[0].id, lastSuccessAt: '2026-08-23T04:00:00.000Z' }],
    updates: [{
      id: 'trusted-before-refresh', title: '海南大学2026年硕士研究生招生简章', date: '2026-08-20',
      url: 'https://gs.hainanu.edu.cn/info/1024/7001.htm', source: sources[0].name,
      sourceId: sources[0].id, category: '简章目录', isTarget2027: false, isImportant: true
    }]
  };
  const service = createUpdateService({
    sources: [sources[0]],
    fetchImpl: async () => { fetchCalls += 1; throw new Error('offline'); },
    cacheStore: {
      async load() { loadCalls += 1; await loadGate; return trustedCache; },
      async save() {}
    },
    delayImpl: async () => {},
    randomImpl: () => 0,
    now: () => new Date('2026-08-24T04:00:00.000Z')
  });

  const firstInitialize = service.initialize();
  const secondInitialize = service.initialize();
  const refresh = service.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  const fetchCallsBeforeLoad = fetchCalls;
  releaseLoad();
  const [, , refreshed] = await Promise.all([firstInitialize, secondInitialize, refresh]);

  assert.strictEqual(secondInitialize, firstInitialize);
  assert.equal(loadCalls, 1);
  assert.equal(fetchCallsBeforeLoad, 0);
  assert.deepEqual(refreshed.updates.map((update) => update.id), ['trusted-before-refresh']);
  assert.equal(refreshed.status, 'stale');
});

test('an HTTP 200 page with no recognizable notices is treated as a source failure', async () => {
  const { createUpdateService } = loadService();
  const singleSource = [sources[0]];
  const cached = {
    status: 'fresh', fetchedAt: '2026-08-21T04:00:00.000Z', lastSuccessAt: '2026-08-21T04:00:00.000Z',
    nextRefreshAt: '2026-08-21T10:00:00.000Z', refreshIntervalMs: 21_600_000, sources: [],
    updates: [{ id: 'last-good', title: '海南大学2027年硕士研究生招生专业目录', date: '2026-09-25', url: 'https://gs.hainanu.edu.cn/info/1024/9000.htm', source: '海南大学研究生院', sourceId: 'hnu-graduate', category: '简章目录', isTarget2027: true, isImportant: true }]
  };
  const store = createMemoryStore(cached);
  let calls = 0;
  const service = createUpdateService({
    sources: singleSource,
    fetchImpl: async (url) => { calls += 1; return makeResponse(url, '<html><body>网站改版中</body></html>'); },
    cacheStore: store,
    now: () => new Date('2026-08-22T04:00:00.000Z'),
    delayImpl: async () => {},
    randomImpl: () => 0
  });

  await service.initialize();
  const snapshot = await service.refresh();

  assert.equal(snapshot.status, 'stale');
  assert.equal(snapshot.sources[0].ok, false);
  assert.match(snapshot.sources[0].error, /未识别到招生通知/);
  assert.deepEqual(snapshot.updates.map((item) => item.id), ['last-good']);
  assert.equal(store.writes.length, 0);
  assert.equal(calls, 2);
  assert.equal(snapshot.sources[0].attempts, 2);
});

test('manual refresh preserves the actual next automatic timer deadline', async () => {
  const { createUpdateService } = loadService();
  const store = createMemoryStore();
  let currentTime = new Date('2026-08-22T04:00:00.000Z');
  let timerCallback;
  const service = createUpdateService({
    sources,
    fetchImpl: async (url) => makeResponse(url, htmlByHost[new URL(url).hostname]),
    cacheStore: store,
    now: () => currentTime,
    refreshIntervalMs: 21_600_000,
    setIntervalImpl(callback) { timerCallback = callback; return { unref() {} }; },
    clearIntervalImpl() {}
  });

  await service.initialize();
  service.startAutoRefresh();
  assert.equal(typeof timerCallback, 'function');
  assert.equal((await service.refresh()).nextRefreshAt, '2026-08-22T10:00:00.000Z');

  currentTime = new Date('2026-08-22T05:00:00.000Z');
  assert.equal((await service.refresh()).nextRefreshAt, '2026-08-22T10:00:00.000Z');
});

test('a refresh finishing after an automatic tick keeps the next automatic deadline', async () => {
  const { createUpdateService } = loadService();
  const store = createMemoryStore();
  let currentTime = new Date('2026-08-22T04:00:00.000Z');
  let timerCallback;
  let releaseFetch;
  const service = createUpdateService({
    sources: [sources[0]],
    fetchImpl: (url) => new Promise((resolve) => {
      releaseFetch = () => resolve(makeResponse(url, htmlByHost[new URL(url).hostname]));
    }),
    cacheStore: store,
    now: () => currentTime,
    refreshIntervalMs: 21_600_000,
    setIntervalImpl(callback) { timerCallback = callback; return { unref() {} }; },
    clearIntervalImpl() {}
  });

  await service.initialize();
  service.startAutoRefresh();
  const refresh = service.refresh();
  await new Promise((resolve) => setImmediate(resolve));

  currentTime = new Date('2026-08-22T10:00:00.000Z');
  timerCallback();
  releaseFetch();
  const snapshot = await refresh;

  assert.equal(snapshot.nextRefreshAt, '2026-08-22T16:00:00.000Z');
});
test('a refresh finishing after a cache-write overlap keeps the next automatic deadline', async () => {
  const { createUpdateService } = loadService();
  let currentTime = new Date('2026-08-22T04:00:00.000Z');
  let timerCallback;
  let releaseSave;
  const service = createUpdateService({
    sources: [sources[0]],
    fetchImpl: async (url) => makeResponse(url, htmlByHost[new URL(url).hostname]),
    cacheStore: {
      async load() { return null; },
      save() {
        return new Promise((resolve) => { releaseSave = resolve; });
      }
    },
    now: () => currentTime,
    refreshIntervalMs: 21_600_000,
    setIntervalImpl(callback) { timerCallback = callback; return { unref() {} }; },
    clearIntervalImpl() {}
  });

  await service.initialize();
  service.startAutoRefresh();
  const refresh = service.refresh();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(typeof releaseSave, 'function');
  currentTime = new Date('2026-08-22T10:00:00.000Z');
  timerCallback();
  releaseSave();
  const snapshot = await refresh;

  assert.equal(snapshot.nextRefreshAt, '2026-08-22T16:00:00.000Z');
});

test('a due refresh triggered by a snapshot read never publishes a past next-refresh deadline', async () => {
  const { createUpdateService } = loadService();
  const store = createMemoryStore();
  let currentTime = new Date('2026-08-22T04:00:00.000Z');
  let timerCallback;
  const service = createUpdateService({
    sources,
    fetchImpl: async (url) => makeResponse(url, htmlByHost[new URL(url).hostname]),
    cacheStore: store,
    now: () => currentTime,
    refreshIntervalMs: 21_600_000,
    setIntervalImpl(callback) { timerCallback = callback; return { unref() {} }; },
    clearIntervalImpl() {}
  });

  await service.initialize();
  service.startAutoRefresh();
  assert.equal(typeof timerCallback, 'function');

  // The clock passes the timer deadline before the tick has a chance to run.
  currentTime = new Date('2026-08-22T11:00:00.000Z');
  const due = service.refreshIfDue();
  assert.equal(due.started, true);
  const snapshot = await due.promise;

  assert.ok(Date.parse(snapshot.nextRefreshAt) > Date.parse(snapshot.fetchedAt));
});

test('rejects an upstream redirect that leaves Hainan University official domains', async () => {
  const { createUpdateService } = loadService();
  const cached = {
    status: 'fresh', fetchedAt: '2026-08-21T04:00:00.000Z', lastSuccessAt: '2026-08-21T04:00:00.000Z',
    nextRefreshAt: '2026-08-21T10:00:00.000Z', refreshIntervalMs: 21_600_000, sources: [],
    updates: [{ id: 'last-good', title: '海南大学2027年硕士研究生招生专业目录', date: '2026-09-25', url: 'https://gs.hainanu.edu.cn/info/1024/9000.htm', source: '海南大学研究生院', sourceId: 'hnu-graduate', category: '简章目录', isTarget2027: true, isImportant: true }]
  };
  const store = createMemoryStore(cached);
  let calls = 0;
  const service = createUpdateService({
    sources: [sources[0]],
    fetchImpl: async (url) => {
      calls += 1;
      return {
        ok: false,
        status: 302,
        statusText: 'Found',
        url,
        headers: new Headers({ location: 'https://evil.example/collect' }),
        text: async () => ''
      };
    },
    cacheStore: store
  });

  await service.initialize();
  const snapshot = await service.refresh();
  assert.equal(snapshot.status, 'stale');
  assert.match(snapshot.sources[0].error, /非官方域名/);
  assert.equal(calls, 1);
  assert.deepEqual(snapshot.updates.map((item) => item.id), ['last-good']);
});

test('rejects a declared oversized response before buffering its body', async () => {
  const { createUpdateService } = loadService();
  let textCalled = false;
  const service = createUpdateService({
    sources: [sources[0]],
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      url,
      headers: new Headers({
        'content-length': '3000000',
        'content-type': 'text/html; charset=utf-8'
      }),
      text: async () => { textCalled = true; return 'x'.repeat(3_000_000); }
    }),
    cacheStore: createMemoryStore()
  });

  await service.initialize();
  const snapshot = await service.refresh();
  assert.equal(snapshot.status, 'seed');
  assert.match(snapshot.sources[0].error, /响应过大/);
  assert.equal(textCalled, false);
});

test('sanitizes malformed cache entries before combining a partial refresh', async () => {
  const { createUpdateService } = loadService();
  const malformedCache = {
    status: 'fresh', fetchedAt: 'not-a-date', lastSuccessAt: '2026-08-21T04:00:00.000Z',
    nextRefreshAt: null, refreshIntervalMs: 'wrong', sources: 'wrong',
    updates: [
      null,
      { id: 'unsafe', title: '伪造通知', date: '2026-09-25', url: 'https://evil.example/notice', source: '未知', sourceId: 'evil' },
      { id: 'last-good', title: '海南大学计算机学院2026年硕士复试旧缓存', date: '2026-03-20', url: 'https://cs.hainanu.edu.cn/info/1086/11111.htm', source: '海南大学计算机科学与技术学院', sourceId: 'hnu-computer', category: '复试录取', isTarget2027: false, isImportant: true }
    ]
  };
  const store = createMemoryStore(malformedCache);
  const service = createUpdateService({
    sources,
    fetchImpl: async (url) => {
      if (new URL(url).hostname === 'cs.hainanu.edu.cn') throw new Error('offline');
      return makeResponse(url, htmlByHost['gs.hainanu.edu.cn']);
    },
    cacheStore: store,
    now: () => new Date('2026-08-22T04:00:00.000Z')
  });

  await service.initialize();
  const snapshot = await service.refresh();
  assert.equal(snapshot.status, 'stale');
  assert.deepEqual(snapshot.updates.map((item) => item.id), [snapshot.updates[0].id, 'last-good']);
  assert.equal(snapshot.updates.some((item) => item.id === 'unsafe'), false);
});

test('migrates a v1 cache without inventing a current discovery time', async () => {
  const { createUpdateService } = loadService();
  const cached = {
    status: 'fresh', fetchedAt: '2026-08-21T04:00:00.000Z', lastSuccessAt: null,
    sources: [],
    updates: [{
      id: 'legacy', title: '海南大学2026年硕士研究生招生简章', date: '2025-09-25',
      url: 'https://gs.hainanu.edu.cn/info/1024/7000.htm', source: '海南大学研究生院',
      sourceId: 'hnu-graduate', category: '简章目录', isTarget2027: false, isImportant: true
    }]
  };
  const service = createUpdateService({
    sources,
    fetchImpl: async () => { throw new Error('not used'); },
    cacheStore: createMemoryStore(cached),
    now: () => new Date('2026-08-23T04:00:00.000Z')
  });

  await service.initialize();
  assert.equal(service.getSnapshot().updates[0].discoveredAt, '2025-09-25T00:00:00.000Z');
});

test('retains a full historical cache when a new low-keyword notice arrives', async () => {
  const { createUpdateService } = loadService();
  const cachedUpdates = Array.from({ length: 30 }, (_, index) => ({
    id: `cached-${index}`,
    title: `海南大学计算机学院2026年硕士研究生复试公告第${index + 1}批`,
    date: '2026-03-20',
    url: `https://cs.hainanu.edu.cn/info/1086/${11000 + index}.htm`,
    source: '海南大学计算机科学与技术学院',
    sourceId: 'hnu-computer', category: '复试录取', isTarget2027: false, isImportant: true,
    discoveredAt: '2026-03-20T04:00:00.000Z'
  }));
  const cached = {
    schemaVersion: 2, status: 'fresh', fetchedAt: '2026-08-22T04:00:00.000Z',
    lastSuccessAt: '2026-08-22T04:00:00.000Z', sources: [], updates: cachedUpdates,
    change: { newCount: 0, newIds: [], changedAt: null }
  };
  const newHtml = '<li><a href="../info/1024/9999.htm">海南大学2026年硕士研究生招生工作说明</a><span>2026-08-23</span></li>';
  const service = createUpdateService({
    sources,
    fetchImpl: async (url) => {
      if (new URL(url).hostname === 'cs.hainanu.edu.cn') throw new Error('offline');
      return makeResponse(url, newHtml);
    },
    cacheStore: createMemoryStore(cached),
    now: () => new Date('2026-08-23T04:00:00.000Z'),
    delayImpl: async () => {}
  });

  await service.initialize();
  const snapshot = await service.refresh();
  const newNotice = snapshot.updates.find((update) => update.title === '海南大学2026年硕士研究生招生工作说明');
  assert.ok(newNotice, 'the new notice must be retained');
  assert.equal(snapshot.updates.length, 31, 'older source cache must not be displaced at the old 30-item boundary');
  assert.deepEqual(snapshot.change.newIds, [newNotice.id]);
});

test('retries one transient source failure and records the successful second attempt', async () => {
  const { createUpdateService } = loadService();
  let attempts = 0;
  const service = createUpdateService({
    sources: [sources[0]],
    fetchImpl: async (url) => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary reset');
      return makeResponse(url, htmlByHost['gs.hainanu.edu.cn']);
    },
    cacheStore: createMemoryStore(),
    now: () => new Date('2026-08-23T04:00:00.000Z'),
    delayImpl: async () => {}
  });

  await service.initialize();
  const snapshot = await service.refresh();

  assert.equal(snapshot.status, 'fresh');
  assert.equal(snapshot.sources[0].attempts, 2);
  assert.equal(snapshot.sources[0].lastSuccessAt, '2026-08-23T04:00:00.000Z');
  assert.equal(snapshot.nextRefreshAt, '2026-08-23T04:10:00.000Z');
  assert.equal(attempts, 2);
});

test('preserves discovery time and reports only genuinely new notice ids on later refreshes', async () => {
  const { createUpdateService } = loadService();
  let currentTime = new Date('2026-08-23T04:00:00.000Z');
  const store = createMemoryStore();
  const service = createUpdateService({
    sources: [sources[0]],
    fetchImpl: async (url) => makeResponse(url, htmlByHost['gs.hainanu.edu.cn']),
    cacheStore: store,
    now: () => currentTime
  });

  await service.initialize();
  const first = await service.refresh();
  const noticeId = first.updates[0].id;
  assert.equal(first.schemaVersion, 2);
  assert.equal(first.updates[0].discoveredAt, '2026-08-23T04:00:00.000Z');
  assert.deepEqual(first.change, {
    newCount: 1,
    newIds: [noticeId],
    updatedCount: 0,
    updatedIds: [],
    changedAt: '2026-08-23T04:00:00.000Z'
  });

  currentTime = new Date('2026-08-23T05:00:00.000Z');
  const second = await service.refresh();
  assert.equal(second.updates[0].discoveredAt, '2026-08-23T04:00:00.000Z');
  assert.deepEqual(second.change, {
    newCount: 0,
    newIds: [],
    updatedCount: 0,
    updatedIds: [],
    changedAt: '2026-08-23T04:00:00.000Z'
  });
});

test('marks an overdue snapshot and coalesces repeated due-refresh checks', async () => {
  const { createUpdateService } = loadService();
  let currentTime = new Date('2026-08-23T04:00:00.000Z');
  let fetchCalls = 0;
  let releaseDueFetch;
  const dueGate = new Promise((resolve) => { releaseDueFetch = resolve; });
  const service = createUpdateService({
    sources: [sources[0]],
    fetchImpl: async (url) => {
      fetchCalls += 1;
      if (fetchCalls > 1) await dueGate;
      return makeResponse(url, htmlByHost['gs.hainanu.edu.cn']);
    },
    cacheStore: createMemoryStore(),
    now: () => currentTime
  });

  await service.initialize();
  await service.refresh();
  currentTime = new Date('2026-08-23T06:00:00.000Z');

  assert.deepEqual(service.getSnapshot().freshness, {
    state: 'overdue',
    overdueSourceIds: ['hnu-graduate'],
    worstSourceAgeMs: 7_200_000,
    ageMs: 7_200_000,
    isOverdue: true
  });
  const first = service.refreshIfDue();
  const second = service.refreshIfDue();
  assert.equal(first.started, true);
  assert.equal(second.started, false);
  assert.strictEqual(second.promise, first.promise);
  assert.equal(fetchCalls, 1, 'the due refresh begins asynchronously after the current turn');

  await Promise.resolve();
  assert.equal(fetchCalls, 2);
  releaseDueFetch();
  await first.promise;
  assert.equal(service.getSnapshot().freshness.state, 'fresh');
});

test('freshness is aggregated from every configured source success time', async () => {
  const { createUpdateService } = loadService();
  const service = createUpdateService({
    sources,
    fetchImpl: async () => { throw new Error('not used'); },
    cacheStore: createMemoryStore({
      schemaVersion: 2,
      fetchedAt: '2026-08-24T04:00:00.000Z',
      lastSuccessAt: '2026-08-24T04:00:00.000Z',
      sources: [
        { id: 'hnu-graduate', lastSuccessAt: '2026-08-24T04:00:00.000Z' },
        { id: 'hnu-computer', lastSuccessAt: '2026-08-24T02:00:00.000Z' }
      ],
      updates: []
    }),
    now: () => new Date('2026-08-24T04:00:00.000Z'),
    refreshIntervalMs: 3_600_000
  });

  await service.initialize();
  const snapshot = service.getSnapshot();

  assert.deepEqual(snapshot.sources.map(({ id, freshness, ageMs, isOverdue }) => ({ id, freshness, ageMs, isOverdue })), [
    { id: 'hnu-graduate', freshness: 'fresh', ageMs: 0, isOverdue: false },
    { id: 'hnu-computer', freshness: 'overdue', ageMs: 7_200_000, isOverdue: true }
  ]);
  assert.deepEqual(snapshot.freshness, {
    state: 'overdue',
    overdueSourceIds: ['hnu-computer'],
    worstSourceAgeMs: 7_200_000,
    ageMs: 7_200_000,
    isOverdue: true
  });
});

test('aggregate never freshness does not report a misleading successful-source age', async () => {
  const { createUpdateService } = loadService();
  const service = createUpdateService({
    sources,
    fetchImpl: async () => { throw new Error('not used'); },
    cacheStore: createMemoryStore({
      schemaVersion: 2,
      fetchedAt: '2026-08-24T04:00:00.000Z',
      lastSuccessAt: '2026-08-24T04:00:00.000Z',
      sources: [{ id: 'hnu-graduate', lastSuccessAt: '2026-08-24T04:00:00.000Z' }],
      updates: []
    }),
    now: () => new Date('2026-08-24T04:00:00.000Z'),
    refreshIntervalMs: 3_600_000
  });

  await service.initialize();
  const snapshot = service.getSnapshot();

  assert.equal(snapshot.sources[0].ageMs, 0);
  assert.equal(snapshot.sources[1].freshness, 'never');
  assert.deepEqual(snapshot.freshness, {
    state: 'never',
    overdueSourceIds: ['hnu-computer'],
    worstSourceAgeMs: null,
    ageMs: null,
    isOverdue: true
  });
});

test('each drift gate retries once then preserves the trusted source cache as degraded', async (t) => {
  const { createUpdateService } = loadService();
  const makeUpdate = (index, date = '2026-08-01') => ({
    id: `legacy-${index}`,
    contentHash: `hash-${index}`,
    title: `海南大学2026年硕士研究生招生简章第${index}号`,
    date,
    url: `https://gs.hainanu.edu.cn/info/1024/${8000 + index}.htm`,
    source: sources[0].name,
    sourceId: sources[0].id,
    category: '简章目录',
    isTarget2027: false,
    isImportant: true,
    discoveredAt: '2026-08-01T04:00:00.000Z'
  });
  const card = (path, title, date) => `<li><a href="${path}">${title}</a><span>${date}</span></li>`;
  const cases = [
    {
      name: 'count drop',
      currentCount: 3,
      prior: Array.from({ length: 10 }, (_, index) => makeUpdate(index)),
      html: Array.from({ length: 3 }, (_, index) => card(`/info/1024/${8000 + index}.htm`, `海南大学2026年硕士研究生招生简章第${index}号`, '2026-08-01')).join('')
    },
    {
      name: 'URL disappearance',
      currentCount: 3,
      prior: Array.from({ length: 5 }, (_, index) => makeUpdate(index)),
      html: [
        card('/info/1024/8000.htm', '海南大学2026年硕士研究生招生简章第0号', '2026-08-01'),
        card('/info/1024/9001.htm', '海南大学2026年硕士研究生招生简章新1号', '2026-08-02'),
        card('/info/1024/9002.htm', '海南大学2026年硕士研究生招生简章新2号', '2026-08-03')
      ].join('')
    },
    {
      name: 'publication rollback',
      currentCount: 1,
      prior: [makeUpdate(0, '2026-08-01')],
      html: card('/info/1024/8000.htm', '海南大学2026年硕士研究生招生简章第0号', '2026-03-01')
    }
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      let calls = 0;
      const events = [];
      const store = createMemoryStore({
        schemaVersion: 2,
        fetchedAt: '2026-08-01T04:00:00.000Z',
        lastSuccessAt: '2026-08-01T04:00:00.000Z',
        sources: [{ id: sources[0].id, lastSuccessAt: '2026-08-01T04:00:00.000Z' }],
        updates: fixture.prior
      });
      const service = createUpdateService({
        sources: [sources[0]],
        fetchImpl: async (url) => { calls += 1; return makeResponse(url, fixture.html); },
        cacheStore: store,
        now: () => new Date('2026-08-24T04:00:00.000Z'),
        delayImpl: async () => {},
        randomImpl: () => 0,
        onRefreshEvent: (event) => events.push(event)
      });

      await service.initialize();
      const snapshot = await service.refresh();

      assert.equal(calls, 2);
      assert.equal(snapshot.sources[0].ok, false);
      assert.equal(snapshot.sources[0].degraded, true);
      assert.match(snapshot.sources[0].error, /疑似/);
      assert.equal(events[0].sources[0].count, fixture.currentCount);
      assert.deepEqual(snapshot.updates.map((update) => update.url).sort(), fixture.prior.map((update) => update.url).sort());
      assert.equal(store.writes.length, 0);
    });
  }
});

test('a legitimate prune of old notices does not trip the drift gate', async () => {
  const { createUpdateService } = loadService();
  const makeUpdate = (index, date) => ({
    id: `legacy-${index}`,
    contentHash: `hash-${index}`,
    title: `海南大学2026年硕士研究生招生简章第${index}号`,
    date,
    url: `https://gs.hainanu.edu.cn/info/1024/${8000 + index}.htm`,
    source: sources[0].name,
    sourceId: sources[0].id,
    category: '简章目录',
    isTarget2027: false,
    isImportant: true,
    discoveredAt: '2026-03-01T04:00:00.000Z'
  });
  const card = (path, title, date) => `<li><a href="${path}">${title}</a><span>${date}</span></li>`;
  const prior = Array.from({ length: 10 }, (_, index) => makeUpdate(index, '2026-03-01'));
  const html = Array.from({ length: 3 }, (_, index) => (
    card(`/info/1024/${8000 + index}.htm`, `海南大学2026年硕士研究生招生简章第${index}号`, '2026-08-01')
  )).join('');
  let calls = 0;
  const store = createMemoryStore({
    schemaVersion: 2,
    fetchedAt: '2026-08-01T04:00:00.000Z',
    lastSuccessAt: '2026-08-01T04:00:00.000Z',
    sources: [{ id: sources[0].id, lastSuccessAt: '2026-08-01T04:00:00.000Z' }],
    updates: prior
  });
  const service = createUpdateService({
    sources: [sources[0]],
    fetchImpl: async (url) => { calls += 1; return makeResponse(url, html); },
    cacheStore: store,
    now: () => new Date('2026-08-24T04:00:00.000Z')
  });

  await service.initialize();
  const snapshot = await service.refresh();

  assert.equal(calls, 1);
  assert.equal(snapshot.sources[0].ok, true);
  assert.equal(snapshot.status, 'fresh');
  assert.equal(snapshot.updates.length, 10, '3 fresh notices plus the 7 pruned ones kept as missing history');
  assert.equal(snapshot.updates.filter((update) => update.missingSince).length, 7);
  assert.equal(store.writes.length, 1);
});

test('same source URL title edit keeps one record and reports an update rather than a discovery', async () => {
  const { createUpdateService } = loadService();
  const url = 'https://gs.hainanu.edu.cn/info/1024/9555.htm';
  const service = createUpdateService({
    sources: [sources[0]],
    fetchImpl: async (requestedUrl) => makeResponse(requestedUrl,
      '<li><a href="../info/1024/9555.htm">海南大学2026年硕士研究生招生简章（修订版）</a><span>2026-08-20</span></li>'),
    cacheStore: createMemoryStore({
      schemaVersion: 2,
      fetchedAt: '2026-08-20T04:00:00.000Z',
      lastSuccessAt: '2026-08-20T04:00:00.000Z',
      sources: [{ id: sources[0].id, lastSuccessAt: '2026-08-20T04:00:00.000Z' }],
      updates: [{
        id: 'legacy-title-derived-id', contentHash: 'old-content',
        title: '海南大学2026年硕士研究生招生简章', date: '2026-08-20', url,
        source: sources[0].name, sourceId: sources[0].id, category: '简章目录',
        isTarget2027: false, isImportant: true,
        discoveredAt: '2026-07-01T04:00:00.000Z', updatedAt: '2026-07-02T04:00:00.000Z'
      }]
    }),
    now: () => new Date('2026-08-24T04:00:00.000Z')
  });

  await service.initialize();
  const snapshot = await service.refresh();

  assert.equal(snapshot.updates.length, 1);
  assert.notEqual(snapshot.updates[0].id, 'legacy-title-derived-id');
  assert.equal(snapshot.updates[0].url, url);
  assert.equal(snapshot.updates[0].discoveredAt, '2026-07-01T04:00:00.000Z');
  assert.equal(snapshot.updates[0].lastSeenAt, '2026-08-24T04:00:00.000Z');
  assert.equal(snapshot.updates[0].updatedAt, '2026-08-24T04:00:00.000Z');
  assert.equal(snapshot.updates[0].changeType, 'updated');
  assert.deepEqual(snapshot.change, {
    newCount: 0,
    newIds: [],
    updatedCount: 1,
    updatedIds: [snapshot.updates[0].id],
    changedAt: '2026-08-24T04:00:00.000Z'
  });
});

test('trusted shrink marks history missing, reappearance clears it, and age or cycle limits expire it', async () => {
  const { createUpdateService } = loadService();
  const makeCached = (number, extra = {}) => ({
    id: `legacy-${number}`, contentHash: `hash-${number}`,
    title: `海南大学2026年硕士研究生招生简章第${number}号`, date: '2026-08-20',
    url: `https://gs.hainanu.edu.cn/info/1024/${9600 + number}.htm`,
    source: sources[0].name, sourceId: sources[0].id, category: '简章目录',
    isTarget2027: false, isImportant: true, discoveredAt: '2026-07-01T04:00:00.000Z',
    ...extra
  });
  const render = (...numbers) => numbers.map((number) =>
    `<li><a href="../info/1024/${9600 + number}.htm">海南大学2026年硕士研究生招生简章第${number}号</a><span>2026-08-20</span></li>`).join('');
  let currentTime = new Date('2026-08-24T04:00:00.000Z');
  let html = render(1);
  const service = createUpdateService({
    sources: [sources[0]],
    fetchImpl: async (url) => makeResponse(url, html),
    cacheStore: createMemoryStore({
      schemaVersion: 2, fetchedAt: '2026-08-20T04:00:00.000Z', lastSuccessAt: '2026-08-20T04:00:00.000Z',
      sources: [{ id: sources[0].id, lastSuccessAt: '2026-08-20T04:00:00.000Z' }],
      updates: [
        makeCached(1),
        makeCached(2),
        makeCached(3, { missingSince: '2026-08-23T04:00:00.000Z', missCount: 168 })
      ]
    }),
    now: () => currentTime
  });

  await service.initialize();
  const shrunk = await service.refresh();
  const missing = shrunk.updates.find((update) => update.url.endsWith('/9602.htm'));
  assert.equal(missing.missingSince, '2026-08-24T04:00:00.000Z');
  assert.equal(missing.missCount, 1);
  assert.equal(shrunk.updates.some((update) => update.url.endsWith('/9603.htm')), false, '169th miss expires history');

  html = render(1, 2);
  currentTime = new Date('2026-08-25T04:00:00.000Z');
  const reappeared = await service.refresh();
  const seenAgain = reappeared.updates.find((update) => update.url.endsWith('/9602.htm'));
  assert.equal(seenAgain.missingSince, undefined);
  assert.equal(seenAgain.missCount, undefined);

  html = render(1);
  currentTime = new Date('2026-08-26T04:00:00.000Z');
  await service.refresh();
  currentTime = new Date('2026-11-25T04:00:00.001Z');
  const expired = await service.refresh();
  assert.equal(expired.updates.some((update) => update.url.endsWith('/9602.htm')), false, 'more than 90 missing days expires history');
});

test('every current-refresh discovery survives the 120 item capacity cap', async () => {
  const { createUpdateService } = loadService();
  const cachedUpdates = Array.from({ length: 120 }, (_, index) => ({
    id: `cached-target-${index}`, contentHash: `cached-hash-${index}`,
    title: `海南大学2027年硕士研究生复试公告第${index + 1}批`, date: '2026-12-31',
    url: `https://cs.hainanu.edu.cn/info/1086/${12000 + index}.htm`,
    source: sources[1].name, sourceId: sources[1].id, category: '复试录取',
    isTarget2027: true, isImportant: true, discoveredAt: '2026-08-01T04:00:00.000Z'
  }));
  const service = createUpdateService({
    sources,
    fetchImpl: async (url) => {
      if (new URL(url).hostname === 'cs.hainanu.edu.cn') throw new Error('offline');
      return makeResponse(url, '<li><a href="../info/1024/9777.htm">海南大学2026年硕士研究生招生工作说明</a><span>2026-08-24</span></li>');
    },
    cacheStore: createMemoryStore({
      schemaVersion: 2, fetchedAt: '2026-08-23T04:00:00.000Z', lastSuccessAt: '2026-08-23T04:00:00.000Z',
      sources: [{ id: sources[1].id, lastSuccessAt: '2026-08-23T04:00:00.000Z' }], updates: cachedUpdates
    }),
    now: () => new Date('2026-08-24T04:00:00.000Z'),
    delayImpl: async () => {}
  });

  await service.initialize();
  const snapshot = await service.refresh();

  assert.equal(snapshot.updates.length, 120);
  assert.equal(snapshot.updates.some((update) => update.url.endsWith('/9777.htm')), true);
  assert.equal(snapshot.change.newCount, 1);
  assert.equal(snapshot.change.newIds.length, 1);
});

test('capacity identity keeps the same normalized URL from distinct sources', async () => {
  const { createUpdateService } = loadService();
  const overlappingSources = [
    { id: 'hnu-graduate-list', name: '海南大学研究生院列表', url: 'https://gs.hainanu.edu.cn/yjszs/ssszs.htm' },
    { id: 'hnu-graduate-home', name: '海南大学研究生院首页', url: 'https://gs.hainanu.edu.cn/' },
    sources[1]
  ];
  const cachedUpdates = Array.from({ length: 119 }, (_, index) => ({
    id: `computer-${index}`, contentHash: `computer-hash-${index}`,
    title: `海南大学计算机学院2027年硕士研究生复试公告第${index + 1}批`, date: '2026-12-31',
    url: `https://cs.hainanu.edu.cn/info/1086/${13000 + index}.htm`,
    source: sources[1].name, sourceId: sources[1].id, category: '复试录取',
    isTarget2027: true, isImportant: true, discoveredAt: '2026-08-01T04:00:00.000Z'
  }));
  const sharedHtml = '<li><a href="https://gs.hainanu.edu.cn/info/1024/9990.htm#section">海南大学2026年硕士研究生招生简章</a><span>2026-08-24</span></li>';
  const service = createUpdateService({
    sources: overlappingSources,
    fetchImpl: async (url) => {
      if (new URL(url).hostname === 'cs.hainanu.edu.cn') throw new Error('offline');
      return makeResponse(url, sharedHtml);
    },
    cacheStore: createMemoryStore({
      schemaVersion: 2, fetchedAt: '2026-08-23T04:00:00.000Z', lastSuccessAt: '2026-08-23T04:00:00.000Z',
      sources: [{ id: sources[1].id, lastSuccessAt: '2026-08-23T04:00:00.000Z' }], updates: cachedUpdates
    }),
    now: () => new Date('2026-08-24T04:00:00.000Z'),
    delayImpl: async () => {},
    randomImpl: () => 0
  });

  await service.initialize();
  const snapshot = await service.refresh();
  const sharedRecords = snapshot.updates.filter((update) => update.url === 'https://gs.hainanu.edu.cn/info/1024/9990.htm');

  assert.equal(snapshot.updates.length, 120);
  assert.deepEqual(sharedRecords.map((update) => update.sourceId).sort(), ['hnu-graduate-home', 'hnu-graduate-list']);
  assert.equal(snapshot.change.newIds.length, 2);
  assert.equal(snapshot.change.newIds.every((id) => snapshot.updates.some((update) => update.id === id)), true);
  assert.deepEqual([...new Set(snapshot.updates.map((update) => update.sourceId))].sort(),
    ['hnu-computer', 'hnu-graduate-home', 'hnu-graduate-list']);
});

test('HTTP 429 honors a bounded Retry-After delay and records the actual delay', async () => {
  const { createUpdateService } = loadService();
  const delays = [];
  let calls = 0;
  const service = createUpdateService({
    sources: [sources[0]],
    fetchImpl: async (url) => {
      calls += 1;
      if (calls === 1) return {
        ok: false, status: 429, url,
        headers: new Headers({ 'content-type': 'text/html', 'retry-after': '99' }),
        text: async () => ''
      };
      return makeResponse(url, htmlByHost['gs.hainanu.edu.cn']);
    },
    cacheStore: createMemoryStore(),
    now: () => new Date('2026-08-24T04:00:00.000Z'),
    delayImpl: async (milliseconds) => { delays.push(milliseconds); },
    randomImpl: () => 0
  });

  await service.initialize();
  const snapshot = await service.refresh();

  assert.deepEqual(delays, [10_000]);
  assert.equal(snapshot.sources[0].retryDelayMs, 10_000);
  assert.equal(snapshot.sources[0].attempts, 2);
  assert.equal(snapshot.sources[0].ok, true);
});

test('HTTP 429 distinguishes missing, HTTP-date, and explicit zero Retry-After values', async (t) => {
  const { createUpdateService } = loadService();
  const cases = [
    { name: 'missing header uses configured delay', retryAfter: undefined, expected: 625 },
    { name: 'HTTP-date uses delta from checked time', retryAfter: 'Mon, 24 Aug 2026 04:00:03 GMT', expected: 3_000 },
    { name: 'explicit zero retries immediately', retryAfter: '0', expected: 0 }
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const delays = [];
      let calls = 0;
      const headers = { 'content-type': 'text/html' };
      if (fixture.retryAfter !== undefined) headers['retry-after'] = fixture.retryAfter;
      const service = createUpdateService({
        sources: [sources[0]],
        fetchImpl: async (url) => {
          calls += 1;
          if (calls === 1) return {
            ok: false, status: 429, url, headers: new Headers(headers), text: async () => ''
          };
          return makeResponse(url, htmlByHost['gs.hainanu.edu.cn']);
        },
        cacheStore: createMemoryStore(),
        now: () => new Date('2026-08-24T04:00:00.000Z'),
        retryDelayMs: 625,
        delayImpl: async (milliseconds) => { delays.push(milliseconds); },
        randomImpl: () => 0
      });

      await service.initialize();
      const snapshot = await service.refresh();
      assert.deepEqual(delays, [fixture.expected]);
      assert.equal(snapshot.sources[0].retryDelayMs, fixture.expected);
    });
  }
});

test('file cache recovers a corrupt primary from backup and exposes unrecoverable corruption', async (t) => {
  const { createFileCacheStore, createUpdateService } = loadService();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hnu-cache-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cachePath = path.join(directory, 'updates.json');
  const store = createFileCacheStore(cachePath);
  const snapshot = {
    schemaVersion: 2, fetchedAt: '2026-08-20T04:00:00.000Z', lastSuccessAt: '2026-08-20T04:00:00.000Z',
    sources: [{ id: sources[0].id, lastSuccessAt: '2026-08-20T04:00:00.000Z' }],
    updates: [{
      id: 'trusted', title: '海南大学2026年硕士研究生招生简章', date: '2026-08-20',
      url: 'https://gs.hainanu.edu.cn/info/1024/9888.htm', source: sources[0].name,
      sourceId: sources[0].id, category: '简章目录', isTarget2027: false, isImportant: true
    }]
  };
  await store.save(snapshot);
  await store.save({ ...snapshot, fetchedAt: '2026-08-21T04:00:00.000Z' });
  await fs.writeFile(cachePath, '{broken', 'utf8');

  const recoveredService = createUpdateService({
    sources: [sources[0]], fetchImpl: async () => { throw new Error('not used'); }, cacheStore: store,
    now: () => new Date('2026-08-24T04:00:00.000Z')
  });
  await recoveredService.initialize();
  const recovered = recoveredService.getSnapshot();
  assert.deepEqual(recovered.updates.map((update) => update.id), ['trusted']);
  assert.match(recovered.error, /备份/);

  await fs.writeFile(`${cachePath}.bak`, '{also broken', 'utf8');
  const failedService = createUpdateService({
    sources: [sources[0]], fetchImpl: async () => { throw new Error('not used'); }, cacheStore: store,
    now: () => new Date('2026-08-24T04:00:00.000Z')
  });
  await failedService.initialize();
  const failed = failedService.getSnapshot();
  assert.equal(failed.status, 'seed');
  assert.deepEqual(failed.updates, []);
  assert.match(failed.error, /缓存.*损坏/);
});

test('file cache reports a missing primary separately when the backup is also broken', async (t) => {
  const { createFileCacheStore } = loadService();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hnu-cache-missing-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cachePath = path.join(directory, 'updates.json');
  await fs.writeFile(`${cachePath}.bak`, '{broken backup', 'utf8');

  await assert.rejects(createFileCacheStore(cachePath).load(), (error) => (
    error.code === 'CACHE_CORRUPTION' && /主缓存缺失.*备份.*损坏/.test(error.message)
  ));
});

test('recovered cache never lets a corrupt primary overwrite the only trusted backup', async (t) => {
  const { createFileCacheStore } = loadService();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hnu-cache-promotion-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cachePath = path.join(directory, 'updates.json');
  const trusted = { schemaVersion: 2, marker: 'trusted-backup', updates: [] };
  const newer = { schemaVersion: 2, marker: 'new-primary', updates: [] };
  const promoted = { schemaVersion: 2, marker: 'promoted', updates: [] };
  const normalStore = createFileCacheStore(cachePath);
  await normalStore.save(trusted);
  await normalStore.save(newer);
  await fs.writeFile(cachePath, '{corrupt primary', 'utf8');

  const failingStore = createFileCacheStore(cachePath, {
    renameImpl: async () => { throw new Error('promotion blocked'); }
  });
  const recovered = await failingStore.load();
  assert.equal(recovered.cacheSnapshot.marker, 'trusted-backup');
  await assert.rejects(failingStore.save(promoted), /promotion blocked/);

  const afterFailedPromotion = await normalStore.load();
  assert.equal(afterFailedPromotion.cacheSnapshot.marker, 'trusted-backup');
  assert.equal(JSON.parse(await fs.readFile(`${cachePath}.bak`, 'utf8')).marker, 'trusted-backup');

  await normalStore.save(promoted);
  assert.equal(JSON.parse(await fs.readFile(cachePath, 'utf8')).marker, 'promoted');
  assert.equal(JSON.parse(await fs.readFile(`${cachePath}.bak`, 'utf8')).marker, 'trusted-backup');
});

test('refresh completion events and success clocks distinguish partial from all-source success', async () => {
  const { createUpdateService } = loadService();
  let currentTime = new Date('2026-08-24T04:00:00.000Z');
  let computerFails = true;
  const events = [];
  const service = createUpdateService({
    sources,
    fetchImpl: async (url) => {
      const host = new URL(url).hostname;
      if (host === 'cs.hainanu.edu.cn' && computerFails) throw new Error('offline');
      return makeResponse(url, htmlByHost[host]);
    },
    cacheStore: createMemoryStore(),
    now: () => currentTime,
    delayImpl: async () => {},
    randomImpl: () => 0,
    onRefreshEvent(event) {
      events.push(structuredClone(event));
      throw new Error('logger unavailable');
    }
  });

  await service.initialize();
  assert.deepEqual(service.getSnapshot().change, {
    newCount: 0, newIds: [], updatedCount: 0, updatedIds: [], changedAt: null
  });
  const partial = await service.refresh();
  assert.equal(partial.lastAttemptAt, '2026-08-24T04:00:00.000Z');
  assert.equal(partial.lastAnySuccessAt, '2026-08-24T04:00:00.000Z');
  assert.equal(partial.lastSuccessAt, partial.lastAnySuccessAt);
  assert.equal(partial.lastAllSuccessAt, null);
  assert.deepEqual(events[0], {
    type: 'refresh-complete', durationMs: 0, status: 'stale', cacheSaved: true,
    newCount: 1, updatedCount: 0,
    sources: [
      {
        id: 'hnu-graduate', attempts: 1, count: 1, degraded: false,
        diagnostics: { candidateCount: 1, relevantCount: 1, containerTypes: ['li'] }, error: null
      },
      { id: 'hnu-computer', attempts: 2, count: 0, degraded: false, diagnostics: null, error: 'offline' }
    ]
  });

  computerFails = false;
  currentTime = new Date('2026-08-24T05:00:00.000Z');
  const complete = await service.refresh();
  assert.equal(complete.lastAttemptAt, '2026-08-24T05:00:00.000Z');
  assert.equal(complete.lastAnySuccessAt, '2026-08-24T05:00:00.000Z');
  assert.equal(complete.lastAllSuccessAt, '2026-08-24T05:00:00.000Z');
  assert.equal(events.length, 2);
  assert.equal(events[1].status, 'fresh');
  assert.equal(events[1].cacheSaved, true);
});

test('scheduled refresh failures are surfaced to the server error callback', async () => {
  let timerCallback;
  const errors = [];
  const { createUpdateService } = loadService();
  const service = createUpdateService({
    sources: [sources[0]],
    fetchImpl: async () => { throw new Error('network reset'); },
    cacheStore: createMemoryStore(),
    delayImpl: async () => { throw new Error('scheduled retry failed'); },
    setIntervalImpl(callback) { timerCallback = callback; return { unref() {} }; },
    clearIntervalImpl() {},
    onRefreshError(error) { errors.push(error.message); }
  });

  await service.initialize();
  service.startAutoRefresh();
  timerCallback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(errors, ['scheduled retry failed']);
});

test('every refresh emits one completion event when retry waiting or upstream fetch rejects', async (t) => {
  const { createUpdateService } = loadService();

  await t.test('retry wait rejects', async () => {
    const events = [];
    const service = createUpdateService({
      sources: [sources[0]],
      fetchImpl: async () => { throw new Error('network reset'); },
      cacheStore: createMemoryStore(),
      delayImpl: async () => { throw new Error('retry wait failed'); },
      onRefreshEvent: (event) => events.push(event)
    });
    await service.initialize();

    await assert.rejects(service.refresh(), /retry wait failed/);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'refresh-complete');
    assert.equal(events[0].status, 'error');
    assert.equal(events[0].cacheSaved, false);
    assert.deepEqual(events[0].sources, [{
      id: 'hnu-graduate', attempts: 1, count: 0, degraded: false, diagnostics: null, error: 'retry wait failed'
    }]);
  });

  await t.test('upstream fetch rejects', async () => {
    const events = [];
    const service = createUpdateService({
      sources: [sources[0]],
      fetchImpl: async () => { throw new Error('upstream rejected'); },
      cacheStore: createMemoryStore(),
      delayImpl: async () => {},
      randomImpl: () => 0,
      onRefreshEvent: (event) => events.push(event)
    });
    await service.initialize();

    const snapshot = await service.refresh();
    assert.equal(snapshot.status, 'seed');
    assert.equal(events.length, 1);
    assert.equal(events[0].sources[0].error, 'upstream rejected');
  });
});

test('fatal multi-source refresh waits for every source before completion and keeps in-flight coalescing', async () => {
  const { createUpdateService } = loadService();
  let releaseComputer;
  const computerGate = new Promise((resolve) => { releaseComputer = resolve; });
  const fetchCalls = { graduate: 0, computer: 0 };
  const events = [];
  const service = createUpdateService({
    sources,
    fetchImpl: async (url) => {
      if (new URL(url).hostname === 'gs.hainanu.edu.cn') {
        fetchCalls.graduate += 1;
        throw new Error('graduate network reset');
      }
      fetchCalls.computer += 1;
      await computerGate;
      return {
        ok: false,
        status: 302,
        url,
        headers: new Headers({ location: 'https://evil.example/collect' }),
        text: async () => ''
      };
    },
    cacheStore: createMemoryStore(),
    delayImpl: async () => { throw new Error('graduate retry wait failed'); },
    randomImpl: () => 0,
    onRefreshEvent: (event) => events.push(event)
  });
  await service.initialize();

  let firstSettled = false;
  const first = service.refresh();
  const firstOutcome = first.then(
    () => ({ status: 'fulfilled' }),
    (error) => ({ status: 'rejected', error })
  );
  firstOutcome.then(() => { firstSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  const completionCountBeforeComputer = events.length;
  const firstSettledBeforeComputer = firstSettled;
  const callsBeforeSecondRefresh = { ...fetchCalls };

  const second = service.refresh();
  const secondSharesFirst = second === first;
  const secondOutcome = secondSharesFirst
    ? firstOutcome
    : second.then(() => ({ status: 'fulfilled' }), (error) => ({ status: 'rejected', error }));
  await new Promise((resolve) => setImmediate(resolve));
  const callsAfterSecondRefresh = { ...fetchCalls };
  releaseComputer();
  const [firstResult, secondResult] = await Promise.all([firstOutcome, secondOutcome]);

  assert.equal(completionCountBeforeComputer, 0);
  assert.equal(firstSettledBeforeComputer, false);
  assert.deepEqual(callsBeforeSecondRefresh, { graduate: 1, computer: 1 });
  assert.equal(secondSharesFirst, true);
  assert.deepEqual(callsAfterSecondRefresh, { graduate: 1, computer: 1 });
  assert.equal(firstResult.status, 'rejected');
  assert.equal(secondResult.status, 'rejected');
  assert.match(firstResult.error.message, /graduate retry wait failed/);
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'error');
  assert.deepEqual(events[0].sources, [
    { id: 'hnu-graduate', attempts: 1, count: 0, degraded: false, diagnostics: null, error: 'graduate retry wait failed' },
    { id: 'hnu-computer', attempts: 1, count: 0, degraded: false, diagnostics: null, error: '官网重定向指向非官方域名，已拒绝' }
  ]);
});

test('async refresh event callback rejection is isolated without an unhandled rejection', async (t) => {
  const { createUpdateService } = loadService();
  const unhandled = [];
  let callbackCalls = 0;
  const onUnhandled = (error) => unhandled.push(error.message);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const service = createUpdateService({
    sources: [sources[0]],
    fetchImpl: async (url) => makeResponse(url, htmlByHost['gs.hainanu.edu.cn']),
    cacheStore: createMemoryStore(),
    onRefreshEvent: async () => {
      callbackCalls += 1;
      throw new Error('async logger failed');
    }
  });

  await service.initialize();
  const snapshot = await service.refresh();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(snapshot.status, 'fresh');
  assert.equal(callbackCalls, 1);
  assert.deepEqual(unhandled, []);
});

test('file cache treats parseable but structurally invalid snapshots as corruption and protects a trusted backup', async (t) => {
  const { createFileCacheStore } = loadService();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hnu-semantic-cache-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const cachePath = path.join(directory, 'updates-cache.json');
  const backupPath = `${cachePath}.bak`;
  const trustedLegacy = { updates: [] };

  await fs.writeFile(cachePath, '{}\n', 'utf8');
  await fs.writeFile(backupPath, `${JSON.stringify(trustedLegacy)}\n`, 'utf8');
  const recovered = await createFileCacheStore(cachePath).load();
  assert.deepEqual(recovered.cacheSnapshot, trustedLegacy);
  assert.match(recovered.recoveryWarning, /损坏|备份/);

  await fs.writeFile(cachePath, '[]\n', 'utf8');
  await fs.writeFile(backupPath, '{"updates":{}}\n', 'utf8');
  await assert.rejects(createFileCacheStore(cachePath).load(), (error) => error.code === 'CACHE_CORRUPTION');

  const trustedBackup = { schemaVersion: 2, updates: [{ id: 'backup-kept' }] };
  await fs.writeFile(cachePath, '{"updates":"not-an-array"}\n', 'utf8');
  await fs.writeFile(backupPath, `${JSON.stringify(trustedBackup)}\n`, 'utf8');
  await createFileCacheStore(cachePath).save({ schemaVersion: 2, updates: [] });
  assert.deepEqual(JSON.parse(await fs.readFile(backupPath, 'utf8')), trustedBackup);
});

test('parser diagnostics are validated, persisted per source, and included in completion summaries', async () => {
  const { createUpdateService } = loadService();
  const events = [];
  const notice = {
    id: 'diagnostic-notice', contentHash: 'content-v1', title: '海南大学2027年硕士研究生招生简章',
    date: '2026-09-25', url: 'https://gs.hainanu.edu.cn/info/1024/9300.htm',
    source: sources[0].name, sourceId: sources[0].id, category: '简章目录', isTarget2027: true, isImportant: true
  };
  const diagnostics = { candidateCount: 3, relevantCount: 1, containerTypes: ['li'] };
  const service = createUpdateService({
    sources: [sources[0]],
    fetchImpl: async (url) => makeResponse(url, '<html></html>'),
    parseDocument: () => ({ updates: [notice], diagnostics }),
    cacheStore: createMemoryStore(),
    onRefreshEvent: (event) => events.push(event)
  });

  await service.initialize();
  const snapshot = await service.refresh();

  assert.deepEqual(snapshot.sources[0].diagnostics, diagnostics);
  assert.deepEqual(snapshot.sources[0].lastTrustedDiagnostics, diagnostics);
  assert.deepEqual(events[0].sources[0].diagnostics, diagnostics);
});

test('invalid parser diagnostics and complete container-type drift retry then retain trusted source state', async (t) => {
  const { createUpdateService } = loadService();
  const cachedNotice = {
    id: 'trusted-notice', contentHash: 'trusted-hash', title: '海南大学2027年硕士研究生招生简章',
    date: '2026-09-25', url: 'https://gs.hainanu.edu.cn/info/1024/9301.htm',
    source: sources[0].name, sourceId: sources[0].id, category: '简章目录', isTarget2027: true, isImportant: true
  };
  const trustedDiagnostics = { candidateCount: 2, relevantCount: 1, containerTypes: ['li'] };
  const cached = {
    schemaVersion: 2, status: 'fresh', fetchedAt: '2026-08-23T04:00:00.000Z',
    lastAnySuccessAt: '2026-08-23T04:00:00.000Z', lastSuccessAt: '2026-08-23T04:00:00.000Z',
    sources: [{ id: sources[0].id, lastSuccessAt: '2026-08-23T04:00:00.000Z', diagnostics: trustedDiagnostics, lastTrustedDiagnostics: trustedDiagnostics }],
    updates: [cachedNotice]
  };

  const fixtures = [
    {
      name: 'diagnostic counts contradict parsed updates',
      parsed: { updates: [cachedNotice], diagnostics: { candidateCount: 1, relevantCount: 0, containerTypes: ['li'] } },
      error: /诊断|计数/,
      expectedParseCalls: 2
    },
    {
      name: 'all trusted container types disappear',
      parsed: { updates: [cachedNotice], diagnostics: { candidateCount: 1, relevantCount: 1, containerTypes: ['div'] } },
      error: /容器|结构/,
      expectedParseCalls: 1
    }
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      let parseCalls = 0;
      const store = createMemoryStore(cached);
      const service = createUpdateService({
        sources: [sources[0]],
        fetchImpl: async (url) => makeResponse(url, '<html></html>'),
        parseDocument() { parseCalls += 1; return fixture.parsed; },
        cacheStore: store,
        now: () => new Date('2026-08-24T04:00:00.000Z'),
        delayImpl: async () => {}, randomImpl: () => 0
      });

      await service.initialize();
      const snapshot = await service.refresh();

      assert.equal(parseCalls, fixture.expectedParseCalls);
      assert.equal(snapshot.status, 'stale');
      assert.equal(snapshot.sources[0].ok, false);
      assert.equal(snapshot.sources[0].degraded, true);
      assert.match(snapshot.sources[0].error, fixture.error);
      assert.equal(snapshot.sources[0].lastSuccessAt, '2026-08-23T04:00:00.000Z');
      assert.deepEqual(snapshot.sources[0].lastTrustedDiagnostics, trustedDiagnostics);
      assert.deepEqual(snapshot.updates.map((update) => update.id), ['trusted-notice']);
      assert.equal(store.writes.length, 0);
    });
  }
});

test('missing history clears a transient updated marker', async () => {
  const { createUpdateService } = loadService();
  let html = '<li><a href="../info/1024/9400.htm">海南大学2027年硕士研究生招生简章（修订）</a><span>2026-09-26</span></li>';
  const cached = {
    schemaVersion: 2, status: 'fresh', fetchedAt: '2026-08-23T04:00:00.000Z', lastSuccessAt: '2026-08-23T04:00:00.000Z',
    sources: [],
    updates: [{
      id: 'stable-old-id', contentHash: 'old-content', title: '海南大学2027年硕士研究生招生简章',
      date: '2026-09-25', url: 'https://gs.hainanu.edu.cn/info/1024/9400.htm', source: sources[0].name,
      sourceId: sources[0].id, category: '简章目录', isTarget2027: true, isImportant: true
    }]
  };
  const service = createUpdateService({
    sources: [sources[0]], fetchImpl: async (url) => makeResponse(url, html), cacheStore: createMemoryStore(cached),
    now: () => new Date('2026-08-24T04:00:00.000Z')
  });

  await service.initialize();
  const first = await service.refresh();
  assert.equal(first.updates.find((update) => update.url.endsWith('/9400.htm')).changeType, 'updated');

  html = '<li><a href="../info/1024/9401.htm">海南大学2027年硕士研究生招生专业目录</a><span>2026-09-27</span></li>';
  const second = await service.refresh();
  const missing = second.updates.find((update) => update.url.endsWith('/9400.htm'));
  assert.equal(missing.missCount, 1);
  assert.equal(Object.hasOwn(missing, 'changeType'), false);
});

test('new-id telemetry references only retained discoveries and reports capacity discards', async () => {
  const { createUpdateService } = loadService();
  const html = Array.from({ length: 125 }, (_, index) => (
    `<li><a href="../info/1024/${9500 + index}.htm">海南大学2027年硕士研究生招生公告${index + 1}</a><span>2026-09-25</span></li>`
  )).join('');
  const service = createUpdateService({
    sources: [sources[0]], fetchImpl: async (url) => makeResponse(url, html), cacheStore: createMemoryStore(),
    now: () => new Date('2026-08-24T04:00:00.000Z')
  });

  await service.initialize();
  const snapshot = await service.refresh();
  const retainedIds = new Set(snapshot.updates.map((update) => update.id));

  assert.equal(snapshot.updates.length, 120);
  assert.equal(snapshot.change.newCount, 120);
  assert.equal(snapshot.change.discardedNewCount, 5);
  assert.equal(snapshot.change.newIds.every((id) => retainedIds.has(id)), true);
});
