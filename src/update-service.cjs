const fs = require('node:fs/promises');
const path = require('node:path');
const {
  isAllowedOfficialUrl,
  parseOfficialDocument,
  parseOfficialPublicationDate,
  makeContentHash
} = require('./official-scraper.cjs');

const DEFAULT_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_RETRY_DELAY_MS = 750;
const MAX_HTML_LENGTH = 2_000_000;
const MAX_REDIRECTS = 3;
const MAX_SNAPSHOT_UPDATES = 120;
const DRIFT_RECENT_WINDOW_MS = 90 * 86_400_000;

function toIsoDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function makeSeedSnapshot(sources, refreshIntervalMs, date) {
  const fetchedAt = toIsoDate(date);
  return {
    schemaVersion: 2,
    status: 'seed',
    fetchedAt,
    lastAttemptAt: null,
    lastAnySuccessAt: null,
    lastAllSuccessAt: null,
    lastSuccessAt: null,
    nextRefreshAt: new Date(new Date(fetchedAt).getTime() + refreshIntervalMs).toISOString(),
    refreshIntervalMs,
    sources: sources.map((source) => ({
      id: source.id,
      name: source.name,
      url: source.url,
      ok: null,
      checkedAt: null,
      lastSuccessAt: null,
      attempts: 0,
      diagnostics: null,
      lastTrustedDiagnostics: null,
      error: null
    })),
    updates: [],
    change: { newCount: 0, newIds: [], updatedCount: 0, updatedIds: [], changedAt: null },
    error: null
  };
}

function isValidIsoDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isCacheSnapshotShape(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.updates));
}

function sanitizeParserDiagnostics(value, expectedRelevantCount = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { candidateCount, relevantCount, containerTypes } = value;
  if (!Number.isInteger(candidateCount) || candidateCount < 0) return null;
  if (!Number.isInteger(relevantCount) || relevantCount < 0 || relevantCount > candidateCount) return null;
  if (Number.isInteger(expectedRelevantCount) && relevantCount !== expectedRelevantCount) return null;
  if (!Array.isArray(containerTypes)) return null;
  const normalizedTypes = [...new Set(containerTypes.map((type) => String(type || '').trim().toLowerCase()))];
  if (normalizedTypes.length !== containerTypes.length) return null;
  if (normalizedTypes.some((type) => type !== 'li' && type !== 'div')) return null;
  if (relevantCount > 0 && normalizedTypes.length === 0) return null;
  return { candidateCount, relevantCount, containerTypes: normalizedTypes };
}

function isStaleAdmissionUpdate(update, referenceDate) {
  if (/2027\s*(?:年|级)/.test(update?.title || '')) return false;
  if (!update?.date || typeof update.date !== 'string') return false;
  const pubYear = Number(update.date.slice(0, 4));
  const refDate = new Date(referenceDate);
  if (!Number.isFinite(refDate.getTime())) return false;
  const shanghaiValues = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(refDate);
  const currentYear = Number(shanghaiValues.find((p) => p.type === 'year')?.value);
  if (!Number.isFinite(currentYear)) return false;
  const targetYear = currentYear + 1;
  // Discard items published > 18 months ago
  const pubMs = Date.parse(`${update.date}T00:00:00Z`);
  if (Number.isFinite(pubMs) && refDate.getTime() - pubMs > 548 * 86_400_000) return true;
  // If title mentions a year that is 2+ years before the target cycle, it's stale
  const titleYear = update.title?.match?.(/(?:20\d{2})年?/);
  if (titleYear) {
    const mentioned = Number(titleYear[0].replace('年', ''));
    if (Number.isFinite(mentioned) && mentioned < targetYear - 1) return true;
  }
  return false;
}

