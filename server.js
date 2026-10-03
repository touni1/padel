// Servidor de MiPuter: sirve la web estática y guarda los archivos subidos en
// Backblaze B2 a través de su API compatible con S3 (Node 20+). Las únicas
// dependencias (node-pty y ws) son para la app Claude y son opcionales.
//
// Las credenciales de B2 se leen de variables de entorno (o de un archivo .env)
// y nunca se envían al navegador.

import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, createReadStream, createWriteStream, statSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, copyFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import dns from 'node:dns';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 8000);
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB || 5120) * 1024 * 1024;
// Hasta este tamaño un archivo se sube de una vez (y se guarda entero en memoria);
// los más grandes se suben por partes de PART_BYTES (subida multiparte de B2).
const SINGLE_UPLOAD_BYTES = 100 * 1024 * 1024;
const PART_BYTES = 64 * 1024 * 1024;
const PREFIX = (process.env.B2_PREFIX || 'miputer').replace(/^\/+|\/+$/g, '') + '/';

// Credenciales de B2: las de .b2.json (guardadas desde Ajustes) mandan sobre las del .env.
const B2_FILE = join(ROOT, '.b2.json');

function makeB2Config({ keyId, appKey, bucket, endpoint, region }) {
  const cfg = { keyId: String(keyId || '').trim(), appKey: String(appKey || '').trim(), bucket: String(bucket || '').trim() };
  // p. ej. https://s3.us-west-004.backblazeb2.com. El panel de B2 lo muestra con el
  // bucket pegado ("s3.us-east-005.backblazeb2.com/mi-bucket"): esa parte se separa.
  cfg.endpoint = String(endpoint || '').trim().replace(/\/+$/, '');
  if (cfg.endpoint && !/^https?:\/\//.test(cfg.endpoint)) cfg.endpoint = `https://${cfg.endpoint}`;
  try {
    const u = new URL(cfg.endpoint);
    const path = decodeURIComponent(u.pathname.replace(/^\/+|\/+$/g, ''));
    if (path && !cfg.bucket) cfg.bucket = path;
    if (cfg.endpoint) cfg.endpoint = u.origin;
  } catch {}
  cfg.enabled = Boolean(cfg.keyId && cfg.appKey && cfg.bucket && cfg.endpoint);
  cfg.region = region || cfg.endpoint.match(/s3\.([a-z0-9-]+)\.backblazeb2\.com/)?.[1] || 'us-east-1';
  return cfg;
}

const b2 = makeB2Config(
  existsSync(B2_FILE)
    ? JSON.parse(readFileSync(B2_FILE, 'utf8'))
    : {
        keyId: process.env.B2_KEY_ID,
        appKey: process.env.B2_APPLICATION_KEY,
        bucket: process.env.B2_BUCKET,
        endpoint: process.env.B2_ENDPOINT,
        region: process.env.B2_REGION,
      },
);
b2.source = existsSync(B2_FILE) ? 'ajustes' : '.env';

// ---------------------------------------------------------------------------
// Contraseña de acceso
// ---------------------------------------------------------------------------
//
// Si hay contraseña, toda la web y la API piden iniciar sesión. La contraseña sale
// de .password.json (hash scrypt, se crea al cambiarla desde la web o con
// `node server.js --temp-password`) o, si ese archivo no existe, de MIPUTER_PASSWORD.
// La sesión es una cookie firmada con HMAC derivada de la contraseña, así que
// sobrevive a reinicios del servidor y cambiar la contraseña cierra todas las sesiones.

const PASSWORD_FILE = join(ROOT, '.password.json');
const MIN_PASSWORD = 12;
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const COOKIE = 'miputer_session';
const loginAttempts = new Map(); // ip -> { count, until }

// { enabled, plain } desde .env, o { enabled, salt, hash, mustChange } desde .password.json
let auth;
let sessionKey;
function loadAuth() {
  if (existsSync(PASSWORD_FILE)) auth = { enabled: true, ...JSON.parse(readFileSync(PASSWORD_FILE, 'utf8')) };
  else auth = { enabled: Boolean(process.env.MIPUTER_PASSWORD), plain: process.env.MIPUTER_PASSWORD || '' };
  sessionKey = crypto.createHash('sha256').update(`miputer-session:${auth.plain ?? auth.hash}`).digest();
}
loadAuth();

function savePassword(password, mustChange) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32).toString('base64');
  const tmp = `${PASSWORD_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify({ salt: salt.toString('base64'), hash, mustChange }), { mode: 0o600 });
  renameSync(tmp, PASSWORD_FILE);
  loadAuth();
}

const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

function checkPassword(password) {
  if (auth.plain !== undefined) return safeEqual(password, auth.plain);
  return safeEqual(crypto.scryptSync(password, Buffer.from(auth.salt, 'base64'), 32).toString('base64'), auth.hash);
}

function makeSession() {
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  const sig = crypto.createHmac('sha256', sessionKey).update(String(exp)).digest('base64url');
  return `${exp}.${sig}`;
}

function isAuthenticated(req) {
  if (!auth.enabled) return true;
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

function formPage({ action, intro, fields, button, error = '' }) {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
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
  <form method="post" action="${action}">
    <h1>◆ MiPuter</h1>
    <p>${intro}</p>
    ${fields}
    ${error ? `<div class="error">${error}</div>` : ''}
    <button type="submit">${button}</button>
  </form>
</body></html>`;
}

const loginPage = (error) =>
  formPage({
    action: 'login',
    intro: 'Introduce la contraseña para entrar',
    fields: '<input type="password" name="password" placeholder="Contraseña" autocomplete="current-password" autofocus required>',
    button: 'Entrar',
    error,
  });

const changePage = (error) =>
  formPage({
    action: 'cambiar-clave',
    intro: auth.mustChange
      ? 'Estás usando una contraseña temporal. Elige una nueva para continuar.'
      : 'Cambia tu contraseña. Se cerrarán las demás sesiones abiertas.',
    fields: `<input type="password" name="current" placeholder="Contraseña actual" autocomplete="current-password" autofocus required>
    <input type="password" name="password" placeholder="Nueva contraseña (mín. ${MIN_PASSWORD} caracteres)" autocomplete="new-password" minlength="${MIN_PASSWORD}" required>
    <input type="password" name="repeat" placeholder="Repite la nueva contraseña" autocomplete="new-password" minlength="${MIN_PASSWORD}" required>`,
    button: 'Cambiar contraseña',
    error,
  });

// Cuenta un intento fallido; tras 5 seguidos, bloqueo de 15 minutos para esa IP.
async function failAttempt(ip) {
  const count = (loginAttempts.get(ip)?.count || 0) + 1;
  loginAttempts.set(ip, { count: count >= 5 ? 0 : count, until: count >= 5 ? Date.now() + 15 * 60000 : 0 });
  await new Promise((r) => setTimeout(r, 500));
}

function blockedFor(ip) {
  const entry = loginAttempts.get(ip);
  return entry && entry.until > Date.now() ? Math.ceil((entry.until - Date.now()) / 60000) : 0;
}

async function handleAuth(req, res, url) {
  if (url.pathname === '/login' && req.method === 'GET') {
    if (isAuthenticated(req)) return redirect(res, '/');
    return sendHtml(res, 200, loginPage());
  }
  if (url.pathname === '/login' && req.method === 'POST') {
    const ip = clientIp(req);
    const mins = blockedFor(ip);
    if (mins) return sendHtml(res, 429, loginPage(`Demasiados intentos. Prueba de nuevo en ${mins} min.`));
    const body = await readBody(req, 4096);
    const password = new URLSearchParams(body.toString()).get('password') || '';
    if (!checkPassword(password)) {
      await failAttempt(ip);
      return sendHtml(res, 401, loginPage('Contraseña incorrecta'));
    }
    loginAttempts.delete(ip);
    res.setHeader('set-cookie', sessionCookie(req, makeSession(), SESSION_DAYS * 86400));
    return redirect(res, auth.mustChange ? '/cambiar-clave' : '/');
  }
  if (url.pathname === '/cambiar-clave') {
    if (!isAuthenticated(req)) return redirect(res, '/login');
    if (req.method === 'GET') return sendHtml(res, 200, changePage());
    if (req.method !== 'POST') return false;
    if (!sameOrigin(req)) return sendHtml(res, 403, changePage('Origen no permitido'));
    const ip = clientIp(req);
    const mins = blockedFor(ip);
    if (mins) return sendHtml(res, 429, changePage(`Demasiados intentos. Prueba de nuevo en ${mins} min.`));
    const form = new URLSearchParams((await readBody(req, 4096)).toString());
    const [current, password, repeat] = ['current', 'password', 'repeat'].map((k) => form.get(k) || '');
    if (!checkPassword(current)) {
      await failAttempt(ip);
      return sendHtml(res, 401, changePage('La contraseña actual no es correcta'));
    }
    if (password.length < MIN_PASSWORD) return sendHtml(res, 400, changePage(`La nueva contraseña necesita al menos ${MIN_PASSWORD} caracteres`));
    if (password !== repeat) return sendHtml(res, 400, changePage('Las contraseñas nuevas no coinciden'));
    if (password === current) return sendHtml(res, 400, changePage('La nueva contraseña tiene que ser distinta de la actual'));
    loginAttempts.delete(ip);
    savePassword(password, false);
    console.log('Contraseña cambiada desde la web');
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

function objectUrl(key, cfg = b2) {
  return `${cfg.endpoint}/${encodeRfc3986(cfg.bucket)}/${key.split('/').map(encodeRfc3986).join('/')}`;
}

async function b2Request(method, key, { body, headers = {}, query = '' } = {}, cfg = b2) {
  const url = objectUrl(key, cfg) + query;
  const payload = body ?? Buffer.alloc(0);
  const signed = signRequest({
    method,
    url,
    headers,
    payloadHash: sha256(payload),
    accessKey: cfg.keyId,
    secretKey: cfg.appKey,
    region: cfg.region,
  });
  delete signed.host; // fetch la pone sola
  const res = await fetch(url, { method, headers: signed, body: method === 'GET' || method === 'HEAD' ? undefined : payload });
  if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
    const text = await res.text().catch(() => '');
    const xml = (t) => t.replace(/&(apos|quot|lt|gt|amp);/g, (_, e) => ({ apos: "'", quot: '"', lt: '<', gt: '>', amp: '&' })[e]);
    let msg = xml(text.match(/<Message>([^<]*)<\/Message>/)?.[1] || '') || text.slice(0, 200) || res.statusText;
    // HEAD no trae cuerpo: un 403 de lectura casi siempre es el tope diario de descargas de la cuenta.
    if (/cap exceeded/i.test(msg) || (res.status === 403 && method === 'HEAD')) {
      msg = 'se alcanzó el tope diario de descargas de Backblaze B2 (se renueva a las 00:00 UTC, o súbelo en B2 → Caps & Alerts)';
    }
    throw Object.assign(new Error(`B2 ${res.status}: ${msg}`), { status: res.status === 404 ? 404 : 502 });
  }
  return res;
}

// Lee [start, end) de un objeto de B2 en tramos de RANGE_BYTES, pidiendo cada
// tramo solo cuando hace falta. Así ninguna conexión con B2 queda abierta y
// frenada mucho rato (B2 la corta) aunque quien lee vaya despacio: una descarga
// lenta, o comprimir y extraer, que esperan a que suba lo anterior.
const RANGE_BYTES = 32 * 1024 * 1024; // cada tramo es una lectura (transacción clase B) en B2

function b2RangeStream(key, start, end, version = '') {
  let next = start; // siguiente byte a pedir
  let size = 4 * 1024 * 1024; // los tramos empiezan chicos y se duplican hasta RANGE_BYTES
  const ahead = []; // tramos ya pedidos, en orden (como mucho uno por delante del que se envía)
  const fetchRange = async (from, to) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await b2Request('GET', key, { headers: { range: `bytes=${from}-${to - 1}` }, query: version ? `?versionId=${encodeRfc3986(version)}` : '' });
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length !== to - from) throw new Error(`B2 devolvió ${buf.length} bytes en vez de ${to - from}`);
        return buf;
      } catch (e) {
        if (attempt >= 3 || e.status === 404) throw e;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  };
  // Empezar chico y adelantar solo un tramo importa con vídeo y audio: al saltar a otro
  // punto el navegador abandona la petición, y lo ya pedido a B2 se habría tirado.
  const fill = () => {
    while (ahead.length < 2 && next < end) {
      const to = Math.min(end, next + size);
      size = Math.min(RANGE_BYTES, size * 2);
      const p = fetchRange(next, to);
      p.catch(() => {}); // el error se recoge al esperarlo, en orden
      ahead.push(p);
      next = to;
    }
  };
  let busy = false;
  return new Readable({
    highWaterMark: 1024 * 1024,
    async read() {
      if (busy) return;
      busy = true;
      try {
        fill();
        if (!ahead.length) return this.push(null);
        const buf = await ahead.shift();
        fill();
        this.push(buf);
      } catch (e) {
        this.destroy(e);
      } finally {
        busy = false;
      }
    },
  });
}

