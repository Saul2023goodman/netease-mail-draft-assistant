const http = require('http');
const fs = require('fs');
const path = require('path');

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

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY'
};

function responseHeaders(type, cacheControl = 'no-store', extraHeaders = {}) {
  return {
    'Content-Type': type,
    'Cache-Control': cacheControl,
    ...SECURITY_HEADERS,
    ...extraHeaders
  };
}

function send(res, status, body, type = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, responseHeaders(type, 'no-store', extraHeaders));
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

function resolvePublicPath(urlPath) {
  const pathname = decodeURIComponent((urlPath || '/').split('?')[0]);
  const relative = pathname === '/' ? 'app.html' : pathname.replace(/^\/+/, '');
  const absolute = path.resolve(ROOT, relative);
  if (absolute !== ROOT && !absolute.startsWith(ROOT + path.sep)) return null;
  return absolute;
}

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname; }
  catch (_) { return send(res, 400, 'Bad Request'); }

  if (pathname === '/health') {
    return sendJson(res, 200, { ok: true, app: 'netease-mail-draft-assistant' });
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
    const cacheControl = filePath.endsWith('.html') ? 'no-store' : 'public, max-age=300';
    res.writeHead(200, responseHeaders(type, cacheControl));

    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`NetEase Mail Draft Assistant web host listening on http://${HOST}:${PORT}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
