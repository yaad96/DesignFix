const proxy = require('http-proxy-middleware');
const fs = require('fs');
const path = require('path');

// The OpenAI API key is read from the gitignored .env file so it never lives in
// the browser (no localStorage, no UI paste, no REACT_APP_ exposure). Put your key
// on an OPENAI_API_KEY=... line in DesignFix-client/.env. The file is re-read on
// every request, so editing it takes effect without restarting the dev server.
const ENV_FILE = path.join(__dirname, '..', '.env');

function readApiKey() {
  try {
    const contents = fs.readFileSync(ENV_FILE, 'utf8');
    for (const rawLine of contents.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      if (line.slice(0, eq).trim() !== 'OPENAI_API_KEY') continue;
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      return value.trim();
    }
    return '';
  } catch (err) {
    return '';
  }
}

module.exports = function (app) {
  // Lets the web app show whether the key is configured, without ever exposing
  // the key itself to the browser.
  app.get('/openai-key-status', (req, res) => {
    res.json({ configured: readApiKey().length > 0 });
  });

  // Only the dashboard's own page may spend the key. Browsers always send an
  // Origin header on cross-site requests, so another web page open in the
  // browser is refused here; tools without an Origin header (curl) still work.
  const devPort = process.env.PORT || '9010';
  const allowedOrigins = new Set([`http://localhost:${devPort}`, `http://127.0.0.1:${devPort}`]);
  app.use('/openai-proxy', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      return res.status(403).json({
        error: { message: 'Only the DesignFix dashboard may use this proxy.' },
      });
    }
    next();
  });

  // Fail fast with a clear message if the key is missing, instead of forwarding
  // an unauthenticated request and getting an opaque 401 back.
  app.use('/openai-proxy', (req, res, next) => {
    if (!readApiKey()) {
      return res.status(400).json({
        error: {
          message:
            'No OpenAI API key configured. Add an OPENAI_API_KEY=... line to DesignFix-client/.env.',
        },
      });
    }
    next();
  });

  app.use(
    '/openai-proxy',
    proxy({
      target: 'https://api.openai.com',
      changeOrigin: true,
      pathRewrite: {
        '^/openai-proxy': '',
      },
      onProxyReq: (proxyReq) => {
        // Inject the real key server-side. This overwrites the placeholder
        // Authorization header the browser OpenAI client sends.
        proxyReq.setHeader('Authorization', `Bearer ${readApiKey()}`);
      },
    })
  );
};
