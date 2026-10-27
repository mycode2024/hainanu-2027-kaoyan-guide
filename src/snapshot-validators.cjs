function toIsoDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function isValidIsoDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isValidPublicationDate(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function getShanghaiDate(value) {
  return new Date(Date.parse(value) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
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

module.exports = {
  toIsoDate,
  isValidIsoDate,
  isValidPublicationDate,
  getShanghaiDate,
  isCacheSnapshotShape,
  sanitizeParserDiagnostics
};
