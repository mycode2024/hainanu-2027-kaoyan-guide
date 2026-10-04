const test = require('node:test');
const assert = require('node:assert/strict');
const { parseOfficialPublicationDate, parseOfficialList } = require('../src/official-scraper.cjs');
const { createUpdateService } = require('../src/update-service.cjs');

const homepage = { id: 'hnu-graduate-home', name: '研究生院首页', url: 'https://gs.hainanu.edu.cn/', context: 'hnu-home', allowedHosts: ['hainanu.edu.cn'] };
const reply = (url, html) => ({ ok: true, status: 200, url, headers: new Headers({ 'content-type': 'text/html' }), text: async () => html });

for (const date of ['2026-10-03', '[10-03]']) {
  test(`placeholder links do not create discoveries or verification requests: ${date}`, async () => {
    const real = '<li><a href="/info/real.htm#details">2027年硕士研究生招生简章</a><time>2026-10-02</time></li>';
    let html = real;
    const writes = [];
    const requests = [];
    const options = { sources: [homepage], now: () => new Date('2026-10-04T04:00:00Z'),
      cacheStore: { load: async () => null, save: async snapshot => writes.push(structuredClone(snapshot)) },
      fetchImpl: async url => { requests.push(url); return reply(url, html); } };
    const service = createUpdateService(options);
    const first = await service.refresh();
    html = real + `<li><a href="">2027年硕士研究生招生专业目录</a><time>${date}</time></li>` +
      `<li><a href="&#35;">2027年硕士研究生报名公告</a><time>${date}</time></li>`;
    const second = await service.refresh();
    assert.equal(second.status, 'fresh');
    assert.equal(second.change.newCount, 0);
    assert.equal(second.change.updatedCount, 0);
    assert.deepEqual(second.updates.map(update => update.id), first.updates.map(update => update.id));
    assert.deepEqual(requests, [homepage.url, homepage.url]);
    assert.equal(writes.at(-1).updates.length, 1);
    assert.equal(writes.at(-1).sourceObservations.length, 1);
    const restarted = createUpdateService({ ...options,
      cacheStore: { load: async () => writes.at(-1), save: options.cacheStore.save } });
    await restarted.initialize();
    assert.deepEqual(restarted.getSnapshot().updates.map(update => update.id), first.updates.map(update => update.id));
    const repeated = await restarted.refresh();
    assert.equal(repeated.status, 'fresh');
    assert.equal(repeated.change.newCount, 0);
  });
}

for (const tag of ['textarea', 'title']) {
  test(`RCDATA ${tag} sample does not become a discovery or cached notice`, async () => {
    const real = '<li><a href="/info/real.htm">2027年硕士研究生招生简章</a><time>2026-10-02</time></li>';
    const sample = '<li><a href="/info/example.htm">2027年硕士研究生复试示例公告</a><time>2026-10-03</time></li>';
    let html = real;
    const writes = [];
    const options = { sources: [homepage], now: () => new Date('2026-10-04T04:00:00Z'),
      cacheStore: { load: async () => null, save: async snapshot => writes.push(structuredClone(snapshot)) },
      fetchImpl: async url => reply(url, html) };
    const service = createUpdateService(options);
    const first = await service.refresh();
    assert.equal(first.updates.length, 1);
    html = `<${tag}>${sample}</${tag}>${real}`;
    const second = await service.refresh();
    assert.equal(second.status, 'fresh');
    assert.equal(second.change.newCount, 0);
    assert.equal(second.change.updatedCount, 0);
    assert.deepEqual(second.updates.map(update => update.id), first.updates.map(update => update.id));
    assert.equal(writes.at(-1).updates.length, 1);
    const restarted = createUpdateService({ ...options,
      cacheStore: { load: async () => writes.at(-1), save: options.cacheStore.save } });
    await restarted.initialize();
    assert.deepEqual(restarted.getSnapshot().updates.map(update => update.id), first.updates.map(update => update.id));
  });
}