function sanitizeCachedSnapshot(value, sources, refreshIntervalMs, date) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.updates)) return null;
  const seed = makeSeedSnapshot(sources, refreshIntervalMs, date);
  const allowedSourceIds = new Set(sources.map((source) => source.id));
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const cacheSuccessTime = isValidIsoDate(value.lastAnySuccessAt)
    ? value.lastAnySuccessAt
    : isValidIsoDate(value.lastSuccessAt) ? value.lastSuccessAt : null;
  const updates = value.updates
    .filter((update) => update && typeof update === 'object')
    // Legacy homepage cache guessed years from MM-DD; do not serve it as trusted history.
    .filter((update) => sourceById.get(update.sourceId)?.context !== 'hnu-home' || update.dateVerified === true)
    .map((update) => {
      const publicationDate = typeof update.date === 'string' ? update.date.trim() : '';
      const publicationFallback = /^20\d{2}-\d{2}-\d{2}$/.test(publicationDate)
        ? `${publicationDate}T00:00:00.000Z`
        : seed.fetchedAt;
      return {
        id: typeof update.id === 'string' ? update.id.trim() : '',
        contentHash: typeof update.contentHash === 'string' ? update.contentHash.trim() : '',
        title: typeof update.title === 'string' ? update.title.trim() : '',
        date: publicationDate,
        dateVerified: update.dateVerified === true,
        url: typeof update.url === 'string' ? update.url.trim() : '',
        source: typeof update.source === 'string' ? update.source.trim() : '',
        sourceId: typeof update.sourceId === 'string' ? update.sourceId.trim() : '',
        category: typeof update.category === 'string' && update.category.trim() ? update.category.trim() : '招生动态',
        isTarget2027: update.isTarget2027 === true,
        isImportant: update.isImportant === true,
        discoveredAt: isValidIsoDate(update.discoveredAt) ? update.discoveredAt : cacheSuccessTime || publicationFallback,
        lastSeenAt: isValidIsoDate(update.lastSeenAt) ? update.lastSeenAt : null,
        updatedAt: isValidIsoDate(update.updatedAt) ? update.updatedAt : null,
        missingSince: isValidIsoDate(update.missingSince) ? update.missingSince : null,
        missCount: Number.isInteger(update.missCount) && update.missCount > 0 ? update.missCount : 0
      };
    })
    .filter((update) => (
      update.id && update.title && /^20\d{2}-\d{2}-\d{2}$/.test(update.date) &&
      update.source && allowedSourceIds.has(update.sourceId) &&
      isAllowedOfficialUrl(update.url, sourceById.get(update.sourceId)) &&
      !isStaleAdmissionUpdate(update, seed.fetchedAt)
    ));

  const cachedSourceById = new Map(
    (Array.isArray(value.sources) ? value.sources : [])
      .filter((source) => source && allowedSourceIds.has(source.id))
      .map((source) => [source.id, source])
  );

  return {
    ...seed,
    status: updates.length ? 'stale' : 'seed',
    fetchedAt: isValidIsoDate(value.fetchedAt) ? value.fetchedAt : seed.fetchedAt,
    lastAttemptAt: isValidIsoDate(value.lastAttemptAt) ? value.lastAttemptAt : null,
    lastAnySuccessAt: cacheSuccessTime,
    lastAllSuccessAt: isValidIsoDate(value.lastAllSuccessAt) ? value.lastAllSuccessAt : null,
    lastSuccessAt: cacheSuccessTime,
    sources: seed.sources.map((source) => {
      const cached = cachedSourceById.get(source.id);
      const diagnostics = sanitizeParserDiagnostics(cached?.diagnostics);
      const lastTrustedDiagnostics = sanitizeParserDiagnostics(cached?.lastTrustedDiagnostics) || diagnostics;
      return {
        ...source,
        lastSuccessAt: isValidIsoDate(cached?.lastSuccessAt) ? cached.lastSuccessAt : null,
        diagnostics,
        lastTrustedDiagnostics
      };
    }),
    updates: rankUpdates(updates, MAX_SNAPSHOT_UPDATES),
    change: {
      newCount: 0,
      newIds: [],
      updatedCount: 0,
      updatedIds: [],
      changedAt: isValidIsoDate(value.change?.changedAt) ? value.change.changedAt : null
    },
    error: typeof value.error === 'string' && value.error.trim() ? value.error.trim().slice(0, 240) : null
  };
}

function getSourceFreshness(lastSuccessAt, currentDate, refreshIntervalMs) {
  if (!isValidIsoDate(lastSuccessAt)) return { freshness: 'never', ageMs: null, isOverdue: true };
  const ageMs = Math.max(0, new Date(currentDate).getTime() - Date.parse(lastSuccessAt));
  if (ageMs >= refreshIntervalMs * 2) return { freshness: 'overdue', ageMs, isOverdue: true };
  if (ageMs >= refreshIntervalMs) return { freshness: 'aging', ageMs, isOverdue: false };
  return { freshness: 'fresh', ageMs, isOverdue: false };
}

