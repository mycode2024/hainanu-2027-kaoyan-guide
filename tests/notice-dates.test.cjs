const test = require('node:test');
const assert = require('node:assert/strict');
const { parseOfficialPublicationDate, parseOfficialList } = require('../src/official-scraper.cjs');
const { createUpdateService } = require('../src/update-service.cjs');

const homepage = { id: 'hnu-graduate-home', name: '研究生院首页', url: 'https://gs.hainanu.edu.cn/', context: 'hnu-home', allowedHosts: ['hainanu.edu.cn'] };
const reply = (url, html) => ({ ok: true, status: 200, url, headers: new Headers({ 'content-type': 'text/html' }), text: async () => html });

for (const [name, label, expectedDate, inferred] of [
  ['time', '<time>2026-09-29</time>', '2026-09-29', false],
  ['datetime', '<time datetime="2026-09-29">9月29日</time>', '2026-09-29', false],
  ['date span', '<span class="pubdate">2026-09-29</span>', '2026-09-29', false],
  ['date div', '<div class="time">2026-09-29</div>', '2026-09-29', false],
  ['nested label', '<span class="date"><time>2026-09-29</time></span>', '2026-09-29', false],
  ['yearless label', '<span class="date">[09-29]</span>', '2026-09-29', true],
  ['invalid label', '<time>2026-02-30</time>', null, false]
]) {
  test(`publication attribution prefers the explicit ${name} over a deadline`, () => {
    const title = '2027年硕士研究生招生报名公告';
    const link = `<a href="info/9801.htm">${title}</a>`;
    for (const html of [
      `<li><p>报名截止：2026-10-24</p><a href="info/9801.htm">${title}${label}</a></li>`,
      `<li>${link}<p>报名截止：2026-10-24</p>${label}</li>`,
      `<li><div class="summary">${link}<p>报名截止：2026-10-24</p></div>${label}</li>`,
      `<div class="card"><div class="summary">${link}<p>报名截止：2026-10-24</p></div>${label}</div>`
    ]) {
      const updates = parseOfficialList(html, homepage, '2026-10-02T04:00:00Z');
      assert.deepEqual(updates.map(update => update.date), expectedDate ? [expectedDate] : [], html);
      if (expectedDate) {
        assert.equal(updates[0].title, title);
        assert.equal(updates[0].dateInferred === true, inferred);
      }
    }
  });
}

test('publication attribution still accepts a plain unlabelled date in a legacy card', () => {
  const html = '<li><a href="info/9801.htm">2027年硕士研究生招生报名公告</a><span>2026-09-29</span></li>';
  assert.deepEqual(parseOfficialList(html, homepage, '2026-10-02T04:00:00Z').map(update => update.date), ['2026-09-29']);
});

for (const shortDate of [false, true]) {
  test(`publication attribution reaches the cache after ${shortDate ? 'article verification' : 'list parsing'}`, async () => {
    const writes = [];
    const requests = [];
    const service = createUpdateService({ sources: [homepage], now: () => new Date('2026-10-02T04:00:00Z'),
      delayImpl: async () => {}, cacheStore: { load: async () => null, save: async snapshot => writes.push(structuredClone(snapshot)) },
      fetchImpl: async url => {
        requests.push(url);
        return reply(url, url === homepage.url
          ? `<li><div class="summary"><a href="info/9801.htm">2027年硕士研究生招生报名公告</a><p>报名截止：2026-10-24</p></div><time>${shortDate ? '[09-29]' : '2026-09-29'}</time></li>`
          : '<meta name="PubDate" content="2026-09-29">');
      }
    });
    const result = await service.refresh();
    assert.equal(result.status, 'fresh');
    assert.equal(requests.length, shortDate ? 2 : 1);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].updates[0].date, '2026-09-29');
    assert.equal(writes[0].updates[0].dateVerified, true);
  });
}

