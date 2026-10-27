const crypto = require('node:crypto');

const SHANGHAI_DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
});

const GRADUATE_ACTION_PATTERN = /招生简章|招生章程|专业目录|考试大纲|初试科目|考试科目|网上报名|预报名|报名公告|网上确认|报考点|准考资格|报考材料|准考证|成绩|分数线|排名查询|复试|调剂|拟录取|录取|推免|推荐免试/;

const SHORT_ACTION_PATTERNS = {
  'graduate-admissions-list': GRADUATE_ACTION_PATTERN,
  'hnu-master': GRADUATE_ACTION_PATTERN,
  'hnu-home': /网上报名|预报名|报名公告|网上确认|报考点|考点|准考资格|准考证|研考|推荐免试/,
  'hnu-computer': /招生简章|招生章程|专业目录|考试大纲|初试科目|考试科目|成绩|分数线|排名查询|复试|调剂|拟录取|录取|推免|推荐免试/
};

function isAllowedOfficialUrl(value, source) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    const configuredHosts = Array.isArray(source?.allowedHosts) && source.allowedHosts.length
      ? source.allowedHosts
      : [new URL(source?.url).hostname];
    return configuredHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function categorizeTitle(title, source) {
  if (source?.context === 'national-policy') return '国家政策';
  if (/初试科目|考试科目|科目调整/.test(title)) return '初试科目';
  if (/招生简章|招生章程|专业目录|考试大纲/.test(title)) return '简章目录';
  if (/网上报名|预报名|报名公告|网上确认|报考点/.test(title)) return '报名确认';
  if (/准考资格|报考材料|准考证/.test(title)) return '资格准考';
  const recommendedAdmissionText = title
    .replace(/(?:不含|不包括|不包含|非|除)\s*(?:推免|推荐免试)/g, '')
    .replace(/(?:推免|推荐免试)(?:研究生|生)?\s*除外/g, '');
  if (/推免|推荐免试/.test(recommendedAdmissionText)) return '推免';
  if (/成绩|分数线|排名查询/.test(title)) return '成绩分数线';
  if (/复试|调剂|拟录取|录取/.test(title)) return '复试录取';
  return '招生动态';
}

function isRelevantAdmissionCycle(title, date, checkedAt, calendar = getShanghaiYearAndMonth(checkedAt)) {
  if (/2027\s*(?:年|级)/.test(title)) return true;
  const titleYear = title.match(/(?:20\d{2})年?/);
  const pubYear = date ? Number(date.slice(0, 4)) : null;
  const checkedDate = new Date(checkedAt);
  const currentYear = calendar?.year;
  const currentMonth = calendar?.month;
  if (!Number.isFinite(currentYear)) return true;
  // The target admission year: current year + 1 (e.g., in 2026 we target 2027 cycle)
  const targetYear = currentYear + 1;
  // If title explicitly mentions a year, only keep target year and one year prior
  if (titleYear) {
    const mentioned = Number(titleYear[0].replace('年', ''));
    if (Number.isFinite(mentioned) && mentioned < targetYear - 1) return false;
  }
  // Filter by publication date: discard items published > 18 months ago
  if (Number.isFinite(pubYear) && date) {
    const pubMs = Date.parse(`${date}T00:00:00Z`);
    const checkedMs = checkedDate.getTime();
    if (Number.isFinite(pubMs) && Number.isFinite(checkedMs) && checkedMs - pubMs > 548 * 86_400_000) {
      return false;
    }
  }
  // In the latter half of the year (Jul+), old-cycle operational notices are stale
  if (currentMonth >= 7 && Number.isFinite(pubYear)) {
    const isOldCycleOperational = /复试|调剂|拟录取|录取通知书|调档/.test(title)
      && !/\b20\d{2}\b/.test(title.replace(String(targetYear), '').replace(String(targetYear - 1), ''));
    if (isOldCycleOperational && pubYear < currentYear) return false;
  }
  return true;
}

function isRelevantTitle(title, source) {
  if (source?.context === 'national-policy') {
    if (/培养(?:工作|管理)?/.test(title)) return false;
    if (/博士/.test(title) && !/硕士/.test(title)) return false;
    return /全国硕士研究生招生|硕士研究生.*招生.*工作|研究生招生考试|研考/.test(title);
  }
  if (/培养(?:工作|管理)?/.test(title)) return false;
  const explicitlyOtherLevel = /博士|本科|学士|高考/.test(title) && !/硕士/.test(title);
  if (explicitlyOtherLevel) return false;
  const graduateContext = /硕士|考研|研考|研究生招生|全国硕士研究生招生考试/.test(title);
  const actionable = /招生|简章|章程|专业目录|考试|科目|大纲|报名|确认|报考|考点|准考|成绩|分数线|复试|调剂|录取|推免|推荐免试|材料/.test(title);
  const contextAction = SHORT_ACTION_PATTERNS[source?.context];
  if (!actionable) return false;
  return graduateContext || Boolean(contextAction?.test(title));
}

function makeHash(value) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 16);
}

function makeId(source, url) {
  const sourceIdentity = source?.id || source?.name || source?.url || '';
  return makeHash(`${sourceIdentity}\n${url}`);
}

function makeContentHash(title, category, date) {
  return makeHash(`${title}\n${category}\n${date}`);
}

function isValidCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function getShanghaiYearAndMonth(checkedAt) {
  const checkedDate = new Date(checkedAt);
  if (!Number.isFinite(checkedDate.getTime())) return null;
  const values = SHANGHAI_DATE_FORMAT.formatToParts(checkedDate);
  const year = Number(values.find((part) => part.type === 'year')?.value);
  const month = Number(values.find((part) => part.type === 'month')?.value);
  const day = Number(values.find((part) => part.type === 'day')?.value);
  return Number.isFinite(year) && Number.isFinite(month) ? { year, month, day } : null;
}

module.exports = {
  SHANGHAI_DATE_FORMAT,
  GRADUATE_ACTION_PATTERN,
  SHORT_ACTION_PATTERNS,
  isAllowedOfficialUrl,
  categorizeTitle,
  isRelevantAdmissionCycle,
  isRelevantTitle,
  makeHash,
  makeId,
  makeContentHash,
  isValidCalendarDate,
  getShanghaiYearAndMonth
};
