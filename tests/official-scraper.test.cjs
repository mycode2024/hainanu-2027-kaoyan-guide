const test = require('node:test');
const assert = require('node:assert/strict');

function loadScraper() {
  try {
    delete require.cache[require.resolve('../src/official-scraper.cjs')];
    return require('../src/official-scraper.cjs');
  } catch {
    return {};
  }
}

const graduateSource = {
  id: 'hnu-graduate',
  name: '海南大学研究生院',
  url: 'https://gs.hainanu.edu.cn/yjszs/ssszs.htm',
  context: 'graduate-admissions-list'
};

const computerSource = {
  id: 'hnu-computer',
  name: '海南大学计算机科学与技术学院',
  url: 'https://cs.hainanu.edu.cn/zsgz/yjszs.htm'
};

for (const href of ['', ' \t\n', '#', '#details', '&#35;', '&#x23;details', ' &#32;&#35;details ']) {
  test(`placeholder notice links are excluded: ${JSON.stringify(href)}`, () => {
    const { parseOfficialDocument } = loadScraper();
    for (const container of ['li', 'div']) {
      const html = `<${container}><a href="${href}">2027年硕士研究生招生专业目录</a><time>2026-10-03</time></${container}>`;
      const result = parseOfficialDocument(html, graduateSource, '2026-10-04T04:00:00Z', 'https://gs.hainanu.edu.cn/new/list.htm');
      assert.deepEqual(result.updates, []);
      assert.equal(result.diagnostics.relevantCount, 0);
    }
  });
}

test('placeholder rejection preserves article fragments, relative links and query targets', () => {
  const { parseOfficialDocument } = loadScraper();
  for (const [href, expected] of [
    ['../info/1.htm#details', 'https://gs.hainanu.edu.cn/info/1.htm'],
    ['/info/2.htm&#35;details', 'https://gs.hainanu.edu.cn/info/2.htm'],
    ['?article=3#details', 'https://gs.hainanu.edu.cn/new/list.htm?article=3'],
    [' /info/4.htm ', 'https://gs.hainanu.edu.cn/info/4.htm']
  ]) {
    const result = parseOfficialDocument(`<li><a href="${href}">2027年硕士研究生招生简章</a><time>2026-10-03</time></li>`,
      graduateSource, '2026-10-04T04:00:00Z', 'https://gs.hainanu.edu.cn/new/list.htm');
    assert.deepEqual(result.updates.map(update => update.url), [expected]);
  }
});

test('placeholder links keep card boundaries against borrowing a sibling date', () => {
  const { parseOfficialList } = loadScraper();
  const html = '<div><li><a href="/info/real.htm">2027年硕士研究生招生简章</a></li>' +
    '<li><a href="#">2027年硕士研究生招生专业目录</a><time>2026-10-03</time></li></div>';
  assert.deepEqual(parseOfficialList(html, graduateSource, '2026-10-04T04:00:00Z'), []);
});

for (const tag of ['textarea', 'title']) {
  const fake = '<li><a href="/info/example.htm">2027年硕士研究生复试示例公告</a><time>2026-10-03</time></li>';
  const real = '<li><a href="/info/real.htm">2027年硕士研究生招生简章</a><time>2026-10-02</time></li>';
  for (const [variant, prefix] of [
    ['ordinary', `<${tag}>${fake}</${tag}>`],
    ['self-closing slash ignored in HTML', `<${tag} />${fake}</${tag}>`],
    ['mixed-case closing tag and false closing prefix', `<${tag}>文字</${tag}-example>${fake}</${tag.toUpperCase()} >`],
    ['template closing tag is plain text', `<template><${tag}></template>${fake}</${tag}></template>`]
  ]) {
    test(`RCDATA ${tag} excludes sample notices: ${variant}`, () => {
      const { parseOfficialDocument } = loadScraper();
      const result = parseOfficialDocument(prefix + real, graduateSource, '2026-10-04T04:00:00Z');
      assert.deepEqual(result.updates.map(update => update.url), ['https://gs.hainanu.edu.cn/info/real.htm']);
      assert.equal(result.diagnostics.candidateCount, 1);
      assert.equal(result.updates[0].date, '2026-10-02');
    });
  }

  test(`RCDATA unclosed ${tag} consumes sample markup through EOF`, () => {
    const { parseOfficialList } = loadScraper();
    assert.deepEqual(parseOfficialList(`<${tag}>${fake}`, graduateSource, '2026-10-04T04:00:00Z'), []);
  });

  test(`RCDATA ${tag} cannot supply publication metadata or bylines`, () => {
    const { parseOfficialPublicationDate } = loadScraper();
    const sample = `<${tag}><meta name="PubDate" content="2026-10-03">2026年10月3日 12:00 来源：研究生院</${tag}>`;
    assert.equal(parseOfficialPublicationDate(sample), null);
    assert.equal(parseOfficialPublicationDate(sample + '<meta name="PubDate" content="2026-10-02">'), '2026-10-02');
  });
}

for (const [name, markup, title, category, important] of [
  ['strong guide keyword', '2027年硕士研究生招生<strong>简章</strong>', '2027年硕士研究生招生简章', '简章目录', true],
  ['nested span and emphasis', '复<span><em>试</em></span>公告', '复试公告', '复试录取', true],
  ['legacy font tag', '2027年硕士研究生专业<font color="red">目录</font>', '2027年硕士研究生专业目录', '简章目录', true],
  ['highlighted confirmation', '网上<mark>确认</mark>公告', '网上确认公告', '报名确认', false],
  ['split admission year', '20<b>27</b>年硕士研究生招生简章', '2027年硕士研究生招生简章', '简章目录', true],
  ['doctoral exclusion', '2027年博<strong>士</strong>研究生招生简章', null, null],
  ['undergraduate exclusion', '2027年本<span>科</span>招生简章', null, null]
]) {
  test(`inline title formatting preserves ${name}`, () => {
    const { parseOfficialList } = loadScraper();
    const html = `<li><a href="/info/9910.htm">${markup}</a><time>2026-10-03</time></li>`;
    const result = parseOfficialList(html, graduateSource, '2026-10-04T04:00:00Z');
    if (!title) return assert.deepEqual(result, []);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, title);
    assert.equal(result[0].category, category);
    assert.equal(result[0].isImportant, important);
    if (title.startsWith('2027')) assert.equal(result[0].isTarget2027, true);
  });
}

test('inline title formatting preserves real whitespace and removed publication boundaries', () => {
  const { parseOfficialList } = loadScraper();
  for (const [markup, title] of [
    ['2027年硕士研究生招生<br>简章', '2027年硕士研究生招生 简章'],
    ['2027年硕士研究生招生<div>简章</div>', '2027年硕士研究生招生 简章'],
    ['2027年硕士研究生招生 <strong>简章</strong>', '2027年硕士研究生招生 简章'],
    ['2027年硕士研究生招生<span class="date">2026-10-03</span>简章', '2027年硕士研究生招生 简章'],
    ['2027年硕士研究生招生<span>简章</span> &lt;补充&gt;', '2027年硕士研究生招生简章 <补充>']
  ]) {
    const result = parseOfficialList(`<li><a href="/info/9910.htm">${markup}</a><time>2026-10-03</time></li>`, graduateSource, '2026-10-04T04:00:00Z');
    assert.equal(result[0]?.title, title);
  }
});