function addFreshness(snapshot, currentDate, refreshIntervalMs) {
  const sourceStates = (snapshot.sources || []).map((source) => ({
    ...source,
    ...getSourceFreshness(source.lastSuccessAt, currentDate, refreshIntervalMs)
  }));
  const hasNever = sourceStates.some((source) => source.freshness === 'never');
  const hasOverdue = sourceStates.some((source) => source.freshness === 'overdue');
  const hasAging = sourceStates.some((source) => source.freshness === 'aging');
  const ages = sourceStates.map((source) => source.ageMs).filter(Number.isFinite);
  const worstSourceAgeMs = hasNever ? null : ages.length ? Math.max(...ages) : null;
  const state = hasNever ? 'never' : hasOverdue ? 'overdue' : hasAging ? 'aging' : 'fresh';
  return {
    sources: sourceStates,
    freshness: {
      state,
      overdueSourceIds: sourceStates.filter((source) => source.isOverdue).map((source) => source.id),
      worstSourceAgeMs,
      ageMs: worstSourceAgeMs,
      isOverdue: state === 'never' || state === 'overdue'
    }
  };
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href;
  } catch {
    return String(value || '');
  }
}

function updateIdentity(update) {
  const sourceId = String(update?.sourceId || '');
  const url = normalizeUrl(update?.url);
  return sourceId && url ? `${sourceId}\n${url}` : String(update?.id || '');
}