for (const [boundary, before, after, oldTitle, oldDate] of [
  ['July in Shanghai', '2026-06-30T15:59:59.999Z', '2026-06-30T16:00:00Z', '硕士研究生复试安排', '2025-09-20'],
  ['new year in Shanghai', '2026-12-31T15:59:59.999Z', '2026-12-31T16:00:00Z', '2026年硕士研究生招生简章', '2026-12-01'],
  ['publication age limit', '2026-07-03T00:00:00Z', '2026-07-03T00:00:00.001Z', '硕士研究生招生公告', '2025-01-01']
]) {
  for (const mode of ['success', 'partial failure', 'offline']) {
    for (const restart of [false, true]) {
      test(`cached admission cycle expires at ${boundary}: ${mode}${restart ? ' after restart' : ''}`, async () => {
        const sources = [{ ...homepage, context: 'hnu-master' },
          { id: 'computer', name: '计算机学院', url: 'https://cs.hainanu.edu.cn/', context: 'hnu-master' }];
        let clock = before;
        let crossedBoundary = false;
        const writes = [];
        const current = '<li><a href="info/current.htm">2027年硕士研究生招生简章</a><time>2026-01-01</time></li>';
        const targetHistory = '<li><a href="info/history.htm">2027年研究生招生学院联系方式</a><time>2024-10-17</time></li>';
        const old = `<li><a href="info/old.htm">${oldTitle}</a><time>${oldDate}</time></li>`;
        const options = { sources, now: () => new Date(clock), delayImpl: async () => {},
          cacheStore: { load: async () => null, save: async snapshot => writes.push(structuredClone(snapshot)) },
          fetchImpl: async url => {
            if (crossedBoundary && (mode === 'offline' || (mode === 'partial failure' && url === homepage.url))) throw new Error('offline');
            return reply(url, url === homepage.url ? current + old + (crossedBoundary ? '' : targetHistory) : current);
          } };
        let service = createUpdateService(options);
        const first = await service.refresh();
        assert.equal(first.status, 'fresh');
        assert.equal(first.updates.length, 4);
        clock = after;
        crossedBoundary = true;
        if (restart) {
          const saved = structuredClone(writes[0]);
          service = createUpdateService({ ...options,
            cacheStore: { load: async () => saved, save: options.cacheStore.save } });
          await service.initialize();
          assert.equal(service.getSnapshot().updates.some(update => update.url.endsWith('/old.htm')), false);
        }
        const result = await service.refresh();
        assert.equal(result.status, mode === 'success' ? 'fresh' : 'stale');
        assert.equal(result.updates.some(update => update.url.endsWith('/old.htm')), false);
        assert.equal(result.updates.length, 3);
        assert.equal(result.change.newCount, 0);
        assert.equal(result.updates.find(update => update.url.endsWith('/history.htm')).date, '2024-10-17');
        assert.equal(writes.length, mode === 'offline' ? 1 : 2);
        if (mode !== 'offline') assert.equal(writes.at(-1).updates.some(update => update.url.endsWith('/old.htm')), false);
      });
    }
  }
}

test('cached admission cycle reports seed when the only cached notice expires during an outage', async () => {
  let clock = '2026-06-30T15:59:59Z';
  let offline = false;
  const service = createUpdateService({ sources: [{ ...homepage, context: 'hnu-master' }],
    now: () => new Date(clock), delayImpl: async () => {},
    fetchImpl: async url => {
      if (offline) throw new Error('offline');
      return reply(url, '<li><a href="info/old.htm">硕士研究生复试安排</a><time>2025-09-20</time></li>');
    } });
  assert.equal((await service.refresh()).updates.length, 1);
  clock = '2026-06-30T16:00:00Z';
  offline = true;
  const result = await service.refresh();
  assert.equal(result.status, 'seed');
  assert.deepEqual(result.updates, []);
  assert.match(result.error, /尚无可用缓存/);
});

test('inline title formatting does not turn a style-only edit into a content update after restart', async () => {
  let title = '2027年硕士研究生招生简章';
  const writes = [];
  const options = { sources: [homepage], now: () => new Date('2026-10-04T04:00:00Z'),
    cacheStore: { load: async () => null, save: async snapshot => writes.push(structuredClone(snapshot)) },
    fetchImpl: async url => reply(url, `<li><a href="info/9910.htm"><img src="cover.jpg"></a>` +
      `<a href="info/9910.htm">${title}</a><time>2026-10-03</time></li>`) };
  const first = await createUpdateService(options).refresh();
  assert.equal(first.status, 'fresh');
  title = '20<b>27</b>年硕士研究生招生<strong>简章</strong>';
  const restarted = createUpdateService({ ...options,
    cacheStore: { load: async () => writes[0], save: async snapshot => writes.push(structuredClone(snapshot)) } });
  const result = await restarted.refresh();
  assert.equal(result.status, 'fresh');
  assert.equal(result.updates[0].title, '2027年硕士研究生招生简章');
  assert.equal(result.updates[0].category, '简章目录');
  assert.equal(result.updates[0].isImportant, true);
  assert.equal(result.updates[0].isTarget2027, true);
  assert.equal(result.updates[0].contentHash, first.updates[0].contentHash);
  assert.equal(result.change.updatedCount, 0);
  assert.equal(result.change.newCount, 0);
  assert.equal(writes.length, 2);
});

