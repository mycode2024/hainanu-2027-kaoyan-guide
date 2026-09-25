const BANDS = [
  [0, 279, '280 以下'], [280, 299, '280–299'], [300, 319, '300–319'],
  [320, 339, '320–339'], [340, 359, '340–359'], [360, 500, '360 及以上']
];

function describe(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0], max: sorted.at(-1),
    mean: Number((sorted.reduce((sum, value) => sum + value, 0) / sorted.length).toFixed(2)),
    median: (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2
  };
}

function summarizeAdmissions(records) {
  const identities = new Set();
  const grouped = new Map();
  for (const row of records) {
    if (identities.has(row.sourceRow)) throw new Error('Duplicate source row');
    identities.add(row.sourceRow);
    for (const [key, max] of [['initial', 500], ['retest', 100], ['composite', 100]]) {
      if (!Number.isFinite(row[key]) || row[key] < 0 || row[key] > max) throw new Error(`Invalid ${key} score`);
    }
    const identity = JSON.stringify([row.program, row.mode, row.plan]);
    if (!grouped.has(identity)) grouped.set(identity, []);
    grouped.get(identity).push(row);
  }
  return {
    total: records.length,
    ordinaryFullTime: records.filter((row) => row.mode === '全日制' && row.plan === '普通计划').length,
    groups: [...grouped.values()].map((rows) => ({
      program: rows[0].program, mode: rows[0].mode, plan: rows[0].plan,
      initial: describe(rows.map((row) => row.initial)),
      retest: describe(rows.map((row) => row.retest)),
      composite: describe(rows.map((row) => row.composite)),
      bands: BANDS.map(([min, max, label]) => ({ label, count: rows.filter((row) => row.initial >= min && row.initial <= max).length }))
    }))
  };
}

module.exports = { summarizeAdmissions };
