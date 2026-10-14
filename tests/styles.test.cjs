const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('card animations exist and are disabled for reduced motion and print', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '..', 'styles.css'), 'utf8');

  assert.match(css, /\.guide-dialog\[open\]\s*\{[^}]*animation:\s*dialog-in\b/, 'the card must use the designed entrance animation');
  assert.match(css, /\.guide-dialog\.guide-closing\s*\{[^}]*animation:\s*dialog-out\b/, 'the closing state must run the exit animation');
  assert.match(css, /@keyframes\s+dialog-in\s*\{/, 'the entrance keyframes must exist');
  assert.match(css, /@keyframes\s+dialog-out\s*\{/, 'the exit keyframes must exist');

  const reducedStart = css.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(reducedStart > -1, 'a reduced-motion media block must exist');
  const reduced = css.slice(reducedStart, css.indexOf('\n}', reducedStart) + 2);
  assert.match(reduced, /\.guide-dialog\[open\][^{}]*\{[^}]*animation:\s*none\s*!important/, 'reduced motion must disable the card animation');

  const printMedia = css.slice(css.lastIndexOf('@media print'));
  assert.match(printMedia, /\.guide-dialog\[open\][^{}]*\{[^}]*animation:\s*none\s*!important/, 'print must disable the card animation');
});

test('print media keeps detail-page hero copy readable on a white background', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '..', 'styles.css'), 'utf8');
  const printMedia = css.slice(css.lastIndexOf('@media print'));

  assert.match(
    printMedia,
    /\.page-hero \.eyebrow\s*,\s*\.page-hero > div > p:last-child\s*\{\s*color:\s*#444\s*;\s*\}/,
    'detail-page eyebrow and description must receive an explicit dark print color'
  );
});
