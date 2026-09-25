const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeAdmissions } = require('../src/admissions-statistics.cjs');
const data = require('../src/admissions-2025.json');
const latestData = require('../src/admissions-2026.json');

test('latest intake is the December 2025 exam and keeps 2026 ordinary and special plans separate', () => {
  assert.equal(latestData.year, 2026);
  assert.equal(latestData.examYear, 2025);
  assert.deepEqual(latestData.records.map((r) => r.sourceRow), Array.from({ length: 94 }, (_, i) => 1458 + i));
  const result = summarizeAdmissions(latestData.records);
  assert.equal(result.total, 94);
  assert.equal(result.ordinaryFullTime, 91);
  assert.deepEqual(result.groups.map((g) => [g.program, g.plan, g.initial.count, g.initial.min, g.initial.max, g.initial.mean, g.initial.median]), [
    ['081200', '普通计划', 19, 291, 340, 315.68, 317],
    ['085404', '普通计划', 27, 330, 407, 365.33, 363],
    ['085404', '骨干计划', 1, 309, 309, 309, 309],
    ['085405', '普通计划', 45, 342, 409, 365.22, 366],
    ['085405', '士兵专项', 2, 251, 298, 274.5, 274.5]
  ]);
  for (const group of result.groups) assert.equal(group.bands.reduce((sum, band) => sum + band.count, 0), group.initial.count);
});

test('published score section clearly pairs the December 2025 exam with the 2026 intake', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'scores.html'), 'utf8');
  const section = page.match(/<section[^>]*id="scores"[\s\S]*?<\/section>/)?.[0] || '';
  assert.match(section, /2025 年 12 月初试/);
  assert.match(section, /2026 年录取/);
  assert.doesNotMatch(section, /2024 年 12 月|2025 年录取|共 82 条|共 8 人/);
  assert.match(section, /315\.68/);
  assert.match(section, /365\.33/);
  assert.match(section, /365\.22/);
  assert.match(section, /CB936332381D12B6ACB9BBAB8EF_4E26C726_110B69\.pdf/);
});

test('separates special plans and part-time candidates from full-time ordinary scores', () => {
  const summary = summarizeAdmissions(data.records);
  assert.deepEqual(summary.groups.map((g) => [g.program, g.mode, g.plan, g.initial.count, g.initial.min, g.initial.max]), [
    ['081200', '全日制', '普通计划', 27, 266, 367],
    ['081200', '全日制', '骨干计划', 1, 211, 211],
    ['085404', '全日制', '普通计划', 10, 271, 326],
    ['085405', '全日制', '普通计划', 37, 311, 383],
    ['085405', '全日制', '士兵专项', 3, 286, 296],
    ['085405', '非全日制', '普通计划', 4, 254, 288]
  ]);
  assert.equal(summary.total, 82);
  assert.equal(summary.ordinaryFullTime, 74);
});

test('computes means, even and odd medians, and inclusive score-band boundaries', () => {
  const rows = [279, 280, 299, 300, 319, 320, 339, 340, 359, 360].map((initial, i) => ({ sourceRow: i, program: '081200', mode: '全日制', plan: '普通计划', initial, retest: 80, composite: 70 }));
  const group = summarizeAdmissions(rows).groups[0];
  assert.equal(group.initial.mean, 319.5);
  assert.equal(group.initial.median, 319.5);
  assert.deepEqual(group.bands.map((b) => b.count), [1, 2, 2, 2, 2, 1]);
  assert.equal(summarizeAdmissions(rows.slice(0, 3)).groups[0].initial.median, 280);
});

test('every extracted row has a unique source reference and score bands reconcile', () => {
  assert.deepEqual(data.records.map((r) => r.sourceRow), Array.from({ length: 82 }, (_, i) => 1411 + i));
  const result = summarizeAdmissions(data.records);
  for (const group of result.groups) {
    assert.equal(group.bands.reduce((sum, band) => sum + band.count, 0), group.initial.count);
  }
  assert.equal(result.groups[0].initial.mean, 312.74);
  assert.equal(result.groups[0].initial.median, 318);
});

test('rejects duplicate rows and invalid scores instead of silently biasing statistics', () => {
  assert.throws(() => summarizeAdmissions([data.records[0], data.records[0]]), /duplicate/i);
  assert.throws(() => summarizeAdmissions([{ ...data.records[0], initial: null }]), /score/i);
  assert.throws(() => summarizeAdmissions([{ ...data.records[0], initial: 501 }]), /score/i);
  assert.deepEqual(summarizeAdmissions([]), { total: 0, ordinaryFullTime: 0, groups: [] });
});
