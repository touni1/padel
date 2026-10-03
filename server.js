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

function b2RangeStream(key, start, end) {
  let next = start; // siguiente byte a pedir
  let size = 4 * 1024 * 1024; // los tramos empiezan chicos y se duplican hasta RANGE_BYTES
  const ahead = []; // tramos ya pedidos, en orden (como mucho uno por delante del que se envía)
  const fetchRange = async (from, to) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await b2Request('GET', key, { headers: { range: `bytes=${from}-${to - 1}` } });
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
async function sendB2File(req, res, key, extra = {}) {
  const head = await b2Request('HEAD', key);
  const size = Number(head.headers.get('content-length')) || 0;
  const etag = head.headers.get('etag');
  const headers = {
    'content-type': head.headers.get('content-type') || 'application/octet-stream',
    'accept-ranges': 'bytes',
    ...(etag ? { etag } : {}),
    ...extra,
  };
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
  const stream = b2RangeStream(key, start, end);
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
if (CLAUDE_SOCKET) {
  try {
    pty = (await import('node-pty')).default;
    ({ WebSocketServer } = await import('ws'));
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
  if (url.pathname !== '/api/pty' || !claudeEnabled()) return reject(404);
  if (!isAuthenticated(req)) return reject(401);
  if (auth.mustChange) return reject(403);
  if (!sameOrigin(req)) return reject(403);
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

const shareAlive = (sh) => sh.expires > Date.now() && (!sh.maxDownloads || sh.downloads < sh.maxDownloads);

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
  url: `${siteOrigin(req)}/d/${token}`,
  key: sh.key,
  name: sh.name,
  size: sh.size,
  created: sh.created,
  expires: sh.expires,
  downloads: sh.downloads,
  maxDownloads: sh.maxDownloads,
});

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
  const key = checkKey(input.key);
  const hours = Number(input.hours);
  if (!SHARE_HOURS.includes(hours)) return sendJson(res, 400, { error: 'Duración no válida' });
  const maxDownloads = input.maxDownloads ? Math.min(1000, Math.max(1, Math.floor(Number(input.maxDownloads)))) : null;
  const head = await b2Request('HEAD', key); // también comprueba que el archivo existe
  const token = crypto.randomBytes(24).toString('base64url');
  shares[token] = {
    key,
    name: String(input.name || key.slice(PREFIX.length + 37) || 'archivo').slice(0, 200),
    size: Number(head.headers.get('content-length')) || 0,
    created: Date.now(),
    expires: Date.now() + hours * 3600_000,
    maxDownloads,
    downloads: 0,
  };
  saveShares();
  return sendJson(res, 201, shareView(req, token, shares[token]));
}

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const human = (n) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);

function sharePage(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
  });
  res.end(`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Descarga · MiPuter</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>◆</text></svg>">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: radial-gradient(circle at 20% 20%, #3a5a8c 0%, #1d2b44 55%, #111a2b 100%); color: #1c2230; }
  main { width: 100%; max-width: 380px; padding: 28px; border-radius: 14px; background: #fff;
    box-shadow: 0 12px 32px rgba(0,0,0,.35); display: grid; gap: 12px; text-align: center; }
  .icon { font-size: 44px; }
  h1 { margin: 0; font-size: 18px; overflow-wrap: anywhere; }
  p { margin: 0; color: #6b7385; font-size: 14px; }
  a.btn { display: block; font-weight: 600; padding: 11px; border-radius: 8px; background: #3b82f6; color: #fff; text-decoration: none; }
</style></head>
<body><main>${body}</main></body></html>`);
}

async function handleShareDownload(req, res, url) {
  const [, , token, action] = url.pathname.split('/');
  purgeShares();
  const sh = token && Object.hasOwn(shares, token) ? shares[token] : null;
  if (!sh) {
    return sharePage(res, 404, '<div class="icon">⌛</div><h1>Este enlace no existe o ya caducó</h1><p>Pídele a quien te lo mandó uno nuevo.</p>');
  }
  if (action === 'descargar') {
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
  const until = new Date(sh.expires).toLocaleString('es-ES', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });
  return sharePage(
    res,
    200,
    `<div class="icon">📦</div><h1>${esc(sh.name)}</h1><p>${human(sh.size)} · disponible hasta el ${esc(until)}${left}</p>
     <a class="btn" href="/d/${esc(token)}/descargar">Descargar</a><p>Compartido desde MiPuter</p>`,
  );
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
      return sendB2File(req, res, key, extra);
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
