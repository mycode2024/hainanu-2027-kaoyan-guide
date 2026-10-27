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

/**
 * Keeps an in-memory snapshot of the official admission notices fresh.
 *
 * Loads the persisted cache on first use, fetches and parses every configured source
 * (with one retry for transient failures), verifies publication dates, merges the
 * results with cached history, persists the new snapshot and reports completion events.
 * Concurrent refreshes share one in-flight run, and a failed refresh never discards the
 * last trusted snapshot. All collaborators (fetch, clock, timers, cache) are injectable
 * for tests. Created through createUpdateService, which exposes bound public methods.
 */
class UpdateService {
  /**
   * @param {object} options Injectable configuration (sources, fetchImpl, cacheStore, now, intervals, hooks).
   */
  constructor(options = {}) {
    this._sources = Array.isArray(options.sources) ? options.sources.slice() : [];
    this._fetchImpl = options.fetchImpl || globalThis.fetch;
    this._cacheStore = options.cacheStore || { load: async () => null, save: async () => {} };
    this._now = options.now || (() => new Date());
    this._refreshIntervalMs = Number.isFinite(options.refreshIntervalMs)
      ? options.refreshIntervalMs
      : DEFAULT_REFRESH_INTERVAL_MS;
    this._requestTimeoutMs = Number.isFinite(options.requestTimeoutMs)
      ? options.requestTimeoutMs
      : DEFAULT_TIMEOUT_MS;
    this._retryDelayMs = Number.isFinite(options.retryDelayMs)
      ? options.retryDelayMs
      : DEFAULT_RETRY_DELAY_MS;
    this._delayImpl = options.delayImpl || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this._randomImpl = options.randomImpl || Math.random;
    this._setIntervalImpl = options.setIntervalImpl || setInterval;
    this._clearIntervalImpl = options.clearIntervalImpl || clearInterval;
    this._onRefreshEvent = typeof options.onRefreshEvent === 'function' ? options.onRefreshEvent : null;
    this._onRefreshError = typeof options.onRefreshError === 'function' ? options.onRefreshError : null;
    this._parseDocument = typeof options.parseDocument === 'function' ? options.parseDocument : parseOfficialDocument;

    if (typeof this._fetchImpl !== 'function') throw new TypeError('A fetch implementation is required');

    this._snapshot = makeSeedSnapshot(this._sources, this._refreshIntervalMs, this._now());
    // The display cap must not erase discovery history for an unchanged source list.
    // Keep compact observations of each source's latest successful list separately.
    this._sourceObservations = new Map();
    this._initializationPromise = null;
    this._inFlight = null;
    this._intervalHandle = null;
    this._nextAutoRefreshAt = null;
  }

  _getNextRefreshAt() {
    const currentTime = Date.parse(toIsoDate(this._now()));
    const fallbackNextRefreshAt = new Date(currentTime + this._refreshIntervalMs).toISOString();
    const autoDeadline = Date.parse(this._nextAutoRefreshAt || '');
    return Number.isFinite(autoDeadline) && autoDeadline > currentTime
      ? this._nextAutoRefreshAt
      : fallbackNextRefreshAt;
  }

  /** @returns {object} The current snapshot with per-source freshness derived at call time. */
  getSnapshot() {
    const derived = addFreshness(this._snapshot, this._now(), this._refreshIntervalMs);
    return {
      ...this._snapshot,
      sources: derived.sources,
      freshness: derived.freshness
    };
  }

  /** Loads and sanitizes the persisted cache once; later calls share the same promise. */
  initialize() {
    if (this._initializationPromise) return this._initializationPromise;
    this._initializationPromise = (async () => {
      try {
        const loaded = await this._cacheStore.load();
        const cached = loaded?.cacheSnapshot || loaded;
        const sanitized = sanitizeCachedSnapshot(cached, this._sources, this._refreshIntervalMs, this._now());
        if (sanitized) {
          this._sourceObservations = new Map(readSourceObservations(cached.sourceObservations, this._sources)
            .map(update => [updateIdentity(update), update]));
          this._snapshot = loaded?.recoveryWarning
            ? { ...sanitized, error: String(loaded.recoveryWarning).slice(0, 240) }
            : sanitized;
        }
      } catch (error) {
        this._snapshot = { ...this._snapshot, error: `读取本地缓存失败：${error.message}` };
      }
      return this._snapshot;
    })();
    return this._initializationPromise;
  }

  async _fetchSourceOnce(source, checkedAt, priorUpdates, priorDiagnostics) {
    let attemptedDiagnostics = null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._requestTimeoutMs);
    timer.unref?.();

