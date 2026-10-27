const {
  isAllowedOfficialUrl,
  isRelevantAdmissionCycle
} = require('./official-scraper.cjs');
const {
  MAX_SNAPSHOT_UPDATES,
  rankUpdates
} = require('./update-ranking.cjs');
const {
  toIsoDate,
  isValidIsoDate,
  isValidPublicationDate,
  getShanghaiDate,
  sanitizeParserDiagnostics
} = require('./snapshot-validators.cjs');

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
      parserVersion: null,
      diagnostics: null,
      lastTrustedDiagnostics: null,
      error: null
    })),
    updates: [],
    change: { newCount: 0, newIds: [], updatedCount: 0, updatedIds: [], changedAt: null },
    error: null
  };
}

function isStaleAdmissionUpdate(update, referenceDate) {
  return !isRelevantAdmissionCycle(update?.title || '', update?.date, referenceDate);
}

function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeCachedUpdate(update, seedFetchedAt, cacheSuccessTime) {
  const publicationDate = trimmedString(update.date);
  const publicationFallback = isValidPublicationDate(publicationDate)
    ? `${publicationDate}T00:00:00.000Z`
    : seedFetchedAt;
  return {
    id: trimmedString(update.id),
    contentHash: trimmedString(update.contentHash),
    title: trimmedString(update.title),
    date: publicationDate,
    dateVerified: update.dateVerified === true,
    url: trimmedString(update.url),
    source: trimmedString(update.source),
    sourceId: trimmedString(update.sourceId),
    category: trimmedString(update.category) || '招生动态',
    isTarget2027: update.isTarget2027 === true,
    isImportant: update.isImportant === true,
    discoveredAt: isValidIsoDate(update.discoveredAt) ? update.discoveredAt : cacheSuccessTime || publicationFallback,
    lastSeenAt: isValidIsoDate(update.lastSeenAt) ? update.lastSeenAt : null,
    updatedAt: isValidIsoDate(update.updatedAt) ? update.updatedAt : null,
    missingSince: isValidIsoDate(update.missingSince) ? update.missingSince : null,
    missCount: Number.isInteger(update.missCount) && update.missCount > 0 ? update.missCount : 0
  };
}

function sanitizeCachedUpdates(value, sources, seed, cacheSuccessTime) {
  const todayInShanghai = getShanghaiDate(seed.fetchedAt);
  const allowedSourceIds = new Set(sources.map((source) => source.id));
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  return value.updates
    .filter((update) => update && typeof update === 'object')
    // Legacy homepage cache guessed years from MM-DD; do not serve it as trusted history.
    .filter((update) => sourceById.get(update.sourceId)?.context !== 'hnu-home' || update.dateVerified === true)
    .map((update) => sanitizeCachedUpdate(update, seed.fetchedAt, cacheSuccessTime))
    .filter((update) => (
      update.id && update.title && isValidPublicationDate(update.date) && update.date <= todayInShanghai &&
      update.source && allowedSourceIds.has(update.sourceId) &&
      isAllowedOfficialUrl(update.url, sourceById.get(update.sourceId)) &&
      !isStaleAdmissionUpdate(update, seed.fetchedAt)
    ));
}

// Restoring a cache must not reset its age. Bound legacy or corrupt deadlines
// by the configured interval after the last known attempt, not startup time.
function inferCachedNextRefreshAt(value, cacheSuccessTime, seedFetchedAt, refreshIntervalMs) {
  const lastCheckedAt = [value.lastAttemptAt, value.fetchedAt, cacheSuccessTime].find(isValidIsoDate);
  const nowMs = Date.parse(seedFetchedAt);
  const lastCheckedMs = Date.parse(lastCheckedAt);
  const inferredDeadline = Number.isFinite(lastCheckedMs) && lastCheckedMs <= nowMs
    ? lastCheckedMs + refreshIntervalMs : nowMs;
  return new Date(Math.min(inferredDeadline,
    isValidIsoDate(value.nextRefreshAt) ? Date.parse(value.nextRefreshAt) : inferredDeadline)).toISOString();
}

function sanitizeCachedSources(value, seedSources) {
  const allowedSourceIds = new Set(seedSources.map((source) => source.id));
  const cachedSourceById = new Map(
    (Array.isArray(value.sources) ? value.sources : [])
      .filter((source) => source && allowedSourceIds.has(source.id))
      .map((source) => [source.id, source])
  );
  return seedSources.map((source) => {
    const cached = cachedSourceById.get(source.id);
    const diagnostics = sanitizeParserDiagnostics(cached?.diagnostics);
    const lastTrustedDiagnostics = sanitizeParserDiagnostics(cached?.lastTrustedDiagnostics) || diagnostics;
    return {
      ...source,
      lastSuccessAt: isValidIsoDate(cached?.lastSuccessAt) ? cached.lastSuccessAt : null,
      parserVersion: Number.isInteger(cached?.parserVersion) && cached.parserVersion > 0 ? cached.parserVersion : null,
      diagnostics,
      lastTrustedDiagnostics
    };
  });
}

function sanitizeCachedSnapshot(value, sources, refreshIntervalMs, date) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.updates)) return null;
  const seed = makeSeedSnapshot(sources, refreshIntervalMs, date);
  const cacheSuccessTime = isValidIsoDate(value.lastAnySuccessAt)
    ? value.lastAnySuccessAt
    : isValidIsoDate(value.lastSuccessAt) ? value.lastSuccessAt : null;
  const updates = sanitizeCachedUpdates(value, sources, seed, cacheSuccessTime);

  return {
    ...seed,
    status: updates.length ? 'stale' : 'seed',
    fetchedAt: isValidIsoDate(value.fetchedAt) ? value.fetchedAt : seed.fetchedAt,
    lastAttemptAt: isValidIsoDate(value.lastAttemptAt) ? value.lastAttemptAt : null,
    lastAnySuccessAt: cacheSuccessTime,
    lastAllSuccessAt: isValidIsoDate(value.lastAllSuccessAt) ? value.lastAllSuccessAt : null,
    lastSuccessAt: cacheSuccessTime,
    nextRefreshAt: inferCachedNextRefreshAt(value, cacheSuccessTime, seed.fetchedAt, refreshIntervalMs),
    sources: sanitizeCachedSources(value, seed.sources),
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

module.exports = {
  makeSeedSnapshot,
  isStaleAdmissionUpdate,
  trimmedString,
  sanitizeCachedUpdate,
  sanitizeCachedUpdates,
  inferCachedNextRefreshAt,
  sanitizeCachedSources,
  sanitizeCachedSnapshot
};
