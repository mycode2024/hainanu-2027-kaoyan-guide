const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

function loadServer() {
  try {
    delete require.cache[require.resolve('../src/http-app.cjs')];
    return require('../src/http-app.cjs');
  } catch {
    return {};
  }
}

test('refresh summaries are formatted as one-line JSON records', () => {
  delete require.cache[require.resolve('../server.cjs')];
  const { formatRefreshLog } = require('../server.cjs');
  const line = formatRefreshLog({
    type: 'refresh-complete', status: 'stale', cacheSaved: true,
    durationMs: 12, newCount: 1, updatedCount: 0, sources: []
  });

  assert.equal(line.includes('\n'), false);
  assert.deepEqual(JSON.parse(line), {
    event: 'official-refresh', type: 'refresh-complete', status: 'stale', cacheSaved: true,
    durationMs: 12, newCount: 1, updatedCount: 0, sources: []
  });
});

function rawRequest(port, pathname, method = 'GET', body = '', headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        ...headers,
        ...(body ? { 'content-length': Buffer.byteLength(body) } : {})
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

function createServiceDouble() {
  let snapshot = {
    status: 'seed', fetchedAt: '2026-08-22T04:00:00.000Z', lastSuccessAt: null,
    lastAttemptAt: '2026-08-22T03:59:00.000Z', lastAllSuccessAt: null,
    nextRefreshAt: '2026-08-22T10:00:00.000Z', refreshIntervalMs: 21_600_000,
    sources: [], updates: [], error: null,
    freshness: { state: 'never', overdueSourceIds: ['hnu-graduate'], worstSourceAgeMs: null, ageMs: null, isOverdue: true }
  };
  let refreshCalls = 0;
  let dueRefreshCalls = 0;
  return {
    get refreshCalls() { return refreshCalls; },
    get dueRefreshCalls() { return dueRefreshCalls; },
    getSnapshot() { return snapshot; },
    refreshIfDue() {
      dueRefreshCalls += 1;
      return { started: false, promise: null };
    },
    async refresh() {
      refreshCalls += 1;
      snapshot = { ...snapshot, status: 'fresh', lastSuccessAt: '2026-08-22T04:01:00.000Z' };
      return snapshot;
    }
  };
}

test('the live backend serves all focused pages and their short aliases', async (t) => {
  const { createHttpServer } = loadServer();
  const server = createHttpServer({ siteRoot: path.resolve(__dirname, '..'), updateService: createServiceDouble() });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  for (const page of ['programs', 'scores', 'preparation', 'timeline', 'application', 'materials', 'updates', 'sources']) {
    for (const suffix of ['', '.html']) {
      const response = await rawRequest(server.address().port, `/${page}${suffix}`);
      assert.equal(response.status, 200, `/${page}${suffix}`);
      assert.match(response.body, new RegExp(`data-page="${page}"`));
    }
  }
});

test('a snapshot read starts an overdue refresh without delaying the response', async (t) => {
  const { createHttpServer } = loadServer();
  let resolveRefresh;
  const pendingRefresh = new Promise((resolve) => { resolveRefresh = resolve; });
  let dueRefreshCalls = 0;
  const updateService = {
    getSnapshot: () => ({ status: 'stale', updates: [] }),
    refresh: async () => ({ status: 'fresh', updates: [] }),
    refreshIfDue() {
      dueRefreshCalls += 1;
      return { started: true, promise: pendingRefresh };
    }
  };
  const server = createHttpServer({ siteRoot: path.resolve(__dirname, '..'), updateService });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/updates`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'stale');
  assert.equal(dueRefreshCalls, 1);
  resolveRefresh();
});

test('serves the live snapshot and manual refresh over JSON APIs', async (t) => {
  const { createHttpServer } = loadServer();
  assert.equal(typeof createHttpServer, 'function', 'createHttpServer must be exported');

  const updateService = createServiceDouble();
  const server = createHttpServer({ siteRoot: path.resolve(__dirname, '..'), updateService });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(Number.isInteger(healthBody.uptimeSeconds), true);
  assert.deepEqual({ ...healthBody, uptimeSeconds: 0 }, {
    product: 'hainanu-2027-kaoyan-guide',
    schemaVersion: 2,
    live: true,
    ready: false,
    uptimeSeconds: 0,
    status: 'seed',
    lastAttemptAt: '2026-08-22T03:59:00.000Z',
    lastAllSuccessAt: null,
    overdueSourceIds: ['hnu-graduate']
  });
  const healthHead = await fetch(`${base}/api/health`, { method: 'HEAD' });
  assert.equal(healthHead.status, 200);
  assert.equal(await healthHead.text(), '');

  const before = await fetch(`${base}/api/updates`);
  assert.equal(before.status, 200);
  assert.equal(before.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal((await before.json()).status, 'seed');

  const refreshed = await fetch(`${base}/api/refresh`, {
    method: 'POST',
    headers: { 'x-hnu-guide-request': '1', origin: base }
  });
  assert.equal(refreshed.status, 200);
  assert.equal((await refreshed.json()).status, 'fresh');
  assert.equal(updateService.refreshCalls, 1);
});

test('keeps the existing static guide available with HEAD support', async (t) => {
  const { createHttpServer } = loadServer();
  const server = createHttpServer({
    siteRoot: path.resolve(__dirname, '..'),
    updateService: createServiceDouble()
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(await page.text(), /海南大学 2027 计算机 408 考研航线图/);

  const head = await fetch(`${base}/styles.css`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('serves each named guide page through canonical and extension aliases', async (t) => {
  const { createHttpServer } = loadServer();
  const siteRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hnu-guide-routes-'));
  t.after(() => fs.promises.rm(siteRoot, { recursive: true, force: true }));

  const files = [
    ['index.html', 'page-home'],
    ['programs.html', 'page-programs'],
    ['timeline.html', 'page-timeline'],
    ['application.html', 'page-application'],
    ['updates.html', 'page-updates']
  ];
  await Promise.all(files.map(([file, marker]) => fs.promises.writeFile(
    path.join(siteRoot, file), `<html><body>${marker}</body></html>`, 'utf8'
  )));

  const server = createHttpServer({ siteRoot, updateService: createServiceDouble() });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
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

  for (const [pathname, file, marker] of pages) {
    const response = await fetch(`${base}${pathname}`);
    assert.equal(response.status, 200, `${pathname} should serve ${file}`);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(await response.text(), new RegExp(marker));

    const head = await fetch(`${base}${pathname}`, { method: 'HEAD' });
    assert.equal(head.status, 200, `${pathname} HEAD should succeed`);
    assert.equal(await head.text(), '');
  }

  const wrongMethod = await fetch(`${base}/timeline`, { method: 'POST' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET, HEAD');
});

test('rejects unsupported API methods and does not expose project internals', async (t) => {
  const { createHttpServer } = loadServer();
  const server = createHttpServer({
    siteRoot: path.resolve(__dirname, '..'),
    updateService: createServiceDouble()
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  const wrongMethod = await rawRequest(port, '/api/refresh', 'GET');
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, 'POST');

  const internalFile = await rawRequest(port, '/server.cjs');
  assert.equal(internalFile.status, 404);

  const traversal = await rawRequest(port, '/%2e%2e/server.cjs');
  assert.equal(traversal.status, 403);
});

test('returns JSON 413 instead of resetting the connection for an oversized refresh body', async (t) => {
  const { createHttpServer } = loadServer();
  const server = createHttpServer({
    siteRoot: path.resolve(__dirname, '..'),
    updateService: createServiceDouble()
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await new Promise((resolve, reject) => {
    const body = 'x'.repeat(2048);
    const request = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: '/api/refresh',
      method: 'POST',
      headers: {
        'content-length': Buffer.byteLength(body),
        'x-hnu-guide-request': '1',
        origin: `http://127.0.0.1:${server.address().port}`
      }
    }, (incoming) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(body);
  });
  assert.equal(response.status, 413);
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(response.body), { error: 'Request body too large' });
});

