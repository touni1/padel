// Piezas compartidas por el editor de PDF y las herramientas PDF: cargar pdf.js y
// pdf-lib, leer archivos, elegir archivos de MiPuter y guardar resultados.
import * as fs from './fs.js';
import * as storage from './storage.js';
import { createWindow } from './wm.js';
import { escapeHtml } from './ui.js';
import { makeThumb, uploadThumb, canThumb } from './thumbs.js';

export const VENDOR = new URL('./vendor/', import.meta.url).href;

let libsPromise;
export function loadLibs() {
  libsPromise ??= Promise.all([import(`${VENDOR}pdfjs/pdf.min.mjs`), import(`${VENDOR}pdf-lib/pdf-lib.esm.min.js`)]).then(
    ([pdfjs, PDFLib]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = `${VENDOR}pdfjs/pdf.worker.min.mjs`;
      return { pdfjs, PDFLib };
    },
    (e) => {
      libsPromise = null;
      throw e;
    },
  );
  return libsPromise;
}

// Opciones de pdf.js para abrir un documento (fuentes, cmaps, decodificadores).
export const pdfjsOptions = (data) => ({
  data,
  cMapUrl: `${VENDOR}pdfjs/cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${VENDOR}pdfjs/standard_fonts/`,
  wasmUrl: `${VENDOR}pdfjs/wasm/`,
  iccUrl: `${VENDOR}pdfjs/iccs/`,
});

export async function readBytes(path) {
  const remote = fs.getRemote(path);
  const res = await fetch(remote ? storage.url(remote.key) : fs.readFile(path));
  if (!res.ok) throw new Error(`No se pudo leer "${fs.basename(path)}" (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

// Todos los archivos con esas extensiones (fuera de la papelera).
export function allFiles(exts, dir = '/', out = []) {
  for (const e of fs.readdir(dir)) {
    if (e.path === fs.TRASH) continue;
    if (e.type === 'dir') allFiles(exts, e.path, out);
    else if (exts.includes(fs.extname(e.name))) out.push(e.path);
  }
  return out;
}

// Ventana para elegir uno o varios archivos. Devuelve las rutas (en el orden marcado) o null.
export function pickFiles({ title, exts, multiple = false, exclude = [] }) {
  return new Promise((resolve) => {
    const list = allFiles(exts).filter((p) => !exclude.includes(p));
    const chosen = [];
    let result = null;
    const win = createWindow({ title, width: 460, height: 420, onClose: () => resolve(result) });
    win.body.innerHTML = `
      <div class="app-fill">
        <div class="pick-list grow">${list.length ? '' : `<p class="pick-empty">No hay archivos ${exts.map((e) => `.${e}`).join(', ')} en tu MiPuter.</p>`}</div>
        ${multiple ? '<div class="toolbar pick-bar"><span class="pick-count">Marca los archivos en el orden que quieras</span><span class="spacer"></span><button class="btn primary" disabled>Usar</button></div>' : ''}
      </div>`;
    const box = win.body.querySelector('.pick-list');
    const ok = win.body.querySelector('.pick-bar button');
    const count = win.body.querySelector('.pick-count');
    for (const p of list) {
      const row = document.createElement('button');
      row.className = 'pick-row';
      row.innerHTML = `<span class="pick-n"></span><span class="pick-name">${escapeHtml(fs.basename(p))}</span><small>${escapeHtml(fs.dirname(p))}</small>`;
      row.onclick = () => {
        if (!multiple) {
          result = [p];
          return win.close();
        }
        const i = chosen.indexOf(p);
        i >= 0 ? chosen.splice(i, 1) : chosen.push(p);
        box.querySelectorAll('.pick-row').forEach((r, k) => {
          const n = chosen.indexOf(list[k]);
          r.classList.toggle('on', n >= 0);
          r.querySelector('.pick-n').textContent = n >= 0 ? n + 1 : '';
        });
        ok.disabled = !chosen.length;
        count.textContent = chosen.length ? `${chosen.length} elegido${chosen.length === 1 ? '' : 's'}` : 'Marca los archivos en el orden que quieras';
      };
      box.appendChild(row);
    }
    if (ok)
      ok.onclick = () => {
        result = [...chosen];
        win.close();
      };
  });
}

// Guarda un resultado en `dir` (en B2 si está configurado) con un nombre libre y devuelve su ruta.
export async function saveOutput(dir, name, data, type) {
  fs.ensureDir(dir);
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const path = fs.join(dir, fs.uniqueName(dir, name));
  if (storage.enabled()) {
    const remote = await storage.upload(blob, fs.basename(path));
    if (canThumb(path)) {
      const thumb = await makeThumb(blob, path);
      remote.thumb = Boolean(thumb) && (await uploadThumb(remote.key, thumb));
    }
    fs.writeRemote(path, remote);
  } else {
    const url = await new Promise((r) => Object.assign(new FileReader(), { onload: (e) => r(e.target.result) }).readAsDataURL(blob));
    fs.writeFile(path, url);
  }
  return path;
}

// "1-3, 5, 8-" → grupos de índices (desde 0). Lanza un error claro si algo no cuadra.
export function parseRanges(text, total) {
  const groups = [];
  for (const part of String(text).split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*-\s*(\d*)$|^(\d+)$/);
    if (!m) throw new Error(`No entiendo "${part}". Usa por ejemplo: 1-3, 5, 8-`);
    const a = Number(m[3] ?? (m[1] || 1));
    const b = Number(m[3] ?? (m[2] || total));
    if (a < 1 || b > total || a > b) throw new Error(`"${part}" no es válido: el PDF tiene ${total} páginas`);
    groups.push(Array.from({ length: b - a + 1 }, (_, i) => a - 1 + i));
  }
  if (!groups.length) throw new Error('Indica las páginas');
  return groups;
}