test('inline title formatting does not join fragments into a publication date', () => {
  const { parseOfficialList } = loadScraper();
  const html = '<li><a href="/info/9910.htm">2027年硕士研究生招生<strong>简章</strong></a>' +
    '<span>2026-</span><span>10-03</span></li>';
  assert.deepEqual(parseOfficialList(html, graduateSource, '2026-10-04T04:00:00Z'), []);
});

for (const [name, links] of [
  ['image before title', '<a href="/info/9901.htm"><img src="cover.jpg" alt="封面"></a>TITLE'],
  ['read-more before title', '<a href="/info/9901.htm">查看详情</a>TITLE'],
  ['read-more after title', 'TITLE<a href="/info/9901.htm">查看详情</a>'],
  ['duplicate titles', 'TITLETITLE'],
  ['nested title', '<a href="/info/9901.htm"><img src="cover.jpg"></a><div>TITLE</div>']
]) {
  for (const container of ['li', 'div']) {
    test(`repeated notice links: ${name} in ${container}`, () => {
      const { parseOfficialDocument } = loadScraper();
      const title = '2027年硕士研究生招生专业目录';
      const anchor = `<a href="/info/9901.htm">${title}</a>`;
      const html = `<${container}>${links.replaceAll('TITLE', anchor)}<time>2026-10-03</time></${container}>`;
      const parsed = parseOfficialDocument(html, graduateSource, '2026-10-04T04:00:00Z');
      assert.deepEqual(parsed.updates.map(({ title, date, url }) => ({ title, date, url })), [{
        title, date: '2026-10-03', url: 'https://gs.hainanu.edu.cn/info/9901.htm'
      }]);
      assert.deepEqual(parsed.diagnostics, { candidateCount: 1, relevantCount: 1, containerTypes: [container] });
    });
  }
}

test('repeated notice links compare resolved URLs using the redirected page and decoded entities', () => {
  const { parseOfficialList } = loadScraper();
  const html = '<li><a href="../info/9901.htm?a=1&amp;b=2#cover"><img src="cover.jpg"></a>' +
    '<a href="https://gs.hainanu.edu.cn/new/info/9901.htm?a=1&b=2#title">2027年硕士研究生招生专业目录</a><time>2026-10-03</time></li>';
  // parseOfficialDocument accepts the effective document URL after redirects.
  const { parseOfficialDocument } = loadScraper();
  const result = parseOfficialDocument(html, graduateSource, '2026-10-04T04:00:00Z', 'https://gs.hainanu.edu.cn/new/list/index.htm');
  assert.deepEqual(result.updates.map(update => update.url), ['https://gs.hainanu.edu.cn/new/info/9901.htm?a=1&b=2']);
  assert.deepEqual(parseOfficialList(html, graduateSource, '2026-10-04T04:00:00Z'), []);
});

test('repeated notice links do not join distinct query targets or borrow a surrounding date', () => {
  const { parseOfficialList } = loadScraper();
  const title = '2027年硕士研究生招生专业目录';
  for (const html of [
    `<li><a href="/info/9901.htm?part=1">${title}</a><a href="/info/9901.htm?part=2">查看详情</a><time>2026-10-03</time></li>`,
    `<div><li><a href="/info/9901.htm"><img src="cover.jpg"></a><a href="/info/9901.htm">${title}</a></li><time>2026-10-03</time></div>`
  ]) assert.deepEqual(parseOfficialList(html, graduateSource, '2026-10-04T04:00:00Z'), []);
});

for (const preview of ['<img src="cover.jpg">', '查看详情']) {
  for (const label of ['<time>2026-10-03</time>', '<span>2026-10-03</span>', '<div class="date">2026-10-03</div>']) {
    test(`repeated notice links retain the outer title with preview ${preview} and ${label}`, () => {
      const { parseOfficialDocument } = loadScraper();
      const html = `<li><p>报名截止：2026-10-20</p><div class="preview"><a href="/info/9901.htm">${preview}</a>${label}</div>` +
        '<a href="/info/9901.htm">2027年硕士研究生招生专业目录</a></li>';
      const parsed = parseOfficialDocument(html, graduateSource, '2026-10-04T04:00:00Z');
      assert.deepEqual(parsed.updates.map(({ title, date }) => ({ title, date })), [{
        title: '2027年硕士研究生招生专业目录', date: '2026-10-03'
      }]);
      assert.deepEqual(parsed.diagnostics.containerTypes, ['li']);
    });
  }
}

test('repeated notice links in separate dated cards cannot borrow the outer footer date', () => {
  const { parseOfficialDocument } = loadScraper();
  const card = date => `<div><a href="/info/9901.htm">2027年硕士研究生招生专业目录</a><span>${date}</span></div>`;
  const html = `<div>${card('2026-10-02')}${card('2026-10-03')}<footer><time>2026-10-04</time></footer></div>`;
  const parsed = parseOfficialDocument(html, graduateSource, '2026-10-04T04:00:00Z');
  assert.deepEqual(parsed.updates.map(update => update.date), ['2026-10-02']);
  assert.equal(parsed.diagnostics.candidateCount, 2);
});

for (const listType of ['ul', 'ol', 'menu']) {
  test(`optional li end tags preserve separate notices inside ${listType}`, () => {
    const { parseOfficialDocument } = loadScraper();
    const card = n => `<li><a href="/info/970${n}.htm">2027年硕士研究生招生公告${n}</a><time>2026-09-2${n}</time>`;
    const html = `<${listType}>${card(1)}${card(2)}</li>${card(3)}</${listType}>`;
    const result = parseOfficialDocument(html, graduateSource, '2026-10-02T04:00:00Z');
    assert.deepEqual(result.updates.map(({ title, date, url }) => ({ title, date, url })), [1, 2, 3].map(n => ({
      title: `2027年硕士研究生招生公告${n}`, date: `2026-09-2${n}`,
      url: `https://gs.hainanu.edu.cn/info/970${n}.htm`
    })));
    assert.deepEqual(result.diagnostics, { candidateCount: 3, relevantCount: 3, containerTypes: ['li'] });
  });
}

test('optional li end tags respect nested list ownership', () => {
  const { parseOfficialDocument } = loadScraper();
  const card = n => `<li><a href="/info/970${n}.htm">2027年硕士研究生招生公告${n}</a><time>2026-09-29</time>`;
  const html = `<ul><li>招生栏目<ol>${card(1)}${card(2)}</ol>${card(3)}</ul>`;
  const result = parseOfficialDocument(html, graduateSource, '2026-10-02T04:00:00Z');
  assert.deepEqual(result.updates.map(update => update.url), [1, 2, 3].map(n => `https://gs.hainanu.edu.cn/info/970${n}.htm`));
  assert.equal(result.diagnostics.candidateCount, 3);
});

