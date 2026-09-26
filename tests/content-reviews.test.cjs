const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('review metadata updates body and footer together without changing historical baseline dates', () => {
  const { renderReviewDates, reviews } = require('../scripts/build-content-reviews.cjs');
  const html = fs.readFileSync(path.join(__dirname, '..', 'application.html'), 'utf8');
  const result = renderReviewDates(html, 'application', { ...reviews, national: { ...reviews.national, date: '2026-10-02' } });
  const body = result.split('<footer')[0];
  const footer = result.split('<footer')[1];
  assert.match(body, /datetime="2026-10-02">2026-10-02<\/time>/);
  assert.match(footer, /datetime="2026-10-02">2026-10-02<\/time>/);
  assert.match(footer, /2026-09-21/);
  assert.doesNotMatch(body, /2026-10-02[\s\S]*2026-10-02[\s\S]*2026-10-02/);
});

test('checked-in pages match centralized review metadata and do not depend on the visit date', () => {
  const { renderReviewDates, pageReviews } = require('../scripts/build-content-reviews.cjs');
  for (const page of Object.keys(pageReviews)) {
    const html = fs.readFileSync(path.join(__dirname, '..', `${page}.html`), 'utf8');
    assert.equal(renderReviewDates(html, page), html, `${page} needs build:reviews`);
  }
});

test('score review date changes in the body and footer from the same dataset metadata', () => {
  const { renderReviewDates, reviews } = require('../scripts/build-content-reviews.cjs');
  const html = fs.readFileSync(path.join(__dirname, '..', 'scores.html'), 'utf8');
  const result = renderReviewDates(html, 'scores', { ...reviews, scores: { ...reviews.scores, date: '2026-09-26' } });
  assert.match(result.split('<footer')[0], /data-review-date="scores" datetime="2026-09-26">2026-09-26<\/time>/);
  assert.match(result.split('<footer')[1], /data-review-date="scores" datetime="2026-09-26">2026-09-26<\/time>/);
});
