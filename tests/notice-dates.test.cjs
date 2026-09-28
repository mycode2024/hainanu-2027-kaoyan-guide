const test = require('node:test');
const assert = require('node:assert/strict');
const { parseOfficialPublicationDate } = require('../src/official-scraper.cjs');
const { createUpdateService } = require('../src/update-service.cjs');

const homepage = { id: 'hnu-graduate-home', name: '研究生院首页', url: 'https://gs.hainanu.edu.cn/', context: 'hnu-home', allowedHosts: ['hainanu.edu.cn'] };
const reply = (url, html) => ({ ok: true, status: 200, url, headers: new Headers({ 'content-type': 'text/html' }), text: async () => html });

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
