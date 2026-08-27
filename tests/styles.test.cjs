const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('print media keeps detail-page hero copy readable on a white background', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '..', 'styles.css'), 'utf8');
  const printMedia = css.slice(css.lastIndexOf('@media print'));

  assert.match(
    printMedia,
    /\.page-hero \.eyebrow\s*,\s*\.page-hero > div > p:last-child\s*\{\s*color:\s*#444\s*;\s*\}/,
    'detail-page eyebrow and description must receive an explicit dark print color'
  );
});