for (const yearless of [false, true]) {
  test(`repeated notice links persist one discovery${yearless ? ' after article verification' : ''}`, async () => {
    const writes = [];
    const old = '<li><a href="info/9900.htm">2027年硕士研究生招生简章</a><time>2026-10-02</time></li>';
    let html = old;
    const options = { sources: [homepage], now: () => new Date('2026-10-04T04:00:00Z'),
      cacheStore: { load: async () => null, save: async snapshot => writes.push(structuredClone(snapshot)) },
      fetchImpl: async url => reply(url, url === homepage.url ? html : '<meta name="PubDate" content="2026-10-03">') };
    const service = createUpdateService(options);
    await service.refresh();
    html += '<li><a href="info/9901.htm"><img src="cover.jpg"></a>' +
      '<a href="info/9901.htm">2027年硕士研究生招生专业目录</a><a href="info/9901.htm">查看详情</a>' +
      `<time>${yearless ? '[10-03]' : '2026-10-03'}</time></li>`;
    const added = await service.refresh();
    assert.equal(added.status, 'fresh');
    assert.equal(added.updates.length, 2);
    assert.equal(added.change.newCount, 1);
    assert.equal(added.updates[0].title, '2027年硕士研究生招生专业目录');
    assert.equal(added.updates[0].date, '2026-10-03');
    assert.equal(added.updates[0].dateVerified, true);
    const restarted = createUpdateService({ ...options,
      cacheStore: { load: async () => writes.at(-1), save: async snapshot => writes.push(structuredClone(snapshot)) } });
    await restarted.initialize();
    assert.equal(restarted.getSnapshot().updates.length, 2);
    const unchanged = await restarted.refresh();
    assert.equal(unchanged.status, 'fresh');
    assert.equal(unchanged.change.newCount, 0);
    assert.equal(unchanged.change.updatedCount, 0);
  });
}

test('repeated notice links migrate the version 2 inner-container baseline', async () => {
  const writes = [];
  const title = '<a href="info/9901.htm">2027年硕士研究生招生专业目录</a>';
  let html = `<div>${title}<span>2026-10-02</span></div>`;
  const options = { sources: [homepage], now: () => new Date('2026-10-04T04:00:00Z'), delayImpl: async () => {},
    cacheStore: { load: async () => null, save: async snapshot => writes.push(structuredClone(snapshot)) },
    fetchImpl: async url => reply(url, html) };
  await createUpdateService(options).refresh();
  const legacy = structuredClone(writes[0]);
  legacy.sources[0].parserVersion = 2;
  html = `<li><div>${title}<span>2026-10-02</span></div><a href="info/9901.htm">查看详情</a><time>2026-10-03</time></li>`;
  const restarted = createUpdateService({ ...options,
    cacheStore: { load: async () => legacy, save: async snapshot => writes.push(structuredClone(snapshot)) } });
  const migrated = await restarted.refresh();
  assert.equal(migrated.status, 'fresh');
  assert.deepEqual(migrated.sources[0].lastTrustedDiagnostics.containerTypes, ['li']);
  assert.equal(migrated.updates[0].date, '2026-10-03');
  assert.equal(migrated.change.newCount, 0);
  assert.equal(migrated.change.updatedCount, 1);
});

for (const [clock, actualDate] of [
  ['2026-10-04T04:00:00Z', '2024-02-29'],
  ['2028-01-15T04:00:00Z', '2024-02-29'],
  ['2028-03-01T04:00:00Z', '2028-02-29'],
  ['2029-03-01T04:00:00Z', '2028-02-29']
]) {
  test(`yearless leap day verifies the original year and survives restart at ${clock}`, async () => {
    const writes = [];
    const options = { sources: [homepage], now: () => new Date(clock), delayImpl: async () => {},
      cacheStore: { load: async () => null, save: async snapshot => writes.push(structuredClone(snapshot)) },
      fetchImpl: async url => reply(url, url === homepage.url
        ? '<li><a href="info/contacts.htm">2027年研究生招生学院联系方式</a><span>[02-29]</span></li>'
        : `<meta name="PubDate" content="${actualDate}">`) };
    const service = createUpdateService(options);
    const first = await service.refresh();
    assert.equal(first.status, 'fresh');
    assert.deepEqual(first.updates.map(update => update.date), [actualDate]);
    assert.equal(first.updates[0].dateVerified, true);
    assert.equal(Object.hasOwn(first.updates[0], 'dateInferred'), false);
    assert.equal(first.change.newCount, 1);
    const restarted = createUpdateService({ ...options,
      cacheStore: { load: async () => writes[0], save: async snapshot => writes.push(structuredClone(snapshot)) } });
    await restarted.initialize();
    assert.deepEqual(restarted.getSnapshot().updates.map(update => update.date), [actualDate]);
    const refreshed = await restarted.refresh();
    assert.equal(refreshed.status, 'fresh');
    assert.equal(refreshed.change.newCount, 0);
    assert.equal(refreshed.change.updatedCount, 0);
    assert.equal(writes.length, 2);
  });
}