test('optional li boundaries cannot borrow dates from siblings or outside the list', () => {
  const { parseOfficialList } = loadScraper();
  const link = '<a href="/info/9701.htm">2027年硕士研究生招生公告</a>';
  for (const html of [
    `<ul><li>${link}<li>其他内容<time>2026-09-29</time></ul>`,
    `<ul><li>${link}</ul><time>2026-09-29</time>`,
    `<ul><li>${link}</ul><ol><li><time>2026-09-29</time></li></ol>`
  ]) assert.deepEqual(parseOfficialList(html, graduateSource, '2026-10-02T04:00:00Z'), []);
});

test('optional li support does not accept an abruptly truncated list', () => {
  const { parseOfficialList } = loadScraper();
  const html = '<ul><li><a href="/info/9701.htm">2027年硕士研究生招生公告</a><time>2026-09-29</time>';
  assert.deepEqual(parseOfficialList(html, graduateSource, '2026-10-02T04:00:00Z'), []);
});

for (const [name, attributes] of [
  ['data-href after href', 'href="/info/1024/9301.htm" data-href="/info/1024/8000.htm"'],
  ['href text inside another attribute', 'href="/info/1024/9301.htm" title="preview href=\'/info/1024/8000.htm\'"'],
  ['greater-than before href', 'title="人数 > 30" href="/info/1024/9301.htm"'],
  ['greater-than after href', 'href="/info/1024/9301.htm" title="人数 > 30"'],
  ['unquoted href', 'href=/info/1024/9301.htm'],
  ['mixed-case href with spacing', "HREF \n = \t '/info/1024/9301.htm'"],
  ['boolean attribute before href', 'download href=/info/1024/9301.htm'],
  ['duplicate href keeps first value', 'href="/info/1024/9301.htm" href="/info/1024/8000.htm"']
]) {
  test(`notice anchor attributes: ${name}`, () => {
    const { parseOfficialList } = loadScraper();
    const title = '海南大学2027年硕士研究生招生简章';
    const html = `<li><a ${attributes}>${title}</a><time>2026-09-29</time></li>`;
    const updates = parseOfficialList(html, graduateSource, '2026-10-01T04:00:00Z');
    assert.deepEqual(updates.map(({ url, title, date }) => ({ url, title, date })), [{
      url: 'https://gs.hainanu.edu.cn/info/1024/9301.htm', title, date: '2026-09-29'
    }]);
  });
}

for (const attributes of [
  'data-href="/info/1024/8000.htm"',
  'title="href=\'/info/1024/8000.htm\'"',
  'href="https://example.com/notice.htm" data-href="/info/1024/8000.htm"'
]) {
  test(`does not manufacture an official link from ${attributes}`, () => {
    const { parseOfficialList } = loadScraper();
    const html = `<li><a ${attributes}>2027年硕士研究生招生简章</a><time>2026-09-29</time></li>`;
    assert.deepEqual(parseOfficialList(html, graduateSource, '2026-10-01T04:00:00Z'), []);
  });
}

for (const [name, body] of [
  ['attribute date after greater-than', '<a href="/info/9501.htm">TITLE</a><span title="比较 > 2020-01-01">2026-09-29</span>'],
  ['attribute text inside title', '<a href="/info/9501.htm"><span title="比较 > 隐藏内容">TITLE</span></a><time>2026-09-29</time>'],
  ['closing container tag inside an attribute', '<a href="/info/9501.htm" title="示例 </li>">TITLE</a><time>2026-09-29</time>'],
  ['unquoted date class', '<a href="/info/9501.htm">TITLE<span class=date>2026-09-29</span></a>'],
  ['nested date span', '<a href="/info/9501.htm">TITLE<span class="date"><span>发布：</span>2026-09-29</span></a>'],
  ['nested time and span date labels', '<a href="/info/9501.htm">TITLE<span class="date"><time>2026-09-29</time></span></a>'],
  ['time with trailing slash', '<a href="/info/9501.htm">TITLE<time/>2026-09-29</time></a>'],
  ['span with trailing slash', '<a href="/info/9501.htm">TITLE<span class="date" />2026-09-29</span></a>'],
  ['anchor with trailing slash', '<a href="/info/9501.htm" />TITLE（2026-12-19）</a><time>2026-09-29</time>'],
  ['fake closing anchor inside attribute', '<a href="/info/9501.htm" title="示例 </a>">TITLE（2026-12-19）</a><time>2026-09-29</time>']
]) {
  test(`visible notice boundaries: ${name}`, () => {
    const { parseOfficialDocument } = loadScraper();
    const title = '2027年硕士研究生招生简章';
    const result = parseOfficialDocument(`<li>${body.replace('TITLE', title)}</li>`, graduateSource, '2026-10-01T04:00:00Z');
    assert.deepEqual(result.updates.map(({ title, date, url }) => ({ title, date, url })), [{
      title: body.includes('（2026-12-19）') ? `${title}（2026-12-19）` : title,
      date: '2026-09-29', url: 'https://gs.hainanu.edu.cn/info/9501.htm'
    }]);
    assert.equal(result.diagnostics.candidateCount, 1);
  });
}

test('custom container names and fake date classes cannot supply a publication label', () => {
  const { parseOfficialList } = loadScraper();
  const title = '2027年硕士研究生招生简章';
  for (const html of [
    `<li-preview><a href="/info/9501.htm">${title}</a><time>2026-09-29</time></li-preview>`,
    `<li><a href="/info/9501.htm">${title}<span data-class="date">2026-12-19</span></a></li>`,
    `<li><a href="/info/9501.htm">${title}<span title="class='date'">2026-12-19</span></a></li>`
  ]) assert.deepEqual(parseOfficialList(html, graduateSource, '2026-10-01T04:00:00Z'), []);
});

test('text cleaning preserves literal angle brackets and ignores comments and declarations', () => {
  const { cleanText } = loadScraper();
  assert.equal(cleanText('<!DOCTYPE html><b title="a > b">正文</b><!-- hidden --> &lt; 3'), '正文 < 3');
});

test('removing a notice title cannot join separate text fragments into a publication date', () => {
  const { parseOfficialList } = loadScraper();
  const body = '2020-<a href="/info/9501.htm">2027年硕士研究生招生简章</a>01-01';
  for (const [suffix, expectedDates] of [['', []], ['<time>2026-09-29</time>', ['2026-09-29']]]) {
    assert.deepEqual(parseOfficialList(`<li>${body}${suffix}</li>`, graduateSource, '2026-10-01T04:00:00Z')
      .map(update => update.date), expectedDates);
  }
});

test('keeps publication labels out of titles and admission-year detection', () => {
  const { parseOfficialList } = loadScraper();
  const title = '2026年硕士研究生招生考试（2026-12-19）安排';
  for (const label of ['<time>2025-09-20</time>', '<span class="notice-date">2025-09-20</span>']) {
    const html = `<li><a href="info/9001.htm">${label}<span class="title">${title}</span></a></li>`;
    const [update] = parseOfficialList(html, graduateSource, '2026-09-27T04:00:00Z');
    assert.equal(update?.title, title, label);
    assert.equal(update.date, '2025-09-20');
  }
});

