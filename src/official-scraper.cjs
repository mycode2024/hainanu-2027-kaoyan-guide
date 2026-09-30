const crypto = require('node:crypto');
const SHANGHAI_DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
});

const ENTITY_MAP = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"'
};

function decodeHtmlEntities(value) {
  return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, code) => {
    if (code[0] === '#') {
      const hexadecimal = code[1]?.toLowerCase() === 'x';
      const number = Number.parseInt(code.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isInteger(number) && number >= 0 && number <= 0x10FFFF
        ? String.fromCodePoint(number)
        : entity;
    }
    return ENTITY_MAP[code.toLowerCase()] ?? entity;
  });
}

function cleanText(value) {
  return decodeHtmlEntities(String(value || '').replace(/<[^>]*>/g, ' '))
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isOfficialHainanUniversityUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (
      url.hostname === 'hainanu.edu.cn' || url.hostname.endsWith('.hainanu.edu.cn')
    );
  } catch {
    return false;
  }
}

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
  const shortActionPatterns = {
    'graduate-admissions-list': /招生简章|招生章程|专业目录|考试大纲|初试科目|考试科目|网上报名|预报名|报名公告|网上确认|报考点|准考资格|报考材料|准考证|成绩|分数线|排名查询|复试|调剂|拟录取|录取|推免|推荐免试/,
    'hnu-master': /招生简章|招生章程|专业目录|考试大纲|初试科目|考试科目|网上报名|预报名|报名公告|网上确认|报考点|准考资格|报考材料|准考证|成绩|分数线|排名查询|复试|调剂|拟录取|录取|推免|推荐免试/,
    'hnu-home': /网上报名|预报名|报名公告|网上确认|报考点|考点|准考资格|准考证|研考|推荐免试/,
    'hnu-computer': /招生简章|招生章程|专业目录|考试大纲|初试科目|考试科目|成绩|分数线|排名查询|复试|调剂|拟录取|录取|推免|推荐免试/
  };
  const contextAction = shortActionPatterns[source?.context];
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

function readHtmlTag(source, start) {
  if (source[start] !== '<') return null;
  let index = start + 1;
  let closing = false;
  if (source[index] === '/') {
    closing = true;
    index += 1;
  }
  while (/\s/.test(source[index] || '')) index += 1;
  if (!/[A-Za-z]/.test(source[index] || '')) return null;

  const nameStart = index;
  while (/[A-Za-z0-9:-]/.test(source[index] || '')) index += 1;
  const name = source.slice(nameStart, index).toLowerCase();
  let quote = null;
  let lastSignificantCharacter = null;
  let slashAtBoundary = false;
  let lastWasWhitespace = true;
  for (; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      lastWasWhitespace = false;
      continue;
    }
    if (character === '>') {
      return {
        name,
        closing,
        selfClosing: !closing && lastSignificantCharacter === '/' && slashAtBoundary,
        end: index + 1
      };
    }
    if (/\s/.test(character)) {
      lastWasWhitespace = true;
      continue;
    }
    lastSignificantCharacter = character;
    if (character === '/') slashAtBoundary = lastWasWhitespace;
    lastWasWhitespace = false;
  }
  return null;
}

function findCommentEnd(source, start) {
  const closingIndex = source.indexOf('-->', start + 4);
  return closingIndex === -1 ? source.length : closingIndex + 3;
}

function findRawElementEnd(source, start, name) {
  // Comparisons and markup-like strings in script/style are not opening tags.
  // Look only for a matching end tag, with a boundary after its exact name.
  const closingTag = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, 'gi');
  closingTag.lastIndex = start;
  const match = closingTag.exec(source);
  return match ? readHtmlTag(source, match.index)?.end || source.length : source.length;
}

function findTemplateEnd(source, start) {
  let depth = 1;
  let index = start;
  while (index < source.length) {
    if (source.startsWith('<!--', index)) {
      index = findCommentEnd(source, index);
      continue;
    }
    const tag = readHtmlTag(source, index);
    if (!tag) {
      index += 1;
      continue;
    }
    if (!tag.closing && !tag.selfClosing && (tag.name === 'script' || tag.name === 'style')) {
      index = findRawElementEnd(source, tag.end, tag.name);
      continue;
    }
    if (tag.name === 'template') {
      if (tag.closing) {
        depth -= 1;
        if (depth === 0) return tag.end;
      } else if (!tag.selfClosing) {
        depth += 1;
      }
    }
    index = tag.end;
  }
  return source.length;
}

function maskRange(output, start, end) {
  for (let index = start; index < end; index += 1) {
    if (output[index] !== '\r' && output[index] !== '\n') output[index] = ' ';
  }
}

