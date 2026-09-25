const { createVercelHandler } = require('../src/vercel-app.cjs');

// Export a request handler; do not start a server or a recurring timer here.
module.exports = createVercelHandler();
