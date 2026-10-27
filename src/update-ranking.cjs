const {
  isAllowedOfficialUrl
} = require('./official-scraper.cjs');
const {
  isValidIsoDate,
  sanitizeParserDiagnostics
} = require('./snapshot-validators.cjs');

const MAX_SNAPSHOT_UPDATES = 120;

const DRIFT_RECENT_WINDOW_MS = 90 * 86_400_000;

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

function toSourceObservation(update) {
  return {
    sourceId: update.sourceId,
    url: normalizeUrl(update.url),
    discoveredAt: update.discoveredAt,
    contentHash: typeof update.contentHash === 'string' ? update.contentHash : '',
    updatedAt: isValidIsoDate(update.updatedAt) ? update.updatedAt : null
  };
}

function readSourceObservations(value, sources) {
  const sourceById = new Map(sources.map(source => [source.id, source]));
  return (Array.isArray(value) ? value : [])
    .filter(update => update && typeof update === 'object' &&
      sourceById.has(update.sourceId) && typeof update.url === 'string' &&
      isAllowedOfficialUrl(update.url, sourceById.get(update.sourceId)) &&
      isValidIsoDate(update.discoveredAt))
    .map(toSourceObservation);
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

module.exports = {
  MAX_SNAPSHOT_UPDATES,
  DRIFT_RECENT_WINDOW_MS,
  getSourceFreshness,
  addFreshness,
  normalizeUrl,
  updateIdentity,
  toSourceObservation,
  readSourceObservations,
  rankUpdates,
  detectSuspiciousDrift,
  detectDiagnosticDrift,
  limitUpdatesWithDiscoveries
};
