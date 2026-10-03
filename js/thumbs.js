// Miniaturas de fotos y vídeos. Se hacen en el navegador: al subir, a partir del
// archivo que ya está en el ordenador (sin gastar descargas de B2), y para lo que
// llegó sin miniatura (zip, subidas antiguas) una sola vez, la primera vez que se ve.
// Se guardan en el servidor (/api/thumbs), no en B2.
import * as fs from './fs.js';
import * as storage from './storage.js';

const SIZE = 256;
const LAZY_MAX_BYTES = 25 * 1024 * 1024; // más grande que esto no se descarga solo para la miniatura
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|avif|heic)$/i;
const VIDEO = /\.(mp4|webm|mov|m4v)$/i;

// `v` (la fecha de modificación) cambia la dirección cuando el archivo se edita: la miniatura vieja
// queda en la caché del navegador pero ya no se pide.
export const thumbUrl = (key, v = '') => `api/thumbs?key=${encodeURIComponent(key)}${v ? `&v=${v}` : ''}`;
export const canThumb = (name) => IMAGE.test(name) || VIDEO.test(name);

function toBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/webp', 0.75));
}

function draw(source, width, height) {
  const scale = Math.min(1, SIZE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return toBlob(canvas);
}

function videoFrame(blob) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const src = URL.createObjectURL(blob);
    const done = (result) => {
      clearTimeout(timer);
      URL.revokeObjectURL(src);
      video.removeAttribute('src');
      resolve(result);
    };
    const timer = setTimeout(() => done(null), 10_000);
    video.muted = true;
    video.preload = 'auto';
    video.onloadedmetadata = () => (video.currentTime = Math.min(1, (video.duration || 0) / 2));
    video.onseeked = async () => done(await draw(video, video.videoWidth, video.videoHeight));
    video.onerror = () => done(null);
    video.src = src;
  });
}

// Devuelve la miniatura (Blob) de una foto o vídeo, o null si no se puede.
export async function makeThumb(blob, name) {
  try {
    if (VIDEO.test(name)) return await videoFrame(blob);
    if (!IMAGE.test(name)) return null;
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const out = await draw(bitmap, bitmap.width, bitmap.height);
    bitmap.close();
    return out;
  } catch {
    return null;
  }
}

export async function uploadThumb(key, blob) {
  const res = await fetch(thumbUrl(key), { method: 'PUT', body: blob, headers: { 'content-type': blob.type || 'image/webp' } });
  return res.ok;
}

// Para lo que no tiene miniatura: se genera de a 2 a la vez, una sola vez por archivo.
const queue = [];
const queued = new Set();
let running = 0;

export function ensureThumb(path, remote) {
  if (remote.thumb !== undefined || queued.has(remote.key) || remote.size > LAZY_MAX_BYTES || !IMAGE.test(path)) return;
  queued.add(remote.key);
  queue.push([path, remote.key]);
  pump();
}

function pump() {
  while (running < 2 && queue.length) {
    const [path, key] = queue.shift();
    running++;
    (async () => {
      try {
        const res = await fetch(storage.url(key));
        // Fallo pasajero (red, tope de B2…): se reintentará la próxima vez que se vea.
        if (!res.ok) return queued.delete(key);
        const thumb = await makeThumb(await res.blob(), path);
        // Si la imagen no se puede leer se guarda false, para no volver a descargarla cada vez.
        fs.setThumb(key, Boolean(thumb) && (await uploadThumb(key, thumb)));
      } catch {
        queued.delete(key);
      }
    })().finally(() => {
      running--;
      pump();
    });
  }
}
