const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

async function host(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

function service() {
  let snapshot = { status: 'seed', updates: [], sources: [] };
  return {
    initialized: false, refreshes: 0,
    async initialize() { this.initialized = true; },
    getSnapshot() { return snapshot; },
    async refresh() { this.refreshes++; snapshot = { status: 'fresh', updates: [{ id: 'notice' }], sources: [] }; return snapshot; },
    refreshIfDue() { return { started: true, promise: this.refresh() }; },
    startAutoRefresh() { throw new Error('A serverless entry must not start a background timer'); }
  };
}

function post(base, origin, headers = {}, body = '') {
  return new Promise((resolve, reject) => {
    const request = http.request(`${base}/api/index?endpoint=refresh`, { method: 'POST', headers: {
      host: 'guide.vercel.app', origin, 'x-hnu-guide-request': '1', ...headers
    } }, response => { response.resume(); response.on('end', () => resolve(response)); });
    request.on('error', reject);
    request.end(body);
  });
}

test('Vercel entry exports a callable handler without starting a listener', () => {
  const before = process._getActiveHandles().filter(handle => handle instanceof http.Server).length;
  const handler = require('../api/index.js');
  assert.equal(typeof handler, 'function');
  assert.equal(process._getActiveHandles().filter(handle => handle instanceof http.Server).length, before);
});

test('cloud GET waits for due refresh and cloud POST accepts only configured HTTPS origins', async t => {
  const { createVercelHandler } = require('../src/vercel-app.cjs');
  const { getTrustedOrigins } = require('../src/vercel-app.cjs');
  assert.deepEqual(getTrustedOrigins({ VERCEL_URL: 'guide.vercel.app', VERCEL_BRANCH_URL: 'hnu-feature-abc.vercel.app', VERCEL_PROJECT_PRODUCTION_URL: 'guide-prod.vercel.app' }), [
    'https://guide.vercel.app', 'https://hnu-feature-abc.vercel.app', 'https://guide-prod.vercel.app'
  ]);
  const updateService = service();
  const handler = createVercelHandler({ updateService, env: { VERCEL_URL: 'guide.vercel.app' } });
  const base = await host(t, handler);
  const initial = await fetch(`${base}/api/index?endpoint=updates`);
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).status, 'fresh');
  assert.equal(updateService.initialized, true);
  for (const origin of ['https://evil.example', 'https://guide.vercel.app.evil.example', 'http://guide.vercel.app', 'null']) {
    const response = await post(base, origin);
    assert.equal(response.statusCode, 403, origin);
  }
  for (const headers of [{ host: 'evil.example' }, { 'sec-fetch-site': 'cross-site' }, { 'x-hnu-guide-request': '' }, { origin: '' }]) {
    assert.equal((await post(base, 'https://guide.vercel.app', headers)).statusCode, 403);
  }
  const response = await post(base, 'https://guide.vercel.app');
  assert.equal(response.statusCode, 200);
  const limited = await post(base, 'https://guide.vercel.app');
  assert.equal(limited.statusCode, 429);
  assert.equal(updateService.refreshes, 2);
  assert.equal((await fetch(`${base}/api/index?endpoint=unknown`)).status, 404);
});

test('a platform-consumed request body completes normally and still enforces the size limit', async t => {
  const { createVercelHandler } = require('../src/vercel-app.cjs');
  const updateService = service();
  const handler = createVercelHandler({ updateService, env: { VERCEL_URL: 'guide.vercel.app' } });
  const base = await host(t, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    request.body = Buffer.concat(chunks);
    await handler(request, response);
  });
  assert.equal((await post(base, 'https://guide.vercel.app')).statusCode, 200);
  assert.equal((await post(base, 'https://guide.vercel.app', { 'content-length': '1025' }, 'x'.repeat(1025))).statusCode, 413);
  assert.equal(updateService.refreshes, 1);
});

test('cloud initialization failure returns JSON and can recover on a later invocation', async t => {
  const { createVercelHandler } = require('../src/vercel-app.cjs');
  const updateService = service();
  let attempts = 0;
  updateService.initialize = async () => { if (++attempts === 1) throw new Error('temporary failure'); };
  const base = await host(t, createVercelHandler({ updateService, env: {} }));
  const response = await fetch(`${base}/api/index?endpoint=health`);
  assert.equal(response.status, 503);
  assert.match(response.headers.get('content-type'), /json/);
  assert.equal((await fetch(`${base}/api/index?endpoint=health`)).status, 200);
});

test('first cloud visit fetches notices even though a new seed has a future refresh deadline', async t => {
  const { createVercelHandler } = require('../src/vercel-app.cjs');
  const updateService = service();
  updateService.refreshIfDue = () => ({ started: false, promise: null });
  const base = await host(t, createVercelHandler({ updateService, env: {} }));
  assert.equal((await (await fetch(`${base}/api/index?endpoint=updates`)).json()).status, 'fresh');
  assert.equal(updateService.refreshes, 1);
});

test('cloud cache stays outside the read-only deployment directory', () => {
  const { getVercelCachePath } = require('../src/vercel-app.cjs');
  assert.ok(getVercelCachePath().startsWith(path.join(os.tmpdir(), 'hnu-guide')));
  assert.ok(!getVercelCachePath().startsWith(path.join(root, 'data')));
});

test('Vercel static build publishes only website files with truthful cloud copy', async t => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'hnu-public-test-'));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  execFileSync(process.execPath, [path.join(root, 'scripts/build-vercel.cjs'), output], { cwd: root });
  const files = await fs.readdir(output);
  assert.deepEqual(files.sort(), ['app.js', 'styles.css', 'index.html', 'programs.html', 'scores.html', 'preparation.html', 'timeline.html', 'application.html', 'materials.html', 'updates.html', 'sources.html'].sort());
  for (const file of files.filter(file => file.endsWith('.html'))) {
    const html = await fs.readFile(path.join(output, file), 'utf8');
    assert.match(html, /data-hosting="vercel"/);
    assert.doesNotMatch(html, /本地 Node\.js 服务运行时才会|电脑关机期间无法抓取/);
  }
});
