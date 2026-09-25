const fs = require('node:fs');
const path = require('node:path');
const data = require('../src/admissions-2026.json');
if (data.year !== 2026 || data.examYear !== 2025) throw new Error('Expected December 2025 exam / 2026 intake data');
const { summarizeAdmissions } = require('../src/admissions-statistics.cjs');
const summary = summarizeAdmissions(data.records);
const names = { '081200': '计算机科学与技术', '085404': '计算机技术', '085405': '软件工程' };
const ordinary = summary.groups.filter((g) => g.mode === '全日制' && g.plan === '普通计划');
const other = summary.groups.filter((g) => !ordinary.includes(g));
const specialCount = data.records.filter((r) => r.plan !== '普通计划').length;
const partTimeCount = data.records.filter((r) => r.mode === '非全日制').length;
const otherCount = other.reduce((sum, g) => sum + g.initial.count, 0);
const sourcePages = data.records.map((r) => r.sourcePage);
const sourceRows = data.records.map((r) => r.sourceRow);
const fmt = (number) => Number.isInteger(number) ? String(number) : number.toFixed(2).replace(/0$/, '');
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function scoreRow(g) {
  return `<tr><th scope="row">${names[g.program]}<small>${g.program} · ${g.mode} · ${g.plan}</small></th><td>${g.initial.count}</td><td>${g.initial.min}</td><td>${g.initial.max}</td><td>${fmt(g.initial.mean)}</td><td>${fmt(g.initial.median)}</td></tr>`;
}

