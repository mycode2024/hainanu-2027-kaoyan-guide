const os = require('node:os');
const path = require('node:path');
const { OFFICIAL_SOURCES } = require('../server.cjs');
const { createRequestHandler } = require('./http-app.cjs');
const { createUpdateService, createFileCacheStore } = require('./update-service.cjs');

function getVercelCachePath() {
  return path.join(os.tmpdir(), 'hnu-guide', 'updates-cache.json');
}

function getTrustedOrigins(env) {
  return [...new Set([
    env.VERCEL_URL && `https://${env.VERCEL_URL}`,
    env.VERCEL_BRANCH_URL && `https://${env.VERCEL_BRANCH_URL}`,
    env.VERCEL_PROJECT_PRODUCTION_URL && `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`,
    env.SITE_URL
  ].filter(Boolean).map(value => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('SITE_URL must be an HTTPS site origin');
    }
    return url.origin;
  }))];
}

function createVercelHandler(options = {}) {
  const env = options.env || process.env;
  const updateService = options.updateService || createUpdateService({
    sources: OFFICIAL_SOURCES,
    cacheStore: createFileCacheStore(getVercelCachePath()),
    requestTimeoutMs: 6_000,
    retryDelayMs: 250
  });
  let initialized;
  let handleRequest;
  return async function handler(request, response) {
    try {
      const url = new URL(request.url || '/', 'https://guide.invalid');
      const endpoint = url.searchParams.get('endpoint') || url.pathname.split('/').pop();
      if (!['updates', 'refresh', 'health'].includes(endpoint)) {
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      if (!handleRequest) {
        handleRequest = createRequestHandler({
          siteRoot: path.resolve(__dirname, '..'), updateService,
          trustedOrigins: getTrustedOrigins(env), awaitDueRefresh: true
        });
      }
      if (!initialized) initialized = updateService.initialize().catch(error => { initialized = null; throw error; });
      await initialized;
      request.url = `/api/${endpoint}`;
      await handleRequest(request, response);
    } catch (error) {
      console.error('Vercel request failed:', error.message);
      if (!response.headersSent) {
        response.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ error: '通知服务暂时不可用，请稍后重试。' }));
      } else if (!response.writableEnded) response.end();
    }
  };
}

module.exports = { createVercelHandler, getVercelCachePath, getTrustedOrigins };
