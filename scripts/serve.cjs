const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function createServer(siteRoot) {
  const root = path.resolve(siteRoot);

  return http.createServer((request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    } catch {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Bad request');
      return;
    }

    if (pathname === '/') pathname = '/index.html';
    const requestedPath = path.resolve(root, `.${pathname}`);
    const insideRoot = requestedPath === root || requestedPath.startsWith(`${root}${path.sep}`);

    if (!insideRoot) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Forbidden');
      return;
    }

    fs.stat(requestedPath, (error, stats) => {
      if (error || !stats.isFile()) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
      }

      const contentType = contentTypes[path.extname(requestedPath).toLowerCase()] || 'application/octet-stream';
      response.writeHead(200, {
        'content-type': contentType,
        'cache-control': 'no-store'
      });

      if (request.method === 'HEAD') {
        response.end();
        return;
      }

      fs.createReadStream(requestedPath).pipe(response);
    });
  });
}

module.exports = { createServer };

if (require.main === module) {
  const siteRoot = path.resolve(__dirname, '..');
  const port = Number(process.env.PORT) || 4173;
  createServer(siteRoot).listen(port, '127.0.0.1', () => {
    console.log(`Hainan University guide: http://127.0.0.1:${port}`);
  });
}
