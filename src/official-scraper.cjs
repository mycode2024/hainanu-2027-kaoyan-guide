const {
  decodeHtmlEntities,
  cleanText,
  readHtmlTag,
  scanHtmlTags,
  maskRange,
  maskNonVisibleRegions,
  extractVisibleText,
  findBalancedElements,
  readHtmlAttribute,
  extractAnchors
} = require('./html-markup.cjs');
const {
  isAllowedOfficialUrl,
  categorizeTitle,
  isRelevantAdmissionCycle,
  isRelevantTitle,
  makeId,
  makeContentHash,
  isValidCalendarDate,
  getShanghaiYearAndMonth
} = require('./official-rules.cjs');

// Bump when parser changes make persisted structural diagnostics incomparable.
const PARSER_DIAGNOSTICS_VERSION = 5;

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

// Expose machine-readable publication dates to the same ordered date scan.
// Keep the publisher's calendar day rather than converting it through UTC.
function inlineTimeElementDates(visibleContent) {
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
  return parts.join('');
}

// Link text may contain an exam/deadline date; it is not a publication label.
// Clickable cards can still contain explicit time/date elements.
function replaceLinksWithPublicationLabels(datedContent) {
  const parts = [];
  let cursor = 0;
  for (const link of findBalancedElements(datedContent, 'a').sort((a, b) => a.start - b.start)) {
    if (link.start < cursor) continue;
    parts.push(datedContent.slice(cursor, link.start), ' ',
      findPublicationLabels(link.content).map(label => label[0]).join(' '), ' ');
    cursor = link.end;
  }
  parts.push(datedContent.slice(cursor));
  return parts.join('');
}

function collectFullDateCandidates(visibleText) {
  return [...visibleText.matchAll(/\b(20\d{2})-((?:0[1-9]|1[0-2]))-((?:0[1-9]|[12]\d|3[01]))\b/g)].map((match) => ({
    index: match.index,
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    value: `${match[1]}-${match[2]}-${match[3]}`,
    inferred: false
  }));
}

function collectShortDateCandidates(shortDateTexts, checkedDate) {
  const candidates = [];
  for (const [priority, text] of shortDateTexts.entries()) {
    for (const match of text.matchAll(/\[\s*((?:0[1-9]|1[0-2]))-((?:0[1-9]|[12]\d|3[01]))\s*\]/g)) {
      const month = Number(match[1]);
      const day = Number(match[2]);
      let year = checkedDate.year - (month > checkedDate.month ? 1 : 0);
      // Keep leap-day labels eligible for article verification even when
      // the guessed year is not a leap year. This date remains inferred.
      if (month === 2 && day === 29) {
        while (!isValidCalendarDate(year, month, day)) year -= 1;
      }
      candidates.push({
        priority,
        index: match.index,
        year,
        month,
        day,
        value: `${year}-${match[1]}-${match[2]}`,
        inferred: true
      });
    }
  }
  return candidates;
}

