// Servidor de MiPuter: sirve la web estática y guarda los archivos subidos en
// Backblaze B2 a través de su API compatible con S3. Sin dependencias (Node 20+).
//
// Las credenciales de B2 se leen de variables de entorno (o de un archivo .env)
// y nunca se envían al navegador.

import http from 'node:http';
import crypto from 'node:crypto';
import { existsSync, createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 8000);
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB || 100) * 1024 * 1024;
const PREFIX = (process.env.B2_PREFIX || 'miputer').replace(/^\/+|\/+$/g, '') + '/';

const b2 = {
  keyId: process.env.B2_KEY_ID,
  appKey: process.env.B2_APPLICATION_KEY,
  bucket: process.env.B2_BUCKET,
  // p. ej. https://s3.us-west-004.backblazeb2.com
  endpoint: (process.env.B2_ENDPOINT || '').replace(/\/+$/, ''),
};
b2.enabled = Boolean(b2.keyId && b2.appKey && b2.bucket && b2.endpoint);
if (b2.enabled && !/^https?:\/\//.test(b2.endpoint)) b2.endpoint = `https://${b2.endpoint}`;
b2.region = process.env.B2_REGION || b2.endpoint.match(/s3\.([a-z0-9-]+)\.backblazeb2\.com/)?.[1] || 'us-east-1';

// ---------------------------------------------------------------------------
// Contraseña de acceso
// ---------------------------------------------------------------------------
//
// Si MIPUTER_PASSWORD está definida, toda la web y la API piden iniciar sesión.
// La sesión es una cookie firmada con HMAC (derivada de la contraseña), así que
// sobrevive a reinicios del servidor y cambiar la contraseña cierra todas las sesiones.

const PASSWORD = process.env.MIPUTER_PASSWORD || '';
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const COOKIE = 'miputer_session';
const sessionKey = crypto.createHash('sha256').update(`miputer-session:${PASSWORD}`).digest();
const loginAttempts = new Map(); // ip -> { count, until }

const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

function makeSession() {
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  const sig = crypto.createHmac('sha256', sessionKey).update(String(exp)).digest('base64url');
  return `${exp}.${sig}`;
}

function isAuthenticated(req) {
  if (!PASSWORD) return true;
  const cookie = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  const [exp, sig] = (cookie?.slice(COOKIE.length + 1) || '').split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, crypto.createHmac('sha256', sessionKey).update(exp).digest('base64url'));
}

