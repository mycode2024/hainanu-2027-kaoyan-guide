const crypto = require('node:crypto');
// Bump when parser changes make persisted structural diagnostics incomparable.
const PARSER_DIAGNOSTICS_VERSION = 2;
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
  const source = String(value || '');
  const parts = [];
  let cursor = 0;
  for (const tag of scanHtmlTags(source)) {
    parts.push(source.slice(cursor, tag.start), ' ');
    cursor = tag.end;
  }
  parts.push(source.slice(cursor));
  return decodeHtmlEntities(parts.join(''))
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
  const attributesStart = index;
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
        attributesStart,
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

function* scanHtmlTags(source) {
  let index = 0;
  while ((index = source.indexOf('<', index)) !== -1) {
    if (source.startsWith('<!--', index) || source.startsWith('<!', index) || source.startsWith('<?', index)) {
      const end = source.startsWith('<!--', index) ? findCommentEnd(source, index) : source.indexOf('>', index + 2) + 1;
      if (end > index) {
        yield { name: '#declaration', start: index, end };
        index = end;
        continue;
      }
    }
    const tag = readHtmlTag(source, index);
    if (!tag) {
      index += 1;
      continue;
    }
    yield { ...tag, start: index };
    index = tag.end;
  }
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
  let coveredThrough = -1;
  return ['time', 'span', 'div'].flatMap(type => findBalancedElements(content, type))
    .filter(label => label.type === 'time' || /(?:^|[\s_-])(?:date|pubdate|time)(?:$|[\s_-])/i.test(
      decodeHtmlEntities(readHtmlAttribute(content, readHtmlTag(content, label.start), 'class') || '')
    ))
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .filter(label => {
      if (label.end <= coveredThrough) return false;
      coveredThrough = label.end;
      return true;
    })
    .map(label => ({ 0: label.content, index: label.start }));
}

function extractPublicationDate(visibleContent, checkedDate) {
  // Expose machine-readable publication dates to the same ordered date scan.
  // Keep the publisher's calendar day rather than converting it through UTC.
  const parts = [];
  let cursor = 0;
  for (const tag of scanHtmlTags(visibleContent)) {
    if (tag.name !== 'time' || tag.closing) continue;
    const value = decodeHtmlEntities(readHtmlAttribute(visibleContent, tag, 'datetime') || '').trim();
    const match = value.match(/^(20\d{2})-(\d{2})-(\d{2})(?:$|[T ])/);
    const validDate = match && Number.isFinite(Date.parse(value)) &&
      isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
    parts.push(visibleContent.slice(cursor, tag.start), `<time>${validDate ? `${match[1]}-${match[2]}-${match[3]} ` : ''}`);
    cursor = tag.end;
  }
  parts.push(visibleContent.slice(cursor));
  // Link text may contain an exam/deadline date; it is not a publication label.
  // Clickable cards can still contain explicit time/date elements.
  const datedContent = parts.join('');
  const publicationParts = [];
  cursor = 0;
  for (const link of findBalancedElements(datedContent, 'a').sort((a, b) => a.start - b.start)) {
    if (link.start < cursor) continue;
    publicationParts.push(datedContent.slice(cursor, link.start), ' ',
      findPublicationLabels(link.content).map(label => label[0]).join(' '), ' ');
    cursor = link.end;
  }
  publicationParts.push(datedContent.slice(cursor));
  const publicationContent = publicationParts.join('');
  const labels = findPublicationLabels(publicationContent);
  // Explicit publication labels take precedence over dates in summaries.
  // An invalid label must not fall back to an unrelated full deadline date.
  // Unlabelled short dates may still trigger verification against the article.
  const visibleText = cleanText(labels.length
    ? labels.map(label => label[0]).join(' ')
    : publicationContent);
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
    const shortDateTexts = [visibleText, ...(labels.length ? [cleanText(publicationContent)] : [])];
    for (const [priority, text] of shortDateTexts.entries()) {
      for (const match of text.matchAll(/\[\s*((?:0[1-9]|1[0-2]))-((?:0[1-9]|[12]\d|3[01]))\s*\]/g)) {
        const month = Number(match[1]);
        const year = checkedDate.year - (month > checkedDate.month ? 1 : 0);
        dateCandidates.push({
          priority,
          index: match.index,
          year,
          month,
          day: Number(match[2]),
          value: `${year}-${match[1]}-${match[2]}`,
          inferred: true
        });
      }
    }
  }

  const date = dateCandidates
    .sort((a, b) => (a.priority || 0) - (b.priority || 0) || a.index - b.index)
    .find((candidate) => isValidCalendarDate(candidate.year, candidate.month, candidate.day));
  // Preserve even an invalid explicit label as a boundary against nested
  // summary dates. It must not silently turn a deadline into a publication.
  return date || labels.length ? { ...date, hasPublicationLabel: labels.length > 0 } : null;
}