// Envía un archivo de B2 al navegador, con soporte de Range (adelantar vídeos,
// reanudar descargas). `extra` añade cabeceras (descarga, caché…).
async function sendB2File(req, res, key, extra = {}, version = '') {
  const head = await b2Request('HEAD', key, { query: version ? `?versionId=${encodeRfc3986(version)}` : '' });
  const size = Number(head.headers.get('content-length')) || 0;
  const etag = head.headers.get('etag');
  const headers = {
    'content-type': head.headers.get('content-type') || 'application/octet-stream',
    'accept-ranges': 'bytes',
    ...(etag ? { etag } : {}),
    ...extra,
  };
  if (/html|svg|xml|javascript/i.test(headers['content-type'])) {
    headers['content-security-policy'] = 'sandbox';
    headers['x-content-type-options'] = 'nosniff';
  }
  // El navegador pregunta si su copia sigue valiendo: si no cambió, no se baja nada de B2.
  if (etag && req.headers['if-none-match'] === etag && !req.headers.range) {
    res.writeHead(304, { etag, 'cache-control': headers['cache-control'] || 'no-cache' });
    return res.end();
  }
  let [start, end] = [0, size];
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && size) {
    if (range[1]) [start, end] = [Number(range[1]), range[2] ? Math.min(size, Number(range[2]) + 1) : size];
    else [start, end] = [Math.max(0, size - Number(range[2])), size];
    if (start >= end || start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      return res.end();
    }
    headers['content-range'] = `bytes ${start}-${end - 1}/${size}`;
  }
  headers['content-length'] = end - start;
  res.writeHead(headers['content-range'] ? 206 : 200, headers);
  if (req.method === 'HEAD' || end === start) return res.end();
  const stream = b2RangeStream(key, start, end, version);
  stream.on('error', (e) => {
    console.error(`Descarga cortada (${key}): ${e.message}`);
    res.destroy(e);
  });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

// ---------------------------------------------------------------------------
// App Claude: terminal real por WebSocket (/api/pty)
// ---------------------------------------------------------------------------
//
// Este servidor nunca ejecuta `claude` por sí mismo: node-pty lanza un *cliente*
// de tmux que se conecta al servidor tmux de un usuario sin privilegios (el
// servicio miputer-claude), y es ese servidor el que corre Claude Code. Cerrar la
// ventana o perder la conexión mata el cliente; la sesión sigue viva para poder
// retomarla hasta que se termina a mano o pasa CLAUDE_IDLE_HOURS sin nadie conectado.

const CLAUDE_SOCKET = process.env.CLAUDE_TMUX_SOCKET || '';
const CLAUDE_WORKDIR = process.env.CLAUDE_WORKDIR || '';
const CLAUDE_MAX = Math.max(1, Number(process.env.CLAUDE_MAX_SESSIONS || 3));
const CLAUDE_IDLE_MS = Number(process.env.CLAUDE_IDLE_HOURS || 24) * 3600_000;
// Shell de login: tmux pasa el PATH del cliente (este servidor), no el del usuario de Claude.
const CLAUDE_CMD = `exec bash -lc 'claude; echo; echo "Claude se ha cerrado. Escribe claude para volver a abrirlo."; exec bash -l'`;
const ptyClients = new Set();

let pty = null;
let WebSocketServer = null;
try {
  ({ WebSocketServer } = await import('ws'));
} catch (e) {
  console.error(`Sin WebSockets (¿falta npm install?): ${e.message}`);
}
if (CLAUDE_SOCKET) {
  try {
    pty = (await import('node-pty')).default;
  } catch (e) {
    console.error(`App Claude desactivada (¿falta npm install?): ${e.message}`);
  }
}
// Sin contraseña no se ofrece nunca una terminal: cualquiera podría abrirla.
const claudeEnabled = () => Boolean(auth.enabled && CLAUDE_SOCKET && pty && WebSocketServer);

function tmux(...args) {
  return new Promise((resolve) => {
    execFile('tmux', ['-S', CLAUDE_SOCKET, ...args], { timeout: 5000 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

async function claudeSessions() {
  const out = await tmux('list-sessions', '-F', '#{session_name} #{session_attached} #{session_activity}');
  return out
    .split('\n')
    .map((line) => line.split(' '))
    .filter(([name]) => /^mp-\d+$/.test(name))
    .map(([name, attached, activity]) => ({ slot: Number(name.slice(3)), attached: Number(attached), activity: Number(activity) * 1000 }));
}

// Evita el secuestro de WebSocket entre sitios: el navegador siempre envía Origin.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  const proto = (process.env.TRUST_PROXY === 'true' && req.headers['x-forwarded-proto']?.split(',')[0].trim()) || 'http';
  const extra = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return origin === `${proto}://${req.headers.host}` || extra.includes(origin);
}

const clamp = (n, min, max) => Math.min(max, Math.max(min, Math.floor(Number(n)) || min));

function attachClaude(ws, slot, cols, rows) {
  const args = ['-u', '-S', CLAUDE_SOCKET, 'new-session', '-A', '-s', `mp-${slot}`];
  if (CLAUDE_WORKDIR) args.push('-c', CLAUDE_WORKDIR);
  args.push(CLAUDE_CMD);
  const term = pty.spawn('tmux', args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: '/',
    env: { TERM: 'xterm-256color', LANG: 'C.UTF-8', PATH: process.env.PATH },
  });
  let alive = true;
  const ping = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 30_000);

  term.onData((data) => ws.readyState === ws.OPEN && ws.send(data));
  term.onExit(() => ws.close(1000));
  ws.on('pong', () => (alive = true));
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.t === 'i' && typeof msg.d === 'string') term.write(msg.d);
    else if (msg.t === 'r') term.resize(clamp(msg.c, 2, 500), clamp(msg.r, 2, 200));
  });
  ws.on('close', () => {
    clearInterval(ping);
    ptyClients.delete(ws);
    try {
      term.kill();
    } catch {}
  });
}

function handleUpgrade(req, socket, head) {
  const reject = (status) => socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\n\r\n`);
  const url = new URL(req.url, 'http://localhost');
  if (!['/api/pty', '/api/rdp', '/api/claude-chat'].includes(url.pathname)) return reject(404);
  if (!auth.enabled || !isAuthenticated(req)) return reject(401);
  if (auth.mustChange) return reject(403);
  if (!sameOrigin(req)) return reject(403);
  if (url.pathname === '/api/rdp') return handleRdpUpgrade(req, socket, head, url, reject);
  if (url.pathname === '/api/claude-chat') return handleChatUpgrade(req, socket, head, reject);
  if (!claudeEnabled()) return reject(404);
  const slot = Number(url.searchParams.get('slot'));
  if (!Number.isInteger(slot) || slot < 1 || slot > CLAUDE_MAX) return reject(400);
  if (ptyClients.size >= CLAUDE_MAX) return reject(429);
  const placeholder = {};
  ptyClients.add(placeholder);
  wss.handleUpgrade(req, socket, head, (ws) => {
    ptyClients.delete(placeholder);
    ptyClients.add(ws);
    attachClaude(ws, slot, clamp(url.searchParams.get('cols'), 2, 500), clamp(url.searchParams.get('rows'), 2, 200));
  });
}

const wss = claudeEnabled() ? new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 }) : null;
// El cliente de Guacamole pide el subprotocolo "guacamole".
const rdpWss = WebSocketServer ? new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, handleProtocols: (protocols) => (protocols.has('guacamole') ? 'guacamole' : false) }) : null;

// Cierra las sesiones que llevan CLAUDE_IDLE_HOURS sin nadie conectado.
if (wss && CLAUDE_IDLE_MS > 0) {
  setInterval(async () => {
    for (const s of await claudeSessions()) {
      if (!s.attached && Date.now() - s.activity > CLAUDE_IDLE_MS) await tmux('kill-session', '-t', `mp-${s.slot}`);
    }
  }, 10 * 60_000).unref();
}

async function handleClaudeApi(req, res, url) {
  if (url.pathname === '/api/claude' && req.method === 'GET') {
    if (!claudeEnabled()) return sendJson(res, 200, { enabled: false });
    return sendJson(res, 200, { enabled: true, max: CLAUDE_MAX, sessions: await claudeSessions() });
  }
  // Termina una sesión (mata Claude): POST /api/claude/kill?slot=N
  if (url.pathname === '/api/claude/kill' && req.method === 'POST') {
    if (!claudeEnabled()) return sendJson(res, 404, { error: 'La app Claude no está activada' });
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Origen no permitido' });
    const slot = Number(url.searchParams.get('slot'));
    if (!Number.isInteger(slot) || slot < 1 || slot > CLAUDE_MAX) return sendJson(res, 400, { error: 'Sesión no válida' });
    await tmux('kill-session', '-t', `mp-${slot}`);
    return sendJson(res, 200, { ok: true });
  }
  return false;
}

// ---------------------------------------------------------------------------
// Árbol de carpetas en el servidor (/api/tree)
// ---------------------------------------------------------------------------
//
// El árbol (carpetas, nombres, textos pequeños y la papelera) se guarda en
// data/arbol.json para verlo igual desde cualquier navegador. Cada guardado sube
// la versión; si un navegador escribe sobre una versión vieja recibe 409 con la
// actual. Además se deja una copia en B2 (PREFIX/.arbol.json) para recuperarlo si
// se pierde el disco del servidor.

const DATA_DIR = join(ROOT, 'data');
const TREE_FILE = join(DATA_DIR, 'arbol.json');
const TREE_B2_KEY = `${PREFIX}.arbol.json`;
const MAX_TREE_BYTES = 20 * 1024 * 1024;
let tree = null; // { version, tree, updated }
let treeBackupTimer = null;

async function loadTree() {
  if (tree) return tree;
  if (existsSync(TREE_FILE)) {
    tree = JSON.parse(readFileSync(TREE_FILE, 'utf8'));
  } else if (b2.enabled) {
    // Disco nuevo o perdido: se recupera la última copia de B2 si existe.
    try {
      const r = await b2Request('GET', TREE_B2_KEY);
      tree = JSON.parse(await r.text());
      saveTreeFile();
      console.log(`Árbol de carpetas recuperado desde B2 (versión ${tree.version})`);
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  tree ??= { version: 0, tree: null, updated: 0 };
  return tree;
}

function saveTreeFile() {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${TREE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(tree), { mode: 0o600 });
  renameSync(tmp, TREE_FILE);
}

function scheduleTreeBackup() {
  if (!b2.enabled) return;
  clearTimeout(treeBackupTimer);
  treeBackupTimer = setTimeout(() => {
    b2Request('PUT', TREE_B2_KEY, { body: Buffer.from(JSON.stringify(tree)), headers: { 'content-type': 'application/json' } }).catch((e) =>
      console.error(`No se pudo copiar el árbol a B2: ${e.message}`),
    );
  }, 10_000);
}

async function handleTree(req, res) {
  const current = await loadTree();
  if (req.method === 'GET') return sendJson(res, 200, current);
  if (req.method !== 'PUT') return sendJson(res, 405, { error: 'Método no permitido' });
  if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Origen no permitido' });
  let input;
  try {
    input = JSON.parse((await readBody(req, MAX_TREE_BYTES)).toString());
  } catch (e) {
    return sendJson(res, e.status || 400, { error: e.status ? e.message : 'Datos no válidos' });
  }
  if (input?.tree?.type !== 'dir' || typeof input.tree.children !== 'object') return sendJson(res, 400, { error: 'Árbol no válido' });
  if (input.baseVersion !== current.version) return sendJson(res, 409, current);
  tree = { version: current.version + 1, tree: input.tree, updated: Date.now() };
  saveTreeFile();
  scheduleTreeBackup();
  return sendJson(res, 200, { version: tree.version });
}

// ---------------------------------------------------------------------------
// Subida por partes (/api/uploads) para archivos de más de 100 MB
// ---------------------------------------------------------------------------
//
// El navegador trocea el archivo y manda cada parte; el servidor la reenvía a B2
// (UploadPart) y al final pide a B2 que las una. Las subidas a medias se anulan
// solas a las 24 h para que no ocupen espacio en el bucket.

const uploads = new Map(); // id -> { key, type, size, name, b2Id, etags: [], created }
const xmlTag = (xml, tag) => xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1];

async function handleUploads(req, res, url) {
  const route = url.pathname;
  if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Origen no permitido' });

  if (route === '/api/uploads' && req.method === 'POST') {
    const size = Number(url.searchParams.get('size'));
    if (!Number.isFinite(size) || size <= 0) return sendJson(res, 400, { error: 'Tamaño no válido' });
    if (size > MAX_UPLOAD_BYTES) return sendJson(res, 413, { error: `El archivo supera el límite de ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024 / 1024)} GB` });
    const name = url.searchParams.get('name');
    const type = url.searchParams.get('type') || 'application/octet-stream';
    const key = newKey(name);
    const r = await b2Request('POST', key, { query: '?uploads', headers: { 'content-type': type } });
    const b2Id = xmlTag(await r.text(), 'UploadId');
    if (!b2Id) throw Object.assign(new Error('B2 no devolvió el identificador de la subida'), { status: 502 });
    const id = crypto.randomUUID();
    uploads.set(id, { key, type, size, b2Id, etags: [], created: Date.now() });
    return sendJson(res, 201, { id, key, partSize: PART_BYTES, parts: Math.ceil(size / PART_BYTES) });
  }

  const up = uploads.get(url.searchParams.get('id'));
  if (!up) return sendJson(res, 404, { error: 'La subida no existe o caducó' });

  if (route === '/api/uploads/part' && req.method === 'PUT') {
    const n = Number(url.searchParams.get('n'));
    if (!Number.isInteger(n) || n < 1 || n > Math.ceil(up.size / PART_BYTES)) return sendJson(res, 400, { error: 'Parte no válida' });
    const body = await readBody(req, PART_BYTES);
    const r = await b2Request('PUT', up.key, { body, query: `?partNumber=${n}&uploadId=${encodeRfc3986(up.b2Id)}` });
    up.etags[n - 1] = r.headers.get('etag');
    return sendJson(res, 200, { n });
  }

  if (route === '/api/uploads/complete' && req.method === 'POST') {
    const total = Math.ceil(up.size / PART_BYTES);
    if (up.etags.filter(Boolean).length !== total) return sendJson(res, 400, { error: 'Faltan partes por subir' });
    const xml = `<CompleteMultipartUpload>${up.etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
    const r = await b2Request('POST', up.key, { body: Buffer.from(xml), query: `?uploadId=${encodeRfc3986(up.b2Id)}`, headers: { 'content-type': 'application/xml' } });
    const text = await r.text();
    if (text.includes('<Error>')) throw Object.assign(new Error(`B2: ${xmlTag(text, 'Message') || 'no se pudo completar la subida'}`), { status: 502 });
    uploads.delete(url.searchParams.get('id'));
    return sendJson(res, 201, { key: up.key, size: up.size, type: up.type });
  }

  if (route === '/api/uploads' && req.method === 'DELETE') {
    uploads.delete(url.searchParams.get('id'));
    await b2Request('DELETE', up.key, { query: `?uploadId=${encodeRfc3986(up.b2Id)}` }).catch(() => {});
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { error: 'Ruta no encontrada' });
}

