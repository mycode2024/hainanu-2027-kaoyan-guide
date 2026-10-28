const path = require('node:path');
const { createStaticServer } = require('../src/http-app.cjs');

function createServer(siteRoot) {
  return createStaticServer(siteRoot);
}

module.exports = { createServer };

if (require.main === module) {
  const siteRoot = path.resolve(__dirname, '..');
  const port = Number(process.env.PORT) || 4173;
  createServer(siteRoot).listen(port, '127.0.0.1', () => {
    console.log(`Hainan University guide: http://127.0.0.1:${port}`);
  });
}
