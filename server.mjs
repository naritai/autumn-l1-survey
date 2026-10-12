import http from 'node:http';
import { readFileSync, createReadStream, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, InputError, csv } from './lib/store.mjs';

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const catalog = JSON.parse(readFileSync(join(ROOT, 'catalog.json'), 'utf8'));
function session(req) { return /(?:^|;\s*)survey_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1]; }
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}
function sameOrigin(req, requiredHeader) {
  if (req.headers[requiredHeader] !== '1') throw new InputError('Неверный запрос.', 403);
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new InputError('Неверный источник запроса.', 403);
  if (req.headers.origin) {
    let origin; try { origin = new URL(req.headers.origin); } catch { throw new InputError('Неверный источник.', 403); }
    if (origin.host !== req.headers.host || !['http:', 'https:'].includes(origin.protocol)) throw new InputError('Неверный источник запроса.', 403);
  }
}
async function body(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new InputError('Ожидается JSON.', 415);
  let size = 0, chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 8192) throw new InputError('Запрос слишком большой.', 413); chunks.push(chunk); }
  try { const data = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(); return data; }
  catch { throw new InputError('Не удалось прочитать запрос.'); }
}
function serveFile(req, res, path, type, { range = false } = {}) {
  const size = statSync(path).size;
  const headers = { 'Content-Type': type, 'Cache-Control': range || type === 'image/png' ? 'private, max-age=3600' : 'no-cache' };
  let start = 0, end = size - 1, status = 200;
  if (range) {
    headers['Accept-Ranges'] = 'bytes';
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
      if (!match[1]) start = Math.max(0, size - Number(match[2]));
      else { start = Number(match[1]); end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1; }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
      status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
  }
  res.writeHead(status, { ...headers, 'Content-Length': end - start + 1 });
  if (req.method === 'HEAD') res.end(); else { const stream = createReadStream(path, { start, end }); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); }
}

export function createApplication({ dataDir = process.env.DATA_DIR || join(ROOT, 'data'), maximum = 200 } = {}) {
  const store = new Store(resolve(dataDir), catalog, { maximum });
  const staticFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/metrics.mjs': ['metrics.mjs', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
  const handle = async (req, res, admin = false) => {
    securityHeaders(res);
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (admin) {
        if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) throw new InputError('Только локальный доступ.', 403);
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new InputError('Метод не поддерживается.', 405);
        if (path === '/') return serveFile(req, res, join(ROOT, 'public', 'admin.html'), 'text/html; charset=utf-8');
        if (path === '/style.css') return serveFile(req, res, join(ROOT, 'public', 'style.css'), 'text/css; charset=utf-8');
        if (path === '/admin.js') return serveFile(req, res, join(ROOT, 'public', 'admin.js'), 'text/javascript; charset=utf-8');
        sameOrigin(req, 'x-survey-admin');
        if (path === '/api/summary') return json(res, 200, store.summary());
        if (path === '/api/export.csv') { res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="l1-survey-results.csv"', 'Cache-Control': 'no-store' }); res.end(csv(store.rows())); return; }
        throw new InputError('Не найдено.', 404);
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (staticFiles[path]) { const [file, type] = staticFiles[path]; return serveFile(req, res, join(ROOT, 'public', file), type); }
        if (path === '/health') return json(res, 200, { ok: true });
        if (path === '/api/config') return json(res, 200, { version: catalog.version, total: 6, trainingMedia: `/media/${catalog.training.id}.mp4` });
        if (path === '/api/session') return json(res, 200, store.publicState(session(req)));
        if (path === '/media/training-reveal.png') return serveFile(req, res, join(ROOT, 'media', 'training-reveal.png'), 'image/png');
        const video = /^\/media\/([a-f0-9]{24})\.mp4$/.exec(path);
        if (video && store.mediaAllowed(session(req), video[1])) return serveFile(req, res, join(ROOT, 'media', video[1] + '.mp4'), 'video/mp4', { range: true });
        throw new InputError('Не найдено.', 404);
      }
      if (req.method !== 'POST') throw new InputError('Метод не поддерживается.', 405);
      sameOrigin(req, 'x-survey-request'); const input = await body(req);
      if (path === '/api/start') {
        const result = store.start(session(req), input);
        const secure = req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted;
        res.setHeader('Set-Cookie', `survey_session=${result.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secure ? '; Secure' : ''}`);
        return json(res, 200, store.publicState(result.token));
      }
      if (path === '/api/finish') return json(res, 200, store.finish(session(req), input));
      const taskRoute = /^\/api\/tasks\/([a-f0-9]{32})\/(played|answer|rating)$/.exec(path);
      if (taskRoute) {
        const [, taskId, action] = taskRoute, token = session(req);
        const result = action === 'played' ? store.played(token, taskId) : action === 'answer' ? store.answer(token, taskId, input) : store.rate(token, taskId, input.clarity);
        return json(res, 200, result);
      }
      throw new InputError('Не найдено.', 404);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (!(error instanceof InputError)) console.error('Request failed:', error.message);
      json(res, error.status || 500, { error: error instanceof InputError ? error.message : 'Не удалось сохранить данные. Повторите попытку.' });
    }
  };
  return { store, handler: (req, res) => handle(req, res, false), adminHandler: (req, res) => handle(req, res, true) };
}

export async function startServers(options = {}) {
  const application = createApplication(options), publicServer = http.createServer(application.handler), adminServer = http.createServer(application.adminHandler);
  for (const server of [publicServer, adminServer]) { server.requestTimeout = 30000; server.headersTimeout = 15000; server.keepAliveTimeout = 5000; }
  const listen = (server, port, host) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(server.address().port); }); });
  try {
    const publicPort = await listen(publicServer, options.port ?? Number(process.env.PORT || 8785), options.host || process.env.HOST || '127.0.0.1');
    const adminPort = await listen(adminServer, options.adminPort ?? Number(process.env.ADMIN_PORT || 8786), '127.0.0.1');
    return { ...application, publicPort, adminPort, async close() { await Promise.all([publicServer, adminServer].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }))); application.store.close(); } };
  } catch (error) { publicServer.close(); adminServer.close(); application.store.close(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await startServers();
  console.log(`Опрос: http://127.0.0.1:${app.publicPort}\nРезультаты: http://127.0.0.1:${app.adminPort}`);
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, async () => { if (closing) return; closing = true; await app.close(); });
}
