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
async function assertContentFits(label) {
  // Layout bounds are checked after the deliberate entrance/selection motion.
  await evaluate(`Promise.all(document.querySelector('.guide-dialog').getAnimations({ subtree: true })
    .filter(animation => animation.effect.getTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => {})))`);
  const overflows = await evaluate(`Array.from(document.querySelectorAll('.guide-panel *')).filter(el =>
    el.getClientRects().length && el.clientWidth > 0 && !el.closest('.score-table, .sr-only, .filter-select-menu') &&
    getComputedStyle(el).visibility !== 'hidden' && !el.matches('.live-updates-console') &&
    !['auto', 'scroll'].includes(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 2
  ).map(el => ({ element: el.className || el.tagName, width: el.clientWidth, content: el.scrollWidth }))`);
  assert.deepEqual(overflows, [], `${label}: content must fit inside its card`);
}
async function key(value) {
  const windowsVirtualKeyCode = { Escape: 27, Tab: 9, ArrowRight: 39, Enter: 13, ArrowDown: 40, ArrowUp: 38, Home: 36, End: 35 }[value];
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
  // CSS-only reordering made mobile keyboard navigation jump below the task
  // card and then back up. Check real Tab navigation as well as reading order.
  for (const width of [390, 640, 641, 1440]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: base + '/' });
    await until(`document.readyState === 'complete' && document.querySelector('.guide-dialog')`);
    const narrow = width <= 640;
    const first = narrow ? '.status-panel' : '.hero-copy';
    const second = narrow ? '.hero-copy' : '.status-panel';
    assert.equal(await evaluate(`document.querySelector('.hero-shell').firstElementChild.matches('${first}')`), true,
      `reading order must match the layout at ${width}px`);
    await evaluate(`document.querySelector('${first} a').focus()`);
    await key('Tab');
    assert.equal(await evaluate(`document.activeElement.matches('${narrow ? '#reset-progress' : '.hero-actions a:last-child'}')`), true);
    await key('Tab');
    assert.equal(await evaluate(`document.activeElement === document.querySelector('${second} a')`), true,
      `Tab must continue into the next visible group at ${width}px`);
    if (narrow) {
      await evaluate(`document.querySelector('[data-site-nav-toggle]').focus()`);
      await key('Tab');
      assert.equal(await evaluate(`document.activeElement === document.querySelector('.stage-actions a')`), true,
        'the collapsed mobile navigation must lead directly to the task card');
    }
  }
  // Crossing the breakpoint must preserve focus in either group and keep the
  // same dashboard nodes (and their event listeners), including with a card open.
  for (const selector of ['.stage-actions a', '#reset-progress', '.hero-actions a:first-child', '.hero-actions a:last-child']) {
    await evaluate(`document.querySelector('${selector}').focus(); window.savedTaskPanel = document.querySelector('.status-panel')`);
    for (const width of [390, 1440]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      assert.equal(await evaluate(`document.activeElement.matches('${selector}')`), true, `resize must retain focus on ${selector}`);
      assert.equal(await evaluate(`document.querySelector('.status-panel') === window.savedTaskPanel`), true);
      assert.equal(await evaluate(`document.querySelector('.hero-shell').firstElementChild.matches('${width <= 640 ? '.status-panel' : '.hero-copy'}')`), true);
    }
  }
  await evaluate(`document.querySelector('.hero-actions a:last-child').focus(); document.activeElement.click()`);
  await until(`document.querySelector('.guide-dialog[open] .guide-panel[data-page="materials"]')`);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  assert.equal(await evaluate(`document.activeElement.closest('.guide-dialog') !== null`), true, 'resizing must not steal dialog focus');
  await close();
  assert.equal(await evaluate(`document.activeElement.matches('.hero-actions a:last-child')`), true, 'closing must restore focus to the moved opener');
  // Changing to shorter content must resize continuously, including when a
  // second selection interrupts it. Selection itself remains synchronous.
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + '/preparation.html' });
  await until(`document.readyState === 'complete' && document.querySelector('[role="tab"]')`);
  const resize = await evaluate(`new Promise(resolve => {
    const panes = document.querySelector('.reading-panes');
    const tabs = document.querySelectorAll('[role="tab"]');
    const before = panes.getBoundingClientRect().height;
    tabs[2].click();
    const immediate = panes.getBoundingClientRect().height;
    const samples = [];
    const started = performance.now();
    function tick() {
      samples.push(panes.getBoundingClientRect().height);
      if (performance.now() - started < 500) return requestAnimationFrame(tick);
      resolve({ before, immediate, samples, final: panes.getBoundingClientRect().height,
        selected: tabs[2].getAttribute('aria-selected') });
    }
    requestAnimationFrame(tick);
  })`);
  assert.equal(resize.selected, 'true');
  assert.ok(Math.abs(resize.before - resize.final) > 20, `fixture must switch between different content heights: ${JSON.stringify(resize)}`);
  assert.ok(Math.abs(resize.immediate - resize.before) < 2, 'the content area must not jump to its new height');
  assert.ok(resize.samples.some(height => height > Math.min(resize.before, resize.final) + 2 && height < Math.max(resize.before, resize.final) - 2), 'the content area must pass through intermediate heights');
  await evaluate(`document.querySelectorAll('[role="tab"]')[0].click()`);
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const interrupted = await evaluate(`(() => {
    const panes = document.querySelector('.reading-panes');
    const before = panes.getBoundingClientRect().height;
    document.querySelectorAll('[role="tab"]')[3].click();
    return { before, after: panes.getBoundingClientRect().height };
  })()`);
  assert.ok(Math.abs(interrupted.after - interrupted.before) < 2, 'rapid selections must resume from the current displayed height');
  await evaluate(`window.dispatchEvent(new Event('beforeprint'))`);
  await send('Emulation.setEmulatedMedia', { media: 'print' });
  assert.equal(await evaluate(`document.querySelector('.reading-panes').getAnimations().some(animation => animation.playState === 'running')`), false, 'printing must release temporary height animations');
  await send('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await evaluate(`window.dispatchEvent(new Event('afterprint')); document.querySelectorAll('[role="tab"]')[1].click()`);
  const reducedAnimations = await evaluate(`document.querySelector('.reading-panes').getAnimations({subtree:true}).filter(animation => animation.playState === 'running' && animation.effect.getTiming().duration > 1).map(animation => ({ name: animation.animationName || animation.transitionProperty || 'layout', duration: animation.effect.getTiming().duration }))`);
  assert.deepEqual(reducedAnimations, [], 'reduced motion must switch content immediately');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await send('Page.navigate', { url: base + '/application.html' });
  await until(`document.readyState === 'complete' && document.querySelector('.step-picker')`);
  const nestedResize = await evaluate(`new Promise(resolve => {
    const panes = document.querySelector('.reading-panes');
    document.querySelectorAll('[role="tab"]')[1].click();
    const started = performance.now(), samples = [];
    setTimeout(() => document.querySelectorAll('.step-picker button')[3].click(), 100);
    function tick() {
      if (performance.now() - started >= 120) samples.push(panes.getBoundingClientRect().height);
      if (performance.now() - started < 850) return requestAnimationFrame(tick);
      resolve({ samples, final: panes.getBoundingClientRect().height,
        content: document.querySelector('.step-reader').getBoundingClientRect().height });
    }
    requestAnimationFrame(tick);
  })`);
  assert.ok(nestedResize.samples.slice(1).every((height, index) => Math.abs(height - nestedResize.samples[index]) < 120), 'a step change during a tab transition must not jump when the old parent animation finishes');
  assert.ok(nestedResize.final >= nestedResize.content, 'nested content must fit after both transitions settle');
  // The card is narrower than the browser. Check its content, including long
  // email links with enlarged text, rather than only the clipped dialog frame.
  for (const width of [320, 700]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 720, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: base + '/' });
    await until(`document.readyState === 'complete' && document.querySelector('.guide-dialog')`);
    if (width === 320) await evaluate(`document.documentElement.style.fontSize = '20px'`);
    for (const page of ['application', 'materials']) {
      await open(page);
      const tabCount = await evaluate(`document.querySelectorAll('.guide-panel [role="tab"]').length`);
      for (let tab = 0; tab < tabCount; tab++) {
        await evaluate(`document.querySelectorAll('.guide-panel [role="tab"]')[${tab}].click()`);
        await assertContentFits(`${page}, tab ${tab}, ${width}px`);
      }
      if (page === 'application') {
        await evaluate(`document.querySelectorAll('.guide-panel [role="tab"]')[1].click()`);
        for (let step = 0; step < 8; step++) {
          await evaluate(`document.querySelectorAll('.guide-panel .step-picker button')[${step}].click()`);
          await assertContentFits(`application step ${step + 1}, ${width}px`);
        }
        assert.equal(await evaluate(`(() => {
          const step = document.querySelector('.guide-panel .step-reader > li:not([hidden])');
          return step.children[1].getBoundingClientRect().left === step.children[0].getBoundingClientRect().left;
        })()`), true, 'narrow cards must give the step content the full row');
      } else {
        await evaluate(`document.querySelector('.guide-panel [role="tab"]').click()`);
        assert.equal(await evaluate(`(() => {
          const items = document.querySelector('.guide-panel .checklist-grid').children;
          return items[1].getBoundingClientRect().top >= items[0].getBoundingClientRect().bottom;
        })()`), true, 'material rows must stack when the card is too narrow for two readable columns');
      }
      await capture(`content-fit-${page}-${width}`);
      await close();
    }
  }
  for (const width of [1440, 768, 390, 320]) {
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
        await assertContentFits(`${page}, tab ${tab}, ${width}px`);
      }
      if (tabCount) await evaluate(`document.querySelector('.guide-panel [role="tab"]').click()`);
      if (page === 'application') {
        await evaluate(`document.querySelectorAll('.guide-panel [role="tab"]')[1].click()`);
        for (let step = 0; step < 8; step++) {
          await evaluate(`document.querySelectorAll('.guide-panel .step-picker button')[${step}].click()`);
          assert.equal(await evaluate(`document.querySelectorAll('.guide-panel .apply-steps > li:not([hidden])').length`), 1);
          await assertContentFits(`application step ${step + 1}, ${width}px`);
        }
      }
      if (page === 'timeline') {
        assert.equal(await evaluate(`document.querySelectorAll('.guide-panel .timeline-launch').length`), 15);
        assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.guide-panel .timeline-date')).filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.textContent)`), [], `timeline dates and labels must fit their cards at ${width}px`);
        await evaluate(`document.querySelector('.guide-panel [data-filter="exam"]').click(); document.querySelector('.guide-panel .timeline-item:not([hidden]) .timeline-launch').click()`);
        assert.equal(await evaluate(`document.querySelector('.guide-panel .timeline-detail').hidden`), false);
        await evaluate(`document.querySelector('.guide-panel [data-timeline-back]').click()`);
        assert.equal(await evaluate(`document.querySelector('.guide-panel .timeline-detail').hidden`), true);
        await evaluate(`document.querySelector('.guide-panel .timeline-item:not([hidden]) .timeline-launch').click()`);
        assert.equal(await evaluate(`document.querySelector('.guide-panel .timeline-detail').hidden`), false);
        await close();
        await open('timeline');
        assert.equal(await evaluate(`document.querySelector('.guide-panel .timeline-detail').hidden`), true, 'reopening a cached timeline card must reset single-node detail view');
        assert.equal(await evaluate(`document.querySelector('.guide-panel .timeline-list').hidden`), false);
        assert.equal(await evaluate(`document.activeElement.hasAttribute('data-guide-close')`), true, 'reopening a cached timeline card must keep focus on the close button');
      }
      if (page === 'updates') {
        await until(`document.querySelector('.guide-panel .official-update-link')`);
        await evaluate(`Promise.all(document.querySelector('.guide-dialog').getAnimations({ subtree: true }).filter(animation => animation.effect.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))`);
        await evaluate(`document.querySelector('.guide-panel #updates-year-trigger').focus(); document.querySelector('.guide-panel #updates-year-trigger').click()`);
        assert.equal(await evaluate(`document.querySelector('.guide-dialog .filter-select-menu[data-open="true"]') !== null`), true);
        await capture(`updates-dropdown-${width}`);
        const menuPosition = await evaluate(`(() => {
          const trigger = document.querySelector('.guide-panel #updates-year-trigger').getBoundingClientRect();
          const menu = document.querySelector('.guide-panel #updates-year-listbox');
          const rect = menu.getBoundingClientRect();
          const option = menu.querySelector('[role="option"]');
          const row = option.getBoundingClientRect();
          return { horizontalOffset: rect.left - trigger.left, gap: menu.dataset.direction === 'up' ? trigger.top - rect.bottom : rect.top - trigger.bottom,
            visible: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
            clickable: option.contains(document.elementFromPoint(row.left + row.width / 2, row.top + row.height / 2)) };
        })()`);
        assert.ok(Math.abs(menuPosition.horizontalOffset) <= 1, `filter menu must align with its trigger at ${width}px: ${JSON.stringify(menuPosition)}`);
        assert.ok(Math.abs(menuPosition.gap - 8) <= 1, `filter menu must stay next to its trigger at ${width}px`);
        assert.equal(menuPosition.visible && menuPosition.clickable, true, 'filter options must be visible and clickable');
        const activeOption = () => evaluate(`document.querySelector('.guide-panel #updates-year-trigger').getAttribute('aria-activedescendant')`);
        const optionCount = await evaluate(`document.querySelectorAll('.guide-panel #updates-year-listbox [role="option"]').length`);
        assert.ok(optionCount >= 2, 'the year filter needs at least two options to test keyboard navigation');
        assert.equal(await activeOption(), 'updates-year-option-0', 'the open menu must start on the selected option');
        await key('ArrowDown');
        assert.equal(await activeOption(), 'updates-year-option-1', 'ArrowDown must move the active option');
        await key('End');
        assert.equal(await activeOption(), `updates-year-option-${optionCount - 1}`, 'End must jump to the last option');
        await key('ArrowDown');
        assert.equal(await activeOption(), `updates-year-option-${optionCount - 1}`, 'ArrowDown must stop at the last option');
        await key('Home');
        assert.equal(await activeOption(), 'updates-year-option-0', 'Home must jump to the first option');
        await key('ArrowUp');
        assert.equal(await activeOption(), 'updates-year-option-0', 'ArrowUp must stop at the first option');
        await key('ArrowDown');
        await key('Enter');
        assert.equal(await evaluate(`document.querySelector('.guide-panel #updates-year').selectedIndex`), 1, 'Enter must commit the active option to the native select');
        assert.equal(await evaluate(`document.querySelector('.guide-panel #updates-year-trigger').getAttribute('aria-expanded')`), 'false', 'committing must close the menu');
        await key('Enter');
        await key('Home');
        await key('Enter');
        assert.equal(await evaluate(`document.querySelector('.guide-panel #updates-year').selectedIndex`), 0, 'Enter on a reopened menu must restore the first option');
        await evaluate(`document.querySelector('.guide-panel #updates-year-trigger').click()`);
        await key('Escape');
        assert.equal(await evaluate(`document.querySelector('.guide-panel #updates-year-trigger').getAttribute('aria-expanded')`), 'false', 'Escape must close the open menu');
        await evaluate(`document.querySelector('.guide-panel #updates-year-trigger').click()`);
        await key('Escape');
        assert.equal(await evaluate(`document.querySelector('.guide-dialog').open`), true);
        await close();
        // A cached panel is interactive before its entrance animation finishes.
        const duringEntrance = await evaluate(`new Promise(resolve => {
          document.querySelector('.page-map-card[href="/updates.html"]').click();
          document.querySelector('.guide-panel #updates-year-trigger').click();
          requestAnimationFrame(() => {
            const trigger = document.querySelector('.guide-panel #updates-year-trigger').getBoundingClientRect();
            const menu = document.querySelector('.guide-panel #updates-year-listbox');
            const rect = menu.getBoundingClientRect();
            resolve({
              centerOffset: (rect.left + rect.right - trigger.left - trigger.right) / 2,
              gap: menu.dataset.direction === 'up' ? trigger.top - rect.bottom : rect.top - trigger.bottom
            });
          });
        })`);
        assert.ok(Math.abs(duringEntrance.centerOffset) <= 1 && Math.abs(duringEntrance.gap - 8) <= 8,
          `a filter opened during the entrance must align during the entrance animation at ${width}px: ${JSON.stringify(duringEntrance)}`);
        await evaluate(`Promise.all(document.querySelector('.guide-dialog').getAnimations({ subtree: true }).filter(animation => animation.effect.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))`);
        const earlyPosition = await evaluate(`(() => {
          const trigger = document.querySelector('.guide-panel #updates-year-trigger').getBoundingClientRect();
          const menu = document.querySelector('.guide-panel #updates-year-listbox');
          const rect = menu.getBoundingClientRect();
          return { offset: rect.left - trigger.left, gap: menu.dataset.direction === 'up' ? trigger.top - rect.bottom : rect.top - trigger.bottom };
        })()`);
        assert.ok(Math.abs(earlyPosition.offset) <= 1 && Math.abs(earlyPosition.gap - 8) <= 1,
          `a filter opened during the entrance must stay aligned at ${width}px: ${JSON.stringify(earlyPosition)}`);
        const closedOnScroll = await evaluate(`(() => {
          const body = document.querySelector('.guide-dialog-body');
          const trigger = document.querySelector('.guide-panel #updates-year-trigger');
          const menu = document.querySelector('.guide-panel #updates-year-listbox');
          body.scrollTop = trigger.getBoundingClientRect().bottom - body.getBoundingClientRect().top + 12;
          body.dispatchEvent(new Event('scroll'));
          const openAfterScroll = menu.dataset.open;
          body.scrollTop = 0;
          return openAfterScroll;
        })()`);
        assert.equal(closedOnScroll, 'false', 'scrolling a filter trigger behind the card header must close its menu');
        await evaluate(`document.querySelector('.guide-panel #updates-year-trigger').click()`);
        assert.equal(await evaluate(`document.querySelector('.guide-panel #updates-year-listbox').dataset.open`), 'true');
        await evaluate(`document.querySelector('[data-guide-close]').click()`);
        assert.equal(await evaluate(`document.querySelector('.guide-panel #updates-year-listbox').dataset.open`), 'false', 'dismissing a card must close any open filter menu immediately');
        await until(`!document.querySelector('.guide-dialog').open`);
        await open('updates');
        assert.equal(await evaluate(`document.querySelector('.guide-panel #updates-year-listbox').dataset.open`), 'false', 'reopening updates must not restore a stale open filter menu');
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
  await evaluate(`window.dispatchEvent(new Event('beforeprint')); window.dispatchEvent(new Event('beforeprint'))`);
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
  // Card motion: the exit animation must delay the close, repeated dismisses
  // during it are ignored, and reduced motion closes immediately.
  await open('programs');
  const motion = await evaluate(`new Promise(resolve => {
    const dialog = document.querySelector('.guide-dialog');
    document.querySelector('[data-guide-close]').click();
    const samples = [];
    const started = performance.now();
    const tick = () => {
      samples.push({ at: Math.round(performance.now() - started), open: dialog.open, closing: dialog.classList.contains('guide-closing') });
      if (!dialog.open || performance.now() - started > 1200) return resolve(samples);
      requestAnimationFrame(tick);
    };
    tick();
  })`);
  assert.equal(motion[0].open, true, 'the card must stay open while the exit animation runs');
  assert.equal(motion[0].closing, true, 'the closing state must be applied immediately');
  assert.equal(motion[motion.length - 1].open, false, 'the card must close after the exit animation');
  assert.ok(motion[motion.length - 1].at >= 100, `the exit animation must delay the close (${motion[motion.length - 1].at}ms)`);
  const interruptedEntrance = await evaluate(`new Promise(resolve => {
    document.querySelector('.page-map-card[href="/programs.html"]').click();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const dialog = document.querySelector('.guide-dialog');
      const before = Number(getComputedStyle(dialog).opacity);
      const backdropBefore = Number(getComputedStyle(dialog, '::backdrop').opacity);
      document.querySelector('[data-guide-close]').click();
      resolve({ before, after: Number(getComputedStyle(dialog).opacity), backdropBefore,
        backdropAfter: Number(getComputedStyle(dialog, '::backdrop').opacity) });
    }));
  })`);
  assert.ok(Math.abs(interruptedEntrance.before - interruptedEntrance.after) < .05, 'closing during the entrance must not flash back to full opacity');
  assert.ok(Math.abs(interruptedEntrance.backdropBefore - interruptedEntrance.backdropAfter) < .05, 'the backdrop must also continue from its current opacity');
  await until(`!document.querySelector('.guide-dialog').open`);
  await open('programs');
  await evaluate(`document.querySelector('[data-guide-close]').click(); document.querySelector('[data-guide-close]').click()`);
  await key('Escape');
  await until(`!document.querySelector('.guide-dialog').open`);
  await open('scores');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.deepEqual(await evaluate(`(() => {
    const dialog = document.querySelector('.guide-dialog');
    document.querySelector('[data-guide-close]').click();
    return { open: dialog.open, closing: dialog.classList.contains('guide-closing') };
  })()`), { open: false, closing: false }, 'reduced motion must close without the exit animation');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
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
  // Deadlines must use Beijing time even on a browser in a different time zone.
  await send('Emulation.setTimezoneOverride', { timezoneId: 'America/Los_Angeles' });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    const RealDate = Date;
    window.guideTestTime = RealDate.parse('2026-10-24T21:59:30+08:00');
    window.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [window.guideTestTime])); }
      static now() { return window.guideTestTime; }
    };
  ` });
  for (const width of [1440, 390, 320]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: base + '/' });
    await until(`document.readyState === 'complete' && document.querySelector('.guide-dialog')`);
    await evaluate(`localStorage.clear(); window.dispatchEvent(new Event('pageshow'))`);
    if (width === 320) await evaluate(`document.documentElement.style.fontSize = '20px'`);
    assert.equal(await evaluate(`document.querySelector('#current-deadline').dataset.state`), 'urgent');
    if (width < 640) {
      const layout = await evaluate(`(() => {
        const panel = document.querySelector('.status-panel').getBoundingClientRect();
        const hero = document.querySelector('.hero-copy').getBoundingClientRect();
        const detail = document.querySelector('#current-stage-detail');
        const deadline = document.querySelector('#current-deadline');
        return { first: panel.top < hero.top, visible: deadline.getBoundingClientRect().bottom <= innerHeight,
          textFits: detail.scrollHeight <= detail.clientHeight + 1,
          widthFits: document.documentElement.scrollWidth <= innerWidth + 1 };
      })()`);
      assert.deepEqual(layout, { first: true, visible: true, textFits: true, widthFits: true }, `home tasks at ${width}px`);
    }
    await capture(`deadline-urgent-${width}`);
    await evaluate(`window.guideTestTime = Date.parse('2026-10-24T22:00:00+08:00'); window.dispatchEvent(new Event('pageshow'))`);
    assert.equal(await evaluate(`document.querySelector('#current-deadline').dataset.state`), 'closed');
    assert.doesNotMatch(await evaluate(`document.querySelector('#current-stage-name').textContent`), /全国网上报名/);
    await capture(`deadline-closed-${width}`);
    await evaluate(`window.guideTestTime = Date.parse('2026-10-31T12:00:00+08:00'); window.dispatchEvent(new Event('pageshow'))`);
    assert.equal(await evaluate(`document.querySelector('#current-deadline').dataset.state`), 'closed');
    assert.match(await evaluate(`document.querySelector('#current-stage-name').textContent`), /4603 审核（补交已截止）/);
    assert.match(await evaluate(`document.querySelector('#current-deadline-scope').textContent`), /其他报考点/);
    await capture(`deadline-review-${width}`);
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`PASS: ${report.length} desktop/mobile panels plus narrow/enlarged-text registration and materials; content fit, URL, scroll, focus, progress, filters, Escape, deep links, precise Beijing deadlines and mobile task visibility.`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (ws?.readyState === WebSocket.OPEN) { await send('Browser.close', {}, false).catch(() => {}); ws.close(); }
  child?.kill(); server.close(); server.closeAllConnections();
  for (const task of pending.values()) clearTimeout(task.timer);
});
