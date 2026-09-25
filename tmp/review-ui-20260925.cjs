const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createHttpServer } = require('../src/http-app.cjs');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'artifacts', 'ui-review-20260925');
fs.mkdirSync(out, { recursive: true });
const phase = process.argv[2] || 'after';
const snapshot = {
  status: 'fresh', schemaVersion: 2, fetchedAt: new Date().toISOString(),
  lastSuccessAt: new Date().toISOString(), refreshIntervalMs: 600000,
  freshness: { state: 'fresh', ageMs: 0, isOverdue: false },
  sources: [{ id: 'hnu', name: '海南大学研究生院', url: 'https://gs.hainanu.edu.cn/', ok: true }],
  updates: Array.from({ length: 12 }, (_, i) => ({
    id: `qa-${i}`, title: `排版测试公告 ${i + 1}：海南大学 2027 年硕士研究生招生考试报名与材料准备事项说明`,
    date: '2026-09-25', url: `https://gs.hainanu.edu.cn/info/qa-${i}.htm`,
    source: '海南大学研究生院', sourceId: 'hnu', category: '招生动态'
  }))
};
const server = createHttpServer({ siteRoot: root, updateService: {
  getSnapshot: () => snapshot, refreshIfDue: () => ({ started: false, promise: null }),
  refresh: async () => snapshot
} });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hnu-ui-review-'));
let child, ws;
const pending = new Map();
let id = 0;
let session;
const errors = [];
function send(method, params = {}, scoped = true) {
  return new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Timeout: ${method}`)); }, 15000);
    pending.set(requestId, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: requestId, method, params, ...(scoped && session ? { sessionId: session } : {}) }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, `${phase}-${name}.png`), Buffer.from(data, 'base64'));
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = await new Promise((resolve, reject) => {
    child = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Browser exited: ${code}`)));
    child.stderr.on('data', data => { stderr += data; const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/); if (match) resolve(match[1]); });
  });
  ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = event => {
    const data = JSON.parse(event.data);
    if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails);
    const task = pending.get(data.id);
    if (!task) return;
    pending.delete(data.id); clearTimeout(task.timer);
    data.error ? task.reject(new Error(JSON.stringify(data.error))) : task.resolve(data.result);
  };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, false);
  session = (await send('Target.attachToTarget', { targetId, flatten: true }, false)).sessionId;
  await send('Page.enable'); await send('Runtime.enable');
  const report = [];
  for (const width of phase === 'interactions' ? [] : [1440, 1024, 768, 390, 320]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const page of ['index', 'programs', 'scores', 'preparation', 'timeline', 'application', 'materials', 'updates', 'sources']) {
      const url = `http://127.0.0.1:${server.address().port}/${page}.html`;
      await send('Page.navigate', { url });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await evaluate(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete' && (!document.querySelector('#live-updates-console') || document.querySelector('#live-updates-console').dataset.state === 'fresh')`)) break;
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      report.push({ width, page, ...await evaluate(`(() => {
        const overflow = [...document.querySelectorAll('body *')].filter(el => {
          if (el.closest('.score-table-wrap, .page-toc, .skip-link, .sr-only')) return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && (rect.right > innerWidth + 1 || rect.left < -1);
        }).slice(0, 12).map(el => el.className || el.tagName);
        return { scrollWidth: document.documentElement.scrollWidth, overflow,
          footer: document.querySelector('.site-footer p').textContent,
          noticeWidth: document.querySelector('.official-update-copy')?.getBoundingClientRect().width,
          noticeFont: document.querySelector('.official-update-copy h3') && getComputedStyle(document.querySelector('.official-update-copy h3')).fontSize };
      })()`) });
      if ([1440, 390].includes(width) && ['index', 'programs', 'updates'].includes(page)) {
        await screenshot(`${page}-${width}`);
        if (page === 'updates') {
          await evaluate(`document.querySelector('.official-updates-list').scrollIntoView({ block: 'start', behavior: 'instant' })`);
          await screenshot(`notices-${width}`);
        }
      }
    }
  }
  if (phase === 'interactions') {
    const assert = require('node:assert/strict');
    async function visit(page) {
      const url = `http://127.0.0.1:${server.address().port}/${page}.html`;
      await send('Page.navigate', { url });
      for (let n = 0; n < 100; n++) {
        if (await evaluate(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete' && (!document.querySelector('#live-updates-console') || document.querySelector('#live-updates-console').dataset.state === 'fresh')`)) return;
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      throw new Error(`Page did not load: ${page}`);
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
    await visit('programs');
    await evaluate(`document.querySelector('[data-site-nav-toggle]').click()`);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-site-nav-menu]')).display`), 'grid');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    assert.equal(await evaluate(`document.querySelector('[data-site-nav-toggle]').getAttribute('aria-expanded')`), 'false');
    await evaluate(`document.querySelector('.task-check').click()`);
    await visit('materials');
    await evaluate(`document.querySelector('.task-check').click()`);
    await visit('index');
    assert.equal(await evaluate(`document.querySelector('#progress-count').textContent`), '2 / 21 项');
    await visit('programs');
    assert.equal(await evaluate(`document.querySelector('.task-check').checked`), true);
    assert.equal(await evaluate(`document.querySelector('.task-check').closest('label').dataset.printState`), '已完成');
    await visit('timeline');
    await evaluate(`document.querySelector('[data-filter="exam"]').click()`);
    const categories = await evaluate(`[...document.querySelectorAll('[data-milestone-id]:not([hidden])')].map(el => el.dataset.category)`);
    assert.ok(categories.length > 0 && categories.every(value => value === 'exam'));
    await visit('updates');
    assert.equal(await evaluate(`document.querySelectorAll('.official-updates-list > li').length`), 8);
    await evaluate(`document.querySelector('#updates-next').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('.official-updates-list > li').length`), 4);
    await evaluate(`document.querySelector('[data-updates-filter="new"]').click()`);
    assert.match(await evaluate(`document.querySelector('.official-updates-list').textContent`), /没有/);
    await evaluate(`document.querySelector('[data-updates-filter="all"]').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('.official-updates-list > li').length`), 8);
    await send('Emulation.setEmulatedMedia', { media: 'print' });
    const print = await evaluate(`({ toc: getComputedStyle(document.querySelector('.page-toc')).display, description: getComputedStyle(document.querySelector('.page-hero > div > p:last-child')).color })`);
    assert.equal(print.toc, 'none');
    assert.equal(print.description, 'rgb(68, 68, 68)');
    await send('Emulation.setEmulatedMedia', { media: 'screen' });
    await visit('index');
    const reset = evaluate(`document.querySelector('#reset-progress').click()`);
    await new Promise(resolve => setTimeout(resolve, 100));
    await send('Page.handleJavaScriptDialog', { accept: true });
    await reset;
    assert.equal(await evaluate(`document.querySelector('#progress-count').textContent`), '0 / 21 项');
    report.push({ interactions: 'mobile menu, Escape, cross-page checklist, printable checked state, timeline filters, notice pagination and filters, print styles, global reset: passed' });
  }
  fs.writeFileSync(path.join(out, `${phase}-report.json`), JSON.stringify({ report, errors }, null, 2));
  console.log(JSON.stringify({ pagesChecked: report.filter(r => r.page).length, interactions: report.filter(r => r.interactions), overflow: report.filter(r => r.overflow?.length), errors, output: out }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (ws?.readyState === WebSocket.OPEN) { await send('Browser.close', {}, false).catch(() => {}); ws.close(); }
  child?.kill(); server.closeAllConnections(); server.close();
});
