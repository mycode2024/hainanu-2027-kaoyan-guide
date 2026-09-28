const { performance } = require('node:perf_hooks');
const { parseOfficialDocument } = require('../src/official-scraper.cjs');
// Fixed offline fixture: compare parser CPU cost without network variability.
const source = { id: 'bench', name: '研究生院', url: 'https://gs.hainanu.edu.cn/', context: 'hnu-master' };
const html = '<div>'.repeat(8) + Array.from({ length: 300 }, (_, i) => `<li><div><a href="info/${i}.htm">2027年硕士研究生招生公告 ${i}</a><span>2026-09-20</span><script>const fake = '2020-01-01';</script></div></li>`).join('') + '</div>'.repeat(8);
for (let i = 0; i < 3; i++) parseOfficialDocument(html, source, '2026-09-27T04:00:00Z');
const times = [];
for (let i = 0; i < 15; i++) {
  const start = performance.now();
  const result = parseOfficialDocument(html, source, '2026-09-27T04:00:00Z');
  times.push(performance.now() - start);
  if (result.updates.length !== 300) throw new Error('Unexpected notice count');
}
times.sort((a, b) => a - b);
console.log(JSON.stringify({ fixture: '300 nested notices; 8 outer containers', medianMs: times[7], minMs: times[0], maxMs: times[14] }, null, 2));