setInterval(() => {
  for (const [id, up] of uploads) {
    if (Date.now() - up.created < 24 * 3600_000) continue;
    uploads.delete(id);
    b2Request('DELETE', up.key, { query: `?uploadId=${encodeRfc3986(up.b2Id)}` }).catch(() => {});
  }
}, 3600_000).unref();

// ---------------------------------------------------------------------------
// ZIP: comprimir y extraer en el servidor (/api/zip, /api/unzip, /api/jobs)
// ---------------------------------------------------------------------------
//
// Todo va de B2 a B2 sin pasar por el navegador ni por el disco: al comprimir se
// leen los archivos de B2 y el zip se sube por partes mientras se genera; al
// extraer, el zip se lee por rangos (nunca entero) y cada archivo se sube al
// bucket. Son tareas en segundo plano: el navegador consulta /api/jobs?id=…

let yazl = null;
let yauzl = null;
try {
  yazl = (await import('yazl')).default;
  yauzl = (await import('yauzl')).default;
} catch (e) {
  console.error(`ZIP desactivado (¿falta npm install?): ${e.message}`);
}

const ZIP_MAX_ENTRIES = 20_000;
const UNZIP_MAX_BYTES = 20 * 1024 ** 3; // tope de lo descomprimido, contra "bombas zip"
// Formatos que ya vienen comprimidos: se guardan tal cual (comprimirlos no reduce nada).
const ALREADY_COMPRESSED = /\.(zip|rar|7z|gz|tgz|bz2|xz|zst|jpe?g|png|gif|webp|heic|avif|mp[34]|m4a|aac|mov|mkv|avi|webm|ogg|opus|flac|pdf|docx|xlsx|pptx|odt|ods|odp|apk|jar|iso)$/i;
const MIME_BY_EXT = {
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript',
  json: 'application/json', xml: 'application/xml', pdf: 'application/pdf', zip: 'application/zip', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
};
const mimeOf = (name) => MIME_BY_EXT[name.split('.').pop().toLowerCase()] || 'application/octet-stream';

const jobs = new Map(); // id -> { state: 'running' | 'done' | 'error', progress, result, error }

function startJob(run) {
  const id = crypto.randomUUID();
  const job = { state: 'running', progress: 0 };
  jobs.set(id, job);
  run(job)
    .then(
      (result) => Object.assign(job, { state: 'done', progress: 1, result }),
      (e) => {
        console.error(`Tarea ${id}: ${e.message}`);
        Object.assign(job, { state: 'error', error: e.message });
      },
    )
    .finally(() => setTimeout(() => jobs.delete(id), 3600_000).unref());
  return id;
}