test('blocks cross-site or unmarked requests from triggering an official refresh', async (t) => {
  const { createHttpServer } = loadServer();
  const updateService = createServiceDouble();
  const server = createHttpServer({ siteRoot: path.resolve(__dirname, '..'), updateService });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const unmarked = await fetch(`${base}/api/refresh`, { method: 'POST' });
  assert.equal(unmarked.status, 403);

  const crossSite = await fetch(`${base}/api/refresh`, {
    method: 'POST',
    headers: {
      'x-hnu-guide-request': '1',
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site'
    }
  });
  assert.equal(crossSite.status, 403);
  assert.equal(updateService.refreshCalls, 0);
});

test('manual refresh rejects DNS rebinding and missing origins, then enforces a bounded cooldown', async (t) => {
  const { createHttpServer } = loadServer();
  const updateService = createServiceDouble();
  let currentTime = 1_000_000;
  const server = createHttpServer({
    siteRoot: path.resolve(__dirname, '..'),
    updateService,
    manualRefreshCooldownMs: 2_000,
    now: () => currentTime
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const localOrigin = `http://127.0.0.1:${port}`;
  const marker = { 'x-hnu-guide-request': '1' };

  const rebinding = await rawRequest(port, '/api/refresh', 'POST', '', {
    ...marker,
    host: `attacker.test:${port}`,
    origin: `http://attacker.test:${port}`
  });
  assert.equal(rebinding.status, 403);

  const missingOrigin = await rawRequest(port, '/api/refresh', 'POST', '', marker);
  assert.equal(missingOrigin.status, 403);

  const mismatch = await rawRequest(port, '/api/refresh', 'POST', '', {
    ...marker,
    origin: `http://127.0.0.1:${port + 1}`
  });
  assert.equal(mismatch.status, 403);

  const legitimate = await rawRequest(port, '/api/refresh', 'POST', '', { ...marker, origin: localOrigin });
  assert.equal(legitimate.status, 200);

  const throttled = await rawRequest(port, '/api/refresh', 'POST', '', { ...marker, origin: localOrigin });
  assert.equal(throttled.status, 429);
  assert.ok(Number(throttled.headers['retry-after']) >= 1);
  assert.ok(Number(throttled.headers['retry-after']) <= 60);
  assert.equal(updateService.refreshCalls, 1);

  currentTime += 2_001;
  const afterCooldown = await rawRequest(port, '/api/refresh', 'POST', '', { ...marker, origin: localOrigin });
  assert.equal(afterCooldown.status, 200);
  assert.equal(updateService.refreshCalls, 2);
});

test('manual refresh supports default HTTP port headers while rejecting mismatched origins', async t => {
  const { createRequestHandler } = loadServer();
  const cases = [
    ['IPv4 browser headers', 80, '127.0.0.1', 'http://127.0.0.1', 200],
    ['localhost browser headers', 80, 'localhost', 'http://localhost', 200],
    ['explicit Host port', 80, '127.0.0.1:80', 'http://127.0.0.1', 200],
    ['explicit Origin port', 80, 'localhost', 'http://localhost:80', 200],
    ['both explicit ports', 80, 'localhost:80', 'http://localhost:80', 200],
    ['nondefault port', 4173, '127.0.0.1:4173', 'http://127.0.0.1:4173', 200],
    ['wrong Host port', 80, '127.0.0.1:4173', 'http://127.0.0.1', 403],
    ['wrong Origin port', 80, '127.0.0.1', 'http://127.0.0.1:4173', 403],
    ['omitted nondefault Host port', 4173, 'localhost', 'http://localhost:4173', 403],
    ['omitted nondefault Origin port', 4173, 'localhost:4173', 'http://localhost', 403],
    ['untrusted host', 80, 'attacker.test', 'http://attacker.test', 403],
    ['untrusted origin', 80, 'localhost', 'http://attacker.test', 403],
    ['wrong scheme', 80, 'localhost', 'https://localhost', 403],
    ['missing origin', 80, 'localhost', undefined, 403],
    ['missing marker', 80, 'localhost', 'http://localhost', 403, { 'x-hnu-guide-request': undefined }],
    ['cross-site request', 80, 'localhost', 'http://localhost', 403, { 'sec-fetch-site': 'cross-site' }]
  ];
  for (const [name, port, host, origin, expectedStatus, extraHeaders = {}] of cases) {
    await t.test(name, async () => {
      const service = createServiceDouble();
      const handler = createRequestHandler({
        siteRoot: path.resolve(__dirname, '..'), updateService: service, manualRefreshCooldownMs: 0
      });
      // Exercise port 80 without binding a privileged or already occupied port.
      const request = {
        url: '/api/refresh', method: 'POST', socket: { localPort: port }, readableEnded: true,
        headers: { host, origin, 'x-hnu-guide-request': '1', ...extraHeaders }, resume() {}
      };
      const response = {
        headersSent: false,
        writeHead(status) { this.status = status; this.headersSent = true; },
        end(body) { this.body = body; }
      };
      await handler(request, response);
      assert.equal(response.status, expectedStatus);
      assert.equal(service.refreshCalls, expectedStatus === 200 ? 1 : 0);
      if (expectedStatus === 200) assert.equal(JSON.parse(response.body).status, 'fresh');
    });
  }
});

test('health distinguishes a live process from trusted-data readiness', async (t) => {
  const { createHttpServer } = loadServer();
  let snapshot = { status: 'seed', updates: [], freshness: { overdueSourceIds: [] } };
  const updateService = {
    getSnapshot: () => snapshot,
    refresh: async () => snapshot
  };
  const server = createHttpServer({ siteRoot: path.resolve(__dirname, '..'), updateService });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const seed = await (await fetch(`${base}/api/health`)).json();
  assert.equal(seed.live, true);
  assert.equal(seed.ready, false);

  snapshot = {
    status: 'stale',
    updates: [{ id: 'trusted-cache' }],
    lastAnySuccessAt: '2026-08-23T04:00:00.000Z',
    freshness: { overdueSourceIds: ['hnu-graduate'] }
  };
  const stale = await (await fetch(`${base}/api/health`)).json();
  assert.equal(stale.live, true);
  assert.equal(stale.ready, true);
});
