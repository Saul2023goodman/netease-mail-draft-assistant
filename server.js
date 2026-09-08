const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cloudDebug = require('./cloud-debug');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

function send(res, status, body, type = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...extraHeaders
  });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

function resolvePublicPath(urlPath) {
  const pathname = decodeURIComponent((urlPath || '/').split('?')[0]);
  const relative = pathname === '/' ? 'app.html' : pathname === '/debug' || pathname === '/debug/' ? 'debug.html' : pathname.replace(/^\/+/, '');
  const absolute = path.resolve(ROOT, relative);
  if (absolute !== ROOT && !absolute.startsWith(ROOT + path.sep)) return null;
  return absolute;
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (!aa.length || aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function debugAuthorized(req) {
  const configured = process.env.DEBUG_TOKEN || '';
  if (!configured) return false;
  const header = String(req.headers['x-debug-token'] || '');
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return safeEqual(header, configured) || safeEqual(bearer, configured);
}

function readJson(req, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

async function handleDebugApi(req, res, pathname) {
  if (!debugAuthorized(req)) return sendJson(res, 401, { ok: false, error: 'Unauthorized debug request' });

  try {
    if (pathname === '/debug/api/status' && req.method === 'GET') {
      return sendJson(res, 200, cloudDebug.getState());
    }

    if (pathname === '/debug/api/screenshot' && req.method === 'GET') {
      const png = await cloudDebug.screenshot();
      return send(res, 200, png, 'image/png');
    }

    if (pathname === '/debug/api/login' && req.method === 'POST') {
      return sendJson(res, 200, await cloudDebug.startLogin());
    }

    if (pathname === '/debug/api/navigate' && req.method === 'POST') {
      const body = await readJson(req);
      return sendJson(res, 200, await cloudDebug.navigate(body.url));
    }

    if (pathname === '/debug/api/click' && req.method === 'POST') {
      const body = await readJson(req);
      return sendJson(res, 200, await cloudDebug.click(body.x, body.y));
    }

    if (pathname === '/debug/api/type' && req.method === 'POST') {
      const body = await readJson(req);
      return sendJson(res, 200, await cloudDebug.type(body.text));
    }

    if (pathname === '/debug/api/key' && req.method === 'POST') {
      const body = await readJson(req);
      return sendJson(res, 200, await cloudDebug.press(body.key));
    }

    if (pathname === '/debug/api/reset' && req.method === 'POST') {
      return sendJson(res, 200, await cloudDebug.reset());
    }

    return sendJson(res, 404, { ok: false, error: 'Unknown debug endpoint' });
  } catch (error) {
    const debugState = cloudDebug.captureError(error);
    return sendJson(res, 500, { ok: false, error: error?.message || String(error), state: debugState });
  }
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try { pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname; }
  catch (_) { return send(res, 400, 'Bad Request'); }

  if (pathname === '/health') {
    const cloudState = cloudDebug.getState();
    return sendJson(res, 200, {
      ok: true,
      app: 'netease-mail-draft-assistant',
      cloudDebug: {
        enabled: Boolean(process.env.DEBUG_TOKEN),
        phase: cloudState.phase,
        browserReady: cloudState.browserReady,
        verificationRequired: cloudState.verificationRequired === true,
        error: cloudState.phase === 'error'
      }
    });
  }

  if (pathname.startsWith('/debug/api/')) {
    return handleDebugApi(req, res, pathname);
  }

  if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
    return send(res, 405, 'Method Not Allowed');
  }

  let filePath;
  try { filePath = resolvePublicPath(req.url); }
  catch (_) { return send(res, 400, 'Bad Request'); }

  if (!filePath) return send(res, 403, 'Forbidden');

  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) return send(res, 404, 'Not Found');

    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': filePath.endsWith('.html') ? 'no-store' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY'
    });

    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`NetEase Mail Draft Assistant web host listening on http://${HOST}:${PORT}`);
  if (process.env.NETEASE_AUTOSTART === '1') {
    setTimeout(async () => {
      try {
        const result = await cloudDebug.startLogin();
        console.log(`[cloud-debug] autostart phase=${result.phase} url=${result.url}`);
      } catch (error) {
        const failedState = cloudDebug.captureError(error);
        console.error('[cloud-debug] autostart phase=' + failedState.phase);
      }
    }, 1500);
  }
});

async function shutdown() {
  try { await cloudDebug.close(); } catch (_) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
