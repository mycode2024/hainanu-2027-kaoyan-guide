const fs = require('node:fs/promises');
const path = require('node:path');
const {
  isCacheSnapshotShape
} = require('./snapshot-validators.cjs');

function createCacheError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function readCacheJson(candidatePath) {
  const parsed = JSON.parse(await fs.readFile(candidatePath, 'utf8'));
  if (!isCacheSnapshotShape(parsed)) throw createCacheError('缓存 JSON 结构无效', 'CACHE_INVALID');
  return parsed;
}

// A readable file whose content is not usable (bad JSON or wrong shape).
function isUnusableCacheError(error) {
  return error instanceof SyntaxError || error.code === 'CACHE_INVALID';
}

// Primary file is missing: fall back to the backup, or report no cache at all.
async function loadBackupAfterMissingPrimary(backupPath) {
  try {
    return { cacheSnapshot: await readCacheJson(backupPath), recoveryWarning: '主缓存缺失，已从备份恢复。' };
  } catch (backupError) {
    if (backupError.code === 'ENOENT') return null;
    throw createCacheError('主缓存缺失，且备份缓存已损坏', 'CACHE_CORRUPTION');
  }
}

// Primary file exists but is unusable: recover from the backup or report corruption.
async function loadBackupAfterCorruptPrimary(backupPath) {
  try {
    return { cacheSnapshot: await readCacheJson(backupPath), recoveryWarning: '主缓存损坏，已从备份恢复。' };
  } catch {
    throw createCacheError('本地缓存及备份均已损坏', 'CACHE_CORRUPTION');
  }
}

async function loadCache(resolvedPath, backupPath) {
  try {
    return await readCacheJson(resolvedPath);
  } catch (primaryError) {
    if (primaryError.code === 'ENOENT') return loadBackupAfterMissingPrimary(backupPath);
    if (!isUnusableCacheError(primaryError)) throw primaryError;
    return loadBackupAfterCorruptPrimary(backupPath);
  }
}

// Only a currently valid primary file is worth keeping as the backup.
async function isPrimaryCacheValid(resolvedPath) {
  try {
    await readCacheJson(resolvedPath);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT' && !isUnusableCacheError(error)) throw error;
    return false;
  }
}

async function saveCache(value, resolvedPath, backupPath, renameImpl) {
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  const temporaryPath = `${resolvedPath}.${process.pid}.tmp`;
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  JSON.parse(serialized);
  await fs.writeFile(temporaryPath, serialized, 'utf8');
  try {
    if (await isPrimaryCacheValid(resolvedPath)) await fs.copyFile(resolvedPath, backupPath);
    await renameImpl(temporaryPath, resolvedPath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function createFileCacheStore(filePath, options = {}) {
  const resolvedPath = path.resolve(filePath);
  const backupPath = `${resolvedPath}.bak`;
  const renameImpl = options.renameImpl || fs.rename;

  return {
    load: () => loadCache(resolvedPath, backupPath),
    save: (value) => saveCache(value, resolvedPath, backupPath, renameImpl)
  };
}

module.exports = {
  createFileCacheStore
};