function rankUpdates(updates, limit = MAX_SNAPSHOT_UPDATES) {
  const unique = [];
  const seen = new Set();
  for (const update of Array.isArray(updates) ? updates : []) {
    if (!update?.title || !update?.url) continue;
    const identity = updateIdentity(update);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
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
    .slice(0, Math.max(0, Number.isFinite(limit) ? limit : MAX_SNAPSHOT_UPDATES));
}

function detectSuspiciousDrift(priorUpdates, currentUpdates, checkedAt) {
  const checkedAtMs = Date.parse(checkedAt);
  const isRecent = (update) => {
    const dateMs = Date.parse(`${update?.date}T00:00:00Z`);
    return Number.isFinite(checkedAtMs) && Number.isFinite(dateMs)
      && dateMs <= checkedAtMs + 86_400_000
      && checkedAtMs - dateMs <= DRIFT_RECENT_WINDOW_MS;
  };
  const prior = (priorUpdates || []).filter((update) => !update.missingSince && isRecent(update));
  const current = (currentUpdates || []).filter(isRecent);
  if (!prior.length) return null;
  if (prior.length >= 5 && current.length < Math.ceil(prior.length * 0.4)) {
    return '疑似官网记录数量异常下降';
  }
  const priorUrls = new Set(prior.map((update) => normalizeUrl(update.url)));
  const currentUrls = new Set(current.map((update) => normalizeUrl(update.url)));
  const disappearedCount = [...priorUrls].filter((url) => !currentUrls.has(url)).length;
  const newCount = [...currentUrls].filter((url) => !priorUrls.has(url)).length;
  if (disappearedCount / prior.length > 0.7 && newCount < Math.ceil(prior.length * 0.5)) {
    return '疑似官网大量链接消失';
  }
  const newestPrior = prior.map((update) => Date.parse(`${update.date}T00:00:00Z`)).filter(Number.isFinite).sort((a, b) => b - a)[0];
  const newestCurrent = current.map((update) => Date.parse(`${update.date}T00:00:00Z`)).filter(Number.isFinite).sort((a, b) => b - a)[0];
  if (Number.isFinite(newestPrior) && Number.isFinite(newestCurrent) && newestPrior - newestCurrent > 120 * 86_400_000) {
    return '疑似官网发布日期异常回退';
  }
  return null;
}

function detectDiagnosticDrift(priorDiagnostics, currentDiagnostics) {
  const trusted = sanitizeParserDiagnostics(priorDiagnostics);
  const current = sanitizeParserDiagnostics(currentDiagnostics);
  if (!trusted || !current || trusted.containerTypes.length === 0 || current.containerTypes.length === 0) return null;
  const trustedTypes = new Set(trusted.containerTypes);
  if (current.containerTypes.every((type) => !trustedTypes.has(type))) {
    return '疑似官网公告容器结构完全变化';
  }
  return null;
}

function limitUpdatesWithDiscoveries(updates, discoveryKeys, limit) {
  const ranked = rankUpdates(updates, Number.MAX_SAFE_INTEGER);
  const discoveries = ranked.filter((update) => discoveryKeys.has(`${update.sourceId}\n${normalizeUrl(update.url)}`));
  const selected = discoveries.slice(0, limit);
  const selectedIdentities = new Set(selected.map(updateIdentity));
  const remaining = ranked.filter((update) => !selectedIdentities.has(updateIdentity(update)));
  const representedSources = new Set(selected.map((update) => update.sourceId));
  for (const update of remaining) {
    if (selected.length >= limit) break;
    if (representedSources.has(update.sourceId)) continue;
    selected.push(update);
    selectedIdentities.add(updateIdentity(update));
    representedSources.add(update.sourceId);
  }
  for (const update of remaining) {
    if (selected.length >= limit) break;
    if (selectedIdentities.has(updateIdentity(update))) continue;
    selected.push(update);
    selectedIdentities.add(updateIdentity(update));
  }
  return rankUpdates(selected, limit);
}

function createFileCacheStore(filePath, options = {}) {
  const resolvedPath = path.resolve(filePath);
  const backupPath = `${resolvedPath}.bak`;
  const renameImpl = options.renameImpl || fs.rename;

  async function readJson(candidatePath) {
    const parsed = JSON.parse(await fs.readFile(candidatePath, 'utf8'));
    if (!isCacheSnapshotShape(parsed)) {
      const error = new Error('缓存 JSON 结构无效');
      error.code = 'CACHE_INVALID';
      throw error;
    }
    return parsed;
  }

  return {
    async load() {
      try {
        return await readJson(resolvedPath);
      } catch (primaryError) {
        if (primaryError.code === 'ENOENT') {
          try {
            return { cacheSnapshot: await readJson(backupPath), recoveryWarning: '主缓存缺失，已从备份恢复。' };
          } catch (backupError) {
            if (backupError.code === 'ENOENT') return null;
            const error = new Error('主缓存缺失，且备份缓存已损坏');
            error.code = 'CACHE_CORRUPTION';
            throw error;
          }
        }
        if (!(primaryError instanceof SyntaxError) && primaryError.code !== 'CACHE_INVALID') {
          throw primaryError;
        }
        try {
          return { cacheSnapshot: await readJson(backupPath), recoveryWarning: '主缓存损坏，已从备份恢复。' };
        } catch {
          const error = new Error('本地缓存及备份均已损坏');
          error.code = 'CACHE_CORRUPTION';
          throw error;
        }
      }
    },

    async save(value) {
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      const temporaryPath = `${resolvedPath}.${process.pid}.tmp`;
      const serialized = `${JSON.stringify(value, null, 2)}\n`;
      JSON.parse(serialized);
      await fs.writeFile(temporaryPath, serialized, 'utf8');
      try {
        let primaryIsValid = false;
        try {
          await readJson(resolvedPath);
          primaryIsValid = true;
        } catch (error) {
          if (error.code !== 'ENOENT' && !(error instanceof SyntaxError) && error.code !== 'CACHE_INVALID') throw error;
        }
        if (primaryIsValid) await fs.copyFile(resolvedPath, backupPath);
        await renameImpl(temporaryPath, resolvedPath);
      } catch (error) {
        await fs.unlink(temporaryPath).catch(() => {});
        throw error;
      }
    }
  };
}

function createUpdateService(options = {}) {
  const sources = Array.isArray(options.sources) ? options.sources.slice() : [];
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const cacheStore = options.cacheStore || { load: async () => null, save: async () => {} };
  const now = options.now || (() => new Date());
  const refreshIntervalMs = Number.isFinite(options.refreshIntervalMs)
    ? options.refreshIntervalMs
    : DEFAULT_REFRESH_INTERVAL_MS;
  const requestTimeoutMs = Number.isFinite(options.requestTimeoutMs)
    ? options.requestTimeoutMs
    : DEFAULT_TIMEOUT_MS;
  const retryDelayMs = Number.isFinite(options.retryDelayMs)
    ? options.retryDelayMs
    : DEFAULT_RETRY_DELAY_MS;
  const delayImpl = options.delayImpl || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const randomImpl = options.randomImpl || Math.random;
  const setIntervalImpl = options.setIntervalImpl || setInterval;
  const clearIntervalImpl = options.clearIntervalImpl || clearInterval;
  const onRefreshEvent = typeof options.onRefreshEvent === 'function' ? options.onRefreshEvent : null;
  const onRefreshError = typeof options.onRefreshError === 'function' ? options.onRefreshError : null;
  const parseDocument = typeof options.parseDocument === 'function' ? options.parseDocument : parseOfficialDocument;

  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required');

  let snapshot = makeSeedSnapshot(sources, refreshIntervalMs, now());
  let initializationPromise = null;
  let inFlight = null;
  let intervalHandle = null;
  let nextAutoRefreshAt = null;

  function getNextRefreshAt() {
    const currentTime = Date.parse(toIsoDate(now()));
    const fallbackNextRefreshAt = new Date(currentTime + refreshIntervalMs).toISOString();
    const autoDeadline = Date.parse(nextAutoRefreshAt || '');
    return Number.isFinite(autoDeadline) && autoDeadline > currentTime
      ? nextAutoRefreshAt
      : fallbackNextRefreshAt;
  }

  function getSnapshot() {
    const derived = addFreshness(snapshot, now(), refreshIntervalMs);
    return {
      ...snapshot,
      sources: derived.sources,
      freshness: derived.freshness
    };
  }

  function initialize() {
    if (initializationPromise) return initializationPromise;
    initializationPromise = (async () => {
      try {
        const loaded = await cacheStore.load();
        const cached = loaded?.cacheSnapshot || loaded;
        const sanitized = sanitizeCachedSnapshot(cached, sources, refreshIntervalMs, now());
        if (sanitized) {
          snapshot = loaded?.recoveryWarning
            ? { ...sanitized, error: String(loaded.recoveryWarning).slice(0, 240) }
            : sanitized;
        }
      } catch (error) {
        snapshot = { ...snapshot, error: `读取本地缓存失败：${error.message}` };
      }
      return snapshot;
    })();
    return initializationPromise;
  }

  async function fetchSourceOnce(source, checkedAt, priorUpdates, priorDiagnostics) {
    let attemptedDiagnostics = null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    timer.unref?.();

    try {
      async function readOfficialHtml(requestedUrl) {
        let response;
        for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
          response = await fetchImpl(requestedUrl, {
            method: 'GET',
            headers: {
              accept: 'text/html,application/xhtml+xml',
              'user-agent': 'HNU-2027-Kaoyan-Guide/1.0 (+local official-notice monitor)'
            },
            redirect: 'manual',
            signal: controller.signal
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

        if (!response || !response.ok) {
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
          throw error;
        }
        if (response.url && !isAllowedOfficialUrl(response.url, source)) {
          throw new Error('响应来自非官方域名，已拒绝');
        }
        const contentType = response.headers?.get?.('content-type') || '';
        if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
          throw new Error('官网返回的不是 HTML 页面');
        }
        const declaredLength = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(declaredLength) && declaredLength > MAX_HTML_LENGTH) throw new Error('官网响应过大，已停止读取');

        let html;
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
          html = decoded + decoder.decode();
        } else {
          html = await response.text();
          if (Buffer.byteLength(html, 'utf8') > MAX_HTML_LENGTH) throw new Error('官网响应过大，已停止读取');
        }
        return html;
      }
      const html = await readOfficialHtml(source.url);
      const parsed = parseDocument(html, source, checkedAt);
      const updates = Array.isArray(parsed?.updates) ? parsed.updates : null;
      attemptedDiagnostics = sanitizeParserDiagnostics(parsed?.diagnostics, updates?.length);
      if (!updates || !attemptedDiagnostics) {
        return {
          ok: false,
          updates: [],
          count: Array.isArray(updates) ? updates.length : 0,
          diagnostics: attemptedDiagnostics,
          error: '解析诊断结构或计数异常，可能是官网页面结构已变化',
          retryable: true,
          degraded: true
        };
      }
      if (updates.length === 0) {
        const error = new Error('未识别到招生通知，可能是官网页面结构已变化');
        error.retryable = true;
        error.diagnostics = attemptedDiagnostics;
        throw error;
      }
      const pending = updates.filter((update) => update.dateInferred);
      updates.filter((update) => !update.dateInferred).forEach((update) => { update.dateVerified = true; });
      let pendingIndex = 0;
      const verifications = await Promise.allSettled(Array.from({ length: Math.min(4, pending.length) }, async () => {
        while (pendingIndex < pending.length) {
          const update = pending[pendingIndex++];
          const article = await readOfficialHtml(update.url);
          const date = parseOfficialPublicationDate(article);
          if (!date) throw new Error('无法核实通知原文的发布年份，已保留上次可信缓存');
          const todayInShanghai = new Date(Date.parse(checkedAt) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
          if (date > todayInShanghai) throw new Error('通知原文发布日期晚于当前日期，已保留上次可信缓存');
          update.date = date;
          update.dateVerified = true;
          delete update.dateInferred;
          update.contentHash = makeContentHash(update.title, update.category, date);
        }
      }));
      const failedVerification = verifications.find((result) => result.status === 'rejected');
      if (failedVerification) throw failedVerification.reason;
      const diagnosticDriftReason = detectDiagnosticDrift(priorDiagnostics, attemptedDiagnostics);
      if (diagnosticDriftReason) {
        return {
          ok: false,
          updates: [],
          count: updates.length,
          diagnostics: attemptedDiagnostics,
          error: diagnosticDriftReason,
          retryable: false,
          degraded: true
        };
      }
      const driftReason = detectSuspiciousDrift(priorUpdates, updates, checkedAt);
      if (driftReason) {
        return {
          ok: false,
          updates: [],
          count: updates.length,
          diagnostics: attemptedDiagnostics,
          error: driftReason,
          retryable: true,
          degraded: true
        };
      }
      return {
        ok: true,
        updates,
        count: updates.length,
        diagnostics: attemptedDiagnostics
      };
    } catch (error) {
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
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchSource(source, checkedAt, priorUpdates, priorDiagnostics) {
    let attempts = 0;
    let result;
    let actualRetryDelayMs = 0;
    while (attempts < 2) {
      attempts += 1;
      result = await fetchSourceOnce(source, checkedAt, priorUpdates, priorDiagnostics);
      if (result.ok || !result.retryable || attempts >= 2) break;
      actualRetryDelayMs = Number.isFinite(result.retryAfterMs)
        ? result.retryAfterMs
        : retryDelayMs + Math.min(250, Math.max(0, Math.floor(Number(randomImpl()) * 251) || 0));
      try {
        await delayImpl(actualRetryDelayMs);
      } catch (error) {
        error.refreshTelemetry = {
          attempts,
          count: Number.isInteger(result.count) ? result.count : result.updates.length,
          degraded: result.degraded === true,
          retryDelayMs: actualRetryDelayMs,
          diagnostics: result.diagnostics || null
        };
        throw error;
      }
    }
    return {
      source: {
        id: source.id,
        name: source.name,
        url: source.url,
        ok: result.ok,
        degraded: result.degraded === true,
        checkedAt,
        lastSuccessAt: result.ok ? checkedAt : null,
        attempts,
        retryDelayMs: actualRetryDelayMs,
        diagnostics: result.diagnostics || null,
        lastTrustedDiagnostics: result.ok ? result.diagnostics : priorDiagnostics || null,
        error: result.ok ? null : result.error
      },
      updates: result.updates,
      count: Number.isInteger(result.count) ? result.count : result.updates.length
    };
  }

  async function performRefresh() {
    await initialize();
    const attemptDate = now();
    const fetchedAt = toIsoDate(attemptDate);
    let nextRefreshAt = getNextRefreshAt();
    let results = [];
    let completionEmitted = false;

    function emitCompletion(status, cacheSaved, change, completionError = null) {
      if (completionEmitted) return;
      completionEmitted = true;
      if (!onRefreshEvent) return;
      const durationMs = Math.max(0, new Date(now()).getTime() - new Date(attemptDate).getTime());
      const resultBySourceId = new Map(results.filter(Boolean).map((result) => [result.source.id, result]));
      const event = {
        type: 'refresh-complete',
        durationMs,
        status,
        cacheSaved,
        newCount: change?.newCount || 0,
        updatedCount: change?.updatedCount || 0,
        sources: sources.map((source) => {
          const result = resultBySourceId.get(source.id);
          return result ? {
            id: source.id,
            attempts: result.source.attempts,
            count: result.count,
            degraded: result.source.degraded === true,
            diagnostics: result.source.diagnostics || null,
            error: result.source.error
          } : {
            id: source.id,
            attempts: 0,
            count: 0,
            degraded: false,
            diagnostics: null,
            error: completionError ? String(completionError.message || completionError).slice(0, 160) : null
          };
        }),
        ...(completionError ? { error: String(completionError.message || completionError).slice(0, 240) } : {})
      };
      try {
        Promise.resolve(onRefreshEvent(event)).catch(() => {});
      } catch {
        // Observability must never make trusted data unavailable.
      }
    }

    try {
      const priorBySource = new Map(sources.map((source) => [
        source.id,
        (snapshot.updates || []).filter((update) => update.sourceId === source.id)
      ]));
      const previousSourceById = new Map((snapshot.sources || []).map((source) => [source.id, source]));
      const priorDiagnosticsBySource = new Map(sources.map((source) => {
        const previous = previousSourceById.get(source.id);
        return [source.id, sanitizeParserDiagnostics(previous?.lastTrustedDiagnostics) || sanitizeParserDiagnostics(previous?.diagnostics)];
      }));
      results = new Array(sources.length);
      const sourceSettlements = await Promise.allSettled(sources.map(async (source, index) => {
        try {
          results[index] = await fetchSource(
            source,
            fetchedAt,
            priorBySource.get(source.id),
            priorDiagnosticsBySource.get(source.id)
          );
        } catch (error) {
          results[index] = {
            source: {
              id: source.id,
              name: source.name,
              url: source.url,
              ok: false,
              degraded: error.refreshTelemetry?.degraded === true,
              checkedAt: fetchedAt,
              lastSuccessAt: null,
              attempts: error.refreshTelemetry?.attempts || 0,
              retryDelayMs: error.refreshTelemetry?.retryDelayMs || 0,
              diagnostics: error.refreshTelemetry?.diagnostics || null,
              lastTrustedDiagnostics: priorDiagnosticsBySource.get(source.id) || null,
              error: String(error?.message || error).slice(0, 160)
            },
            updates: [],
            count: error.refreshTelemetry?.count || 0
          };
          throw error;
        }
      }));
      const fatalSettlement = sourceSettlements.find((settlement) => settlement.status === 'rejected');
      if (fatalSettlement) throw fatalSettlement.reason;
      nextRefreshAt = getNextRefreshAt();
    const successfulSourceIds = new Set(results.filter((result) => result.source.ok).map((result) => result.source.id));
    const failedCount = results.length - successfulSourceIds.size;
    const sourceStates = results.map((result) => ({
      ...result.source,
      lastSuccessAt: result.source.lastSuccessAt || previousSourceById.get(result.source.id)?.lastSuccessAt || null
    }));

    if (successfulSourceIds.size === 0) {
      const hasCachedUpdates = snapshot.updates.length > 0;
      const change = {
        newCount: 0,
        newIds: [],
        updatedCount: 0,
        updatedIds: [],
        changedAt: snapshot.change?.changedAt || null
      };
      snapshot = {
        ...snapshot,
        status: hasCachedUpdates ? 'stale' : 'seed',
        fetchedAt,
        lastAttemptAt: fetchedAt,
        nextRefreshAt,
        refreshIntervalMs,
        sources: sourceStates,
        change,
        error: hasCachedUpdates
          ? `${failedCount} 个官方来源暂时不可用，正在展示最近一次成功缓存。`
          : `${failedCount} 个官方来源暂时不可用，尚无可用缓存。`
      };
      emitCompletion(snapshot.status, false, change);
      return getSnapshot();
    }

    const previousUpdates = snapshot.updates || [];
    const previousUpdateByUrl = new Map(previousUpdates.map((update) => [
      `${update.sourceId}\n${normalizeUrl(update.url)}`,
      update
    ]));
    const freshUpdates = results.flatMap((result) => result.updates).map((update) => {
      const previous = previousUpdateByUrl.get(`${update.sourceId}\n${normalizeUrl(update.url)}`);
      const contentChanged = Boolean(previous?.contentHash && update.contentHash && previous.contentHash !== update.contentHash);
      const next = {
        ...update,
        discoveredAt: previous?.discoveredAt || fetchedAt,
        lastSeenAt: fetchedAt,
        updatedAt: contentChanged ? fetchedAt : previous?.updatedAt || null
      };
      if (contentChanged) next.changeType = 'updated';
      return next;
    });
    const filteredFreshUpdates = freshUpdates.filter((update) => !isStaleAdmissionUpdate(update, fetchedAt));
    const freshKeys = new Set(filteredFreshUpdates.map((update) => `${update.sourceId}\n${normalizeUrl(update.url)}`));
    const missingHistory = previousUpdates
      .filter((update) => successfulSourceIds.has(update.sourceId))
      .filter((update) => !freshKeys.has(`${update.sourceId}\n${normalizeUrl(update.url)}`))
      .map((update) => {
        const { changeType: _transientChangeType, ...historicalUpdate } = update;
        return {
          ...historicalUpdate,
          missingSince: update.missingSince || fetchedAt,
          missCount: (Number.isInteger(update.missCount) ? update.missCount : 0) + 1
        };
      })
      .filter((update) => (
        update.missCount <= 168 && new Date(fetchedAt).getTime() - Date.parse(update.missingSince) <= 90 * 86_400_000
      ));
    const carriedUpdates = previousUpdates.filter((update) => !successfulSourceIds.has(update.sourceId));
    const discoveredUpdates = filteredFreshUpdates.filter((update) => !previousUpdateByUrl.has(`${update.sourceId}\n${normalizeUrl(update.url)}`));
    const discoveryKeys = new Set(discoveredUpdates.map((update) => `${update.sourceId}\n${normalizeUrl(update.url)}`));
    const updates = limitUpdatesWithDiscoveries(
      [...filteredFreshUpdates, ...missingHistory, ...carriedUpdates],
      discoveryKeys,
      MAX_SNAPSHOT_UPDATES
    );
    const retainedDiscoveryKeys = new Set(updates.map((update) => `${update.sourceId}\n${normalizeUrl(update.url)}`));
    const retainedDiscoveries = discoveredUpdates.filter((update) => (
      retainedDiscoveryKeys.has(`${update.sourceId}\n${normalizeUrl(update.url)}`)
    ));
    const newIds = retainedDiscoveries.map((update) => update.id);
    const discardedNewCount = discoveredUpdates.length - retainedDiscoveries.length;
    const updatedIds = filteredFreshUpdates.filter((update) => update.changeType === 'updated').map((update) => update.id);
    const nextSnapshot = {
      schemaVersion: 2,
      status: failedCount === 0 ? 'fresh' : 'stale',
      fetchedAt,
      lastAttemptAt: fetchedAt,
      lastAnySuccessAt: fetchedAt,
      lastAllSuccessAt: failedCount === 0 ? fetchedAt : snapshot.lastAllSuccessAt || null,
      lastSuccessAt: fetchedAt,
      nextRefreshAt,
      refreshIntervalMs,
      sources: sourceStates,
      updates,
      change: {
        newCount: newIds.length,
        newIds,
        updatedCount: updatedIds.length,
        updatedIds,
        changedAt: newIds.length || updatedIds.length ? fetchedAt : snapshot.change?.changedAt || null,
        ...(discardedNewCount > 0 ? { discardedNewCount } : {})
      },
      error: failedCount ? `${failedCount} 个官方来源暂时不可用，已保留其最近缓存。` : null
    };

    snapshot = nextSnapshot;
    let cacheSaved = true;
    try {
      await cacheStore.save(nextSnapshot);
    } catch (error) {
      cacheSaved = false;
      snapshot = { ...nextSnapshot, status: 'stale', error: `最新通知已读取，但本地缓存写入失败：${error.message}` };
    }
    const completedNextRefreshAt = getNextRefreshAt();
    if (snapshot.nextRefreshAt !== completedNextRefreshAt) {
      snapshot = { ...snapshot, nextRefreshAt: completedNextRefreshAt };
    }
    emitCompletion(snapshot.status, cacheSaved, snapshot.change);
    return getSnapshot();
    } catch (error) {
      nextRefreshAt = getNextRefreshAt();
      snapshot = {
        ...snapshot,
        status: snapshot.updates.length ? 'stale' : 'seed',
        fetchedAt,
        lastAttemptAt: fetchedAt,
        nextRefreshAt,
        error: `官方信息刷新失败：${String(error?.message || error).slice(0, 200)}`
      };
      emitCompletion('error', false, {
        newCount: 0,
        updatedCount: 0
      }, error);
      throw error;
    }
  }

  function refresh() {
    if (inFlight) return inFlight;
    inFlight = performRefresh().finally(() => { inFlight = null; });
    return inFlight;
  }

  function refreshIfDue() {
    if (inFlight) return { started: false, promise: inFlight };
    const dueAt = Date.parse(snapshot.nextRefreshAt);
    if (Number.isFinite(dueAt) && new Date(now()).getTime() < dueAt) {
      return { started: false, promise: null };
    }
    return { started: true, promise: refresh() };
  }

  function startAutoRefresh() {
    if (intervalHandle) return intervalHandle;
    nextAutoRefreshAt = new Date(new Date(toIsoDate(now())).getTime() + refreshIntervalMs).toISOString();
    intervalHandle = setIntervalImpl(() => {
      nextAutoRefreshAt = new Date(new Date(toIsoDate(now())).getTime() + refreshIntervalMs).toISOString();
      refresh().catch((error) => {
        if (onRefreshError) {
          try { onRefreshError(error); } catch { /* A logging failure cannot recover a refresh. */ }
        }
      });
    }, refreshIntervalMs);
    intervalHandle.unref?.();
    return intervalHandle;
  }

  function stopAutoRefresh() {
    if (!intervalHandle) return;
    clearIntervalImpl(intervalHandle);
    intervalHandle = null;
    nextAutoRefreshAt = null;
  }

  return {
    getSnapshot,
    initialize,
    refresh,
    refreshIfDue,
    startAutoRefresh,
    stopAutoRefresh
  };
}

module.exports = {
  DEFAULT_REFRESH_INTERVAL_MS,
  createFileCacheStore,
  createUpdateService
};