function extractPublicationDate(visibleContent, checkedDate) {
  const publicationContent = replaceLinksWithPublicationLabels(inlineTimeElementDates(visibleContent));
  const labels = findPublicationLabels(publicationContent);
  // Explicit publication labels take precedence over dates in summaries.
  // An invalid label must not fall back to an unrelated full deadline date.
  // Unlabelled short dates may still trigger verification against the article.
  const visibleText = cleanText(labels.length
    ? labels.map(label => label[0]).join(' ')
    : publicationContent);
  const dateCandidates = collectFullDateCandidates(visibleText);

  if (checkedDate) {
    const shortDateTexts = [visibleText, ...(labels.length ? [cleanText(publicationContent)] : [])];
    dateCandidates.push(...collectShortDateCandidates(shortDateTexts, checkedDate));
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

function extractAnchorTitle(titleHtml) {
  const publicationLabels = findPublicationLabels(titleHtml);
  if (publicationLabels.length) {
    const titleContent = titleHtml.split('');
    for (const label of publicationLabels) {
      maskRange(titleContent, label.index, label.index + label[0].length);
    }
    titleHtml = titleContent.join('');
  }
  return cleanText(titleHtml, true);
}

function selectNoticeAnchor(anchors, source, documentUrl) {
  if (anchors.length <= 1) return anchors[0] || null;
  const targets = new Set();
  for (const anchor of anchors) {
    try {
      const url = new URL(decodeHtmlEntities(anchor.href), documentUrl);
      url.hash = '';
      targets.add(url.href);
    } catch {
      return null;
    }
    // A shared container must not pair different notices with one date.
    if (targets.size > 1) return null;
  }
  // Prefer the notice title over an image or a generic read-more label.
  // Keep non-notice links as boundaries so a parent cannot lend them a date.
  return anchors.find(anchor => isRelevantTitle(extractAnchorTitle(anchor.titleHtml), source)) || anchors[0];
}

function extractAnnouncementCards(html, calendar, source, documentUrl) {
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
    const anchor = selectNoticeAnchor(extractAnchors(element.content), source, documentUrl);
    if (!anchor) continue;
    if (element.end >= earliestLinkedListEnd) continue;
    if (element.type === 'li') earliestLinkedListEnd = element.end;
    const date = extractPublicationDate(element.content, calendar);
    if (!date) continue;
    const card = { ...element, anchor, date: date.value,
      dateInferred: date.inferred, hasPublicationLabel: date.hasPublicationLabel };
    const innerCard = cards.at(-1);
    const otherInnerCard = cards.at(-2);
    if (element.end < earliestEnd) {
      cards.push(card);
    } else if (innerCard &&
        innerCard.start >= element.start && innerCard.end <= element.end &&
        !(otherInnerCard && otherInnerCard.start >= element.start && otherInnerCard.end <= element.end)) {
      // Only a single child card can be extended by its parent. Prefer an
      // explicit parent date over an unlabelled summary deadline.
      const preferParentDate = date.hasPublicationLabel &&
        (!innerCard.hasPublicationLabel || (!innerCard.date && date.value));
      const preferParentTitle = !isRelevantTitle(extractAnchorTitle(innerCard.anchor.titleHtml), source) &&
        isRelevantTitle(extractAnchorTitle(anchor.titleHtml), source);
      if (preferParentDate) {
        cards[cards.length - 1] = card;
      } else if (preferParentTitle) {
        // Completing a dated preview's title must not borrow an unrelated
        // date from the parent's body, including an application deadline.
        cards[cards.length - 1] = { ...card, date: innerCard.date,
          dateInferred: innerCard.dateInferred, hasPublicationLabel: innerCard.hasPublicationLabel };
      }
    }
    earliestEnd = Math.min(earliestEnd, element.end);
  }
  return cards.reverse().filter(card => card.date);
}

// Returns the notice for one extracted card, or null when it is not a relevant,
// resolvable and trusted official link.
function buildUpdateFromCandidate(candidate, source, documentUrl, checkedAt, calendar) {
  // Keep placeholder anchors during card extraction to preserve boundaries,
  // but never turn an empty or same-page fragment link into a notice URL.
  const href = decodeHtmlEntities(candidate.anchor.href).trim();
  if (!href || href.startsWith('#')) return null;
  const title = extractAnchorTitle(candidate.anchor.titleHtml);
  if (!isRelevantTitle(title, source)) return null;
  // A guessed year must not discard a notice before the article is checked.
  if (!isRelevantAdmissionCycle(title, candidate.dateInferred ? null : candidate.date, checkedAt, calendar)) return null;

  let url;
  try {
    // Resolve against the fetched page while keeping source identity and trust rules.
    const resolvedUrl = new URL(href, documentUrl);
    resolvedUrl.hash = '';
    url = resolvedUrl.href;
  } catch {
    return null;
  }
  if (!isAllowedOfficialUrl(url, source)) return null;

  const category = categorizeTitle(title, source);
  return {
    id: makeId(source, url),
    contentHash: makeContentHash(title, category, candidate.date),
    title,
    date: candidate.date,
    ...(candidate.dateInferred ? { dateInferred: true } : {}),
    url,
    source: source.name,
    sourceId: source.id,
    category,
    isTarget2027: /2027/.test(title),
    isImportant: source.context === 'national-policy' || /招生简章|招生章程|专业目录|初试科目|考试科目|考试大纲|网上报名|预报名|报名公告|准考资格|复试|调剂/.test(title)
  };
}

function parseOfficialDocument(html, source, checkedAt = new Date().toISOString(), documentUrl = source?.url) {
  const calendar = getShanghaiYearAndMonth(checkedAt);
  const candidates = extractAnnouncementCards(html, calendar, source, documentUrl);
  const diagnostics = {
    candidateCount: candidates.length,
    relevantCount: 0,
    containerTypes: [...new Set(candidates.map((candidate) => candidate.type))]
  };
  if (!source || !isAllowedOfficialUrl(source.url, source)) return { updates: [], diagnostics };

  const updatesById = new Map();
  for (const candidate of candidates) {
    const update = buildUpdateFromCandidate(candidate, source, documentUrl, checkedAt, calendar);
    if (update && !updatesById.has(update.id)) updatesById.set(update.id, update);
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
  isRelevantAdmissionCycle,
  mergeAndRankUpdates,
  parseOfficialDocument,
  parseOfficialPublicationDate,
  makeContentHash,
  parseOfficialList
};