test('publication attribution rejects an outside list date without writing it to cache', async () => {
  const writes = [];
  let dated = false;
  const service = createUpdateService({ sources: [homepage], now: () => new Date('2026-10-02T04:00:00Z'),
    delayImpl: async () => {}, cacheStore: { load: async () => null, save: async snapshot => writes.push(structuredClone(snapshot)) },
    fetchImpl: async url => reply(url, `<div><ul><li><a href="info/9801.htm">2027年硕士研究生招生报名公告</a>${dated ? '<time>2026-09-29</time>' : ''}</li></ul><footer>栏目更新：2026-10-02</footer></div>`)
  });
  const initial = await service.refresh();
  assert.equal(initial.sources[0].ok, false);
  assert.equal(initial.updates.length, 0);
  assert.equal(writes.length, 0);
  dated = true;
  const trusted = await service.refresh();
  assert.equal(trusted.status, 'fresh');
  assert.equal(trusted.updates[0].date, '2026-09-29');
  dated = false;
  const missing = await service.refresh();
  assert.equal(missing.status, 'stale');
  assert.equal(missing.sources[0].ok, false);
  assert.deepEqual(missing.updates, trusted.updates);
  assert.equal(writes.length, 1);
});

for (const [name, html, expected] of [
  ['unquoted attributes', '<meta name=PubDate content=2026-09-29>', '2026-09-29'],
  ['greater-than in an attribute', '<meta name="PubDate" title="人数 > 30" content="2026-09-29">', '2026-09-29'],
  ['mixed case and encoded value', '<META CONTENT="2026&#45;09&#45;29" NAME=PubDate>', '2026-09-29'],
  ['unquoted property', '<meta property=article:published_time content=2026-09-29T09:00:00+08:00>', '2026-09-29'],
  ['tag text inside an attribute', '<div title=\'<meta name="PubDate" content="2020-01-01">\'></div><meta name=PubDate content=2026-09-29>', '2026-09-29'],
  ['non-metadata attributes', '<meta data-name=PubDate data-content=2026-09-29>', null],
  ['hidden metadata', '<template><meta name=PubDate content=2026-09-29></template>', null],
  ['impossible metadata date', '<meta name=PubDate content=2026-02-30>', null]
]) {
  test(`publication metadata attributes: ${name}`, () => {
    assert.equal(parseOfficialPublicationDate(html), expected);
  });
}

for (const [name, label, expectedDate] of [
  ['date attribute', '<time datetime="2026-09-29">9月29日</time>', '2026-09-29'],
  ['unquoted date attribute', '<time datetime=2026-09-29>9月29日</time>', '2026-09-29'],
  ['timestamp preserves publisher calendar day', '<time datetime="2026-09-29T00:30:00+08:00">9月29日</time>', '2026-09-29'],
  ['space-separated timestamp', '<time datetime="2026-09-29 00:30:00+08:00">9月29日</time>', '2026-09-29'],
  ['space-separated local timestamp', '<time datetime="2026-09-29 09:00">9月29日</time>', '2026-09-29'],
  ['attribute greater-than and mixed case', '<TIME title="人数 > 30" DATETIME="2026-09-29">9月29日</TIME>', '2026-09-29'],
  ['machine date takes precedence over short text', '<time datetime="2025-09-29">[09-29]</time>', '2025-09-29'],
  ['invalid machine date falls back to visible date', '<time datetime="2026-02-30">2026-09-29</time>', '2026-09-29'],
  ['invalid machine date alone', '<time datetime="2026-02-30">2月30日</time>', null],
  ['data attribute is not datetime', '<time data-datetime="2026-09-29">9月29日</time>', null],
  ['datetime outside time', '<span datetime="2026-09-29">9月29日</span>', null]
]) {
  test(`list publication datetime: ${name}`, () => {
    const title = '2027年硕士研究生招生考试（2026-12-19）安排';
    for (const clickable of [false, true]) {
      const html = clickable
        ? `<li><a href="info/9401.htm">${title}${label}</a></li>`
        : `<li><a href="info/9401.htm">${title}</a>${label}</li>`;
      const updates = parseOfficialList(html, homepage, '2026-10-01T04:00:00Z');
      assert.deepEqual(updates.map(update => update.date), expectedDate ? [expectedDate] : [], String(clickable));
      if (expectedDate) {
        assert.equal(updates[0].title, title);
        assert.equal(updates[0].dateInferred, undefined);
      }
    }
  });
}

