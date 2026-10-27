const {
  PARSER_DIAGNOSTICS_VERSION,
  parseOfficialDocument
} = require('./official-scraper.cjs');
const { createFileCacheStore } = require('./file-cache-store.cjs');
const {
  MAX_SNAPSHOT_UPDATES,
  addFreshness,
  normalizeUrl,
  updateIdentity,
  toSourceObservation,
  readSourceObservations,
  detectSuspiciousDrift,
  detectDiagnosticDrift,
  limitUpdatesWithDiscoveries
} = require('./update-ranking.cjs');
const {
  toIsoDate,
  sanitizeParserDiagnostics
} = require('./snapshot-validators.cjs');
const {
  makeSeedSnapshot,
  isStaleAdmissionUpdate,
  sanitizeCachedSnapshot
} = require('./snapshot-cache.cjs');
const {
  fetchOfficialHtml,
  buildDegradedResult,
  buildNoNoticesError,
  verifyUpdatePublicationDates
} = require('./official-fetch.cjs');

const DEFAULT_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

const DEFAULT_TIMEOUT_MS = 12_000;

const DEFAULT_RETRY_DELAY_MS = 750;

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
  // The display cap must not erase discovery history for an unchanged source list.
  // Keep compact observations of each source's latest successful list separately.
  let sourceObservations = new Map();
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
          sourceObservations = new Map(readSourceObservations(cached.sourceObservations, sources)
            .map(update => [updateIdentity(update), update]));
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
      const readOfficialHtml = (url) => fetchOfficialHtml({
        url, source, fetchImpl, signal: controller.signal, checkedAt, retryDelayMs
      });
      const page = await readOfficialHtml(source.url);
      const parsed = parseDocument(page.html, source, checkedAt, page.url);
      let updates = Array.isArray(parsed?.updates) ? parsed.updates : null;
      attemptedDiagnostics = sanitizeParserDiagnostics(parsed?.diagnostics, updates?.length);
      if (!updates || !attemptedDiagnostics) {
        return buildDegradedResult({
          count: Array.isArray(updates) ? updates.length : 0,
          diagnostics: attemptedDiagnostics,
          error: '解析诊断结构或计数异常，可能是官网页面结构已变化',
          retryable: true
        });
      }
      if (updates.length === 0) throw buildNoNoticesError(attemptedDiagnostics);
      updates = await verifyUpdatePublicationDates(updates, readOfficialHtml, checkedAt);
      attemptedDiagnostics = { ...attemptedDiagnostics, relevantCount: updates.length };
      if (updates.length === 0) throw buildNoNoticesError(attemptedDiagnostics);
      const diagnosticDriftReason = detectDiagnosticDrift(priorDiagnostics, attemptedDiagnostics);
      if (diagnosticDriftReason) {
        return buildDegradedResult({
          count: updates.length, diagnostics: attemptedDiagnostics, error: diagnosticDriftReason, retryable: false
        });
      }
      const driftReason = detectSuspiciousDrift(priorUpdates, updates, checkedAt);
      if (driftReason) {
        return buildDegradedResult({
          count: updates.length, diagnostics: attemptedDiagnostics, error: driftReason, retryable: true
        });
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
    // Time-based expiry applies to all cached paths, including failed sources.
    // Expired records must not be mistaken for disappearing upstream links.
    const previousUpdates = (snapshot.updates || []).filter(update => !isStaleAdmissionUpdate(update, fetchedAt));
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
        previousUpdates.filter((update) => update.sourceId === source.id)
      ]));
      const previousSourceById = new Map((snapshot.sources || []).map((source) => [source.id, source]));
      const priorDiagnosticsBySource = new Map(sources.map((source) => {
        const previous = previousSourceById.get(source.id);
        // A different parser can select a different container for identical
        // HTML. Re-establish only that structural baseline after an upgrade;
        // record-count, URL-loss and publication-date checks remain active.
        if (previous?.parserVersion !== PARSER_DIAGNOSTICS_VERSION) return [source.id, null];
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
      parserVersion: result.source.ok ? PARSER_DIAGNOSTICS_VERSION
        : previousSourceById.get(result.source.id)?.parserVersion ?? null,
      lastTrustedDiagnostics: result.source.ok ? result.source.lastTrustedDiagnostics
        : previousSourceById.get(result.source.id)?.lastTrustedDiagnostics || result.source.lastTrustedDiagnostics,
      lastSuccessAt: result.source.lastSuccessAt || previousSourceById.get(result.source.id)?.lastSuccessAt || null
    }));

    if (successfulSourceIds.size === 0) {
      const hasCachedUpdates = previousUpdates.length > 0;
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
        updates: previousUpdates,
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

    const previousUpdateByUrl = new Map([...sourceObservations, ...previousUpdates.map((update) => [
      `${update.sourceId}\n${normalizeUrl(update.url)}`,
      update
    ])]);
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
    const updatedIds = filteredFreshUpdates.filter((update) => update.changeType === 'updated' &&
      retainedDiscoveryKeys.has(updateIdentity(update))).map((update) => update.id);
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
    // Replace successful sources rather than accumulating an unbounded archive;
    // failed sources retain their last successful observations for recovery.
    sourceObservations = new Map([
      ...[...previousUpdateByUrl].filter(([, update]) => !successfulSourceIds.has(update.sourceId)),
      ...filteredFreshUpdates.map(update => [updateIdentity(update), toSourceObservation(update)])
    ]);
    let cacheSaved = true;
    try {
      await cacheStore.save({ ...nextSnapshot, sourceObservations: [...sourceObservations.values()].map(toSourceObservation) });
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
        status: previousUpdates.length ? 'stale' : 'seed',
        updates: previousUpdates,
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