test('does not add publication text to target-year clickable card titles', () => {
  const { parseOfficialList } = loadScraper();
  const title = '2027年硕士研究生招生考试（2026-12-19）安排';
  const html = `<li><a href="info/9001.htm"><span>${title}</span><time>2026-09-20</time></a></li>`;
  const [update] = parseOfficialList(html, graduateSource, '2026-09-27T04:00:00Z');
  assert.equal(update.title, title);
  assert.equal(update.date, '2026-09-20');
});

test('classifies recommended-admission interviews and offers under recommended admission', () => {
  const { parseOfficialList, categorizeTitle } = loadScraper();
  for (const title of ['2027年推免硕士研究生复试录取办法', '2027年推荐免试硕士研究生拟录取公示']) {
    const [update] = parseOfficialList(`<li><a href="info/9001.htm">${title}</a><time>2026-09-20</time></li>`, graduateSource, '2026-09-27T04:00:00Z');
    assert.equal(update.category, '推免');
  }
  assert.equal(categorizeTitle('2027年硕士研究生复试录取办法', graduateSource), '复试录取');
});

test('keeps ordinary admissions notices out of recommended admission when it is explicitly excluded', () => {
  const { categorizeTitle } = loadScraper();
  for (const title of [
    '2027年硕士研究生拟录取名单公示（不含推免生）',
    '2027年非推免硕士研究生复试录取办法',
    '2027年硕士研究生拟录取名单（不包括推荐免试研究生）',
    '2027年硕士研究生复试安排（推免生除外）'
  ]) assert.equal(categorizeTitle(title, graduateSource), '复试录取', title);
});

test('uses the publication label instead of an exam date in the linked title', () => {
  const { parseOfficialList } = loadScraper();
  const html = '<li><a href="info/9001.htm">2027年硕士研究生招生考试（2026-12-19）安排</a><time>2026-09-20</time></li>';
  const [update] = parseOfficialList(html, graduateSource, '2026-09-27T04:00:00Z');
  assert.equal(update.date, '2026-09-20');
  assert.equal(update.dateInferred, undefined);
});

test('a full date in the title cannot verify a yearless publication label', () => {
  const { parseOfficialList } = loadScraper();
  const html = '<li><a href="info/9001.htm">2027年硕士研究生招生考试（2026-12-19）安排</a><span>[09-20]</span></li>';
  const [update] = parseOfficialList(html, graduateSource, '2026-09-27T04:00:00Z');
  assert.equal(update.date, '2026-09-20');
  assert.equal(update.dateInferred, true);
  assert.deepEqual(parseOfficialList('<li><a href="info/9001.htm">2027年硕士研究生招生考试（2026-12-19）安排</a></li>', graduateSource), []);
});

test('an impossible full date does not mark a fallback short date as verified', () => {
  const { parseOfficialList } = loadScraper();
  const [update] = parseOfficialList('<li><a href="info/9001.htm">2027年硕士研究生招生公告</a><time>2026-02-30</time><span>[09-20]</span></li>', graduateSource, '2026-09-27T04:00:00Z');
  assert.equal(update.date, '2026-09-20');
  assert.equal(update.dateInferred, true);
});

test('retains explicit publication labels inside a clickable notice card', () => {
  const { parseOfficialList } = loadScraper();
  for (const label of ['<time>2026-09-20</time>', '<span class="notice-date">2026-09-20</span>', '<span class="date">[09-20]</span>']) {
    const html = `<li><a href="info/9001.htm"><span class="title">2027年硕士研究生招生考试（2026-12-19）安排</span>${label}</a></li>`;
    const [update] = parseOfficialList(html, graduateSource, '2026-09-27T04:00:00Z');
    assert.equal(update?.date, '2026-09-20', label);
    assert.equal(update.dateInferred === true, label.includes('[09-20]'));
  }
});

test('parses official list variants into safe absolute notice records', () => {
  const { parseOfficialList } = loadScraper();
  assert.equal(typeof parseOfficialList, 'function', 'parseOfficialList must be exported');

  const graduateHtml = `
    <ul>
      <li><a href="../info/1024/8892.htm" target="_blank"> 关于调整2027年硕士研究生招生考试初试科目的通知 </a><span>2026-07-02</span></li>
      <li><a href="../info/1024/9000.htm">海南大学2027年硕士研究生招生简章 &amp; 专业目录</a><span>2026-09-25</span></li>
      <li><a href="mailto:test@hainanu.edu.cn">联系我们</a><span>2026-09-30</span></li>
    </ul>`;
  const computerHtml = `
    <ul>
      <li><span><a href="../info/1086/11860.htm">海南大学计算机科学与技术学院2026年硕士研究生复试录取工作实施细则</a></span><i>2026-03-24</i></li>
      <li><span><a href="javascript:void(0)">研究生招生</a></span><i>2026-03-20</i></li>
    </ul>`;

  const graduate = parseOfficialList(graduateHtml, graduateSource);
  const computer = parseOfficialList(computerHtml, computerSource);

  assert.deepEqual(graduate.map(({ title, date, url, category, isTarget2027 }) => ({
    title, date, url, category, isTarget2027
  })), [
    {
      title: '关于调整2027年硕士研究生招生考试初试科目的通知',
      date: '2026-07-02',
      url: 'https://gs.hainanu.edu.cn/info/1024/8892.htm',
      category: '初试科目',
      isTarget2027: true
    },
    {
      title: '海南大学2027年硕士研究生招生简章 & 专业目录',
      date: '2026-09-25',
      url: 'https://gs.hainanu.edu.cn/info/1024/9000.htm',
      category: '简章目录',
      isTarget2027: true
    }
  ]);
  assert.equal(computer.length, 1);
  assert.deepEqual(
    { title: computer[0].title, date: computer[0].date, url: computer[0].url, category: computer[0].category },
    {
      title: '海南大学计算机科学与技术学院2026年硕士研究生复试录取工作实施细则',
      date: '2026-03-24',
      url: 'https://cs.hainanu.edu.cn/info/1086/11860.htm',
      category: '复试录取'
    }
  );
});

test('masks script bodies when an unquoted attribute value ends with a slash', () => {
  const { parseOfficialList } = loadScraper();
  const html = [
    '<ul>',
    '<li><script src=/app.js/>window.noticeDate = "2021-01-01";</script>',
    '<a href="../info/1024/9001.htm">海南大学2027年硕士研究生招生简章</a><span>2026-09-01</span></li>',
    '</ul>'
  ].join('');
  const updates = parseOfficialList(html, graduateSource);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].date, '2026-09-01');
});

