const fs = require('node:fs/promises');
const path = require('node:path');
const {
  isCacheSnapshotShape
} = require('./snapshot-validators.cjs');

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

module.exports = {
  createFileCacheStore
};
