'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createHttpServer } = require('../src/http-app.cjs');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'artifacts', 'card-navigation');
fs.mkdirSync(out, { recursive: true });
const snapshot = { status: 'fresh', lastSuccessAt: new Date().toISOString(), sources: [],
  updates: Array.from({ length: 12 }, (_, i) => ({ id: `qa-${i}`, title: `2027 年硕士研究生报名通知 ${i + 1}`,
    date: '2026-10-13', url: `https://gs.hainanu.edu.cn/info/qa-${i}.htm`, source: '海南大学研究生院', sourceId: 'hnu', category: '报名确认' })) };
const server = createHttpServer({ siteRoot: root, updateService: { getSnapshot: () => snapshot, refresh: async () => snapshot } });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hnu-cards-'));
let child, ws, session, id = 0;
const pending = new Map(), errors = [], report = [];
function send(method, params = {}, scoped = true) {
  return new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(method)); }, 15000);
    pending.set(requestId, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: requestId, method, params, ...(scoped && session ? { sessionId: session } : {}) }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function until(expression) {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`Not ready: ${expression}`);
}
async function capture(name) {
  await new Promise(resolve => setTimeout(resolve, 240));
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(data, 'base64'));
}
async function close() {
  await evaluate(`document.querySelector('[data-guide-close]').click()`);
  await until(`!document.querySelector('.guide-dialog').open`);
}
async function open(page) {
  await evaluate(`document.querySelector('.page-map-card[href="/${page}.html"]').click()`);
  await until(`document.querySelector('.guide-dialog[open] .guide-panel[data-page="${page}"]')`);
}
async function key(value) {
  const windowsVirtualKeyCode = { Escape: 27, Tab: 9, ArrowRight: 39, Enter: 13 }[value];
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: value, code: value, windowsVirtualKeyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code: value, windowsVirtualKeyCode });
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = await new Promise((resolve, reject) => {
    child = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
      ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.once('error', reject);
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
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const width of [1440, 390]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: base + '/' });
    await until(`document.readyState === 'complete'`);
    await evaluate(`localStorage.clear(); window.dispatchEvent(new Event('pageshow'))`);
    await capture(`home-${width}`);
    await evaluate(`document.querySelector('.page-map-card').focus(); window.scrollTo({top: 200, behavior: 'instant'})`);
    const position = await evaluate('scrollY');
    await open('programs');
    assert.equal(await evaluate('location.pathname'), '/');
    assert.equal(await evaluate(`getComputedStyle(document.documentElement).overflowY`), 'hidden');
    await evaluate(`document.querySelector('.guide-panel .task-check').click()`);
    await capture(`programs-${width}`);
    await key('Escape');
    await until(`!document.querySelector('.guide-dialog').open`);
    assert.equal(await evaluate('scrollY'), position);
    assert.equal(await evaluate(`document.activeElement.classList.contains('page-map-card')`), true);
    assert.equal(await evaluate(`document.querySelector('#progress-count').textContent`), '1 / 21 项');
    await open('materials');
    await evaluate(`document.querySelector('.guide-panel .task-check').click()`);
    await close();
    assert.equal(await evaluate(`document.querySelector('#progress-count').textContent`), '2 / 21 项');
    await open('programs');
    assert.equal(await evaluate(`document.querySelector('.guide-panel .task-check').checked`), true);
    await close();
    for (const page of ['scores', 'preparation', 'timeline', 'application', 'materials', 'updates', 'sources']) {
      await open(page);
      const dimensions = await evaluate(`(() => { const d = document.querySelector('.guide-dialog'); const r = d.getBoundingClientRect(); return {left:r.left,right:r.right,bottom:r.bottom,overflow:d.scrollWidth>d.clientWidth+1,tabs:d.querySelectorAll('[role="tab"]').length}; })()`);
      assert.equal(await evaluate('location.pathname'), '/');
      assert.ok(dimensions.left >= 0 && dimensions.right <= width + 1 && dimensions.bottom <= 901);
      assert.equal(dimensions.overflow, false, page);
      // Every tab remains usable and shows exactly one content group.
      const tabCount = await evaluate(`document.querySelectorAll('.guide-panel [role="tab"]').length`);
      for (let tab = 0; tab < tabCount; tab++) {
        await evaluate(`document.querySelectorAll('.guide-panel [role="tab"]')[${tab}].click()`);
        assert.equal(await evaluate(`document.querySelectorAll('.guide-panel [role="tabpanel"]:not([hidden])').length`), 1);
      }
      if (tabCount) await evaluate(`document.querySelector('.guide-panel [role="tab"]').click()`);
      if (page === 'application') {
        await evaluate(`document.querySelectorAll('.guide-panel [role="tab"]')[1].click()`);
        for (let step = 0; step < 8; step++) {
          await evaluate(`document.querySelectorAll('.guide-panel .step-picker button')[${step}].click()`);
          assert.equal(await evaluate(`document.querySelectorAll('.guide-panel .apply-steps > li:not([hidden])').length`), 1);
        }
      }
      if (page === 'timeline') {
        assert.equal(await evaluate(`document.querySelectorAll('.guide-panel .timeline-launch').length`), 15);
        await evaluate(`document.querySelector('.guide-panel [data-filter="exam"]').click(); document.querySelector('.guide-panel .timeline-item:not([hidden]) .timeline-launch').click()`);
        assert.equal(await evaluate(`document.querySelector('.guide-panel .timeline-detail').hidden`), false);
        await evaluate(`document.querySelector('.guide-panel [data-timeline-back]').click()`);
        assert.equal(await evaluate(`document.querySelector('.guide-panel .timeline-detail').hidden`), true);
      }
      if (page === 'updates') {
        await until(`document.querySelector('.guide-panel .official-update-link')`);
        await evaluate(`document.querySelector('.guide-panel #updates-year-trigger').focus(); document.querySelector('.guide-panel #updates-year-trigger').click()`);
        assert.equal(await evaluate(`document.querySelector('.guide-dialog .filter-select-menu[data-open="true"]') !== null`), true);
        await key('Escape');
        assert.equal(await evaluate(`document.querySelector('.guide-dialog').open`), true);
      }
      await capture(`${page}-${width}`); report.push({ width, page, ...dimensions }); await close();
    }
    await evaluate(`document.querySelector('a[href="/application.html#review-deadlines"]').click()`);
    await until(`document.querySelector('.guide-panel[data-page="application"]')`);
    assert.equal(await evaluate(`document.querySelector('.guide-panel #review-deadlines').closest('[role="tabpanel"]').hidden`), false);
    await capture(`deadlines-${width}`); await close();
    await send('Page.navigate', { url: base + '/preparation.html#risks' });
    await until(`document.readyState === 'complete' && location.pathname === '/preparation.html'`);
    assert.equal(await evaluate(`document.querySelector('#risks').closest('[role="tabpanel"]').hidden`), false);
    await capture(`direct-preparation-${width}`);
  }
  await send('Page.navigate', { url: base + '/' });
  await until(`document.readyState === 'complete' && location.pathname === '/'`);
  await evaluate(`localStorage.clear(); window.dispatchEvent(new Event('pageshow')); Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('Blocked'); } }); void 0;`);
  await open('programs');
  await evaluate(`document.querySelector('.guide-panel .task-check').click()`);
  await close(); await open('materials');
  await evaluate(`document.querySelector('.guide-panel .task-check').click()`);
  await close(); await open('programs');
  assert.equal(await evaluate(`document.querySelector('.guide-panel .task-check').checked`), true, 'blocked storage must retain cross-card session progress');
  assert.equal(await evaluate(`document.querySelector('#progress-count').textContent`), '2 / 21 项');
  assert.equal(await evaluate(`document.querySelector('.guide-back').hidden`), true, 'a fresh card has no stale back trail');
  await evaluate(`window.dispatchEvent(new Event('beforeprint'))`);
  assert.equal(await evaluate(`document.querySelector('.guide-panel .reading-context').open`), true);
  await send('Emulation.setEmulatedMedia', { media: 'print' });
  assert.equal(await evaluate(`getComputedStyle(document.querySelectorAll('.guide-panel .reading-pane')[1]).display`), 'block');
  await send('Emulation.setEmulatedMedia', { media: 'screen' });
  await evaluate(`window.dispatchEvent(new Event('afterprint'))`);
  assert.equal(await evaluate(`document.querySelector('.guide-panel .reading-context').open`), false);
  await close();
  // Local content cards use the same dialog, including links between cards.
  await evaluate(`document.querySelector('[data-guide-local="before-apply"]').click()`);
  await until(`document.querySelector('.guide-panel .truth-banner')`);
  await evaluate(`document.querySelector('.guide-panel a[href="/programs.html"]').click()`);
  await until(`document.querySelector('.guide-panel[data-page="programs"]')`);
  assert.equal(await evaluate(`document.querySelector('.guide-back').hidden`), false);
  await evaluate(`document.querySelector('.guide-back').click()`);
  await until(`document.querySelector('.guide-panel .truth-banner')`);
  await close();
  // Keyboard focus cannot escape into the background page.
  await open('materials');
  for (let i = 0; i < 14; i++) {
    await key('Tab');
    assert.equal(await evaluate(`document.querySelector('.guide-dialog').contains(document.activeElement)`), true);
  }
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 2, y: 2, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 2, y: 2, button: 'left', clickCount: 1 });
  await until(`!document.querySelector('.guide-dialog').open`);
  await send('Page.navigate', { url: base + '/preparation.html' });
  await until(`document.readyState === 'complete' && location.pathname === '/preparation.html'`);
  await evaluate(`document.querySelector('.page-toc a[href="#risks"]').click(); document.querySelector('.page-toc a[href="#exam"]').click()`);
  assert.equal(await evaluate(`document.querySelector('[role="tab"][aria-selected="true"]').textContent`), '408 初试');
  await send('Page.navigate', { url: base + '/timeline.html' });
  await until(`document.readyState === 'complete' && location.pathname === '/timeline.html'`);
  await evaluate(`document.querySelector('.timeline-launch').click(); window.dispatchEvent(new Event('beforeprint'));`);
  await send('Emulation.setEmulatedMedia', { media: 'print' });
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.timeline-list')).display === 'none'`), false);
  assert.equal(await evaluate(`document.querySelectorAll('.timeline-list .timeline-body').length`), 15);
  await send('Emulation.setEmulatedMedia', { media: 'screen' });
  await evaluate(`window.dispatchEvent(new Event('afterprint'))`);
  assert.equal(await evaluate(`document.querySelector('.timeline-detail').hidden`), false);
  await send('Page.navigate', { url: base + '/' });
  await until(`document.readyState === 'complete' && location.pathname === '/'`);
  await evaluate(`localStorage.clear(); window.dispatchEvent(new Event('pageshow')); Storage.prototype.setItem = () => { throw new DOMException('Full', 'QuotaExceededError'); }; void 0;`);
  await open('programs');
  await evaluate(`document.querySelector('.guide-panel .task-check').click()`);
  await close(); await open('materials');
  await evaluate(`document.querySelector('.guide-panel .task-check').click(); window.dispatchEvent(new Event('pageshow'))`);
  await close(); await open('programs');
  assert.equal(await evaluate(`document.querySelector('.guide-panel .task-check').checked`), true, 'failed writes must not restore stale readable storage');
  assert.equal(await evaluate(`document.querySelector('#progress-count').textContent`), '2 / 21 项');
  await close();
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`PASS: ${report.length} desktop/mobile panels; URL, scroll, focus, progress, filters, Escape and deep links.`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (ws?.readyState === WebSocket.OPEN) { await send('Browser.close', {}, false).catch(() => {}); ws.close(); }
  child?.kill(); server.close(); server.closeAllConnections();
  for (const task of pending.values()) clearTimeout(task.timer);
});