test('masks template bodies when an unquoted attribute value ends with a slash', () => {
  const { parseOfficialList } = loadScraper();
  const html = [
    '<ul>',
    '<li><template data-x=/><a href="../info/1024/9999.htm">幽灵公告</a><span>2026-09-02</span></template>',
    '<a href="../info/1024/9001.htm">海南大学2027年硕士研究生招生简章</a><span>2026-09-01</span></li>',
    '</ul>'
  ].join('');
  const updates = parseOfficialList(html, graduateSource);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].title, '海南大学2027年硕士研究生招生简章');
  assert.equal(updates[0].url, 'https://gs.hainanu.edu.cn/info/1024/9001.htm');
});

test('deduplicates updates and prioritizes target-cycle actionable notices', () => {
  const { mergeAndRankUpdates } = loadScraper();
  assert.equal(typeof mergeAndRankUpdates, 'function', 'mergeAndRankUpdates must be exported');

  const input = [
    { title: '海南大学2026年录取通知书发放通知', date: '2026-07-02', url: 'https://gs.hainanu.edu.cn/info/1024/8882.htm', sourceId: 'hnu-graduate', isTarget2027: false, isImportant: false },
    { title: '海南大学2027年硕士研究生招生专业目录', date: '2026-09-25', url: 'https://gs.hainanu.edu.cn/info/1024/9000.htm', sourceId: 'hnu-graduate', isTarget2027: true, isImportant: true },
    { title: '海南大学2027年硕士研究生招生专业目录', date: '2026-09-25', url: 'https://gs.hainanu.edu.cn/info/1024/9000.htm', sourceId: 'duplicate', isTarget2027: true, isImportant: true },
    { title: '海南大学2027年网上报名公告', date: '2026-09-20', url: 'https://gs.hainanu.edu.cn/info/1024/8990.htm', sourceId: 'hnu-graduate', isTarget2027: true, isImportant: true }
  ];

  const result = mergeAndRankUpdates(input, 3);
  assert.deepEqual(result.map((item) => item.title), [
    '海南大学2027年硕士研究生招生专业目录',
    '海南大学2027年网上报名公告',
    '海南大学2026年录取通知书发放通知'
  ]);
});

test('keeps same-title notices with distinct official URLs and favors recency within a cycle', () => {
  const { mergeAndRankUpdates } = loadScraper();
  const input = [
    { title: '复试名单公示', date: '2025-03-20', url: 'https://gs.hainanu.edu.cn/info/1024/7001.htm', sourceId: 'hnu-graduate', isTarget2027: false, isImportant: true },
    { title: '复试名单公示', date: '2026-03-20', url: 'https://cs.hainanu.edu.cn/info/1086/8001.htm', sourceId: 'hnu-computer', isTarget2027: false, isImportant: true },
    { title: '硕士研究生招生工作说明', date: '2026-08-23', url: 'https://gs.hainanu.edu.cn/info/1024/9001.htm', sourceId: 'hnu-graduate', isTarget2027: false, isImportant: false }
  ];

  const result = mergeAndRankUpdates(input, 10);
  assert.deepEqual(result.map((item) => item.url), [
    'https://gs.hainanu.edu.cn/info/1024/9001.htm',
    'https://cs.hainanu.edu.cn/info/1086/8001.htm',
    'https://gs.hainanu.edu.cn/info/1024/7001.htm'
  ]);
});

test('uses the admissions-list context for short actionable titles while excluding doctoral notices', () => {
  const { parseOfficialList } = loadScraper();
  const html = `
    <ul>
      <li><a href="../info/1024/9010.htm">2027年招生专业目录</a><span>2026-09-26</span></li>
      <li><a href="../info/1024/9011.htm">复试名单公示</a><span>2027-03-25</span></li>
      <li><a href="../info/1024/9012.htm">2027年博士研究生招生简章</a><span>2026-09-27</span></li>
      <li><a href="../info/1024/9013.htm">本科生招生计划</a><span>2026-09-28</span></li>
    </ul>`;

  const updates = parseOfficialList(html, graduateSource);
  assert.deepEqual(updates.map((item) => item.title), [
    '2027年招生专业目录',
    '复试名单公示'
  ]);
});

test('infers the publication year for month-day notices on the HNU homepage', () => {
  const { parseOfficialList } = loadScraper();
  const homepageSource = {
    id: 'hnu-graduate-home',
    name: '海南大学研究生院首页',
    url: 'https://gs.hainanu.edu.cn/',
    allowedHosts: ['hainanu.edu.cn'],
    context: 'hnu-home'
  };
  const html = `
    <ul>
      <li><a href="info/1019/8072.htm">2026年全国硕士研究生招生考试海南大学考点网上确认公告</a><span>[10-28]</span></li>
      <li><a href="info/1019/9010.htm">关于2027年全国硕士研究生招生预报名的温馨提醒</a><span>[09-30]</span></li>
    </ul>`;

  const augustCheck = parseOfficialList(html, homepageSource, '2026-08-23T04:00:00.000Z');
  const octoberCheck = parseOfficialList(html, homepageSource, '2026-10-01T04:00:00.000Z');

  assert.deepEqual(augustCheck.map((item) => item.date), ['2025-10-28', '2025-09-30']);
  assert.deepEqual(octoberCheck.map((item) => item.date), ['2026-10-28', '2026-09-30']);
});

test('accepts relevant CHSI ministry policy notices and rejects unrelated policy or off-domain links', () => {
  const { parseOfficialList } = loadScraper();
  const policySource = {
    id: 'chsi-ministry-policy',
    name: '研招网 · 教育部政策',
    url: 'https://yz.chsi.com.cn/kyzx/jybzc/',
    allowedHosts: ['yz.chsi.com.cn'],
    context: 'national-policy'
  };
  const html = `
    <ul>
      <li><div class="title"><a href="/kyzx/jybzc/202609/notice.html">教育部关于印发《2027年全国硕士研究生招生工作管理规定》的通知</a></div><div class="time">2026-09-24</div></li>
      <li><div class="title"><a href="/kyzx/jybzc/201903/training.html">教育部办公厅关于进一步规范和加强研究生培养管理的通知</a></div><div class="time">2019-03-01</div></li>
      <li><div class="title"><a href="/kyzx/jybzc/202609/doctoral.html">2027年博士研究生招生考试工作通知</a></div><div class="time">2026-09-23</div></li>
      <li><div class="title"><a href="https://evil.example/fake">2027年全国硕士研究生招生考试报名公告</a></div><div class="time">2026-09-25</div></li>
    </ul>`;

  const updates = parseOfficialList(html, policySource, '2026-09-25T04:00:00.000Z');
  assert.deepEqual(updates.map(({ title, date, url, category, isImportant }) => ({ title, date, url, category, isImportant })), [{
    title: '教育部关于印发《2027年全国硕士研究生招生工作管理规定》的通知',
    date: '2026-09-24',
    url: 'https://yz.chsi.com.cn/kyzx/jybzc/202609/notice.html',
    category: '国家政策',
    isImportant: true
  }]);
});