function sessionCookie(req, value, maxAge) {
  const secure = process.env.COOKIE_SECURE === 'true' || req.headers['x-forwarded-proto'] === 'https';
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function clientIp(req) {
  return (process.env.TRUST_PROXY === 'true' && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;
}

function loginPage(error = '') {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MiPuter</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>◆</text></svg>">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: radial-gradient(circle at 20% 20%, #3a5a8c 0%, #1d2b44 55%, #111a2b 100%); color: #1c2230; }
  form { width: 100%; max-width: 340px; padding: 28px; border-radius: 14px; background: #fff;
    box-shadow: 0 12px 32px rgba(0,0,0,.35); display: grid; gap: 14px; }
  h1 { margin: 0; font-size: 22px; text-align: center; }
  p { margin: 0; text-align: center; color: #6b7385; font-size: 14px; }
  input { font: inherit; padding: 10px 12px; border: 1px solid #d5dae3; border-radius: 8px; }
  input:focus { outline: 2px solid #3b82f6; border-color: transparent; }
  button { font: inherit; font-weight: 600; padding: 10px; border: 0; border-radius: 8px; background: #3b82f6; color: #fff; cursor: pointer; }
  .error { color: #b4232a; text-align: center; font-size: 14px; }
</style></head>
<body>
  <form method="post" action="login">
    <h1>◆ MiPuter</h1>
    <p>Introduce la contraseña para entrar</p>
    <input type="password" name="password" placeholder="Contraseña" autocomplete="current-password" autofocus required>
    ${error ? `<div class="error">${error}</div>` : ''}
    <button type="submit">Entrar</button>
  </form>
</body></html>`;
}

async function handleAuth(req, res, url) {
  if (url.pathname === '/login' && req.method === 'GET') {
    if (isAuthenticated(req)) return redirect(res, '/');
    return sendHtml(res, 200, loginPage());
  }
  if (url.pathname === '/login' && req.method === 'POST') {
    const ip = clientIp(req);
    const entry = loginAttempts.get(ip);
    if (entry && entry.until > Date.now()) {
      const mins = Math.ceil((entry.until - Date.now()) / 60000);
      return sendHtml(res, 429, loginPage(`Demasiados intentos. Prueba de nuevo en ${mins} min.`));
    }
    const body = await readBody(req, 4096);
    const password = new URLSearchParams(body.toString()).get('password') || '';
    if (!safeEqual(password, PASSWORD)) {
      const count = (entry?.count || 0) + 1;
      // Tras 5 fallos seguidos, bloqueo de 15 minutos para esa IP.
      loginAttempts.set(ip, { count: count >= 5 ? 0 : count, until: count >= 5 ? Date.now() + 15 * 60000 : 0 });
      await new Promise((r) => setTimeout(r, 500));
      return sendHtml(res, 401, loginPage('Contraseña incorrecta'));
    }
    loginAttempts.delete(ip);
    res.setHeader('set-cookie', sessionCookie(req, makeSession(), SESSION_DAYS * 86400));
    return redirect(res, '/');
  }
  if (url.pathname === '/logout' && req.method === 'POST') {
    res.setHeader('set-cookie', sessionCookie(req, '', 0));
    return redirect(res, '/login');
  }
  return false;
}

function redirect(res, location) {
  res.writeHead(303, { location });
  res.end();
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

// ---------------------------------------------------------------------------
// Firma AWS Signature V4 (la que usa la API S3 de B2)
// ---------------------------------------------------------------------------

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const encodeRfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function signRequest({ method, url, headers = {}, payloadHash, accessKey, secretKey, region, date = new Date() }) {
  const u = new URL(url);
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const all = { ...headers, host: u.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
  const names = Object.keys(all).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonicalHeaders = names.map((h) => `${h}:${lower[h]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalQuery = [...u.searchParams]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [method, u.pathname, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = ['s3', 'aws4_request'].reduce(hmac, hmac(hmac(`AWS4${secretKey}`, day), region));
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return {
    ...all,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function objectUrl(key) {
  return `${b2.endpoint}/${encodeRfc3986(b2.bucket)}/${key.split('/').map(encodeRfc3986).join('/')}`;
}

async function b2Request(method, key, { body, headers = {} } = {}) {
  const url = objectUrl(key);
  const payload = body ?? Buffer.alloc(0);
  const signed = signRequest({
    method,
    url,
    headers,
    payloadHash: sha256(payload),
    accessKey: b2.keyId,
    secretKey: b2.appKey,
    region: b2.region,
  });
  delete signed.host; // fetch la pone sola
  const res = await fetch(url, { method, headers: signed, body: method === 'GET' || method === 'HEAD' ? undefined : payload });
  if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
    const text = await res.text().catch(() => '');
    const msg = text.match(/<Message>([^<]*)<\/Message>/)?.[1] || text.slice(0, 200) || res.statusText;
    throw Object.assign(new Error(`B2 ${res.status}: ${msg}`), { status: res.status === 404 ? 404 : 502 });
  }
  return res;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req, limit = MAX_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error(`El archivo supera el límite de ${Math.round(limit / 1024 / 1024)} MB`), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function checkKey(key) {
  if (!key || !key.startsWith(PREFIX) || key.includes('..')) {
    throw Object.assign(new Error('Clave no válida'), { status: 400 });
  }
  return key;
}

function newKey(name) {
  const safe = String(name || 'archivo').replace(/[^\w.-]+/g, '_').slice(-100) || 'archivo';
  return `${PREFIX}${crypto.randomUUID()}-${safe}`;
}

async function handleApi(req, res, url) {
  const route = url.pathname;
  const method = req.method;

  if (route === '/api/status' && method === 'GET') {
    return sendJson(res, 200, { auth: Boolean(PASSWORD), b2: b2.enabled, bucket: b2.enabled ? b2.bucket : null, maxUploadMb: MAX_UPLOAD_BYTES / 1024 / 1024 });
  }
  if (!b2.enabled) return sendJson(res, 503, { error: 'Backblaze B2 no está configurado en el servidor' });

  // Subir un archivo nuevo: POST /api/files?name=foto.png  (cuerpo = bytes)
  if (route === '/api/files' && method === 'POST') {
    const body = await readBody(req);
    const key = newKey(url.searchParams.get('name'));
    const type = req.headers['content-type'] || 'application/octet-stream';
    await b2Request('PUT', key, { body, headers: { 'content-type': type } });
    return sendJson(res, 201, { key, size: body.length, type });
  }

  // Copiar en el servidor: POST /api/files/copy?key=...
  if (route === '/api/files/copy' && method === 'POST') {
    const src = checkKey(url.searchParams.get('key'));
    const key = newKey(src.slice(PREFIX.length + 37));
    await b2Request('PUT', key, { headers: { 'x-amz-copy-source': `/${b2.bucket}/${src.split('/').map(encodeRfc3986).join('/')}` } });
    return sendJson(res, 201, { key });
  }

  if (route === '/api/files') {
    const key = checkKey(url.searchParams.get('key'));

    // Leer: GET /api/files?key=...[&download=nombre]
    if (method === 'GET') {
      const r = await b2Request('GET', key);
      const headers = {
        'content-type': r.headers.get('content-type') || 'application/octet-stream',
        'cache-control': 'private, max-age=3600',
      };
      if (r.headers.get('content-length')) headers['content-length'] = r.headers.get('content-length');
      const download = url.searchParams.get('download');
      if (download) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeRfc3986(download)}`;
      res.writeHead(200, headers);
      return Readable.fromWeb(r.body).pipe(res);
    }

    // Sobrescribir: PUT /api/files?key=...  (cuerpo = bytes)
    if (method === 'PUT') {
      const body = await readBody(req);
      await b2Request('PUT', key, { body, headers: { 'content-type': req.headers['content-type'] || 'application/octet-stream' } });
      return sendJson(res, 200, { key, size: body.length });
    }

    if (method === 'DELETE') {
      await b2Request('DELETE', key);
      return sendJson(res, 200, { ok: true });
    }
  }

  sendJson(res, 404, { error: 'Ruta no encontrada' });
}

// ---------------------------------------------------------------------------
// Archivos estáticos
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
};
const PUBLIC = ['index.html', 'css', 'js', 'docs'];

function serveStatic(req, res, url) {
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '') || 'index.html';
  const allowed = PUBLIC.some((p) => rel === p || rel.startsWith(p + sep) || rel.startsWith(p + '/'));
  const file = join(ROOT, rel);
  if (!allowed || !file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('No encontrado');
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (PASSWORD && (await handleAuth(req, res, url)) !== false) return;
    if (!isAuthenticated(req)) {
      if (url.pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'Sesión caducada: vuelve a iniciar sesión' });
      return redirect(res, '/login');
    }
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    console.error(e.message);
    if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message });
    else res.destroy();
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => {
    console.log(`MiPuter en http://localhost:${PORT}`);
    console.log(PASSWORD ? 'Acceso protegido con contraseña' : '⚠️  Sin contraseña: define MIPUTER_PASSWORD en .env para proteger el acceso');
    console.log(b2.enabled ? `Subidas → Backblaze B2 (bucket "${b2.bucket}", región ${b2.region})` : 'B2 no configurado: las subidas se guardan en el navegador');
  });
}