for (const [name, label, article] of [
  ['metadata attributes', '<span>[09-29]</span>', '<meta title="人数 > 30" name=PubDate content=2026-09-29>'],
  ['time datetime', '<time datetime="2026-09-29">9月29日</time>', null],
  ['visible label boundaries', '<span title="比较 > 2020-01-01">2026-09-29</span>', null]
]) {
  test(`publication date formats reach the trusted cache: ${name}`, async () => {
    const writes = [];
    const requests = [];
    const service = createUpdateService({
      sources: [homepage], now: () => new Date('2026-10-01T04:00:00Z'), delayImpl: async () => {},
      cacheStore: { load: async () => null, save: async snapshot => writes.push(structuredClone(snapshot)) },
      fetchImpl: async url => {
        requests.push(url);
        return reply(url, url === homepage.url
          ? `<li><a href="info/9401.htm">2027年硕士研究生招生简章</a>${label}</li>`
          : article || '');
      }
    });
    const result = await service.refresh();
    assert.equal(result.status, 'fresh');
    assert.equal(requests.length, article ? 2 : 1);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].updates[0].date, '2026-09-29');
    assert.equal(writes[0].updates[0].dateVerified, true);
  });
}

test('does not discard a yearless operational notice before verifying its actual year', async () => {
  const service = createUpdateService({
    sources: [{ ...homepage, context: 'hnu-master' }], now: () => new Date('2026-09-27T04:00:00Z'),
    retryDelayMs: 0, delayImpl: async () => {},
    fetchImpl: async url => reply(url, url === homepage.url
      ? '<li><a href="info/current.htm">硕士研究生复试安排</a><span>[10-01]</span></li>'
      : '<meta name="PubDate" content="2026-09-26">')
  });
  const result = await service.refresh();
  assert.equal(result.sources[0].ok, true);
  assert.deepEqual(result.updates.map(item => item.date), ['2026-09-26']);
});

test('rechecks operational notice age after verifying the publication year', async () => {
  const service = createUpdateService({
    sources: [{ ...homepage, context: 'hnu-master' }], now: () => new Date('2026-09-27T04:00:00Z'),
    fetchImpl: async url => reply(url, url === homepage.url
      ? '<li><a href="info/old.htm">硕士研究生复试安排</a><span>[09-20]</span></li><li><a href="info/current.htm">2027年硕士研究生招生简章</a><time>2026-09-25</time></li>'
      : '<meta name="PubDate" content="2025-09-20">')
  });
  const result = await service.refresh();
  assert.equal(result.sources[0].ok, true);
  assert.deepEqual(result.updates.map(item => item.url), ['https://gs.hainanu.edu.cn/info/current.htm']);
  assert.equal(result.sources[0].diagnostics.relevantCount, 1);
});

test('does not report a successful source when verified dates filter out every notice', async () => {
  const service = createUpdateService({
    sources: [{ ...homepage, context: 'hnu-master' }], now: () => new Date('2026-09-27T04:00:00Z'),
    delayImpl: async () => {},
    fetchImpl: async url => reply(url, url === homepage.url
      ? '<li><a href="info/old.htm">硕士研究生复试安排</a><span>[09-20]</span></li>'
      : '<meta name="PubDate" content="2025-09-20">')
  });
  const result = await service.refresh();
  assert.equal(result.sources[0].ok, false);
  assert.equal(result.sources[0].lastSuccessAt, null);
  assert.deepEqual(result.updates, []);
});