test('recognizes real HNU and CHSI masters admissions titles', () => {
  const { parseOfficialList } = loadScraper();
  const hnuHomeSource = {
    id: 'hnu-home',
    name: '海南大学首页',
    url: 'https://www.hainanu.edu.cn/',
    allowedHosts: ['hainanu.edu.cn']
  };
  const policySource = {
    id: 'chsi-ministry-policy',
    name: '研招网 · 教育部政策',
    url: 'https://yz.chsi.com.cn/kyzx/jybzc/',
    allowedHosts: ['yz.chsi.com.cn'],
    context: 'national-policy'
  };

  const hnuUpdates = parseOfficialList(`
    <ul><li><a href="/info/1019/9001.htm">海南大学海甸校区考点致参加2026年研考考生的一封信</a><span>2025-12-20</span></li></ul>`, hnuHomeSource);
  const policyUpdates = parseOfficialList(`
    <ul>
      <li><a href="/kyzx/jybzc/202509/soldier.html">关于做好2026年退役大学生士兵专项硕士研究生招生计划招生工作的通知</a><span>2025-09-18</span></li>
      <li><a href="/kyzx/jybzc/202509/doctoral.html">博士研究生培养管理工作通知</a><span>2025-09-17</span></li>
    </ul>`, policySource);

  assert.deepEqual(hnuUpdates.map((item) => item.title), ['海南大学海甸校区考点致参加2026年研考考生的一封信']);
  assert.deepEqual(policyUpdates.map((item) => item.title), ['关于做好2026年退役大学生士兵专项硕士研究生招生计划招生工作的通知']);
});

test('keeps the notice id stable across content changes while contentHash changes', () => {
  const { parseOfficialList } = loadScraper();
  const first = parseOfficialList(`
    <ul><li><a href="../info/1024/9020.htm#top">2027年硕士研究生招生专业目录</a><span>2026-09-20</span></li></ul>`, graduateSource)[0];
  const corrected = parseOfficialList(`
    <ul><li><a href="../info/1024/9020.htm">2027年硕士研究生招生专业目录（修订版）</a><span>2026-09-21</span></li></ul>`, graduateSource)[0];

  assert.equal(first.url, 'https://gs.hainanu.edu.cn/info/1024/9020.htm');
  assert.equal(first.id, corrected.id);
  assert.notEqual(first.contentHash, corrected.contentHash);
});

test('uses the Shanghai calendar for short dates and rejects impossible calendar dates', () => {
  const { parseOfficialList } = loadScraper();
  const html = `
    <ul>
      <li><a href="../info/1024/9030.htm">2026年硕士研究生招生考试公告</a><span>[01-01]</span></li>
      <li><a href="../info/1024/9031.htm">2026年硕士研究生招生考试公告</a><span>2026-02-30</span></li>
      <li><a href="../info/1024/9032.htm">2026年硕士研究生招生考试公告</a><span>[02-30]</span></li>
    </ul>`;

  const updates = parseOfficialList(html, graduateSource, '2025-12-31T16:30:00.000Z');

  assert.deepEqual(updates.map(({ date, url }) => ({ date, url })), [{
    date: '2026-01-01',
    url: 'https://gs.hainanu.edu.cn/info/1024/9030.htm'
  }]);
});

test('returns parser diagnostics while parseOfficialList remains an updates-only wrapper', () => {
  const { parseOfficialDocument, parseOfficialList } = loadScraper();
  assert.equal(typeof parseOfficialDocument, 'function', 'parseOfficialDocument must be exported');
  const html = `
    <ul>
      <li><a href="../info/1024/9040.htm">2027年硕士研究生招生专业目录</a><span>2026-09-24</span></li>
      <li><a href="../info/1024/9041.htm">2027年博士研究生招生简章</a><span>2026-09-25</span></li>
    </ul>`;

  const document = parseOfficialDocument(html, graduateSource, '2026-09-26T04:00:00.000Z');

  assert.deepEqual(document.diagnostics, {
    candidateCount: 2,
    relevantCount: 1,
    containerTypes: ['li']
  });
  assert.deepEqual(parseOfficialList(html, graduateSource, '2026-09-26T04:00:00.000Z'), document.updates);
});

test('parses a dated non-list announcement without borrowing a distant date', () => {
  const { parseOfficialDocument } = loadScraper();
  const html = `
    <section>
      <div class="announcement"><a href="../info/1024/9050.htm">2027年硕士研究生招生专业目录</a><time>2026-09-26</time></div>
      <div class="announcement"><a href="../info/1024/9051.htm">2027年硕士研究生招生简章</a></div>
      <div class="site-footer">2026-09-27</div>
    </section>`;

  const document = parseOfficialDocument(html, graduateSource, '2026-09-28T04:00:00.000Z');

  assert.deepEqual(document.updates.map(({ title, date, url }) => ({ title, date, url })), [{
    title: '2027年硕士研究生招生专业目录',
    date: '2026-09-26',
    url: 'https://gs.hainanu.edu.cn/info/1024/9050.htm'
  }]);
  assert.deepEqual(document.diagnostics.containerTypes, ['div']);
});

test('does not let unrelated list markup hide a dated announcement block', () => {
  const { parseOfficialList } = loadScraper();
  const html = `
    <ul><li><a href="../info/1024/9060.htm">本科生招生计划</a><span>2026-09-26</span></li></ul>
    <div class="announcement"><a href="../info/1024/9061.htm">2027年硕士研究生招生简章</a><time>2026-09-27</time></div>`;

  assert.deepEqual(parseOfficialList(html, graduateSource).map((item) => item.url), [
    'https://gs.hainanu.edu.cn/info/1024/9061.htm'
  ]);
});

test('requires graduate context for normal-source notices unless the source is an admissions list', () => {
  const { parseOfficialList } = loadScraper();
  const genericSource = {
    ...graduateSource,
    id: 'hnu-generic-campus-news',
    context: undefined
  };
  const html = `
    <ul>
      <li><a href="../info/1024/9070.htm">海南大学海甸校区考点交通管理通知</a><span>2026-09-28</span></li>
      <li><a href="../info/1024/9071.htm">复试名单公示</a><span>2026-09-29</span></li>
    </ul>`;

  assert.deepEqual(parseOfficialList(html, genericSource), []);
  assert.deepEqual(parseOfficialList(html, graduateSource).map((item) => item.title), ['复试名单公示']);
});

test('rejects national masters training policy even when its title also mentions admissions work', () => {
  const { parseOfficialList } = loadScraper();
  const policySource = {
    id: 'chsi-ministry-policy',
    name: '研招网 · 教育部政策',
    url: 'https://yz.chsi.com.cn/kyzx/jybzc/',
    allowedHosts: ['yz.chsi.com.cn'],
    context: 'national-policy'
  };
  const html = `
    <ul>
      <li><a href="/kyzx/jybzc/202609/training.html">关于做好2026年硕士研究生招生培养工作的通知</a><span>2026-09-28</span></li>
      <li><a href="/kyzx/jybzc/202609/notice.html">关于做好2026年退役大学生士兵专项硕士研究生招生计划招生工作的通知</a><span>2026-09-29</span></li>
    </ul>`;

  assert.deepEqual(parseOfficialList(html, policySource).map((item) => item.title), [
    '关于做好2026年退役大学生士兵专项硕士研究生招生计划招生工作的通知'
  ]);
});