const multipartXml = (etags) =>
  `<CompleteMultipartUpload>${etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;

// Sube un stream de cualquier tamaño a B2 por partes (hasta 3 a la vez) y devuelve
// los bytes subidos. El stream se frena mientras haya 3 partes en camino.
async function streamToB2(readable, key, type) {
  const created = await b2Request('POST', key, { query: '?uploads', headers: { 'content-type': type } });
  const b2Id = xmlTag(await created.text(), 'UploadId');
  if (!b2Id) throw new Error('B2 no devolvió el identificador de la subida');
  const etags = [];
  const parts = [];
  const inflight = new Set();
  let chunks = [];
  let pending = 0;
  let total = 0;
  const flush = () => {
    const body = Buffer.concat(chunks);
    chunks = [];
    pending = 0;
    const n = parts.length + 1;
    const p = b2Request('PUT', key, { body, query: `?partNumber=${n}&uploadId=${encodeRfc3986(b2Id)}` }).then((r) => {
      etags[n - 1] = r.headers.get('etag');
    });
    parts.push(p);
    inflight.add(p);
    p.catch(() => {}).finally(() => inflight.delete(p));
  };
  try {
    for await (const chunk of readable) {
      chunks.push(chunk);
      pending += chunk.length;
      total += chunk.length;
      if (pending >= PART_BYTES) {
        flush();
        while (inflight.size >= 3) await Promise.race(inflight);
      }
    }
    if (pending || !parts.length) flush();
    await Promise.all(parts);
    const done = await b2Request('POST', key, {
      body: Buffer.from(multipartXml(etags)),
      query: `?uploadId=${encodeRfc3986(b2Id)}`,
      headers: { 'content-type': 'application/xml' },
    });
    const text = await done.text();
    if (text.includes('<Error>')) throw new Error(`B2: ${xmlTag(text, 'Message') || 'no se pudo completar la subida'}`);
    return total;
  } catch (e) {
    await Promise.allSettled(parts);
    await b2Request('DELETE', key, { query: `?uploadId=${encodeRfc3986(b2Id)}` }).catch(() => {});
    throw e;
  }
}

// Rutas dentro del zip: sin "..", sin barras al principio y con "/" como separador.
function zipPath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    .join('/')
    .slice(0, 1000);
}

function decodeData(data) {
  const m = data.match(/^data:[^,]*?(;base64)?,/);
  if (!m) return Buffer.from(data, 'utf8');
  const payload = data.slice(m[0].length);
  return m[1] ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
}

async function handleZip(req, res) {
  let input;
  try {
    input = JSON.parse((await readBody(req, 64 * 1024 * 1024)).toString());
  } catch (e) {
    return sendJson(res, e.status || 400, { error: e.status ? e.message : 'Datos no válidos' });
  }
  const entries = Array.isArray(input.entries) ? input.entries : [];
  if (!entries.length || entries.length > ZIP_MAX_ENTRIES) return sendJson(res, 400, { error: `Se pueden comprimir entre 1 y ${ZIP_MAX_ENTRIES} elementos` });
  const clean = entries.map((e) => ({
    path: zipPath(e.path),
    dir: Boolean(e.dir),
    key: e.key ? checkKey(e.key) : null,
    data: typeof e.data === 'string' ? e.data : '',
    size: Math.max(0, Number(e.size) || 0),
  }));
  if (clean.some((e) => !e.path)) return sendJson(res, 400, { error: 'Hay un nombre de archivo no válido' });
  const name = String(input.name || 'archivo.zip');
  const key = newKey(name.toLowerCase().endsWith('.zip') ? name : `${name}.zip`);
  const total = clean.reduce((a, e) => a + (e.key ? e.size : 0), 0) || 1;

  const id = startJob(async (job) => {
    const zip = new yazl.ZipFile();
    let read = 0;
    for (const e of clean) {
      const opts = { compress: !ALREADY_COMPRESSED.test(e.path) };
      if (e.dir) {
        zip.addEmptyDirectory(e.path);
      } else if (e.key) {
        // Lazy: cada archivo se pide a B2 recién cuando le toca, de a uno.
        zip.addReadStreamLazy(e.path, opts, (cb) => {
          b2Request('HEAD', e.key).then((head) => {
            const counter = new Transform({
              transform(chunk, _, done) {
                read += chunk.length;
                job.progress = Math.min(0.99, read / total);
                done(null, chunk);
              },
            });
            const src = b2RangeStream(e.key, 0, Number(head.headers.get('content-length')) || 0);
            src.on('error', (err) => counter.destroy(err));
            cb(null, src.pipe(counter));
          }, cb);
        });
      } else {
        zip.addBuffer(decodeData(e.data), e.path, opts);
      }
    }
    zip.on('error', (err) => zip.outputStream.destroy(err));
    zip.end();
    const size = await streamToB2(zip.outputStream, key, 'application/zip');
    return { key, size, type: 'application/zip' };
  });
  return sendJson(res, 202, { job: id });
}

// Lector de yauzl que pide a B2 solo los bytes que necesita, por tramos.
function b2RangeReader(key) {
  const reader = new yauzl.RandomAccessReader();
  reader._readStreamForRange = (start, end) => b2RangeStream(key, start, end);
  return reader;
}

async function handleUnzip(req, res) {
  let input;
  try {
    input = JSON.parse((await readBody(req, 8192)).toString());
  } catch {
    return sendJson(res, 400, { error: 'Datos no válidos' });
  }
  const key = checkKey(input.key);
  const head = await b2Request('HEAD', key);
  const zipSize = Number(head.headers.get('content-length'));

  const id = startJob(async (job) => {
    const zipfile = await yauzl.fromRandomAccessReaderPromise(b2RangeReader(key), zipSize, { validateEntrySizes: true, strictFileNames: false });
    if (zipfile.entryCount > ZIP_MAX_ENTRIES) throw new Error(`El zip tiene más de ${ZIP_MAX_ENTRIES} elementos`);
    const files = [];
    const dirs = new Set();
    const uploaded = [];
    let unpacked = 0;
    let seen = 0;
    try {
      for await (const entry of zipfile.eachEntry()) {
        seen++;
        job.progress = Math.min(0.99, seen / Math.max(1, zipfile.entryCount));
        const path = zipPath(entry.fileName);
        if (!path || path.startsWith('__MACOSX/') || path.endsWith('.DS_Store')) continue;
        if (entry.fileName.endsWith('/')) {
          dirs.add(path);
          continue;
        }
        if (entry.isEncrypted()) throw new Error('El zip tiene contraseña: no se puede extraer aquí');
        unpacked += entry.uncompressedSize;
        if (unpacked > UNZIP_MAX_BYTES) throw new Error('El contenido descomprimido supera 20 GB');
        const name = path.split('/').pop();
        const type = mimeOf(name);
        const fileKey = newKey(name);
        const stream = await zipfile.openReadStreamPromise(entry);
        if (entry.uncompressedSize <= PART_BYTES) {
          const chunks = [];
          for await (const c of stream) chunks.push(c);
          await b2Request('PUT', fileKey, { body: Buffer.concat(chunks), headers: { 'content-type': type } });
        } else {
          await streamToB2(stream, fileKey, type);
        }
        uploaded.push(fileKey);
        files.push({ path, key: fileKey, size: entry.uncompressedSize, type });
      }
    } catch (e) {
      // Si algo falla a medias no quedan archivos huérfanos en el bucket.
      await Promise.all(uploaded.map((k) => b2Request('DELETE', k).catch(() => {})));
      throw e;
    } finally {
      zipfile.close();
    }
    return { files, dirs: [...dirs] };
  });
  return sendJson(res, 202, { job: id });
}

async function handleZipApi(req, res, url) {
  if (url.pathname === '/api/jobs' && req.method === 'GET') {
    const job = jobs.get(url.searchParams.get('id'));
    return job ? sendJson(res, 200, job) : sendJson(res, 404, { error: 'La tarea no existe o caducó' });
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Método no permitido' });
  if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Origen no permitido' });
  if (!yazl || !yauzl) return sendJson(res, 503, { error: 'ZIP no disponible en el servidor (falta npm install)' });
  if (!b2.enabled) return sendJson(res, 503, { error: 'Backblaze B2 no está configurado en el servidor' });
  if (url.pathname === '/api/zip') return handleZip(req, res);
  if (url.pathname === '/api/unzip') return handleUnzip(req, res);
  return sendJson(res, 404, { error: 'Ruta no encontrada' });
}

// ---------------------------------------------------------------------------
// Herramientas PDF del servidor (/api/pdf): comprimir, proteger, quitar
// contraseña y reparar, con Ghostscript y qpdf
// ---------------------------------------------------------------------------
//
// Lo que se puede hacer en el navegador (unir, dividir, numerar…) se hace allí;
// esto es lo que necesita programas del sistema. El PDF se baja de B2 a una
// carpeta temporal privada del servicio (PrivateTmp), se procesa con tiempo
// límite y el resultado se sube a B2. Las contraseñas van en un archivo de
// argumentos (qpdf @archivo), no en la línea de comandos que ve `ps`.

const PDF_MAX_BYTES = 300 * 1024 * 1024;
const PDF_TIMEOUT_MS = 5 * 60_000;
const GS_QUALITY = { baja: '/printer', media: '/ebook', alta: '/screen' }; // "alta" = comprime más

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: PDF_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      // qpdf sale con 3 cuando terminó bien pero con avisos (p. ej. tras reparar).
      if (err && !(cmd === 'qpdf' && err.code === 3)) {
        const msg = `${stderr || ''}`.trim().split('\n').slice(-2).join(' ') || err.message;
        return reject(new Error(/password/i.test(msg) ? 'Contraseña incorrecta' : msg.slice(0, 300)));
      }
      resolve(stdout);
    });
  });
}

async function handlePdfOps(req, res) {
  if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Origen no permitido' });
  if (!b2.enabled) return sendJson(res, 503, { error: 'Backblaze B2 no está configurado en el servidor' });
  let input;
  try {
    input = JSON.parse((await readBody(req, 8192)).toString());
  } catch {
    return sendJson(res, 400, { error: 'Datos no válidos' });
  }
  const { op } = input;
  if (!['compress', 'protect', 'unlock', 'repair'].includes(op)) return sendJson(res, 400, { error: 'Operación no válida' });
  const key = checkKey(input.key);
  const password = String(input.password || '');
  if (op === 'protect' && !password) return sendJson(res, 400, { error: 'Falta la contraseña' });
  if (/[\r\n]/.test(password)) return sendJson(res, 400, { error: 'La contraseña no puede tener saltos de línea' });
  if (op === 'protect' && password.length > 128) return sendJson(res, 400, { error: 'Contraseña demasiado larga' });
  const head = await b2Request('HEAD', key);
  const size = Number(head.headers.get('content-length')) || 0;
  if (size > PDF_MAX_BYTES) return sendJson(res, 413, { error: 'El PDF supera 300 MB' });
  const name = String(input.name || 'documento.pdf').slice(0, 200);

  const id = startJob(async (job) => {
    const dir = await mkdtemp(join(tmpdir(), 'miputer-pdf-'));
    const src = join(dir, 'entrada.pdf');
    const out = join(dir, 'salida.pdf');
    try {
      await pipeline(b2RangeStream(key, 0, size), createWriteStream(src, { mode: 0o600 }));
      job.progress = 0.3;
      if (op === 'compress') {
        const level = GS_QUALITY[input.level] || GS_QUALITY.media;
        await run('gs', ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-dQUIET', '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.6', `-dPDFSETTINGS=${level}`, '-dDetectDuplicateImages=true', `-sOutputFile=${out}`, src]);
      } else if (op === 'repair') {
        await run('qpdf', ['--object-streams=generate', src, out]);
      } else {
        // Contraseña en un archivo de argumentos, uno por línea.
        const argfile = join(dir, 'args');
        const args =
          op === 'protect'
            ? ['--encrypt', password, `${password}-${crypto.randomBytes(16).toString('hex')}`, '256', '--', src, out]
            : [...(password ? [`--password=${password}`] : []), '--decrypt', src, out];
        await writeFile(argfile, `${args.join('\n')}\n`, { mode: 0o600 });
        await run('qpdf', [`@${argfile}`]);
      }
      job.progress = 0.8;
      const outSize = (await stat(out)).size;
      // Comprimir no siempre achica (PDF ya optimizado): en ese caso se avisa en vez de engordarlo.
      if (op === 'compress' && outSize >= size) return { unchanged: true, size };
      const newKeyName = newKey(name);
      await streamToB2(createReadStream(out), newKeyName, 'application/pdf');
      return { key: newKeyName, size: outSize, type: 'application/pdf', before: size };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  return sendJson(res, 202, { job: id });
}

// ---------------------------------------------------------------------------
// Enlaces de descarga para compartir (/d/<token>)
// ---------------------------------------------------------------------------
//
// Un enlace da acceso a UN archivo de B2 sin iniciar sesión, hasta que caduca,
// se agotan sus descargas o se desactiva. El token es aleatorio (192 bits) y los
// enlaces se guardan en data/enlaces.json.

const SHARES_FILE = join(DATA_DIR, 'enlaces.json');
const SHARE_HOURS = [1, 24, 24 * 7, 24 * 30];
let shares = existsSync(SHARES_FILE) ? JSON.parse(readFileSync(SHARES_FILE, 'utf8')) : {};

function saveShares() {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${SHARES_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(shares), { mode: 0o600 });
  renameSync(tmp, SHARES_FILE);
}

// Tipos: archivo (por defecto, los enlaces viejos no lo tienen), carpeta y "pedir archivos".
const shareType = (sh) => sh.type || 'file';
const shareAlive = (sh) =>
  sh.expires > Date.now() &&
  (shareType(sh) === 'upload' ? !sh.maxFiles || sh.files < sh.maxFiles : !sh.maxDownloads || sh.downloads < sh.maxDownloads);

function purgeShares() {
  const dead = Object.keys(shares).filter((t) => !shareAlive(shares[t]));
  dead.forEach((t) => delete shares[t]);
  if (dead.length) saveShares();
}

function siteOrigin(req) {
  const proto = (process.env.TRUST_PROXY === 'true' && req.headers['x-forwarded-proto']?.split(',')[0].trim()) || 'http';
  return `${proto}://${req.headers.host}`;
}

const shareView = (req, token, sh) => ({
  token,
  type: shareType(sh),
  url: `${siteOrigin(req)}/${shareType(sh) === 'upload' ? 'u' : 'd'}/${token}`,
  key: sh.key,
  dir: sh.dir,
  name: sh.name,
  size: sh.size,
  created: sh.created,
  expires: sh.expires,
  downloads: sh.downloads,
  maxDownloads: sh.maxDownloads,
  files: sh.files,
  bytes: sh.bytes,
  maxFiles: sh.maxFiles,
  maxBytes: sh.maxBytes,
});

// ---- El árbol visto desde el servidor (carpetas compartidas, archivos recibidos) ----

const treePath = (p) => String(p || '').split('/').filter((s) => s && s !== '.' && s !== '..');

async function treeNode(path) {
  let node = (await loadTree()).tree;
  for (const part of treePath(path)) node = node?.type === 'dir' ? node.children[part] : undefined;
  return node || null;
}

function uniqueChild(children, name) {
  if (!children[name]) return name;
  const dot = name.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 2; ; i++) if (!children[`${base} (${i})${ext}`]) return `${base} (${i})${ext}`;
}

// Agrega archivos ya subidos a B2 a una carpeta del árbol (la crea si no existe).
async function addFilesToTree(dir, files) {
  const current = await loadTree();
  if (!current.tree) throw new Error('El árbol de carpetas todavía no existe');
  let node = current.tree;
  for (const part of treePath(dir)) {
    if (node.children[part]?.type !== 'dir') node.children[part] = { type: 'dir', children: {}, mtime: Date.now() };
    node = node.children[part];
  }
  const names = files.map((f) => {
    const name = uniqueChild(node.children, f.name);
    node.children[name] = { type: 'file', content: '', remote: { key: f.key, size: f.size, type: f.type }, mtime: Date.now() };
    return name;
  });
  node.mtime = Date.now();
  tree = { version: current.version + 1, tree: current.tree, updated: Date.now() };
  saveTreeFile();
  scheduleTreeBackup();
  return names;
}

// ---- Archivos de MiPuter para Claude (herramientas miputer_* del chat) ----------
//
// Claude no ve el árbol de carpetas: pide operaciones al puente, el puente las
// pasa por la conexión del chat y aquí se hacen sobre el árbol del servidor y B2.
// Solo se puede tocar lo que cuelga de "/" (no la papelera salvo para borrar).