function maskNonVisibleRegions(content) {
  const source = String(content || '');
  const output = source.split('');
  let index = 0;

  while (index < source.length) {
    if (source.startsWith('<!--', index)) {
      const end = findCommentEnd(source, index);
      maskRange(output, index, end);
      index = end;
      continue;
    }
    const tag = readHtmlTag(source, index);
    if (!tag) {
      index += 1;
      continue;
    }
    if (!tag.closing && !tag.selfClosing && (tag.name === 'script' || tag.name === 'style')) {
      const end = findRawElementEnd(source, tag.end, tag.name);
      maskRange(output, index, end);
      index = end;
      continue;
    }
    if (!tag.closing && !tag.selfClosing && tag.name === 'template') {
      const end = findTemplateEnd(source, tag.end);
      maskRange(output, index, end);
      index = end;
      continue;
    }
    index = tag.end;
  }

  return output.join('');
}

function extractVisibleText(content) {
  return cleanText(maskNonVisibleRegions(content));
}

function findPublicationLabels(content) {
  const labels = [...content.matchAll(/<time\b[^>]*>[\s\S]*?<\/time>/gi)];
  for (const label of content.matchAll(/<span\b([^>]*)>[\s\S]*?<\/span>/gi)) {
    const className = label[1].match(/\bclass\s*=\s*(["'])(.*?)\1/i)?.[2] || '';
    if (/(?:^|[\s_-])(?:date|pubdate|time)(?:$|[\s_-])/i.test(className)) labels.push(label);
  }
  return labels.sort((a, b) => a.index - b.index);
}

function extractPublicationDate(visibleContent, checkedDate) {
  // Link text may contain an exam/deadline date; it is not a publication label.
  // Clickable cards can still contain explicit time/date elements.
  const visibleText = cleanText(visibleContent.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi,
    (link) => findPublicationLabels(link).map((label) => label[0]).join(' ')));
  const dateCandidates = [];

  for (const match of visibleText.matchAll(/\b(20\d{2})-((?:0[1-9]|1[0-2]))-((?:0[1-9]|[12]\d|3[01]))\b/g)) {
    dateCandidates.push({
      index: match.index,
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      value: `${match[1]}-${match[2]}-${match[3]}`,
      inferred: false
    });
  }

  if (checkedDate) {
    for (const match of visibleText.matchAll(/\[\s*((?:0[1-9]|1[0-2]))-((?:0[1-9]|[12]\d|3[01]))\s*\]/g)) {
      const month = Number(match[1]);
      const year = checkedDate.year - (month > checkedDate.month ? 1 : 0);
      dateCandidates.push({
        index: match.index,
        year,
        month,
        day: Number(match[2]),
        value: `${year}-${match[1]}-${match[2]}`,
        inferred: true
      });
    }
  }

  return dateCandidates
    .sort((a, b) => a.index - b.index)
    .find((candidate) => isValidCalendarDate(candidate.year, candidate.month, candidate.day)) ?? null;
}

// Only publication metadata or the publisher's dated byline may establish a year.
// Dates in the article body can describe deadlines for a different admission cycle.
function parseOfficialPublicationDate(html) {
  const visibleHtml = maskNonVisibleRegions(String(html || ''));
  const candidates = [];
  for (const tag of visibleHtml.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = Object.fromEntries([...tag[0].matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map((match) => [match[1].toLowerCase(), match[3]]));
    if (/^(pubdate|publishdate|article:published_time)$/i.test(attributes.name || attributes.property || '')) {
      candidates.push(attributes.content || '');
    }
  }
  const byline = extractVisibleText(visibleHtml).match(/(20\d{2}年\d{1,2}月\d{1,2}日)\s+\d{1,2}:\d{2}\s*来源\s*[:：]/);
  if (byline) candidates.push(byline[1]);
  for (const value of candidates) {
    const match = value.match(/^(20\d{2})[-年](\d{1,2})[-月](\d{1,2})(?:日|T|\b)/);
    if (match && isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
      return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
    }
  }
  return null;
}

function findBalancedElements(scanDocument, type) {
  const tagPattern = new RegExp(`<\\/?${type}\\b[^>]*>`, 'gi');
  const openElements = [];
  const elements = [];
  let tag;

  while ((tag = tagPattern.exec(scanDocument))) {
    if (/^<\//.test(tag[0])) {
      const opening = openElements.pop();
      if (!opening) continue;
      elements.push({
        type,
        start: opening.start,
        end: tagPattern.lastIndex,
        content: scanDocument.slice(opening.start, tagPattern.lastIndex)
      });
    } else if (!/\/\s*>$/.test(tag[0])) {
      openElements.push({ start: tag.index });
    }
  }

  return elements;
}

function extractAnchors(visibleContent) {
  return [...visibleContent.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({ href: match[2], titleHtml: match[3] }));
}

function extractAnnouncementCards(html, calendar) {
  // Preserve offsets while masking once for the entire document.
  const visibleHtml = maskNonVisibleRegions(html);
  const elements = ['li', 'div']
    .flatMap((type) => findBalancedElements(visibleHtml, type))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const candidates = elements
    .map((element) => {
      const anchors = extractAnchors(element.content);
      if (anchors.length !== 1) return null;
      const date = extractPublicationDate(element.content, calendar);
      return date ? { ...element, anchor: anchors[0], date: date.value, dateInferred: date.inferred } : null;
    })
    .filter(Boolean);

  // Ordered starts mean any later candidate ending inside this one is a child.
  // A reverse scan selects the innermost cards without an all-pairs search.
  const cards = [];
  let earliestEnd = Infinity;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (candidate.end < earliestEnd) cards.push(candidate);
    earliestEnd = Math.min(earliestEnd, candidate.end);
  }
  return cards.reverse();
}

function parseOfficialDocument(html, source, checkedAt = new Date().toISOString()) {
  const calendar = getShanghaiYearAndMonth(checkedAt);
  const candidates = extractAnnouncementCards(html, calendar);
  const diagnostics = {
    candidateCount: candidates.length,
    relevantCount: 0,
    containerTypes: [...new Set(candidates.map((candidate) => candidate.type))]
  };
  if (!source || !isAllowedOfficialUrl(source.url, source)) return { updates: [], diagnostics };

  const updatesById = new Map();

  for (const candidate of candidates) {
    let titleHtml = candidate.anchor.titleHtml;
    const publicationLabels = findPublicationLabels(titleHtml);
    if (publicationLabels.length) {
      const titleContent = titleHtml.split('');
      for (const label of publicationLabels) {
        maskRange(titleContent, label.index, label.index + label[0].length);
      }
      titleHtml = titleContent.join('');
    }
    const title = cleanText(titleHtml);
    if (!isRelevantTitle(title, source)) continue;
    // A guessed year must not discard a notice before the article is checked.
    if (!isRelevantAdmissionCycle(title, candidate.dateInferred ? null : candidate.date, checkedAt, calendar)) continue;

    let url;
    try {
      const resolvedUrl = new URL(decodeHtmlEntities(candidate.anchor.href), source.url);
      resolvedUrl.hash = '';
      url = resolvedUrl.href;
    } catch {
      continue;
    }
    if (!isAllowedOfficialUrl(url, source)) continue;

    const category = categorizeTitle(title, source);
    const isTarget2027 = /2027|2027年/.test(title);
    const isImportant = source.context === 'national-policy' || /招生简章|招生章程|专业目录|初试科目|考试科目|考试大纲|网上报名|预报名|报名公告|准考资格|复试|调剂/.test(title);

    const update = {
      id: makeId(source, url),
      contentHash: makeContentHash(title, category, candidate.date),
      title,
      date: candidate.date,
      ...(candidate.dateInferred ? { dateInferred: true } : {}),
      url,
      source: source.name,
      sourceId: source.id,
      category,
      isTarget2027,
      isImportant
    };
    if (!updatesById.has(update.id)) updatesById.set(update.id, update);
  }

  const updates = [...updatesById.values()];
  diagnostics.relevantCount = updates.length;
  return { updates, diagnostics };
}

function parseOfficialList(html, source, checkedAt = new Date().toISOString()) {
  return parseOfficialDocument(html, source, checkedAt).updates;
}

function mergeAndRankUpdates(updates, limit = 20) {
  const unique = [];
  const seenUrls = new Set();

  for (const update of Array.isArray(updates) ? updates : []) {
    if (!update || !update.url || !update.title) continue;
    if (seenUrls.has(update.url)) continue;
    seenUrls.add(update.url);
    unique.push(update);
  }

  return unique
    .sort((a, b) => {
      const dateOrder = String(b.date || '').localeCompare(String(a.date || ''), 'zh-CN');
      if (dateOrder !== 0) return dateOrder;
      if (Boolean(a.isTarget2027) !== Boolean(b.isTarget2027)) return a.isTarget2027 ? -1 : 1;
      if (Boolean(a.isImportant) !== Boolean(b.isImportant)) return a.isImportant ? -1 : 1;
      return String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN');
    })
    .slice(0, Math.max(0, Number.isFinite(limit) ? limit : 20));
}

module.exports = {
  categorizeTitle,
  cleanText,
  isAllowedOfficialUrl,
  isOfficialHainanUniversityUrl,
  isRelevantAdmissionCycle,
  mergeAndRankUpdates,
  parseOfficialDocument,
  parseOfficialPublicationDate,
  makeContentHash,
  parseOfficialList
};