    try {
      const readOfficialHtml = (url) => fetchOfficialHtml({
        url, source, fetchImpl: this._fetchImpl, signal: controller.signal, checkedAt, retryDelayMs: this._retryDelayMs
      });
      const page = await readOfficialHtml(source.url);
      const parsed = this._parseDocument(page.html, source, checkedAt, page.url);
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

  // Honors Retry-After when present, otherwise the base delay plus up to 250ms of jitter.
  _computeRetryDelayMs(result) {
    return Number.isFinite(result.retryAfterMs)
      ? result.retryAfterMs
      : this._retryDelayMs + Math.min(250, Math.max(0, Math.floor(Number(this._randomImpl()) * 251) || 0));
  }

  // Waits before the retry; if waiting itself fails, attaches telemetry so the failure is still reported.
  async _waitBeforeRetry(result, attempts, delayMs) {
    try {
      await this._delayImpl(delayMs);
    } catch (error) {
      error.refreshTelemetry = {
        attempts,
        count: Number.isInteger(result.count) ? result.count : result.updates.length,
        degraded: result.degraded === true,
        retryDelayMs: delayMs,
        diagnostics: result.diagnostics || null
      };
      throw error;
    }
  }

  async _fetchSource(source, checkedAt, priorUpdates, priorDiagnostics) {
    let attempts = 0;
    let result;
    let actualRetryDelayMs = 0;
    while (attempts < 2) {
      attempts += 1;
      result = await this._fetchSourceOnce(source, checkedAt, priorUpdates, priorDiagnostics);
      if (result.ok || !result.retryable || attempts >= 2) break;
      actualRetryDelayMs = this._computeRetryDelayMs(result);
      await this._waitBeforeRetry(result, attempts, actualRetryDelayMs);
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
  async _fetchAllSources(results, fetchedAt, previousUpdates, priorDiagnosticsBySource) {
    const settlements = await Promise.allSettled(this._sources.map(async (source, index) => {
      try {
        results[index] = await this._fetchSource(
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

  async _saveMergedSnapshot(nextSnapshot) {
    try {
      await this._cacheStore.save({
        ...nextSnapshot,
        sourceObservations: [...this._sourceObservations.values()].map(toSourceObservation)
      });
      return true;
    } catch (error) {
      this._snapshot = { ...nextSnapshot, status: 'stale', error: `最新通知已读取，但本地缓存写入失败：${error.message}` };
      return false;
    }
  }

  // Returns a function that emits the refresh-complete event at most once per refresh.
  _createCompletionEmitter(attemptDate, getResults) {
    let completionEmitted = false;
    return (status, cacheSaved, change, completionError = null) => {
      if (completionEmitted) return;
      completionEmitted = true;
      if (!this._onRefreshEvent) return;
      const durationMs = Math.max(0, new Date(this._now()).getTime() - new Date(attemptDate).getTime());
      const event = buildRefreshEvent({
        sources: this._sources, results: getResults(), status, cacheSaved, change, completionError, durationMs
      });
      try {
        Promise.resolve(this._onRefreshEvent(event)).catch(() => {});
      } catch {
        // Observability must never make trusted data unavailable.
      }
    };
  }

  // Commits fetched results to the snapshot, persists them and reports completion.
  async _applyRefreshResults({ results, previousUpdates, previousSourceById, fetchedAt, emitCompletion }) {
    const nextRefreshAt = this._getNextRefreshAt();
    const refreshIntervalMs = this._refreshIntervalMs;
    const successfulSourceIds = new Set(results.filter((result) => result.source.ok).map((result) => result.source.id));
    const failedCount = results.length - successfulSourceIds.size;
    const sourceStates = buildSourceStates(results, previousSourceById);

    if (successfulSourceIds.size === 0) {
      this._snapshot = buildAllSourcesFailedSnapshot({
        snapshot: this._snapshot, previousUpdates, failedCount, fetchedAt, nextRefreshAt, refreshIntervalMs, sourceStates
      });
      emitCompletion(this._snapshot.status, false, this._snapshot.change);
      return this.getSnapshot();
    }

    const merged = mergeRefreshResults({
      results, previousUpdates, sourceObservations: this._sourceObservations, successfulSourceIds, fetchedAt
    });
    const nextSnapshot = buildMergedSnapshot({
      snapshot: this._snapshot, merged, failedCount, fetchedAt, nextRefreshAt, refreshIntervalMs, sourceStates
    });
    this._snapshot = nextSnapshot;
    this._sourceObservations = buildNextSourceObservations(merged, successfulSourceIds);
    const cacheSaved = await this._saveMergedSnapshot(nextSnapshot);
    const completedNextRefreshAt = this._getNextRefreshAt();
    if (this._snapshot.nextRefreshAt !== completedNextRefreshAt) {
      this._snapshot = { ...this._snapshot, nextRefreshAt: completedNextRefreshAt };
    }
    emitCompletion(this._snapshot.status, cacheSaved, this._snapshot.change);
    return this.getSnapshot();
  }

  // Keeps the last trusted updates visible after an unexpected refresh failure.
  _recordRefreshFailure(error, previousUpdates, fetchedAt, emitCompletion) {
    this._snapshot = {
      ...this._snapshot,
      status: previousUpdates.length ? 'stale' : 'seed',
      updates: previousUpdates,
      fetchedAt,
      lastAttemptAt: fetchedAt,
      nextRefreshAt: this._getNextRefreshAt(),
      error: `官方信息刷新失败：${String(error?.message || error).slice(0, 200)}`
    };
    emitCompletion('error', false, {
      newCount: 0,
      updatedCount: 0
    }, error);
  }

  async _performRefresh() {
    await this.initialize();
    const attemptDate = this._now();
    const fetchedAt = toIsoDate(attemptDate);
    // Time-based expiry applies to all cached paths, including failed sources.
    // Expired records must not be mistaken for disappearing upstream links.
    const previousUpdates = (this._snapshot.updates || []).filter(update => !isStaleAdmissionUpdate(update, fetchedAt));
    let results = [];
    const emitCompletion = this._createCompletionEmitter(attemptDate, () => results);

    try {
      const previousSourceById = new Map((this._snapshot.sources || []).map((source) => [source.id, source]));
      results = new Array(this._sources.length);
      await this._fetchAllSources(
        results, fetchedAt, previousUpdates, buildPriorDiagnosticsBySource(this._sources, previousSourceById)
      );
      return await this._applyRefreshResults({ results, previousUpdates, previousSourceById, fetchedAt, emitCompletion });
    } catch (error) {
      this._recordRefreshFailure(error, previousUpdates, fetchedAt, emitCompletion);
      throw error;
    }
  }

  /** Runs a refresh, or joins the one already in flight. */
  refresh() {
    if (this._inFlight) return this._inFlight;
    this._inFlight = this._performRefresh().finally(() => { this._inFlight = null; });
    return this._inFlight;
  }

  /** Starts a refresh only when the snapshot's next refresh time has passed. */
  refreshIfDue() {
    if (this._inFlight) return { started: false, promise: this._inFlight };
    const dueAt = Date.parse(this._snapshot.nextRefreshAt);
    if (Number.isFinite(dueAt) && new Date(this._now()).getTime() < dueAt) {
      return { started: false, promise: null };
    }
    return { started: true, promise: this.refresh() };
  }

  _scheduleNextAutoRefreshAt() {
    this._nextAutoRefreshAt = new Date(new Date(toIsoDate(this._now())).getTime() + this._refreshIntervalMs).toISOString();
  }

  /** Starts the periodic background refresh (idempotent) and returns the timer handle. */
  startAutoRefresh() {
    if (this._intervalHandle) return this._intervalHandle;
    this._scheduleNextAutoRefreshAt();
    this._intervalHandle = this._setIntervalImpl(() => {
      this._scheduleNextAutoRefreshAt();
      this.refresh().catch((error) => {
        if (this._onRefreshError) {
          try { this._onRefreshError(error); } catch { /* A logging failure cannot recover a refresh. */ }
        }
      });
    }, this._refreshIntervalMs);
    this._intervalHandle.unref?.();
    return this._intervalHandle;
  }

  /** Stops the periodic background refresh. */
  stopAutoRefresh() {
    if (!this._intervalHandle) return;
    this._clearIntervalImpl(this._intervalHandle);
    this._intervalHandle = null;
    this._nextAutoRefreshAt = null;
  }
}

function createUpdateService(options = {}) {
  const service = new UpdateService(options);
  return {
    getSnapshot: () => service.getSnapshot(),
    initialize: () => service.initialize(),
    refresh: () => service.refresh(),
    refreshIfDue: () => service.refreshIfDue(),
    startAutoRefresh: () => service.startAutoRefresh(),
    stopAutoRefresh: () => service.stopAutoRefresh()
  };
}

module.exports = {
  DEFAULT_REFRESH_INTERVAL_MS,
  createFileCacheStore,
  createUpdateService
};
