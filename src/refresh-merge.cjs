const { PARSER_DIAGNOSTICS_VERSION } = require('./official-scraper.cjs');
const { sanitizeParserDiagnostics } = require('./snapshot-validators.cjs');
const { isStaleAdmissionUpdate } = require('./snapshot-cache.cjs');
const {
  MAX_SNAPSHOT_UPDATES,
  normalizeUrl,
  updateIdentity,
  toSourceObservation,
  limitUpdatesWithDiscoveries
} = require('./update-ranking.cjs');

const MAX_MISSING_REFRESHES = 168;
const MAX_MISSING_AGE_MS = 90 * 86_400_000;

function urlKey(update) {
  return `${update.sourceId}\n${normalizeUrl(update.url)}`;
}

function buildEmptyChange(changedAt = null) {
  return { newCount: 0, newIds: [], updatedCount: 0, updatedIds: [], changedAt };
}

// Last trusted structural baseline per source; null after a parser upgrade.
function buildPriorDiagnosticsBySource(sources, previousSourceById) {
  return new Map(sources.map((source) => {
    const previous = previousSourceById.get(source.id);
    // A different parser can select a different container for identical
    // HTML. Re-establish only that structural baseline after an upgrade;
    // record-count, URL-loss and publication-date checks remain active.
    if (previous?.parserVersion !== PARSER_DIAGNOSTICS_VERSION) return [source.id, null];
    return [source.id, sanitizeParserDiagnostics(previous?.lastTrustedDiagnostics) || sanitizeParserDiagnostics(previous?.diagnostics)];
  }));
}

// Result recorded for a source whose fetch threw before producing a normal result.
function buildFailedSourceResult(source, error, fetchedAt, priorDiagnostics) {
  return {
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
      lastTrustedDiagnostics: priorDiagnostics || null,
      error: String(error?.message || error).slice(0, 160)
    },
    updates: [],
    count: error.refreshTelemetry?.count || 0
  };
}

function buildSourceStates(results, previousSourceById) {
  return results.map((result) => ({
    ...result.source,
    parserVersion: result.source.ok ? PARSER_DIAGNOSTICS_VERSION
      : previousSourceById.get(result.source.id)?.parserVersion ?? null,
    lastTrustedDiagnostics: result.source.ok ? result.source.lastTrustedDiagnostics
      : previousSourceById.get(result.source.id)?.lastTrustedDiagnostics || result.source.lastTrustedDiagnostics,
    lastSuccessAt: result.source.lastSuccessAt || previousSourceById.get(result.source.id)?.lastSuccessAt || null
  }));
}

function buildRefreshEvent({ sources, results, status, cacheSaved, change, completionError, durationMs }) {
  const resultBySourceId = new Map(results.filter(Boolean).map((result) => [result.source.id, result]));
  return {
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
}

// Snapshot fields when no source succeeded: keep the last trusted updates.
function buildAllSourcesFailedSnapshot({ snapshot, previousUpdates, failedCount, fetchedAt, nextRefreshAt, refreshIntervalMs, sourceStates }) {
  const hasCachedUpdates = previousUpdates.length > 0;
  return {
    ...snapshot,
    status: hasCachedUpdates ? 'stale' : 'seed',
    updates: previousUpdates,
    fetchedAt,
    lastAttemptAt: fetchedAt,
    nextRefreshAt,
    refreshIntervalMs,
    sources: sourceStates,
    change: buildEmptyChange(snapshot.change?.changedAt || null),
    error: hasCachedUpdates
      ? `${failedCount} 个官方来源暂时不可用，正在展示最近一次成功缓存。`
      : `${failedCount} 个官方来源暂时不可用，尚无可用缓存。`
  };
}

function annotateFreshUpdates(results, previousUpdateByUrl, fetchedAt) {
  return results.flatMap((result) => result.updates).map((update) => {
    const previous = previousUpdateByUrl.get(urlKey(update));
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
}

// Updates that vanished from a successful source stay visible for a bounded time.
function carryMissingHistory(previousUpdates, successfulSourceIds, freshKeys, fetchedAt) {
  return previousUpdates
    .filter((update) => successfulSourceIds.has(update.sourceId))
    .filter((update) => !freshKeys.has(urlKey(update)))
    .map((update) => {
      const { changeType: _transientChangeType, ...historicalUpdate } = update;
      return {
        ...historicalUpdate,
        missingSince: update.missingSince || fetchedAt,
        missCount: (Number.isInteger(update.missCount) ? update.missCount : 0) + 1
      };
    })
    .filter((update) => (
      update.missCount <= MAX_MISSING_REFRESHES &&
      new Date(fetchedAt).getTime() - Date.parse(update.missingSince) <= MAX_MISSING_AGE_MS
    ));
}

// Merges fresh results with cached history and reports which updates are new or changed.
function mergeRefreshResults({ results, previousUpdates, sourceObservations, successfulSourceIds, fetchedAt }) {
  const previousUpdateByUrl = new Map([...sourceObservations, ...previousUpdates.map((update) => [urlKey(update), update])]);
  const freshUpdates = annotateFreshUpdates(results, previousUpdateByUrl, fetchedAt);
  const filteredFreshUpdates = freshUpdates.filter((update) => !isStaleAdmissionUpdate(update, fetchedAt));
  const freshKeys = new Set(filteredFreshUpdates.map(urlKey));
  const missingHistory = carryMissingHistory(previousUpdates, successfulSourceIds, freshKeys, fetchedAt);
  const carriedUpdates = previousUpdates.filter((update) => !successfulSourceIds.has(update.sourceId));
  const discoveredUpdates = filteredFreshUpdates.filter((update) => !previousUpdateByUrl.has(urlKey(update)));
  const updates = limitUpdatesWithDiscoveries(
    [...filteredFreshUpdates, ...missingHistory, ...carriedUpdates],
    new Set(discoveredUpdates.map(urlKey)),
    MAX_SNAPSHOT_UPDATES
  );
  const retainedKeys = new Set(updates.map(urlKey));
  const retainedDiscoveries = discoveredUpdates.filter((update) => retainedKeys.has(urlKey(update)));
  return {
    updates,
    filteredFreshUpdates,
    previousUpdateByUrl,
    newIds: retainedDiscoveries.map((update) => update.id),
    discardedNewCount: discoveredUpdates.length - retainedDiscoveries.length,
    updatedIds: filteredFreshUpdates.filter((update) => update.changeType === 'updated' &&
      retainedKeys.has(updateIdentity(update))).map((update) => update.id)
  };
}

function buildMergedSnapshot({ snapshot, merged, failedCount, fetchedAt, nextRefreshAt, refreshIntervalMs, sourceStates }) {
  const { newIds, updatedIds, discardedNewCount } = merged;
  return {
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
    updates: merged.updates,
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
}

// Replace successful sources rather than accumulating an unbounded archive;
// failed sources retain their last successful observations for recovery.
function buildNextSourceObservations(merged, successfulSourceIds) {
  return new Map([
    ...[...merged.previousUpdateByUrl].filter(([, update]) => !successfulSourceIds.has(update.sourceId)),
    ...merged.filteredFreshUpdates.map((update) => [updateIdentity(update), toSourceObservation(update)])
  ]);
}

module.exports = {
  buildPriorDiagnosticsBySource,
  buildFailedSourceResult,
  buildSourceStates,
  buildRefreshEvent,
  buildAllSourcesFailedSnapshot,
  mergeRefreshResults,
  buildMergedSnapshot,
  buildNextSourceObservations
};