for (const [name, list] of [
  ['closed list item', '<ul><li>LINK</li></ul>'],
  ['optional list item end', '<ul><li>LINK</ul>'],
  ['nested title wrappers', '<ul><li><div class="title"><span>LINK</span></div></li></ul>'],
  ['nested list item', '<ul><li>栏目<ul><li>LINK</li></ul></li></ul>']
]) {
  test(`publication attribution cannot escape a ${name}`, () => {
    const { parseOfficialDocument } = loadScraper();
    const link = '<a href="/info/9801.htm">2027年硕士研究生招生报名公告</a>';
    const html = `<div class="section"><div>${list.replace('LINK', link)}</div><footer>栏目更新：2026-10-02</footer></div>`;
    const result = parseOfficialDocument(html, graduateSource, '2026-10-02T04:00:00Z');
    assert.deepEqual(result.updates, []);
    assert.equal(result.diagnostics.candidateCount, 0);
  });
}

test('publication attribution keeps a parent card with an unlinked nested list and its own date', () => {
  const { parseOfficialList } = loadScraper();
  const html = '<ul><li><a href="/info/9801.htm">2027年硕士研究生招生报名公告</a><ul><li>材料说明</li></ul><time>2026-09-29</time></li></ul>';
  assert.deepEqual(parseOfficialList(html, graduateSource, '2026-10-02T04:00:00Z').map(update => update.date), ['2026-09-29']);
});

test('forms unique announcement cards from nested markup without pairing multi-link containers', () => {
  const { parseOfficialDocument } = loadScraper();
  const html = `
    <div class="card">
      <div class="title"><a href="../info/1024/9080.htm">2027年硕士研究生招生专业目录</a></div>
      <div class="time">2026-09-30</div>
    </div>
    <li class="notice">
      <div class="title"><a href="../info/1024/9081.htm">2027年硕士研究生招生简章</a></div>
      <div class="time">2026-10-01</div>
    </li>
    <li class="multi-link-notice">
      <a href="../info/1024/9082.htm">2027年硕士研究生招生专业目录</a>
      <a href="../info/1024/9083.htm">2027年硕士研究生招生简章</a>
      <span>2026-10-02</span>
    </li>`;

  const document = parseOfficialDocument(html, graduateSource);

  assert.deepEqual(document.updates.map(({ url, date }) => ({ url, date })), [
    { url: 'https://gs.hainanu.edu.cn/info/1024/9080.htm', date: '2026-09-30' },
    { url: 'https://gs.hainanu.edu.cn/info/1024/9081.htm', date: '2026-10-01' }
  ]);
  assert.deepEqual(document.diagnostics, {
    candidateCount: 2,
    relevantCount: 2,
    containerTypes: ['div', 'li']
  });
});

test('uses the first valid visible publication date without reading href or title attributes', () => {
  const { parseOfficialDocument } = loadScraper();
  const html = `
    <ul>
      <li><a href="../2026-02-30/9090.htm" title="2026-02-30">2027年硕士研究生招生专业目录</a><span>2026-02-30</span><time>2026-09-30</time></li>
      <li><a href="../2026-10-01/9091.htm" title="2026-10-01">2027年硕士研究生招生简章</a><span class="date" title="2026-10-01"></span></li>
    </ul>`;

  const document = parseOfficialDocument(html, graduateSource);

  assert.deepEqual(document.updates.map(({ url, date }) => ({ url, date })), [{
    url: 'https://gs.hainanu.edu.cn/2026-02-30/9090.htm',
    date: '2026-09-30'
  }]);
  assert.deepEqual(document.diagnostics, {
    candidateCount: 1,
    relevantCount: 1,
    containerTypes: ['li']
  });
});

test('counts announcement candidates separately from safe, relevant unique updates', () => {
  const { parseOfficialDocument } = loadScraper();
  const html = `
    <ul>
      <li><a href="../info/1024/9100.htm">2027年硕士研究生招生专业目录</a><span>2026-10-01</span></li>
      <li><a href="../info/1024/9100.htm#copy">2027年硕士研究生招生专业目录（转载）</a><span>2026-10-02</span></li>
      <li><a href="https://evil.example/9101.htm">2027年硕士研究生招生简章</a><span>2026-10-03</span></li>
      <li><a href="../info/1024/9102.htm">本科生招生计划</a><span>2026-10-04</span></li>
    </ul>
    <div class="site-footer">2026-10-05</div>`;

  const document = parseOfficialDocument(html, graduateSource);

  assert.deepEqual(document.updates.map((item) => item.url), ['https://gs.hainanu.edu.cn/info/1024/9100.htm']);
  assert.deepEqual(document.diagnostics, {
    candidateCount: 4,
    relevantCount: 1,
    containerTypes: ['li']
  });
});

test('ignores non-visible script dates when selecting a publication date', () => {
  const { parseOfficialList } = loadScraper();
  const html = `
    <ul><li>
      <a href="../info/1024/9110.htm">2027年硕士研究生招生专业目录</a>
      <script>const cachedDate = '2026-01-01';</script>
      <time>2026-10-05</time>
    </li></ul>`;

  assert.deepEqual(parseOfficialList(html, graduateSource).map(({ date, url }) => ({ date, url })), [{
    date: '2026-10-05',
    url: 'https://gs.hainanu.edu.cn/info/1024/9110.htm'
  }]);
});

test('ignores complete announcement markup embedded in hidden regions', () => {
  const { parseOfficialDocument } = loadScraper();
  const fakeNotice = '<li><a href="../info/1024/9120.htm">2027年硕士研究生招生专业目录</a><span>2026-10-06</span></li>';
  const fakeCard = '<div class="card"><a href="../info/1024/9121.htm">2027年硕士研究生招生简章</a><time>2026-10-07</time></div>';
  const html = `
    <script>const fakeNotice = '${fakeNotice}';</script>
    <!-- ${fakeNotice} -->
    <style>.placeholder::after { content: '${fakeCard}'; }</style>
    <template>${fakeCard}</template>
    <li><a href="../info/1024/9122.htm">2027年硕士研究生招生专业目录</a><span>2026-10-08</span></li>`;

  const document = parseOfficialDocument(html, graduateSource);

  assert.deepEqual(document.updates.map(({ url, date }) => ({ url, date })), [{
    url: 'https://gs.hainanu.edu.cn/info/1024/9122.htm',
    date: '2026-10-08'
  }]);
  assert.deepEqual(document.diagnostics, {
    candidateCount: 1,
    relevantCount: 1,
    containerTypes: ['li']
  });
});