const TEXT_EXT = /\.(txt|md|csv|json|js|mjs|ts|py|html?|css|xml|ya?ml|ini|sh|log|sql|php|java|c|cpp|h|go|rs|rb)$/i;
const CLAUDE_FILE_MAX = 35 * 1024 * 1024; // lo que entra cómodo por la conexión del chat
const mimeFor = (name) => (TEXT_EXT.test(name) ? 'text/plain; charset=utf-8' : mimeOf(name));

function normTreePath(p) {
  const parts = treePath(p);
  if (!parts.length) throw new Error('Indica una ruta dentro de MiPuter, por ejemplo /Escritorio/nota.txt');
  if (parts[0] === 'Papelera') throw new Error('La papelera no se puede tocar directamente');
  return parts;
}

// Cambia el árbol del servidor con `fn(raíz)` y lo guarda como una versión nueva.
async function mutateTree(fn) {
  const current = await loadTree();
  if (!current.tree) throw new Error('El árbol de carpetas todavía no existe');
  const result = await fn(current.tree);
  tree = { version: current.version + 1, tree: current.tree, updated: Date.now() };
  saveTreeFile();
  scheduleTreeBackup();
  return result;
}

function parentOf(root, parts, create) {
  let node = root;
  for (const part of parts.slice(0, -1)) {
    if (node.children[part]?.type !== 'dir') {
      if (!create) throw new Error(`No existe la carpeta /${parts.slice(0, parts.indexOf(part) + 1).join('/')}`);
      node.children[part] = { type: 'dir', children: {}, mtime: Date.now() };
    }
    node = node.children[part];
  }
  return node;
}

async function writeTreeFile(path, bytes, type) {
  const parts = normTreePath(path);
  const name = parts.at(-1);
  // Si ya existía en B2 se sobrescribe la misma clave: así queda como versión anterior.
  const existing = (await treeNode(`/${parts.join('/')}`)) || null;
  if (existing?.type === 'dir') throw new Error(`/${parts.join('/')} es una carpeta`);
  let remote = null;
  if (b2.enabled) {
    const key = existing?.remote?.key || newKey(name);
    await b2Request('PUT', key, { body: bytes, headers: { 'content-type': type } });
    removeThumb(key);
    remote = { key, size: bytes.length, type };
  }
  await mutateTree((root) => {
    const parent = parentOf(root, parts, true);
    parent.children[name] = remote ? { type: 'file', content: '', remote, mtime: Date.now() } : { type: 'file', content: bytes.toString('utf8'), mtime: Date.now() };
    parent.mtime = Date.now();
  });
  return { ruta: `/${parts.join('/')}`, bytes: bytes.length, reemplazado: Boolean(existing) };
}

async function readTreeBytes(path, max) {
  const node = await treeNode(`/${treePath(path).join('/')}`);
  if (!node) throw new Error(`No existe ${path}`);
  if (node.type === 'dir') throw new Error(`${path} es una carpeta: usa miputer_listar`);
  if (node.remote) {
    if (node.remote.size > max) throw new Error(`Pesa ${human(node.remote.size)}: el máximo es ${human(max)}`);
    const r = await b2Request('GET', node.remote.key);
    return { bytes: Buffer.from(await r.arrayBuffer()), type: node.remote.type };
  }
  return node.content.startsWith('data:') ? { bytes: decodeData(node.content), type: node.content.slice(5, node.content.indexOf(';')) } : { bytes: Buffer.from(node.content, 'utf8'), type: 'text/plain' };
}

async function claudeFsAction(action, a = {}) {
  switch (action) {
    case 'listar': {
      const path = `/${treePath(a.ruta || '/').join('/')}`;
      const node = await treeNode(path);
      if (node?.type !== 'dir') throw new Error(`No existe la carpeta ${path}`);
      return Object.entries(node.children).map(([nombre, n]) => ({
        nombre,
        tipo: n.type === 'dir' ? 'carpeta' : 'archivo',
        ...(n.type === 'file' ? { tamaño: n.remote ? n.remote.size : n.content.length } : { elementos: Object.keys(n.children).length }),
        modificado: new Date(n.mtime).toISOString(),
      }));
    }
    case 'leer': {
      const { bytes } = await readTreeBytes(a.ruta, 2 * 1024 * 1024);
      const text = bytes.toString('utf8');
      if (text.includes('�') || bytes.includes(0)) throw new Error('No es un archivo de texto: usa miputer_traer para copiarlo a tu carpeta de trabajo');
      return text;
    }
    case 'escribir': {
      const contenido = String(a.contenido ?? '');
      if (Buffer.byteLength(contenido) > 5 * 1024 * 1024) throw new Error('Demasiado largo (máx. 5 MB): crea el archivo en tu carpeta y usa miputer_guardar');
      return writeTreeFile(a.ruta, Buffer.from(contenido, 'utf8'), mimeFor(String(a.ruta)));
    }
    case 'subir': {
      const bytes = Buffer.from(String(a.datos || ''), 'base64');
      if (bytes.length > CLAUDE_FILE_MAX) throw new Error(`Supera ${human(CLAUDE_FILE_MAX)}`);
      return writeTreeFile(a.ruta, bytes, mimeFor(String(a.ruta)));
    }
    case 'bajar': {
      const { bytes } = await readTreeBytes(a.ruta, CLAUDE_FILE_MAX);
      return { datos: bytes.toString('base64'), bytes: bytes.length };
    }
    case 'crear_carpeta': {
      const parts = normTreePath(a.ruta);
      await mutateTree((root) => {
        const parent = parentOf(root, parts, true);
        if (parent.children[parts.at(-1)]?.type === 'file') throw new Error('Ya hay un archivo con ese nombre');
        parent.children[parts.at(-1)] ??= { type: 'dir', children: {}, mtime: Date.now() };
      });
      return { ruta: `/${parts.join('/')}` };
    }
    case 'mover': {
      const from = normTreePath(a.origen);
      const to = normTreePath(a.destino);
      if (`/${to.join('/')}/`.startsWith(`/${from.join('/')}/`)) throw new Error('No se puede mover una carpeta dentro de sí misma');
      return mutateTree((root) => {
        const src = parentOf(root, from, false);
        const node = src.children[from.at(-1)];
        if (!node) throw new Error(`No existe /${from.join('/')}`);
        const dst = parentOf(root, to, true);
        if (dst.children[to.at(-1)]) throw new Error(`Ya existe /${to.join('/')}`);
        delete src.children[from.at(-1)];
        dst.children[to.at(-1)] = node;
        node.mtime = Date.now();
        return { de: `/${from.join('/')}`, a: `/${to.join('/')}` };
      });
    }
    case 'eliminar': {
      // Va a la papelera (se puede restaurar 30 días), igual que al borrar desde MiPuter.
      const parts = normTreePath(a.ruta);
      return mutateTree((root) => {
        const parent = parentOf(root, parts, false);
        const node = parent.children[parts.at(-1)];
        if (!node) throw new Error(`No existe /${parts.join('/')}`);
        root.children.Papelera ??= { type: 'dir', children: {}, mtime: Date.now() };
        const trash = root.children.Papelera;
        const name = uniqueChild(trash.children, parts.at(-1));
        delete parent.children[parts.at(-1)];
        node.trashed = { from: `/${parts.join('/')}`, at: Date.now() };
        trash.children[name] = node;
        return { enPapelera: `/Papelera/${name}` };
      });
    }
  }
  throw new Error(`Acción desconocida: ${action}`);
}
const CLAUDE_FS_MUTATES = new Set(['escribir', 'subir', 'crear_carpeta', 'mover', 'eliminar']);

// Todo lo que cuelga de un nodo, con rutas relativas (para el zip de una carpeta compartida).
function collectNode(node, rel, out = []) {
  if (node.type === 'dir') {
    out.push({ path: `${rel}/`, dir: true });
    for (const [name, child] of Object.entries(node.children)) collectNode(child, `${rel}/${name}`, out);
  } else if (node.remote) {
    out.push({ path: rel, key: node.remote.key, size: node.remote.size || 0 });
  } else {
    out.push({ path: rel, data: node.content || '', size: (node.content || '').length });
  }
  return out;
}

async function handleSharesApi(req, res, url) {
  purgeShares();
  if (req.method === 'GET') {
    const list = Object.entries(shares).map(([t, sh]) => shareView(req, t, sh)).sort((a, b) => b.created - a.created);
    return sendJson(res, 200, list);
  }
  if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Origen no permitido' });
  if (req.method === 'DELETE') {
    delete shares[url.searchParams.get('token')];
    saveShares();
    return sendJson(res, 200, { ok: true });
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Método no permitido' });
  if (!b2.enabled) return sendJson(res, 503, { error: 'Backblaze B2 no está configurado en el servidor' });
  let input;
  try {
    input = JSON.parse((await readBody(req, 8192)).toString());
  } catch {
    return sendJson(res, 400, { error: 'Datos no válidos' });
  }
  const hours = Number(input.hours);
  if (!SHARE_HOURS.includes(hours)) return sendJson(res, 400, { error: 'Duración no válida' });
  const type = ['file', 'folder', 'upload'].includes(input.type) ? input.type : 'file';
  const base = { created: Date.now(), expires: Date.now() + hours * 3600_000 };
  const token = crypto.randomBytes(24).toString('base64url');

  if (type === 'file') {
    const key = checkKey(input.key);
    const maxDownloads = input.maxDownloads ? Math.min(1000, Math.max(1, Math.floor(Number(input.maxDownloads)))) : null;
    const head = await b2Request('HEAD', key); // también comprueba que el archivo existe
    shares[token] = { ...base, key, name: String(input.name || key.slice(PREFIX.length + 37) || 'archivo').slice(0, 200), size: Number(head.headers.get('content-length')) || 0, maxDownloads, downloads: 0 };
  } else {
    const dir = `/${treePath(input.path).join('/')}`;
    if (dir === '/' || dir === '/Papelera' || dir.startsWith('/Papelera/')) return sendJson(res, 400, { error: 'Elige una carpeta' });
    const node = await treeNode(dir);
    if (type === 'folder' && node?.type !== 'dir') return sendJson(res, 404, { error: 'La carpeta no existe en el servidor (espera unos segundos a que se sincronice)' });
    const name = treePath(dir).at(-1);
    if (type === 'folder') {
      const maxDownloads = input.maxDownloads ? Math.min(1000, Math.max(1, Math.floor(Number(input.maxDownloads)))) : null;
      shares[token] = { ...base, type, dir, name, maxDownloads, downloads: 0 };
    } else {
      const maxFiles = input.maxFiles ? Math.min(10_000, Math.max(1, Math.floor(Number(input.maxFiles)))) : null;
      const maxBytes = Math.min(MAX_UPLOAD_BYTES * 10, Math.max(1024 ** 2, Number(input.maxBytes) || 1024 ** 3));
      shares[token] = { ...base, type, dir, name, maxFiles, maxBytes, files: 0, bytes: 0 };
    }
  }
  saveShares();
  return sendJson(res, 201, shareView(req, token, shares[token]));
}

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const human = (n) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);
const untilText = (ms) => new Date(ms).toLocaleString('es-ES', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });

