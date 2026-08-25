const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const PUBLIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/programs', 'programs.html'],
  ['/programs.html', 'programs.html'],
  ['/timeline', 'timeline.html'],
  ['/timeline.html', 'timeline.html'],
  ['/application', 'application.html'],
  ['/application.html', 'application.html'],
  ['/updates', 'updates.html'],
  ['/updates.html', 'updates.html'],
  ['/styles.css', 'styles.css'],
  ['/app.js', 'app.js']
]);

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; base-uri 'none'; connect-src 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff'
};

function writeText(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    ...extraHeaders
  });
  response.end(body);
}

function writeJson(response, status, value, extraHeaders = {}) {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    ...extraHeaders
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function consumeSmallBody(request, maximumBytes = 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let exceeded = false;
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > maximumBytes && !exceeded) {
        exceeded = true;
        const error = new Error('request body too large');
        error.code = 'BODY_TOO_LARGE';
        reject(error);
      }
    });
    request.on('end', () => { if (!exceeded) resolve(); });
    request.on('error', reject);
  });
}

function isTrustedRefreshRequest(request) {
  if (request.headers['x-hnu-guide-request'] !== '1') return false;
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site') return false;
  const localPort = Number(request.socket?.localPort);
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65_535) return false;
  const expectedHost = `127.0.0.1:${localPort}`;
  if (request.headers.host !== expectedHost) return false;
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    const originUrl = new URL(origin);
    return originUrl.protocol === 'http:' && originUrl.origin === `http://${expectedHost}`;
  } catch {
    return false;
  }
}

function createHttpServer({
  siteRoot,
  updateService,
  manualRefreshCooldownMs = 10_000,
  now = () => Date.now()
}) {
  if (!updateService || typeof updateService.getSnapshot !== 'function' || typeof updateService.refresh !== 'function') {
    throw new TypeError('updateService must provide getSnapshot() and refresh()');
  }
  const root = path.resolve(siteRoot);
  const startedAt = Date.now();
  const cooldownMs = Math.min(60_000, Math.max(0, Number(manualRefreshCooldownMs) || 0));
  let lastManualRefreshAt = Number.NEGATIVE_INFINITY;

  return http.createServer(async (request, response) => {
    const rawUrl = request.url || '/';
    if (/%2e/i.test(rawUrl)) {
      writeText(response, 403, 'Forbidden');
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(rawUrl, 'http://127.0.0.1').pathname);
    } catch {
      writeText(response, 400, 'Bad request');
      return;
    }

    if (pathname === '/api/health') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        writeJson(response, 405, { error: 'Method not allowed' }, { allow: 'GET, HEAD' });
        return;
      }
      const snapshot = updateService.getSnapshot();
      const ready = (snapshot.status === 'fresh' || snapshot.status === 'stale') &&
        Array.isArray(snapshot.updates) && snapshot.updates.length > 0;
      const health = {
        product: 'hainanu-2027-kaoyan-guide',
        schemaVersion: 2,
        live: true,
        ready,
        uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
        status: snapshot.status,
        lastAttemptAt: snapshot.lastAttemptAt || null,
        lastAllSuccessAt: snapshot.lastAllSuccessAt || null,
        overdueSourceIds: Array.isArray(snapshot.freshness?.overdueSourceIds)
          ? snapshot.freshness.overdueSourceIds
          : []
      };
      if (request.method === 'HEAD') {
        response.writeHead(200, {
          ...SECURITY_HEADERS,
          'cache-control': 'no-store',
          'content-type': 'application/json; charset=utf-8'
        });
        response.end();
        return;
      }
      writeJson(response, 200, health);
      return;
    }

    if (pathname === '/api/updates') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        writeJson(response, 405, { error: 'Method not allowed' }, { allow: 'GET, HEAD' });
        return;
      }
      if (request.method === 'GET' && typeof updateService.refreshIfDue === 'function') {
        try {
          const dueRefresh = updateService.refreshIfDue();
          dueRefresh?.promise?.catch?.(() => {});
        } catch {
          // A background refresh must never make the last good snapshot unavailable.
        }
      }
      const payload = updateService.getSnapshot();
      if (request.method === 'HEAD') {
        response.writeHead(200, {
          ...SECURITY_HEADERS,
          'cache-control': 'no-store',
          'content-type': 'application/json; charset=utf-8'
        });
        response.end();
        return;
      }
      writeJson(response, 200, payload);
      return;
    }

    if (pathname === '/api/refresh') {
      if (request.method !== 'POST') {
        writeJson(response, 405, { error: 'Method not allowed' }, { allow: 'POST' });
        return;
      }
      if (!isTrustedRefreshRequest(request)) {
        request.resume();
        writeJson(response, 403, { error: 'Refresh request rejected' });
        return;
      }
      try {
        await consumeSmallBody(request);
        const clockValue = now();
        const currentTime = clockValue instanceof Date ? clockValue.getTime() : Number(clockValue);
        const safeCurrentTime = Number.isFinite(currentTime) ? currentTime : Date.now();
        const elapsed = safeCurrentTime - lastManualRefreshAt;
        if (cooldownMs > 0 && elapsed >= 0 && elapsed < cooldownMs) {
          const retryAfterSeconds = Math.min(60, Math.max(1, Math.ceil((cooldownMs - elapsed) / 1000)));
          writeJson(response, 429, { error: '同步请求过于频繁，请稍后重试。' }, {
            'retry-after': String(retryAfterSeconds)
          });
          return;
        }
        lastManualRefreshAt = safeCurrentTime;
        const payload = await updateService.refresh();
        writeJson(response, 200, payload);
      } catch (error) {
        if (error.code === 'BODY_TOO_LARGE') {
          if (!response.headersSent) writeJson(response, 413, { error: 'Request body too large' });
          return;
        }
        if (!response.headersSent) writeJson(response, 502, {
          error: '官方信息同步失败，请稍后重试。',
          snapshot: updateService.getSnapshot()
        });
      }
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      writeText(response, 405, 'Method not allowed', { allow: 'GET, HEAD' });
      return;
    }

    const publicFile = PUBLIC_FILES.get(pathname);
    if (!publicFile) {
      writeText(response, 404, 'Not found');
      return;
    }

    const filePath = path.join(root, publicFile);
    const contentType = CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream';
    try {
      const stats = await fs.promises.stat(filePath);
      if (!stats.isFile()) throw new Error('not a file');
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        'cache-control': 'no-store',
        'content-length': stats.size,
        'content-type': contentType
      });
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      const stream = fs.createReadStream(filePath);
      stream.on('error', () => response.destroy());
      stream.pipe(response);
    } catch {
      writeText(response, 404, 'Not found');
    }
  });
}

module.exports = { createHttpServer };
