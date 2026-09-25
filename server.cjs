const path = require('node:path');
const { createHttpServer } = require('./src/http-app.cjs');
const {
  DEFAULT_REFRESH_INTERVAL_MS,
  createFileCacheStore,
  createUpdateService
} = require('./src/update-service.cjs');

const OFFICIAL_SOURCES = [
  {
    id: 'hnu-graduate',
    name: '海南大学研究生院',
    url: 'https://gs.hainanu.edu.cn/yjszs/ssszs.htm',
    allowedHosts: ['hainanu.edu.cn'],
    context: 'hnu-master'
  },
  {
    id: 'hnu-graduate-home',
    name: '海南大学研究生院首页',
    url: 'https://gs.hainanu.edu.cn/',
    allowedHosts: ['hainanu.edu.cn'],
    context: 'hnu-home'
  },
  {
    id: 'hnu-computer',
    name: '海南大学计算机科学与技术学院',
    url: 'https://cs.hainanu.edu.cn/zsgz/yjszs.htm',
    allowedHosts: ['hainanu.edu.cn'],
    context: 'hnu-computer'
  },
  {
    id: 'chsi-ministry-policy',
    name: '研招网 · 教育部政策',
    url: 'https://yz.chsi.com.cn/kyzx/jybzc/',
    allowedHosts: ['yz.chsi.com.cn'],
    context: 'national-policy'
  }
];

function formatRefreshLog(event) {
  return JSON.stringify({ event: 'official-refresh', ...event });
}

async function startServer(options = {}) {
  const siteRoot = path.resolve(options.siteRoot || __dirname);
  const requestedPort = Number(options.port ?? process.env.PORT ?? 4173);
  const port = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65_535
    ? requestedPort
    : 4173;
  const host = options.host || '127.0.0.1';
  const updateService = options.updateService || createUpdateService({
    sources: OFFICIAL_SOURCES,
    cacheStore: createFileCacheStore(path.join(siteRoot, 'data', 'updates-cache.json')),
    refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
    onRefreshEvent(event) {
      console.log(formatRefreshLog(event));
    },
    onRefreshError(error) {
      console.error(formatRefreshLog({
        type: 'refresh-failed',
        status: 'error',
        error: String(error?.message || error).slice(0, 240)
      }));
    }
  });

  await updateService.initialize();
  const server = createHttpServer({ siteRoot, updateService });
  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  updateService.startAutoRefresh?.();
  updateService.refresh().catch((error) => {
    console.error(formatRefreshLog({
      type: 'refresh-failed',
      status: 'error',
      error: String(error?.message || error).slice(0, 240)
    }));
  });

  server.on('close', () => updateService.stopAutoRefresh?.());
  return { server, updateService };
}

module.exports = { OFFICIAL_SOURCES, formatRefreshLog, startServer };

if (require.main === module) {
  startServer().then(({ server }) => {
    const address = server.address();
    console.log(`海南大学 2027 考研导航已启动：http://127.0.0.1:${address.port}`);
    console.log('保持此窗口打开；按 Ctrl+C 停止。');

    const shutdown = () => {
      server.close(() => process.exit(0));
      server.closeIdleConnections?.();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }).catch((error) => {
    console.error(`启动失败：${error.message}`);
    process.exitCode = 1;
  });
}