// Página pública (descarga o subida). `script` va con un nonce: es lo único que puede ejecutarse.
function sharePage(res, status, body, script = '') {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; script-src 'nonce-${nonce}'; form-action 'none'; base-uri 'none'`,
  });
  res.end(`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>MiPuter</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>◆</text></svg>">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: radial-gradient(circle at 20% 20%, #3a5a8c 0%, #1d2b44 55%, #111a2b 100%); color: #1c2230; }
  main { width: 100%; max-width: 420px; padding: 28px; border-radius: 14px; background: #fff;
    box-shadow: 0 12px 32px rgba(0,0,0,.35); display: grid; gap: 12px; text-align: center; }
  .icon { font-size: 44px; }
  h1 { margin: 0; font-size: 18px; overflow-wrap: anywhere; }
  p { margin: 0; color: #6b7385; font-size: 14px; }
  a.btn, label.btn { display: block; font-weight: 600; padding: 11px; border-radius: 8px; background: #3b82f6; color: #fff; text-decoration: none; cursor: pointer; }
  input[type=file] { display: none; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; text-align: left; font-size: 13px; }
  li { padding: 6px 8px; border-radius: 6px; background: #f2f4f8; overflow-wrap: anywhere; }
  li.ok { background: #e3f6e8; } li.err { background: #fde7e9; }
  progress { width: 100%; }
</style></head>
<body><main>${body}</main>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`);
}

const deadPage = (res) => sharePage(res, 404, '<div class="icon">⌛</div><h1>Este enlace no existe o ya caducó</h1><p>Pídele a quien te lo mandó uno nuevo.</p>');

// /d/<token>: descargar un archivo o una carpeta (como zip armado al vuelo).
async function handleShareDownload(req, res, url) {
  const [, , token, action] = url.pathname.split('/');
  purgeShares();
  const sh = token && Object.hasOwn(shares, token) ? shares[token] : null;
  if (!sh || shareType(sh) === 'upload') return deadPage(res);
  const folder = shareType(sh) === 'folder';
  const node = folder ? await treeNode(sh.dir) : null;
  if (folder && node?.type !== 'dir') return sharePage(res, 404, '<div class="icon">🗑️</div><h1>La carpeta ya no está disponible</h1>');

  if (action === 'descargar') {
    if (folder) {
      if (!yazl) return sharePage(res, 503, '<h1>No se puede armar el zip ahora</h1>');
      sh.downloads++;
      saveShares();
      const zip = new yazl.ZipFile();
      for (const e of collectNode(node, sh.name)) {
        const opts = { compress: !ALREADY_COMPRESSED.test(e.path) };
        if (e.dir) zip.addEmptyDirectory(e.path);
        else if (e.key)
          zip.addReadStreamLazy(e.path, opts, (cb) =>
            b2Request('HEAD', e.key).then((h) => cb(null, b2RangeStream(e.key, 0, Number(h.headers.get('content-length')) || 0)), cb),
          );
        else zip.addBuffer(decodeData(e.data), e.path, opts);
      }
      zip.on('error', (err) => {
        console.error(`Zip de carpeta compartida: ${err.message}`);
        res.destroy(err);
      });
      zip.end();
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename*=UTF-8''${encodeRfc3986(`${sh.name}.zip`)}`,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
      res.on('close', () => zip.outputStream.destroy());
      return zip.outputStream.pipe(res);
    }
    try {
      await b2Request('HEAD', sh.key);
    } catch (e) {
      if (e.status === 404) return sharePage(res, 404, '<div class="icon">🗑️</div><h1>El archivo ya no está disponible</h1>');
      throw e;
    }
    // Solo cuenta la descarga cuando empieza desde el principio (no al reanudar).
    if (!/^bytes=[1-9]/.test(req.headers.range || '')) {
      sh.downloads++;
      saveShares();
    }
    return sendB2File(req, res, sh.key, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename*=UTF-8''${encodeRfc3986(sh.name)}`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
  }
  if (action) return sharePage(res, 404, '<h1>No encontrado</h1>');
  const left = sh.maxDownloads ? ` · quedan ${sh.maxDownloads - sh.downloads} descargas` : '';
  if (folder) {
    const items = collectNode(node, sh.name).filter((e) => !e.dir);
    const size = items.reduce((a, e) => a + e.size, 0);
    return sharePage(
      res,
      200,
      `<div class="icon">📁</div><h1>${esc(sh.name)}</h1><p>${items.length} archivo${items.length === 1 ? '' : 's'} · ${human(size)} · disponible hasta el ${esc(untilText(sh.expires))}${left}</p>
       <a class="btn" href="/d/${esc(token)}/descargar">Descargar todo (.zip)</a><p>Compartido desde MiPuter</p>`,
    );
  }
  return sharePage(
    res,
    200,
    `<div class="icon">📦</div><h1>${esc(sh.name)}</h1><p>${human(sh.size)} · disponible hasta el ${esc(untilText(sh.expires))}${left}</p>
     <a class="btn" href="/d/${esc(token)}/descargar">Descargar</a><p>Compartido desde MiPuter</p>`,
  );
}

// /u/<token>: página para que alguien te suba archivos a una carpeta, sin entrar.
const UPLOAD_SCRIPT = `
const input = document.querySelector('input[type=file]');
const list = document.querySelector('ul');
const info = document.querySelector('.left');
input.onchange = async () => {
  for (const file of input.files) {
    const li = document.createElement('li');
    li.textContent = file.name;
    const bar = document.createElement('progress');
    bar.max = 1; bar.value = 0;
    li.appendChild(bar);
    list.appendChild(li);
    const res = await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', location.pathname.replace(/\\/$/, '') + '/subir?name=' + encodeURIComponent(file.name));
      xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = (e) => e.lengthComputable && (bar.value = e.loaded / e.total);
      xhr.onload = () => resolve({ ok: xhr.status < 300, data: (() => { try { return JSON.parse(xhr.responseText); } catch { return {}; } })() });
      xhr.onerror = () => resolve({ ok: false, data: { error: 'Se cortó la conexión' } });
      xhr.send(file);
    });
    bar.remove();
    li.className = res.ok ? 'ok' : 'err';
    li.textContent = (res.ok ? '✅ ' : '❌ ') + file.name + (res.ok ? '' : ' — ' + (res.data.error || 'error'));
    if (res.data.left) info.textContent = res.data.left;
  }
  input.value = '';
};`;

function uploadLeft(sh) {
  const parts = [`hasta el ${untilText(sh.expires)}`];
  if (sh.maxFiles) parts.push(`quedan ${sh.maxFiles - sh.files} archivos`);
  parts.push(`${human(Math.max(0, sh.maxBytes - sh.bytes))} disponibles`);
  return parts.join(' · ');
}

async function handleUploadRequest(req, res, url) {
  const [, , token, action] = url.pathname.split('/');
  purgeShares();
  const sh = token && Object.hasOwn(shares, token) ? shares[token] : null;
  if (!sh || shareType(sh) !== 'upload') return action ? sendJson(res, 404, { error: 'El enlace caducó' }) : deadPage(res);

  if (action === 'subir' && req.method === 'POST') {
    const size = Number(req.headers['content-length']);
    if (!Number.isFinite(size) || size <= 0) return sendJson(res, 411, { error: 'Archivo vacío' });
    if (size > MAX_UPLOAD_BYTES) return sendJson(res, 413, { error: `Supera el límite de ${human(MAX_UPLOAD_BYTES)}` });
    if (sh.bytes + size > sh.maxBytes) return sendJson(res, 413, { error: 'No queda espacio en este enlace' });
    if (sh.maxFiles && sh.files >= sh.maxFiles) return sendJson(res, 403, { error: 'Ya se subieron todos los archivos permitidos' });
    // Se reserva antes de subir, así dos subidas a la vez no se pasan del límite.
    sh.files++;
    sh.bytes += size;
    saveShares();
    const name = String(url.searchParams.get('name') || 'archivo').replace(/[\\/\x00-\x1f]/g, '_').slice(-150).trim() || 'archivo';
    const type = /^[\w.+-]+\/[\w.+-]+$/.test(req.headers['content-type'] || '') ? req.headers['content-type'] : 'application/octet-stream';
    const key = newKey(name);
    try {
      const uploaded = await streamToB2(req, key, type);
      if (uploaded !== size) throw new Error('La subida llegó incompleta');
      await addFilesToTree(sh.dir, [{ name, key, size, type }]);
      console.log(`Recibido por enlace: ${name} (${human(size)}) en ${sh.dir}`);
      return sendJson(res, 201, { ok: true, left: uploadLeft(sh) });
    } catch (e) {
      sh.files--;
      sh.bytes -= size;
      saveShares();
      b2Request('DELETE', key).catch(() => {});
      throw e;
    }
  }
  if (action) return sendJson(res, 404, { error: 'No encontrado' });
  return sharePage(
    res,
    200,
    `<div class="icon">📤</div><h1>Enviar archivos a «${esc(sh.name)}»</h1><p class="left">${esc(uploadLeft(sh))}</p>
     <label class="btn">Elegir archivos…<input type="file" multiple></label><ul></ul><p>Solo puedes subir; no ves lo que hay en la carpeta.</p>`,
    UPLOAD_SCRIPT,
  );
}

// ---------------------------------------------------------------------------
// Descargar desde una URL (/api/fetch-url)
// ---------------------------------------------------------------------------
//
// El servidor baja el archivo directo a B2. Para que no se pueda usar contra
// servicios internos (SSRF), solo se aceptan direcciones públicas: se comprueba
// la IP real al conectar (no solo el nombre), también en cada redirección.

function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224);
  }
  const v6 = ip.toLowerCase();
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicIp(mapped[1]);
  return !(v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb') || v6.startsWith('ff') || v6.startsWith('::ffff:') || v6.startsWith('64:ff9b'));
}

function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { all: true }, (err, addresses) => {
    if (err) return cb(err);
    const ok = addresses.filter((a) => isPublicIp(a.address));
    if (!ok.length || ok.length !== addresses.length) return cb(Object.assign(new Error('Esa dirección no es pública'), { code: 'EPRIVATE' }));
    if (options?.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

function fetchPublic(target, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(target);
    } catch {
      return reject(new Error('La URL no es válida'));
    }
    if (!['http:', 'https:'].includes(u.protocol)) return reject(new Error('Solo se aceptan enlaces http o https'));
    if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && !isPublicIp(u.hostname.replace(/^\[|\]$/g, ''))) return reject(new Error('Esa dirección no es pública'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { lookup: safeLookup, headers: { 'user-agent': 'Mozilla/5.0 (MiPuter)' }, timeout: 30_000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects >= 5) return reject(new Error('Demasiadas redirecciones'));
        return resolve(fetchPublic(new URL(res.headers.location, u).href, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`El servidor respondió ${res.statusCode}`));
      }
      resolve({ res, url: u });
    });
    req.on('timeout', () => req.destroy(new Error('El servidor tardó demasiado en responder')));
    req.on('error', (e) => reject(e.code === 'EPRIVATE' ? new Error('Esa dirección no es pública') : e));
  });
}

function fileNameFrom(res, u) {
  const cd = res.headers['content-disposition'] || '';
  const star = cd.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  const plain = cd.match(/filename="?([^";]+)"?/i);
  let name = '';
  try {
    name = star ? decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')) : plain ? plain[1] : decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
  } catch {}
  return name.replace(/[\\/\x00-\x1f]/g, '_').slice(-150).trim() || 'descarga';
}

async function handleFetchUrl(req, res) {
  if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Origen no permitido' });
  if (!b2.enabled) return sendJson(res, 503, { error: 'Backblaze B2 no está configurado en el servidor' });
  let input;
  try {
    input = JSON.parse((await readBody(req, 8192)).toString());
  } catch {
    return sendJson(res, 400, { error: 'Datos no válidos' });
  }
  const target = String(input.url || '').trim();
  const id = startJob(async (job) => {
    const { res: r, url: u } = await fetchPublic(target);
    const total = Number(r.headers['content-length']) || 0;
    if (total > MAX_UPLOAD_BYTES) {
      r.destroy();
      throw new Error(`El archivo pesa ${human(total)}: el límite es ${human(MAX_UPLOAD_BYTES)}`);
    }
    const name = fileNameFrom(r, u);
    const type = String(r.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
    let read = 0;
    const counter = new Transform({
      transform(chunk, _, done) {
        read += chunk.length;
        if (read > MAX_UPLOAD_BYTES) return done(new Error(`El archivo supera el límite de ${human(MAX_UPLOAD_BYTES)}`));
        if (total) job.progress = Math.min(0.99, read / total);
        done(null, chunk);
      },
    });
    r.on('error', (e) => counter.destroy(e));
    // Si deja de llegar información durante un minuto, se corta.
    r.setTimeout(60_000, () => r.destroy(new Error('La descarga se quedó parada')));
    const key = newKey(name);
    const size = await streamToB2(r.pipe(counter), key, /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : 'application/octet-stream');
    return { key, size, type, name };
  });
  return sendJson(res, 202, { job: id });
}

// ---------------------------------------------------------------------------
// Robots y buscadores: fuera
// ---------------------------------------------------------------------------
//
// robots.txt lo respetan los buscadores serios; a los demás bots conocidos
// (buscadores, IA, SEO) se les responde 403. La cabecera X-Robots-Tag va en todas
// las respuestas por si algo se cuela.

const BLOCKED_BOTS =
  /googlebot|google-extended|googleother|google-inspectiontool|adsbot|mediapartners|apis-google|storebot|bingbot|bingpreview|msnbot|adidxbot|slurp|duckduckbot|baiduspider|yandex|sogou|exabot|seznambot|petalbot|applebot|amazonbot|gptbot|chatgpt-user|oai-searchbot|ccbot|claudebot|claude-web|claude-searchbot|anthropic-ai|perplexitybot|perplexity-user|youbot|cohere-ai|bytespider|meta-externalagent|meta-externalfetcher|facebookbot|diffbot|imagesiftbot|omgili|timpibot|ahrefsbot|semrushbot|mj12bot|dotbot|dataforseobot|blexbot|serpstatbot|barkrowler|seekportbot|ia_archiver|archive\.org_bot|heritrix|scrapy|crawler|spider/i;

// ---------------------------------------------------------------------------
// Miniaturas (/api/thumbs)
// ---------------------------------------------------------------------------
//
// Las genera el navegador (al subir una foto o vídeo, o la primera vez que se ve)
// y se guardan en el disco del servidor, no en B2: verlas no gasta descargas.
// Si se pierden, se vuelven a generar solas.

const THUMB_DIR = join(DATA_DIR, 'miniaturas');
const MAX_THUMB_BYTES = 300 * 1024;
const thumbFile = (key) => join(THUMB_DIR, `${sha256(key)}.img`);
const thumbType = (b) =>
  b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : b[0] === 0x89 && b[1] === 0x50 ? 'image/png' : b.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;

function removeThumb(key) {
  try {
    unlinkSync(thumbFile(key));
  } catch {}
}

function copyThumb(from, to) {
  try {
    copyFileSync(thumbFile(from), thumbFile(to));
  } catch {}
}

async function handleThumbs(req, res, url) {
  const key = checkKey(url.searchParams.get('key'));
  const file = thumbFile(key);
  if (req.method === 'GET') {
    if (!existsSync(file)) return sendJson(res, 404, { error: 'Sin miniatura' });
    const body = readFileSync(file);
    // La clave de un archivo no cambia de contenido salvo al editarlo, y las fotos no se editan aquí.
    res.writeHead(200, { 'content-type': thumbType(body) || 'application/octet-stream', 'cache-control': 'private, max-age=31536000, immutable' });
    return res.end(body);
  }
  if (req.method !== 'PUT') return sendJson(res, 405, { error: 'Método no permitido' });
  if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Origen no permitido' });
  const body = await readBody(req, MAX_THUMB_BYTES);
  if (!thumbType(body)) return sendJson(res, 400, { error: 'La miniatura tiene que ser WebP, JPEG o PNG' });
  mkdirSync(THUMB_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(file, body, { mode: 0o600 });
  return sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// Versiones anteriores (/api/versions)
// ---------------------------------------------------------------------------
//
// B2 guarda las versiones viejas de cada objeto (según la regla de ciclo de vida
// del bucket). Restaurar copia esa versión como la actual.

async function handleVersions(req, res, url) {
  const key = checkKey(url.searchParams.get('key'));
  if (req.method === 'GET') {
    const r = await b2Request('GET', '', { query: `?versions&prefix=${encodeRfc3986(key)}&max-keys=100` });
    const xml = await r.text();
    const versions = [...xml.matchAll(/<Version>([\s\S]*?)<\/Version>/g)]
      .map(([, v]) => ({ key: xmlTag(v, 'Key'), id: xmlTag(v, 'VersionId'), date: xmlTag(v, 'LastModified'), size: Number(xmlTag(v, 'Size')), latest: xmlTag(v, 'IsLatest') === 'true' }))
      .filter((v) => v.key === key)
      .map(({ key: _k, ...v }) => v)
      .sort((a, b) => b.date.localeCompare(a.date));
    return sendJson(res, 200, versions);
  }
  if (req.method === 'POST') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Origen no permitido' });
    const version = url.searchParams.get('version') || '';
    if (!/^[\w.:-]{1,200}$/.test(version)) return sendJson(res, 400, { error: 'Versión no válida' });
    const source = `/${b2.bucket}/${key.split('/').map(encodeRfc3986).join('/')}?versionId=${encodeRfc3986(version)}`;
    await b2Request('PUT', key, { headers: { 'x-amz-copy-source': source } });
    removeThumb(key);
    const head = await b2Request('HEAD', key);
    return sendJson(res, 200, { size: Number(head.headers.get('content-length')) || 0 });
  }
  return sendJson(res, 405, { error: 'Método no permitido' });
}

// ---------------------------------------------------------------------------
// Configurar B2 desde Ajustes
// ---------------------------------------------------------------------------
//
// Las claves llegan del navegador, se prueban subiendo y borrando un objeto, y solo
// si funcionan se guardan en .b2.json (600). La applicationKey nunca vuelve al navegador.

async function handleB2Config(req, res) {
  if (req.method === 'GET') {
    return sendJson(res, 200, {
      enabled: b2.enabled,
      source: b2.source,
      bucket: b2.bucket || '',
      endpoint: b2.endpoint || '',
      keyId: b2.keyId ? `${b2.keyId.slice(0, 6)}…` : '',
    });
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Método no permitido' });
  if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Origen no permitido' });
  let input;
  try {
    input = JSON.parse((await readBody(req, 8192)).toString());
  } catch {
    return sendJson(res, 400, { error: 'Datos no válidos' });
  }
  const cfg = makeB2Config(input);
  if (!cfg.enabled) return sendJson(res, 400, { error: 'Rellena los cuatro campos' });
  // Solo endpoints de Backblaze: el servidor no debe hacer peticiones a cualquier URL.
  if (!/^https:\/\/s3\.[a-z0-9-]+\.backblazeb2\.com$/.test(cfg.endpoint)) {
    return sendJson(res, 400, { error: 'El endpoint tiene que ser del tipo s3.<región>.backblazeb2.com' });
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{4,61}[A-Za-z0-9]$/.test(cfg.bucket)) return sendJson(res, 400, { error: `Nombre de bucket no válido: "${cfg.bucket}"` });

  const testKey = `${PREFIX}.prueba-de-conexion`;
  try {
    await b2Request('PUT', testKey, { body: Buffer.from('ok'), headers: { 'content-type': 'text/plain' } }, cfg);
    await (await b2Request('GET', testKey, {}, cfg)).arrayBuffer();
    await b2Request('DELETE', testKey, {}, cfg);
  } catch (e) {
    return sendJson(res, 400, { error: `No se pudo usar el bucket con esas claves (${e.message})` });
  }

  const { keyId, appKey, bucket, endpoint, region } = cfg;
  const tmp = `${B2_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify({ keyId, appKey, bucket, endpoint, region }), { mode: 0o600 });
  renameSync(tmp, B2_FILE);
  Object.assign(b2, cfg, { source: 'ajustes' });
  console.log(`Subidas → Backblaze B2 (bucket "${b2.bucket}", región ${b2.region}) — configurado desde Ajustes`);
  return sendJson(res, 200, { ok: true, bucket: b2.bucket });
}

// ---------------------------------------------------------------------------
// App Claude en modo chat (/api/claude-chat)
// ---------------------------------------------------------------------------
//
// MiPuter no lanza Claude: pasa mensajes entre la ventana y el puente que corre
// como mpclaude (servicio miputer-claude-chat), por su socket local. Solo deja
// pasar las órdenes conocidas.

const CHAT_SOCKET = process.env.CLAUDE_CHAT_SOCKET || '/run/miputer-claude-chat/chat.sock';
const CHAT_OPS = new Set(['list', 'history', 'start', 'send', 'attach', 'permission', 'interrupt', 'mode', 'delete', 'rename']);
const chatWss = WebSocketServer ? new WebSocketServer({ noServer: true, maxPayload: 40 * 1024 * 1024 }) : null;

function handleChatUpgrade(req, socket, head, reject) {
  if (!chatWss || !existsSync(CHAT_SOCKET)) return reject(503);
  chatWss.handleUpgrade(req, socket, head, (ws) => {
    const bridge = net.connect(CHAT_SOCKET);
    let buf = '';
    bridge.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        if (line.startsWith('{"ev":"fs"')) {
          handleClaudeFs(line);
          continue;
        }
        if (ws.readyState === ws.OPEN) ws.send(line);
      }
    });
    const handleClaudeFs = async (line) => {
      const { id, action, args } = JSON.parse(line);
      let reply;
      try {
        reply = { op: 'fsresult', id, ok: true, result: await claudeFsAction(action, args) };
        // La ventana trae el árbol nuevo enseguida (el archivo aparece en el escritorio).
        if (CLAUDE_FS_MUTATES.has(action) && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ ev: 'tree-changed' }));
      } catch (e) {
        reply = { op: 'fsresult', id, ok: false, error: e.message };
      }
      if (!bridge.destroyed) bridge.write(`${JSON.stringify(reply)}\n`);
    };
    const close = () => {
      bridge.destroy();
      if (ws.readyState === ws.OPEN) ws.close();
    };
    bridge.on('error', (e) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ ev: 'error', message: `No se pudo hablar con Claude (${e.code || e.message})` }));
      close();
    });
    bridge.on('close', close);
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (CHAT_OPS.has(msg?.op)) bridge.write(`${JSON.stringify(msg)}\n`);
    });
    ws.on('close', close);
  });
}

