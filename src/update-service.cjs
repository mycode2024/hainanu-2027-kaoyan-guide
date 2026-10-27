const { parseOfficialDocument } = require('./official-scraper.cjs');
const { createFileCacheStore } = require('./file-cache-store.cjs');
const {
  buildPriorDiagnosticsBySource,
  buildFailedSourceResult,
  buildSourceStates,
  buildRefreshEvent,
  buildAllSourcesFailedSnapshot,
  mergeRefreshResults,
  buildMergedSnapshot,
  buildNextSourceObservations
} = require('./refresh-merge.cjs');
const {
  addFreshness,
  updateIdentity,
  toSourceObservation,
  readSourceObservations,
  detectSuspiciousDrift,
  detectDiagnosticDrift
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
  buildFetchFailureResult,
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
      return buildFetchFailureResult(error, attemptedDiagnostics);
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

  // Fills the caller-owned results so a fatal failure still reports every source it reached.
  async function fetchAllSources(results, fetchedAt, previousUpdates, priorDiagnosticsBySource) {
    const settlements = await Promise.allSettled(sources.map(async (source, index) => {
      try {
        results[index] = await fetchSource(
          source,
          fetchedAt,
          previousUpdates.filter((update) => update.sourceId === source.id),
          priorDiagnosticsBySource.get(source.id)
        );
      } catch (error) {
        results[index] = buildFailedSourceResult(source, error, fetchedAt, priorDiagnosticsBySource.get(source.id));
        throw error;
      }
    }));
    const fatalSettlement = settlements.find((settlement) => settlement.status === 'rejected');
    if (fatalSettlement) throw fatalSettlement.reason;
  }

  async function saveMergedSnapshot(nextSnapshot) {
    try {
      await cacheStore.save({ ...nextSnapshot, sourceObservations: [...sourceObservations.values()].map(toSourceObservation) });
      return true;
    } catch (error) {
      snapshot = { ...nextSnapshot, status: 'stale', error: `最新通知已读取，但本地缓存写入失败：${error.message}` };
      return false;
    }
  }

  // Returns a function that emits the refresh-complete event at most once per refresh.
  function createCompletionEmitter(attemptDate, getResults) {
    let completionEmitted = false;
    return function emitCompletion(status, cacheSaved, change, completionError = null) {
      if (completionEmitted) return;
      completionEmitted = true;
      if (!onRefreshEvent) return;
      const durationMs = Math.max(0, new Date(now()).getTime() - new Date(attemptDate).getTime());
      const event = buildRefreshEvent({ sources, results: getResults(), status, cacheSaved, change, completionError, durationMs });
      try {
        Promise.resolve(onRefreshEvent(event)).catch(() => {});
      } catch {
        // Observability must never make trusted data unavailable.
      }
    };
  }

  // Commits fetched results to the snapshot, persists them and reports completion.
  async function applyRefreshResults({ results, previousUpdates, previousSourceById, fetchedAt, emitCompletion }) {
    const nextRefreshAt = getNextRefreshAt();
    const successfulSourceIds = new Set(results.filter((result) => result.source.ok).map((result) => result.source.id));
    const failedCount = results.length - successfulSourceIds.size;
    const sourceStates = buildSourceStates(results, previousSourceById);

    if (successfulSourceIds.size === 0) {
      snapshot = buildAllSourcesFailedSnapshot({
        snapshot, previousUpdates, failedCount, fetchedAt, nextRefreshAt, refreshIntervalMs, sourceStates
      });
      emitCompletion(snapshot.status, false, snapshot.change);
      return getSnapshot();
    }

    const merged = mergeRefreshResults({ results, previousUpdates, sourceObservations, successfulSourceIds, fetchedAt });
    const nextSnapshot = buildMergedSnapshot({
      snapshot, merged, failedCount, fetchedAt, nextRefreshAt, refreshIntervalMs, sourceStates
    });
    snapshot = nextSnapshot;
    sourceObservations = buildNextSourceObservations(merged, successfulSourceIds);
    const cacheSaved = await saveMergedSnapshot(nextSnapshot);
    const completedNextRefreshAt = getNextRefreshAt();
    if (snapshot.nextRefreshAt !== completedNextRefreshAt) {
      snapshot = { ...snapshot, nextRefreshAt: completedNextRefreshAt };
    }
    emitCompletion(snapshot.status, cacheSaved, snapshot.change);
    return getSnapshot();
  }

  // Keeps the last trusted updates visible after an unexpected refresh failure.
  function recordRefreshFailure(error, previousUpdates, fetchedAt, emitCompletion) {
    snapshot = {
      ...snapshot,
      status: previousUpdates.length ? 'stale' : 'seed',
      updates: previousUpdates,
      fetchedAt,
      lastAttemptAt: fetchedAt,
      nextRefreshAt: getNextRefreshAt(),
      error: `官方信息刷新失败：${String(error?.message || error).slice(0, 200)}`
    };
    emitCompletion('error', false, {
      newCount: 0,
      updatedCount: 0
    }, error);
  }

  async function performRefresh() {
    await initialize();
    const attemptDate = now();
    const fetchedAt = toIsoDate(attemptDate);
    // Time-based expiry applies to all cached paths, including failed sources.
    // Expired records must not be mistaken for disappearing upstream links.
    const previousUpdates = (snapshot.updates || []).filter(update => !isStaleAdmissionUpdate(update, fetchedAt));
    let results = [];
    const emitCompletion = createCompletionEmitter(attemptDate, () => results);

    try {
      const previousSourceById = new Map((snapshot.sources || []).map((source) => [source.id, source]));
      results = new Array(sources.length);
      await fetchAllSources(results, fetchedAt, previousUpdates, buildPriorDiagnosticsBySource(sources, previousSourceById));
      return await applyRefreshResults({ results, previousUpdates, previousSourceById, fetchedAt, emitCompletion });
    } catch (error) {
      recordRefreshFailure(error, previousUpdates, fetchedAt, emitCompletion);
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