const section = `<!-- admissions-2026:start -->
      <section class="content-section score-section" id="scores" aria-labelledby="scores-title">
        <div class="section-heading"><div><p class="section-index">${data.year} 届 / 最近一届分数统计</p><h2 id="scores-title">${data.examYear} 年 12 月初试，<br>${data.year} 年录取成绩</h2></div><p><strong>本板块统计 ${data.examYear} 年 12 月初试、${data.year} 年录取的考生。</strong>按海南大学 ${data.announcementDate} 公布的官方拟录取名单逐行统计学院代码 812；初试满分 500，复试与综合成绩满分 100。核对日期：<time datetime="${data.verifiedAt}">${data.verifiedAt}</time>。</p></div>
        <div class="score-overview" aria-label="${data.year}年拟录取统计范围"><div><span>公示样本 · 不含推免</span><strong>${summary.total}<small> 人</small></strong></div><div><span>全日制普通计划</span><strong>${summary.ordinaryFullTime}<small> 人</small></strong></div><div><span>专项计划 · 单列</span><strong>${specialCount}<small> 人</small></strong></div><div><span>非全日制 · 此名单内</span><strong>${partTimeCount}<small> 人</small></strong></div></div>
        <p class="baseline-note"><strong>先区分三个概念：</strong>复试线是进入复试的要求；下表“最低分”是公示拟录取考生中的初试最低分；最终排序还要结合复试成绩。这里的最低分不等于复试线，也不是 2027 年录取保证线。</p>
        <div class="score-table-wrap" role="region" aria-label="全日制普通计划初试成绩统计" tabindex="0"><table class="score-table"><caption>全日制普通计划 · 拟录取初试成绩（500 分制）</caption><thead><tr><th scope="col">专业 / 统计口径</th><th scope="col">人数</th><th scope="col">最低分</th><th scope="col">最高分</th><th scope="col">平均分</th><th scope="col">中位数</th></tr></thead><tbody>${ordinary.map(scoreRow).join('')}</tbody></table></div>
        <div class="score-distributions" aria-label="普通计划拟录取初试分数段分布">${ordinary.map((g) => `<article class="score-distribution"><p class="eyebrow">${g.program} / ${g.initial.count} 人</p><h3>${names[g.program]}</h3><p>全日制普通计划 · 初试分数段</p><ul>${g.bands.map((band) => `<li><span>${band.label}</span><meter min="0" max="100" value="${(band.count / g.initial.count * 100).toFixed(2)}" aria-label="${escape(names[g.program])}，${band.label}分：${band.count}人，占${(band.count / g.initial.count * 100).toFixed(1)}%"></meter><strong>${band.count} 人 <small>${(band.count / g.initial.count * 100).toFixed(1)}%</small></strong></li>`).join('')}</ul></article>`).join('')}</div>
        <details class="score-details"><summary>查看专项与非全日制分组：共 ${otherCount} 人，单独统计</summary><div class="score-table-wrap" role="region" aria-label="专项和非全日制初试统计" tabindex="0"><table class="score-table"><caption>专项及非全日制分组 · 拟录取初试成绩（500 分制）</caption><thead><tr><th scope="col">专业 / 统计口径</th><th scope="col">人数</th><th scope="col">最低分</th><th scope="col">最高分</th><th scope="col">平均分</th><th scope="col">中位数</th></tr></thead><tbody>${other.map(scoreRow).join('')}</tbody></table></div><p>专项名称沿用官方名单备注。此名单中计科院没有非全日制记录。小样本只用于说明本次公示情况，不并入普通计划分数比较。</p></details>
        <details class="score-details"><summary>查看各组复试、综合成绩（100 分制）</summary><div class="score-table-wrap" role="region" aria-label="复试与综合成绩统计" tabindex="0"><table class="score-table"><caption>拟录取样本 · 复试与综合成绩</caption><thead><tr><th scope="col">专业 / 统计口径</th><th scope="col">人数</th><th scope="col">复试范围</th><th scope="col">复试均分</th><th scope="col">综合范围</th><th scope="col">综合均分</th></tr></thead><tbody>${summary.groups.map((g) => `<tr><th scope="row">${names[g.program]}<small>${g.mode} · ${g.plan}</small></th><td>${g.initial.count}</td><td>${fmt(g.retest.min)}–${fmt(g.retest.max)}</td><td>${fmt(g.retest.mean)}</td><td>${fmt(g.composite.min)}–${fmt(g.composite.max)}</td><td>${fmt(g.composite.mean)}</td></tr>`).join('')}</tbody></table></div><p>按公示原值统计。学院 ${data.year} 年细则规定：综合成绩＝初试总分 ÷ 5 × 60% ＋复试成绩 × 40%；复试由上机和面试各占 50%。</p></details>
        <div class="score-method"><h3>这些数字怎样使用</h3><ul><li>最低分反映个别样本，中位数反映该组中间位置。学硕与专硕科目组合不同，分数不能直接等同为报考难度。</li><li>样本来自拟录取公示，不代表最终报到人数；名单没有单独标注一志愿与调剂，因此不推算报录比或各分数段录取率。</li><li>学院初期计划与后续公示人数口径不同。分数统计以公示记录为准，未把推免人数加入初试样本。</li><li><strong>复试线 / 入围最低分：暂未核实。</strong>学院复试名单附件下载需要验证码，暂不从拟录取名单反推复试线。</li></ul><p>统计保留两位小数；分数段两端均包含，百分比因四舍五入可能不恰好合计为 100%。</p></div>
        <div class="score-sources"><h3>官方来源与核对范围</h3><a href="${data.sourceUrl}" target="_blank" rel="noopener noreferrer">01 · ${data.sourceTitle}（PDF） ↗</a><p>使用第 ${Math.min(...sourcePages)}–${Math.max(...sourcePages)} 页，学院代码 812，总序号 ${Math.min(...sourceRows)}–${Math.max(...sourceRows)}，共 ${summary.total} 条；页面仅展示汇总分数。</p><a href="${data.announcementUrl}" target="_blank" rel="noopener noreferrer">02 · ${data.year} 年拟录取名单公示（${data.announcementDate}） ↗</a><p>上述 PDF 来自此官方公示页面。正式录取名单以教育部审核为准。</p><a href="${data.rulesUrl}" target="_blank" rel="noopener noreferrer">03 · 计算机学院 ${data.year} 年硕士研究生复试录取实施细则（${data.rulesDate}） ↗</a><p>用于核对专业、初期计划、复试方式和计分口径；页面末尾附复试名单下载入口。</p></div>
      </section>
      <!-- admissions-2026:end -->`;

const pagePath = path.join(__dirname, '..', 'scores.html');
let html = fs.readFileSync(pagePath, 'utf8');
const marker = /<!-- admissions-20\d{2}:start -->[\s\S]*?<!-- admissions-20\d{2}:end -->/;
if (!marker.test(html)) throw new Error('Statistics section marker missing from scores.html');
html = html.replace(marker, section);
if (!html.includes('id="scores"')) throw new Error('Statistics section insertion failed');
fs.writeFileSync(pagePath, html);
console.log(`Built ${data.year} intake / December ${data.examYear} exam score section: ${summary.total} records, ${summary.groups.length} groups`);