// ---------------------------------------------------------------------------
// App Windows: escritorio remoto (RDP) por WebSocket (/api/rdp) a través de guacd
// ---------------------------------------------------------------------------
//
// El navegador habla el protocolo de Guacamole con este servidor, que hace el
// saludo con guacd (127.0.0.1:4822) poniendo los datos de conexión, y después
// solo pasa instrucciones completas de un lado a otro. La contraseña de Windows
// vive en .windows.json (600) y nunca llega al navegador.

const RDP_FILE = join(ROOT, '.windows.json');
const RDP_MAX = 2;
const RDP_LAYOUTS = ['es-latam-qwerty', 'es-es-qwerty', 'en-us-qwerty', 'pt-br-qwerty'];
let rdpConfig = existsSync(RDP_FILE) ? JSON.parse(readFileSync(RDP_FILE, 'utf8')) : null;
const rdpClients = new Set();

// Guacamole cuenta longitudes en caracteres Unicode, no en unidades de JavaScript.
const guacEncode = (...elements) => elements.map((e) => `${[...String(e)].length}.${e}`).join(',') + ';';

// Separa del búfer las instrucciones completas. Devuelve { instructions, raw, rest }.
function guacParse(buffer) {
  const instructions = [];
  let i = 0;
  let consumed = 0;
  outer: while (i < buffer.length) {
    const elements = [];
    for (;;) {
      const dot = buffer.indexOf('.', i);
      if (dot < 0) break outer;
      const length = Number(buffer.slice(i, dot));
      if (!Number.isInteger(length) || length < 0) throw new Error('Instrucción de Guacamole mal formada');
      let j = dot + 1;
      for (let n = 0; n < length; n++) {
        if (j >= buffer.length) break outer;
        j += buffer.codePointAt(j) > 0xffff ? 2 : 1;
      }
      if (j >= buffer.length) break outer;
      elements.push(buffer.slice(dot + 1, j));
      const term = buffer[j];
      i = j + 1;
      if (term === ';') break;
      if (term !== ',') throw new Error('Instrucción de Guacamole mal formada');
    }
    instructions.push(elements);
    consumed = i;
  }
  return { instructions, raw: buffer.slice(0, consumed), rest: buffer.slice(consumed) };
}