// Only publication metadata or the publisher's dated byline may establish a year.
// Dates in the article body can describe deadlines for a different admission cycle.
function parseOfficialPublicationDate(html) {
  const visibleHtml = maskNonVisibleRegions(String(html || ''));
  const candidates = [];
  for (const tag of scanHtmlTags(visibleHtml)) {
    if (tag.name !== 'meta' || tag.closing) continue;
    const name = decodeHtmlEntities(readHtmlAttribute(visibleHtml, tag, 'name') ||
      readHtmlAttribute(visibleHtml, tag, 'property') || '').trim();
    if (/^(pubdate|publishdate|article:published_time)$/i.test(name)) {
      candidates.push(decodeHtmlEntities(readHtmlAttribute(visibleHtml, tag, 'content') || '').trim());
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
  const openElements = [];
  const elements = [];
  const listStack = [];
  const finishElement = (end) => {
    const opening = openElements.pop();
    if (!opening) return;
    elements.push({ type, start: opening.start, end, content: scanDocument.slice(opening.start, end) });
  };

  for (const tag of scanHtmlTags(scanDocument)) {
    if (type === 'li' && ['ul', 'ol', 'menu'].includes(tag.name)) {
      if (!tag.closing) {
        listStack.push(tag.name);
      } else {
        const listIndex = listStack.lastIndexOf(tag.name);
        if (listIndex !== -1) {
          // The final li can end at its list boundary. Nested lists own their
          // items, so closing an inner list must leave the outer li open.
          while (openElements.length && openElements.at(-1).listDepth > listIndex) {
            finishElement(tag.start);
          }
          listStack.length = listIndex;
        }
      }
      continue;
    }
    if (tag.name !== type) continue;
    if (tag.closing) {
      if (type === 'li' && openElements.at(-1)?.listDepth !== listStack.length) continue;
      finishElement(tag.end);
    } else if (!tag.selfClosing || type === 'a' || type === 'span' || type === 'time') {
      // A sibling li implicitly ends the prior item in the same list.
      if (type === 'li' && listStack.length && openElements.at(-1)?.listDepth === listStack.length) {
        finishElement(tag.start);
      }
      // Preserve link/label matching: a trailing slash does not close these
      // non-void HTML elements before their actual end tag.
      openElements.push({ start: tag.start, listDepth: listStack.length });
    }
  }

  return elements;
}

function readHtmlAttribute(source, tag, name) {
  const attributes = source.slice(tag.attributesStart, tag.end - 1);
  // Consume whole attributes, including quoted values, before comparing names.
  // This keeps data-href and text such as title="href='...'" out of URL lookup.
  const pattern = /([^\s/>=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of attributes.matchAll(pattern)) {
    if (match[1].toLowerCase() === name) return match[2] ?? match[3] ?? match[4] ?? '';
  }
  return null;
}

function extractAnchors(visibleContent) {
  const anchors = [];
  let opening = null;
  let index = 0;
  while ((index = visibleContent.indexOf('<', index)) !== -1) {
    const tag = readHtmlTag(visibleContent, index);
    if (!tag) {
      index += 1;
      continue;
    }
    if (tag.name === 'a') {
      if (tag.closing) {
        if (opening && opening.href !== null) {
          anchors.push({ href: opening.href, titleHtml: visibleContent.slice(opening.end, index) });
        }
        opening = null;
      } else {
        opening = { href: readHtmlAttribute(visibleContent, tag, 'href'), end: tag.end };
      }
    }
    index = tag.end;
  }
  return anchors;
}

function extractAnnouncementCards(html, calendar) {
  // Preserve offsets while masking once for the entire document.
  const visibleHtml = maskNonVisibleRegions(html);
  const elements = ['li', 'div']
    .flatMap((type) => findBalancedElements(visibleHtml, type))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  // A linked li owns its notice even when its publication date is absent.
  // Track those boundaries before discarding undated cards, so a containing
  // div cannot supply a footer/sibling date. Title-only divs still allow their
  // parent card to provide its sibling date label.
  const cards = [];
  let earliestEnd = Infinity;
  let earliestLinkedListEnd = Infinity;
  // Ordered starts allow the same linear reverse scan for both boundaries.
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    const element = elements[index];
    const anchors = extractAnchors(element.content);
    if (anchors.length !== 1) continue;
    if (element.end >= earliestLinkedListEnd) continue;
    if (element.type === 'li') earliestLinkedListEnd = element.end;
    const date = extractPublicationDate(element.content, calendar);
    if (!date) continue;
    const card = { ...element, anchor: anchors[0], date: date.value,
      dateInferred: date.inferred, hasPublicationLabel: date.hasPublicationLabel };
    const innerCard = cards.at(-1);
    if (element.end < earliestEnd) {
      cards.push(card);
    } else if (date.hasPublicationLabel && innerCard &&
        innerCard.start >= element.start && innerCard.end <= element.end &&
        (!innerCard.hasPublicationLabel || (!innerCard.date && date.value))) {
      // A title/summary div may contain a deadline. Prefer the enclosing
      // card's publication label over that inner unlabelled date.
      cards[cards.length - 1] = card;
    }
    earliestEnd = Math.min(earliestEnd, element.end);
  }
  return cards.reverse().filter(card => card.date);
}

function parseOfficialDocument(html, source, checkedAt = new Date().toISOString(), documentUrl = source?.url) {
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
      // Resolve against the fetched page while keeping source identity and trust rules.
      const resolvedUrl = new URL(decodeHtmlEntities(candidate.anchor.href), documentUrl);
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
  PARSER_DIAGNOSTICS_VERSION,
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
