const {
  isAllowedOfficialUrl,
  isRelevantAdmissionCycle,
  parseOfficialPublicationDate,
  makeContentHash
} = require('./official-scraper.cjs');
const {
  getShanghaiDate
} = require('./snapshot-validators.cjs');

const MAX_HTML_LENGTH = 2_000_000;

const MAX_REDIRECTS = 3;

function buildHttpError(response, checkedAt, retryDelayMs) {
  const error = new Error(`HTTP ${response?.status || 'unknown'}`);
  error.retryable = response?.status === 408 || response?.status === 429 || response?.status >= 500;
  if (response?.status === 429) {
    const retryAfter = response.headers?.get?.('retry-after');
    const hasRetryAfter = typeof retryAfter === 'string' && retryAfter.trim() !== '';
    const seconds = hasRetryAfter ? Number(retryAfter) : Number.NaN;
    const requestedDelay = !hasRetryAfter
      ? retryDelayMs
      : Number.isFinite(seconds)
        ? seconds * 1000
        : Math.max(0, Date.parse(retryAfter) - Date.parse(checkedAt));
    error.retryAfterMs = Math.min(10_000, Math.max(0, Number.isFinite(requestedDelay) ? requestedDelay : retryDelayMs));
  }
  return error;
}

// Follows only redirects that stay on the source's official domains.
async function fetchFollowingOfficialRedirects(requestedUrl, source, fetchImpl, signal) {
  let response;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    response = await fetchImpl(requestedUrl, {
      method: 'GET',
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'HNU-2027-Kaoyan-Guide/1.0 (+local official-notice monitor)'
      },
      redirect: 'manual',
      signal
    });

    if (response?.status >= 300 && response.status < 400) {
      const location = response.headers?.get?.('location');
      if (!location) throw new Error('官网返回了无地址的重定向');
      const redirectedUrl = new URL(location, requestedUrl).href;
      if (!isAllowedOfficialUrl(redirectedUrl, source)) throw new Error('官网重定向指向非官方域名，已拒绝');
      if (redirectCount === MAX_REDIRECTS) throw new Error('官网重定向次数过多');
      requestedUrl = redirectedUrl;
      continue;
    }
    break;
  }
  return { response, requestedUrl };
}

function assertOfficialHtmlResponse(response, source) {
  if (response.url && !isAllowedOfficialUrl(response.url, source)) {
    throw new Error('响应来自非官方域名，已拒绝');
  }
  const contentType = response.headers?.get?.('content-type') || '';
  if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    throw new Error('官网返回的不是 HTML 页面');
  }
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_HTML_LENGTH) throw new Error('官网响应过大，已停止读取');
}

async function readBoundedHtmlBody(response) {
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let bytesRead = 0;
    let decoded = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_HTML_LENGTH) {
        await reader.cancel().catch(() => {});
        throw new Error('官网响应过大，已停止读取');
      }
      decoded += decoder.decode(value, { stream: true });
    }
    return decoded + decoder.decode();
  }
  const html = await response.text();
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_LENGTH) throw new Error('官网响应过大，已停止读取');
  return html;
}

async function fetchOfficialHtml({ url, source, fetchImpl, signal, checkedAt, retryDelayMs }) {
  const { response, requestedUrl } = await fetchFollowingOfficialRedirects(url, source, fetchImpl, signal);
  if (!response || !response.ok) throw buildHttpError(response, checkedAt, retryDelayMs);
  assertOfficialHtmlResponse(response, source);
  return { html: await readBoundedHtmlBody(response), url: response.url || requestedUrl };
}

function buildDegradedResult({ count, diagnostics, error, retryable }) {
  return { ok: false, updates: [], count, diagnostics, error, retryable, degraded: true };
}

function buildNoNoticesError(diagnostics) {
  const error = new Error('未识别到招生通知，可能是官网页面结构已变化');
  error.retryable = true;
  error.diagnostics = diagnostics;
  return error;
}

// Converts a thrown fetch/parse error into a failed source result and decides retryability.
function buildFetchFailureResult(error, attemptedDiagnostics) {
  const message = error?.name === 'AbortError' ? '请求超时' : String(error?.message || '请求失败');
  return {
    ok: false,
    updates: [],
    diagnostics: error?.diagnostics || attemptedDiagnostics,
    degraded: error?.degraded === true,
    error: message.slice(0, 160),
    retryable: error?.name === 'AbortError' || error?.retryable === true || error instanceof TypeError ||
      !('retryable' in Object(error)) && /network|fetch|socket|reset|timeout|offline/i.test(message),
    retryAfterMs: Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : null
  };
}

// Confirms every update's publication year against its article (up to four requests in
// parallel) and drops verified updates that fall outside the current admission cycle.
async function verifyUpdatePublicationDates(updates, readOfficialHtml, checkedAt) {
  const todayInShanghai = getShanghaiDate(checkedAt);
  const verifyPublicationDate = (update) => {
    if (update.date > todayInShanghai) throw new Error('通知发布日期晚于当前日期，已保留上次可信缓存');
    update.dateVerified = true;
  };
  const pending = updates.filter((update) => update.dateInferred);
  updates.filter((update) => !update.dateInferred).forEach(verifyPublicationDate);
  let pendingIndex = 0;
  const verifications = await Promise.allSettled(Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (pendingIndex < pending.length) {
      const update = pending[pendingIndex++];
      const article = await readOfficialHtml(update.url);
      const date = parseOfficialPublicationDate(article.html);
      if (!date) throw new Error('无法核实通知原文的发布年份，已保留上次可信缓存');
      update.date = date;
      verifyPublicationDate(update);
      delete update.dateInferred;
      update.contentHash = makeContentHash(update.title, update.category, date);
    }
  }));
  const failedVerification = verifications.find((result) => result.status === 'rejected');
  if (failedVerification) throw failedVerification.reason;
  // Apply the same age rules to verified article dates as to dated lists.
  const inferredIds = new Set(pending.map((update) => update.id));
  return updates.filter((update) => !inferredIds.has(update.id)
    || isRelevantAdmissionCycle(update.title, update.date, checkedAt));
}

module.exports = {
  MAX_HTML_LENGTH,
  MAX_REDIRECTS,
  buildHttpError,
  fetchFollowingOfficialRedirects,
  assertOfficialHtmlResponse,
  readBoundedHtmlBody,
  fetchOfficialHtml,
  buildDegradedResult,
  buildNoNoticesError,
  buildFetchFailureResult,
  verifyUpdatePublicationDates
};