for (const [name, article, error] of [
  ['missing metadata', '<p>报名截止：2024-02-29</p>', /无法核实通知原文/],
  ['invalid full date', '<meta name="PubDate" content="2026-02-29">', /无法核实通知原文/],
  ['future leap day', '<meta name="PubDate" content="2028-02-29">', /发布日期晚于当前日期/]
]) {
  test(`yearless leap day retains trusted cache with ${name}`, async () => {
    let label = '2024-02-29';
    const writes = [];
    const service = createUpdateService({ sources: [homepage], now: () => new Date('2026-10-04T04:00:00Z'),
      delayImpl: async () => {},
      cacheStore: { load: async () => null, save: async snapshot => writes.push(structuredClone(snapshot)) },
      fetchImpl: async url => reply(url, url === homepage.url
        ? `<li><a href="info/contacts.htm">2027年研究生招生学院联系方式</a><time>${label}</time></li>`
        : article) });
    const trusted = await service.refresh();
    assert.equal(trusted.status, 'fresh');
    label = '[02-29]';
    const failed = await service.refresh();
    assert.equal(failed.status, 'stale');
    assert.match(failed.sources[0].error, error);
    assert.deepEqual(failed.updates, trusted.updates);
    assert.equal(writes.length, 1);
  });
}

test('yearless leap day handling still rejects impossible full and short dates', () => {
  for (const label of ['2026-02-29', '[02-30]', '[04-31]']) {
    const html = `<li><a href="info/contacts.htm">2027年研究生招生学院联系方式</a><time>${label}</time></li>`;
    assert.deepEqual(parseOfficialList(html, homepage, '2026-10-04T04:00:00Z'), [], label);
  }
});

for (const [clock, today, tomorrow] of [
  ['2026-10-02T15:59:59.999Z', '2026-10-02', '2026-10-03'],
  ['2026-10-02T16:00:00Z', '2026-10-03', '2026-10-04'],
  ['2026-10-03T04:00:00Z', '2026-10-03', '2026-10-04'],
  ['2026-12-31T16:00:00Z', '2027-01-01', '2027-01-02'],
  ['2028-02-28T16:00:00Z', '2028-02-29', '2028-03-01']
]) {
  for (const yearless of [false, true]) {
    test(`future publication guard: ${yearless ? 'article' : 'full list date'} at ${clock}`, async () => {
      let date = today;
      const writes = [];
      const options = { sources: [homepage], now: () => new Date(clock), delayImpl: async () => {},
        cacheStore: { load: async () => null, save: async snapshot => writes.push(structuredClone(snapshot)) },
        fetchImpl: async url => reply(url, url === homepage.url
          ? `<li><a href="info/9901.htm">2027年硕士研究生招生报名公告</a><time>${yearless ? `[${date.slice(5)}]` : date}</time></li>`
          : `<meta name="PubDate" content="${date}">`) };
      const service = createUpdateService(options);
      const trusted = await service.refresh();
      assert.equal(trusted.status, 'fresh');
      assert.equal(trusted.updates[0].date, today);
      assert.equal(trusted.updates[0].dateVerified, true);
      date = tomorrow;
      const rejected = await service.refresh();
      assert.equal(rejected.status, 'stale');
      assert.match(rejected.sources[0].error, /发布日期晚于当前日期/);
      assert.deepEqual(rejected.updates, trusted.updates);
      assert.equal(writes.length, 1);
      const cold = await createUpdateService(options).refresh();
      assert.equal(cold.sources[0].ok, false);
      assert.equal(cold.updates.length, 0);
      assert.equal(writes.length, 1);
      const restarted = createUpdateService({ ...options,
        cacheStore: { load: async () => writes[0], save: async () => assert.fail('initialize must not write') } });
      await restarted.initialize();
      assert.deepEqual(restarted.getSnapshot().updates.map(update => update.date), [today]);
    });
  }

  test(`future publication guard filters restored cache at ${clock}`, async () => {
    const updates = [today, tomorrow].map(date => ({ id: date, date, dateVerified: true,
      title: '2027年硕士研究生招生公告', sourceId: homepage.id, source: homepage.name,
      url: `https://gs.hainanu.edu.cn/info/${date}.htm` }));
    const service = createUpdateService({ sources: [homepage], now: () => new Date(clock), delayImpl: async () => {},
      cacheStore: { load: async () => ({ updates }), save: async () => assert.fail('offline refresh must not write') },
      fetchImpl: async () => { throw new Error('offline'); } });
    await service.initialize();
    assert.deepEqual(service.getSnapshot().updates.map(update => update.date), [today]);
    const offline = await service.refresh();
    assert.deepEqual(offline.updates.map(update => update.date), [today]);
  });
}

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
