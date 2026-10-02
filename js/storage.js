// Cliente del almacenamiento remoto (Backblaze B2 a través de server.js).

let status = { b2: false };

// Consulta al servidor si B2 está disponible. Si la web se sirve sin server.js
// (p. ej. con python -m http.server) simplemente queda desactivado.
export async function init() {
  try {
    const res = await fetch('api/status');
    if (res.ok) status = await res.json();
  } catch {
    status = { b2: false };
  }
  return status;
}

export const enabled = () => status.b2;
export const authEnabled = () => Boolean(status.auth);

export function logout() {
  const form = document.createElement('form');
  form.method = 'post';
  form.action = 'logout';
  document.body.appendChild(form);
  form.submit();
}
export const bucket = () => status.bucket;

async function check(res) {
  if (res.ok) return res.json();
  if (res.status === 401) {
    // La sesión ha caducado: vuelve a la pantalla de inicio de sesión.
    location.href = 'login';
    throw new Error('Sesión caducada');
  }
  const data = await res.json().catch(() => ({}));
  throw new Error(data.error || `Error ${res.status} del servidor`);
}

export function url(key, { download } = {}) {
  let u = `api/files?key=${encodeURIComponent(key)}`;
  if (download) u += `&download=${encodeURIComponent(download)}`;
  return u;
}

const MULTIPART_FROM = 64 * 1024 * 1024;
const fmtSize = (mb) => (mb >= 1024 ? `${Math.round(mb / 1024)} GB` : `${mb} MB`);

// Sube un File/Blob y devuelve { key, size, type }. onProgress(0..1) es opcional.
export async function upload(file, name = file.name, onProgress) {
  if (status.maxUploadMb && file.size > status.maxUploadMb * 1024 * 1024) {
    throw new Error(`"${name}" supera el límite de ${fmtSize(status.maxUploadMb)}`);
  }
  if (file.size > MULTIPART_FROM) return uploadInParts(file, name, onProgress);
  const res = await fetch(`api/files?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  });
  return check(res);
}

// Archivos grandes: se trocean en el navegador y se suben de a 3 partes a la vez,
// reintentando cada parte hasta 3 veces si falla la conexión.
async function uploadInParts(file, name, onProgress) {
  const type = file.type || 'application/octet-stream';
  const q = `name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}&size=${file.size}`;
  const up = await check(await fetch(`api/uploads?${q}`, { method: 'POST' }));
  const done = new Array(up.parts).fill(0);
  const report = () => onProgress?.(done.reduce((a, b) => a + b, 0) / file.size);
  let next = 1;
  const worker = async () => {
    while (next <= up.parts) {
      const n = next++;
      const chunk = file.slice((n - 1) * up.partSize, n * up.partSize);
      for (let attempt = 1; ; attempt++) {
        try {
          await check(await fetch(`api/uploads/part?id=${up.id}&n=${n}`, { method: 'PUT', body: chunk }));
          break;
        } catch (e) {
          if (attempt >= 3) throw e;
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }
      done[n - 1] = chunk.size;
      report();
    }
  };
  try {
    await Promise.all([worker(), worker(), worker()]);
    return await check(await fetch(`api/uploads/complete?id=${up.id}`, { method: 'POST' }));
  } catch (e) {
    fetch(`api/uploads?id=${up.id}`, { method: 'DELETE' }).catch(() => {});
    throw e;
  }
}

export async function readText(key) {
  const res = await fetch(url(key));
  if (!res.ok) await check(res);
  return res.text();
}

export async function writeText(key, text, type = 'text/plain; charset=utf-8') {
  return check(await fetch(url(key), { method: 'PUT', headers: { 'content-type': type }, body: text }));
}

export async function remove(key) {
  return check(await fetch(url(key), { method: 'DELETE' }));
}

export async function copy(key) {
  return check(await fetch(`api/files/copy?key=${encodeURIComponent(key)}`, { method: 'POST' }));
}

export function isTextType(type = '', name = '') {
  return /^text\/|json|javascript|xml|svg/.test(type) || /\.(txt|md|json|js|css|html?|csv|py|svg)$/i.test(name);
}