test('does not let an unclosed pseudo div inside script break a following real card', () => {
  const { parseOfficialDocument } = loadScraper();
  const html = `
    <div class="card">
      <script>const fake = '<div class="ghost"><a href="../info/1024/9130.htm">2027年硕士研究生招生简章</a><time>2026-10-09</time>';</script>
      <a href="../info/1024/9131.htm">2027年硕士研究生招生专业目录</a><time>2026-10-10</time>
    </div>`;

  const document = parseOfficialDocument(html, graduateSource);

  assert.deepEqual(document.updates.map(({ url, date }) => ({ url, date })), [{
    url: 'https://gs.hainanu.edu.cn/info/1024/9131.htm',
    date: '2026-10-10'
  }]);
  assert.deepEqual(document.diagnostics, {
    candidateCount: 1,
    relevantCount: 1,
    containerTypes: ['div']
  });
});

for (const [name, hidden] of [
  ['spaced comparison', '<script>const a=1,b=2;if(a < b) console.log(a);</script>'],
  ['compact comparison and mixed-case close', '<script>const a=1,b=2;if(a<b) console.log(a);</ScRiPt >'],
  ['style comment', '<style>/* a < b */</style>'],
  ['comparison inside template', '<template><script>const a=1,b=2;if(a<b) console.log(a);</script></template>']
]) {
  test(`preserves notices following raw text with ${name}`, () => {
    const { parseOfficialDocument } = loadScraper();
    const card = '<li><a href="/info/1024/9200.htm">2027年硕士研究生招生简章</a><time>2026-09-28</time></li>';
    const result = parseOfficialDocument(hidden + card, graduateSource, '2026-09-30T04:00:00Z');
    assert.deepEqual(result.updates.map(({ url, date }) => ({ url, date })), [
      { url: 'https://gs.hainanu.edu.cn/info/1024/9200.htm', date: '2026-09-28' }
    ]);
    assert.deepEqual(result.diagnostics, { candidateCount: 1, relevantCount: 1, containerTypes: ['li'] });
  });
}

test('raw text ends only at the matching tag name rather than a closing-name prefix', () => {
  const { parseOfficialDocument } = loadScraper();
  const fake = '<li><a href="/info/1024/9201.htm">2027年硕士研究生招生简章</a><time>2026-09-29</time></li>';
  const real = '<li><a href="/info/1024/9202.htm">2027年硕士研究生招生目录</a><time>2026-09-28</time></li>';
  for (const tag of ['script', 'style']) {
    const html = `<${tag}>/* </${tag}ure> ${fake} */</${tag}>${real}`;
    const result = parseOfficialDocument(html, graduateSource, '2026-09-30T04:00:00Z');
    assert.deepEqual(result.updates.map(item => item.url), ['https://gs.hainanu.edu.cn/info/1024/9202.htm'], tag);
    assert.equal(result.diagnostics.candidateCount, 1, tag);
  }
});

test('preserves publication metadata after a script comparison', () => {
  const { parseOfficialPublicationDate } = loadScraper();
  assert.equal(parseOfficialPublicationDate(
    '<script>const a=1,b=2;if(a<b) console.log(a);</script><meta name="PubDate" content="2026-09-28">'
  ), '2026-09-28');
});

test('masks nested templates through their matching outer closing tag', () => {
  const { parseOfficialDocument } = loadScraper();
  const html = `
    <TEMPLATE data-label="outer > preview"><TeMpLaTe data-depth="inner"></TeMpLaTe><div class="card"><a href="../info/1024/9140.htm">2027年硕士研究生招生专业目录</a><time>2026-10-11</time></div></TEMPLATE>`;

  const document = parseOfficialDocument(html, graduateSource);

  assert.deepEqual(document.updates, []);
  assert.deepEqual(document.diagnostics, {
    candidateCount: 0,
    relevantCount: 0,
    containerTypes: []
  });
});

test('masks unclosed hidden regions through EOF without producing diagnostics candidates', () => {
  const { parseOfficialDocument } = loadScraper();
  const fakeNotice = '<li><a href="../info/1024/9141.htm">2027年硕士研究生招生专业目录</a><span>2026-10-12</span></li>';
  const cases = [
    { name: 'comment', html: `<!-- ${fakeNotice}` },
    { name: 'script', html: `<script>const fake = '${fakeNotice}';` },
    { name: 'style', html: `<style>.placeholder::after { content: '${fakeNotice}'; }` },
    { name: 'template', html: `<template>${fakeNotice}` }
  ];

  for (const fixture of cases) {
    const document = parseOfficialDocument(fixture.html, graduateSource);
    assert.deepEqual(document.updates, [], fixture.name);
    assert.deepEqual(document.diagnostics, {
      candidateCount: 0,
      relevantCount: 0,
      containerTypes: []
    }, fixture.name);
  }
});

test('production HNU source contexts recall short admissions notices without admitting campus or other-level noise', () => {
  const { parseOfficialList } = loadScraper();
  delete require.cache[require.resolve('../server.cjs')];
  const { OFFICIAL_SOURCES } = require('../server.cjs');
  const byContext = new Map(OFFICIAL_SOURCES.map((source) => [source.context, source]));

  const fixtures = [
    {
      context: 'hnu-master',
      accepted: ['复试名单公示'],
      html: `
        <li><a href="../info/1024/9201.htm">复试名单公示</a><span>2027-03-20</span></li>
        <li><a href="../info/1024/9202.htm">校园交通安排</a><span>2027-03-21</span></li>`
    },
    {
      context: 'hnu-home',
      accepted: ['网上确认公告'],
      html: `
        <li><a href="info/1019/9203.htm">网上确认公告</a><span>[10-28]</span></li>
        <li><a href="info/1019/9204.htm">研究生培养管理通知</a><span>[10-29]</span></li>`
    },
    {
      context: 'hnu-computer',
      accepted: ['调剂公告', '拟录取公示'],
      html: `
        <li><a href="../info/1086/9205.htm">调剂公告</a><span>2027-04-01</span></li>
        <li><a href="../info/1086/9206.htm">拟录取公示</a><span>2027-04-02</span></li>
        <li><a href="../info/1086/9207.htm">本科招生公告</a><span>2027-04-03</span></li>
        <li><a href="../info/1086/9208.htm">博士研究生招生公告</a><span>2027-04-04</span></li>`
    }
  ];

  for (const fixture of fixtures) {
    const source = byContext.get(fixture.context);
    assert.ok(source, `production source ${fixture.context} must exist`);
    assert.deepEqual(
      parseOfficialList(fixture.html, source, '2026-11-01T04:00:00.000Z').map((update) => update.title),
      fixture.accepted
    );
  }
});

test('numeric HTML entities outside the Unicode code-point range stay literal instead of throwing', () => {
  const { cleanText } = loadScraper();

  assert.equal(cleanText('合法 &#x10FFFF;'), `合法 ${String.fromCodePoint(0x10FFFF)}`);
  assert.doesNotThrow(() => cleanText('越界 &#x110000;'));
  assert.equal(cleanText('越界 &#x110000;'), '越界 &#x110000;');
  assert.equal(cleanText('越界 &#999999999;'), '越界 &#999999999;');
});
