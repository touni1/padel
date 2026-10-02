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
export const bucket = () => status.bucket;

async function check(res) {
  if (res.ok) return res.json();
  const data = await res.json().catch(() => ({}));
  throw new Error(data.error || `Error ${res.status} del servidor`);
}

export function url(key, { download } = {}) {
  let u = `api/files?key=${encodeURIComponent(key)}`;
  if (download) u += `&download=${encodeURIComponent(download)}`;
  return u;
}

// Sube un File/Blob y devuelve { key, size, type }.
export async function upload(file, name = file.name) {
  if (status.maxUploadMb && file.size > status.maxUploadMb * 1024 * 1024) {
    throw new Error(`"${name}" supera el límite de ${status.maxUploadMb} MB`);
  }
  const res = await fetch(`api/files?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
  });
  return check(res);
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