function rdpParams(q) {
  const c = rdpConfig;
  return {
    hostname: c.host,
    port: String(c.port || 3389),
    username: c.username,
    password: c.password,
    domain: c.domain || '',
    security: 'any',
    'ignore-cert': 'true',
    'server-layout': c.layout || 'es-latam-qwerty',
    'resize-method': 'display-update',
    'enable-wallpaper': 'true',
    'enable-font-smoothing': 'true',
    timezone: q.tz || '',
  };
}

function attachRdp(ws, q) {
  const guacd = net.connect(4822, '127.0.0.1');
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let ready = false;
  const close = () => {
    rdpClients.delete(ws);
    guacd.destroy();
    if (ws.readyState === ws.OPEN) ws.close();
  };
  // El cliente de Guacamole espera primero el identificador del túnel.
  ws.send(guacEncode('', crypto.randomUUID()));

  guacd.on('connect', () => guacd.write(guacEncode('select', 'rdp')));
  guacd.on('data', (chunk) => {
    let parsed;
    try {
      parsed = guacParse(buffer + decoder.write(chunk));
    } catch (e) {
      console.error(`RDP: ${e.message}`);
      return close();
    }
    buffer = parsed.rest;
    if (ready) {
      if (parsed.raw && ws.readyState === ws.OPEN) ws.send(parsed.raw);
      return;
    }
    for (const [opcode, ...args] of parsed.instructions) {
      if (opcode === 'args') {
        // Saludo: tamaño de pantalla, formatos que entiende el navegador y datos de conexión.
        const params = rdpParams(q);
        guacd.write(guacEncode('size', q.width, q.height, q.dpi));
        guacd.write(guacEncode('audio', 'audio/L8', 'audio/L16'));
        guacd.write(guacEncode('video'));
        guacd.write(guacEncode('image', 'image/png', 'image/jpeg', 'image/webp'));
        if (q.tz) guacd.write(guacEncode('timezone', q.tz));
        guacd.write(guacEncode('connect', ...args.map((name) => (name.startsWith('VERSION_') ? 'VERSION_1_3_0' : params[name] ?? ''))));
      } else if (opcode === 'ready') {
        ready = true;
        // Lo que llegó detrás de "ready" en el mismo paquete ya es de la sesión.
        const after = parsed.instructions.slice(parsed.instructions.findIndex((x) => x[0] === 'ready') + 1);
        if (after.length && ws.readyState === ws.OPEN) ws.send(after.map((x) => guacEncode(...x)).join(''));
        break;
      } else if (opcode === 'error') {
        if (ws.readyState === ws.OPEN) ws.send(guacEncode(opcode, ...args));
        return close();
      }
    }
  });
  guacd.on('error', (e) => {
    console.error(`RDP: no se pudo hablar con guacd (${e.message})`);
    if (ws.readyState === ws.OPEN) ws.send(guacEncode('error', 'No se pudo conectar con el servicio de escritorio remoto', '519'));
    close();
  });
  guacd.on('close', close);

  ws.on('message', (data) => {
    const text = data.toString();
    // Instrucciones internas del túnel ("0.," = opcode vacío): el ping se devuelve, no va a guacd.
    if (text.startsWith('0.,')) {
      if (text.startsWith('0.,4.ping,')) ws.send(text);
      return;
    }
    if (ready) guacd.write(text);
  });
  ws.on('close', close);
}

function handleRdpUpgrade(req, socket, head, url, reject) {
  if (!rdpConfig || !WebSocketServer) return reject(404);
  if (rdpClients.size >= RDP_MAX) return reject(429);
  const n = (k, def, min, max) => Math.min(max, Math.max(min, Math.round(Number(url.searchParams.get(k)) || def)));
  const q = {
    width: n('width', 1280, 320, 4096),
    height: n('height', 720, 240, 2160),
    dpi: n('dpi', 96, 48, 300),
    tz: /^[A-Za-z_]+\/[A-Za-z_\/+-]+$/.test(url.searchParams.get('tz') || '') ? url.searchParams.get('tz') : '',
  };
  const placeholder = {};
  rdpClients.add(placeholder);
  rdpWss.handleUpgrade(req, socket, head, (ws) => {
    rdpClients.delete(placeholder);
    rdpClients.add(ws);
    attachRdp(ws, q);
  });
}

async function handleWindowsConfig(req, res) {
  if (req.method === 'GET') {
    return sendJson(res, 200, rdpConfig ? { configured: true, host: rdpConfig.host, port: rdpConfig.port, username: rdpConfig.username, domain: rdpConfig.domain, layout: rdpConfig.layout } : { configured: false, layouts: RDP_LAYOUTS });
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Método no permitido' });
  if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Origen no permitido' });
  let input;
  try {
    input = JSON.parse((await readBody(req, 8192)).toString());
  } catch {
    return sendJson(res, 400, { error: 'Datos no válidos' });
  }
  const host = String(input.host || '').trim();
  const username = String(input.username || '').trim();
  const port = Number(input.port || 3389);
  if (!/^[a-z0-9.-]{1,253}$/i.test(host)) return sendJson(res, 400, { error: 'Dirección del Windows no válida' });
  if (!username) return sendJson(res, 400, { error: 'Falta el usuario de Windows' });
  if (!Number.isInteger(port) || port < 1 || port > 65535) return sendJson(res, 400, { error: 'Puerto no válido' });
  // Sin contraseña nueva se conserva la anterior (para cambiar solo el teclado, por ejemplo).
  const password = String(input.password || '') || rdpConfig?.password;
  if (!password) return sendJson(res, 400, { error: 'Falta la contraseña de Windows' });
  rdpConfig = { host, port, username, password, domain: String(input.domain || '').trim(), layout: RDP_LAYOUTS.includes(input.layout) ? input.layout : RDP_LAYOUTS[0] };
  const tmp = `${RDP_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(rdpConfig), { mode: 0o600 });
  renameSync(tmp, RDP_FILE);
  console.log(`Escritorio remoto configurado: ${username}@${host}:${port}`);
  return sendJson(res, 200, { ok: true });
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
    return sendJson(res, 200, { auth: auth.enabled, b2: b2.enabled, bucket: b2.enabled ? b2.bucket : null, maxUploadMb: MAX_UPLOAD_BYTES / 1024 / 1024 });
  }
  if (route.startsWith('/api/claude') && (await handleClaudeApi(req, res, url)) !== false) return;
  if (route === '/api/b2-config') return handleB2Config(req, res);
  if (route === '/api/tree') return handleTree(req, res);
  if (route === '/api/shares') return handleSharesApi(req, res, url);
  if (route === '/api/thumbs') return handleThumbs(req, res, url);
  if (route === '/api/versions') return handleVersions(req, res, url);
  if (route === '/api/fetch-url' && method === 'POST') return handleFetchUrl(req, res);
  if (route === '/api/windows-config') return handleWindowsConfig(req, res);
  if (route === '/api/zip' || route === '/api/unzip' || route === '/api/jobs') return handleZipApi(req, res, url);
  if (route === '/api/pdf' && method === 'POST') return handlePdfOps(req, res);
  if (route.startsWith('/api/uploads')) {
    if (!b2.enabled) return sendJson(res, 503, { error: 'Backblaze B2 no está configurado en el servidor' });
    return handleUploads(req, res, url);
  }
  if (!b2.enabled) return sendJson(res, 503, { error: 'Backblaze B2 no está configurado en el servidor' });

  // Subir un archivo nuevo: POST /api/files?name=foto.png  (cuerpo = bytes)
  if (route === '/api/files' && method === 'POST') {
    const body = await readBody(req, SINGLE_UPLOAD_BYTES);
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
    copyThumb(src, key);
    return sendJson(res, 201, { key });
  }

  if (route === '/api/files') {
    const key = checkKey(url.searchParams.get('key'));

    // Leer: GET /api/files?key=...[&download=nombre]
    if (method === 'GET' || method === 'HEAD') {
      // no-cache = el navegador guarda la copia pero pregunta antes de usarla (ver ETag en sendB2File):
      // así un archivo editado (misma clave) nunca se ve desactualizado.
      const extra = { 'cache-control': 'private, no-cache' };
      const download = url.searchParams.get('download');
      if (download) extra['content-disposition'] = `attachment; filename*=UTF-8''${encodeRfc3986(download)}`;
      const version = url.searchParams.get('version') || '';
      if (version && !/^[\w.:-]{1,200}$/.test(version)) return sendJson(res, 400, { error: 'Versión no válida' });
      return sendB2File(req, res, key, extra, version);
    }

    // Sobrescribir: PUT /api/files?key=...  (cuerpo = bytes)
    if (method === 'PUT') {
      const body = await readBody(req, SINGLE_UPLOAD_BYTES);
      await b2Request('PUT', key, { body, headers: { 'content-type': req.headers['content-type'] || 'application/octet-stream' } });
      removeThumb(key);
      return sendJson(res, 200, { key, size: body.length });
    }

    if (method === 'DELETE') {
      await b2Request('DELETE', key);
      removeThumb(key);
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
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
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
  res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex');
  try {
    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('User-agent: *\nDisallow: /\n');
    }
    if (BLOCKED_BOTS.test(req.headers['user-agent'] || '')) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Acceso no permitido a robots.\n');
    }
    // Enlaces compartidos: públicos, sin iniciar sesión.
    if (url.pathname.startsWith('/d/') && req.method === 'GET') return await handleShareDownload(req, res, url);
    if (url.pathname.startsWith('/u/')) return await handleUploadRequest(req, res, url);
    if (auth.enabled && (await handleAuth(req, res, url)) !== false) return;
    if (!isAuthenticated(req)) {
      if (url.pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'Sesión caducada: vuelve a iniciar sesión' });
      return redirect(res, '/login');
    }
    // Con una contraseña temporal no se puede usar nada hasta cambiarla.
    if (auth.mustChange) {
      if (url.pathname.startsWith('/api/')) return sendJson(res, 403, { error: 'Cambia la contraseña temporal para continuar' });
      return redirect(res, '/cambiar-clave');
    }
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    console.error(e.message);
    if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message });
    else res.destroy();
  }
});
server.on('upgrade', handleUpgrade);

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

// `node server.js --temp-password`: crea una contraseña temporal que obliga a
// cambiarla en el primer inicio de sesión, la muestra una vez y termina.
// (Reinicia el servicio después para que la cargue.)
if (isMain && process.argv.includes('--temp-password')) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const temp = Array.from(crypto.randomBytes(16), (b) => alphabet[b % alphabet.length]).join('').match(/.{4}/g).join('-');
  savePassword(temp, true);
  console.log(`Contraseña temporal: ${temp}`);
  process.exit(0);
}

if (isMain) {
  // HOST=127.0.0.1 deja el puerto accesible solo desde la propia máquina (detrás de un proxy).
  server.listen(PORT, process.env.HOST || undefined, () => {
    console.log(`MiPuter en http://${process.env.HOST || 'localhost'}:${PORT}`);
    console.log(auth.enabled ? 'Acceso protegido con contraseña' : '⚠️  Sin contraseña: define MIPUTER_PASSWORD en .env para proteger el acceso');
    console.log(b2.enabled ? `Subidas → Backblaze B2 (bucket "${b2.bucket}", región ${b2.region})` : 'B2 no configurado: las subidas se guardan en el navegador');
    if (CLAUDE_SOCKET) console.log(claudeEnabled() ? `App Claude activa (máx. ${CLAUDE_MAX} sesiones)` : 'App Claude desactivada');
  });
}
