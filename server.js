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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_UPLOAD_BYTES) {
        reject(Object.assign(new Error(`El archivo supera el límite de ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`), { status: 413 }));
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
    return sendJson(res, 200, { b2: b2.enabled, bucket: b2.enabled ? b2.bucket : null, maxUploadMb: MAX_UPLOAD_BYTES / 1024 / 1024 });
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
    console.log(b2.enabled ? `Subidas → Backblaze B2 (bucket "${b2.bucket}", región ${b2.region})` : 'B2 no configurado: las subidas se guardan en el navegador');
  });
}