test('includes current recommended-admission rules and retained target-year contact notices', async () => {
  const source = { ...homepage, id: 'hnu-graduate', context: 'hnu-master' };
  const html = '<li><a href="info/1024/8992.htm">海南大学2027年各学院接收推荐免试研究生（含直博生）工作实施细则</a><time>2026-09-20</time></li>' +
    '<li><a href="info/1024/6742.htm">海南大学2027年研究生招生学院联系方式</a><time>2024-10-17</time></li>';
  const service = createUpdateService({ sources: [source], now: () => new Date('2026-09-23T04:00:00Z'), fetchImpl: async (url) => reply(url, html) });
  const result = await service.refresh();
  assert.deepEqual(result.updates.map((item) => item.date), ['2026-09-20', '2024-10-17']);
});

test('discards legacy homepage years before an offline refresh can carry them forward', async () => {
  const cache = { updates: [{ id: 'legacy', title: '2026年硕士研究生预报名提醒', date: '2026-09-30', sourceId: homepage.id, source: homepage.name, url: 'https://gs.hainanu.edu.cn/info/1019/8012.htm' }] };
  const service = createUpdateService({ sources: [homepage], cacheStore: { load: async () => cache }, now: () => new Date('2026-09-23T04:00:00Z') });
  await service.initialize();
  assert.deepEqual(service.getSnapshot().updates, []);
});

test('reads publication metadata instead of dates in the notice body', () => {
  assert.equal(parseOfficialPublicationDate('<meta name="PubDate" content="2025-09-30"><p>报名时间：2025年10月10日</p>'), '2025-09-30');
  assert.equal(parseOfficialPublicationDate('<p>报名时间：2025年10月10日</p>'), null);
  assert.equal(parseOfficialPublicationDate('<meta content="2026-02-30" name="PubDate">'), null);
  assert.equal(parseOfficialPublicationDate('<meta property="article:published_time" content="2026-09-20T09:00:00+08:00">'), '2026-09-20');
  assert.equal(parseOfficialPublicationDate('<div>2025年09月30日 16:51&nbsp;　来源:研究生院</div><p>报名时间2025年10月10日</p>'), '2025-09-30');
});

test('verifies yearless homepage dates against the article even after the anniversary', async () => {
  const service = createUpdateService({
    sources: [homepage], now: () => new Date('2026-10-01T04:00:00Z'), retryDelayMs: 0,
    fetchImpl: async (url) => reply(url, url === homepage.url
      ? '<li><a href="info/1019/8012.htm">关于2026年硕士研究生招生预报名的温馨提醒</a><span>[09-30]</span></li>'
      : '<meta name="PubDate" content="2025-09-30">')
  });
  const result = await service.refresh();
  assert.equal(result.status, 'fresh');
  assert.equal(result.updates[0].date, '2025-09-30');
  assert.equal(result.updates[0].dateVerified, true);
});

test('never publishes a guessed year if the article has no verifiable publication date', async () => {
  const service = createUpdateService({
    sources: [homepage], now: () => new Date('2026-09-23T04:00:00Z'), retryDelayMs: 0,
    fetchImpl: async (url) => reply(url, url === homepage.url
      ? '<li><a href="info/1019/8012.htm">2026年硕士研究生招生预报名提醒</a><span>[09-30]</span></li>'
      : '<p>报名时间：2025-10-10</p>')
  });
  const result = await service.refresh();
  assert.equal(result.sources[0].ok, false);
  assert.deepEqual(result.updates, []);
});

test('newly discovered older notices do not jump ahead of recent cached notices', async () => {
  const source = { ...homepage, id: 'hnu-graduate', context: 'hnu-master' };
  let pass = 0;
  const recent = '<li><a href="info/1024/9000.htm">2027年硕士研究生招生简章</a><time>2026-09-20</time></li>';
  const older = '<li><a href="info/1024/8000.htm">2026年硕士研究生招生简章</a><time>2025-09-30</time></li>';
  const service = createUpdateService({ sources: [source], now: () => new Date('2026-09-23T04:00:00Z'), fetchImpl: async (url) => reply(url, recent + (pass++ ? older : '')) });
  await service.refresh();
  const result = await service.refresh();
  assert.deepEqual(result.updates.map((item) => item.date), ['2026-09-20', '2025-09-30']);
  assert.equal(result.change.newCount, 1);
});
