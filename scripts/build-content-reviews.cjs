const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const reviews = {
  ...require('../src/content-reviews.json'),
  scores: { label: '2026 届分数数据', date: require('../src/admissions-2026.json').verifiedAt }
};
const pageReviews = {
  index: ['national', 'directory', 'baseline'],
  programs: ['directory', 'baseline'],
  scores: ['scores'],
  preparation: ['baseline'],
  timeline: ['national', 'baseline'],
  application: ['national', 'baseline'],
  materials: ['national', 'baseline'],
  updates: ['national'],
  sources: ['national', 'baseline']
};

function renderReviewDates(html, page, metadata = reviews) {
  function time(key) {
    const review = metadata[key];
    if (!review || !/^20\d{2}-\d{2}-\d{2}$/.test(review.date)) throw new Error(`Invalid review date: ${key}`);
    return `<time data-review-date="${key}" datetime="${review.date}">${review.date}</time>`;
  }
  if (!pageReviews[page]) throw new Error(`Unknown page: ${page}`);
  const footer = '个人备考导航，不是海南大学或研招网官方页面。信息核对：' +
    pageReviews[page].map(key => `${metadata[key].label} ${time(key)}`).join('；') +
    '。核对范围分别标注，动态通知由本地服务另行同步。';
  return html.replace(/<time data-review-date="([a-z]+)"[^>]*>[^<]*<\/time>/g, (_, key) => time(key))
    .replace(/(<footer\b[\s\S]*?<p)[^>]*>[\s\S]*?<\/p>/, `$1 data-review-footer>${footer}</p>`);
}

function build() {
  for (const page of Object.keys(pageReviews)) {
    const filename = path.join(root, `${page}.html`);
    const html = fs.readFileSync(filename, 'utf8');
    fs.writeFileSync(filename, renderReviewDates(html, page), 'utf8');
  }
}
module.exports = { renderReviewDates, reviews, pageReviews, build };
if (require.main === module) build();
