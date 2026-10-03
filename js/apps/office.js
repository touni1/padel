// Ver documentos de Word (.docx) y hojas de cálculo (.xlsx, .xls, .ods) sin
// descargarlos. Solo lectura. El contenido se muestra en un iframe aislado y sin
// scripts, así un documento malicioso no puede hacer nada dentro de MiPuter.
import * as fs from '../fs.js';
import * as storage from '../storage.js';
import { createWindow } from '../wm.js';
import { escapeHtml, formatSize } from '../ui.js';

const VENDOR = new URL('../vendor/', import.meta.url).href;
const MAX_BYTES = 40 * 1024 * 1024;
const MAX_ROWS = 2000;
const MAX_COLS = 60;
const SHEETS = ['xlsx', 'xls', 'xlsm', 'ods'];

const scripts = new Map();
function loadScript(src) {
  if (!scripts.has(src)) {
    scripts.set(
      src,
      new Promise((resolve, reject) => {
        const el = Object.assign(document.createElement('script'), { src, onload: resolve });
        el.onerror = () => {
          scripts.delete(src);
          reject(new Error(`No se pudo cargar ${src}`));
        };
        document.head.appendChild(el);
      }),
    );
  }
  return scripts.get(src);
}

const DOC_CSS = `
  body { margin: 0; background: #e9ebef; font: 15px/1.55 Calibri, Carlito, "Segoe UI", Arial, sans-serif; color: #1c2230; }
  .page { max-width: 800px; margin: 20px auto; padding: 56px 64px; background: #fff; box-shadow: 0 1px 6px rgba(0,0,0,.18); }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; margin: 10px 0; }
  td, th { border: 1px solid #c8ccd4; padding: 4px 8px; vertical-align: top; }
  h1, h2, h3 { line-height: 1.25; }
  @media (max-width: 700px) { .page { margin: 0; padding: 20px; } }`;

const SHEET_CSS = `
  body { margin: 0; font: 13px Calibri, Carlito, "Segoe UI", Arial, sans-serif; color: #1c2230; background: #fff; }
  table { border-collapse: collapse; }
  td { border: 1px solid #d5dae3; padding: 3px 7px; white-space: nowrap; max-width: 360px; overflow: hidden; text-overflow: ellipsis; }
  tr:first-child td { background: #f2f4f8; font-weight: 600; position: sticky; top: 0; }
  .note { padding: 8px 12px; background: #fff7d6; border-bottom: 1px solid #f0d97a; }`;

// Deja solo enlaces http(s), mailto y anclas internas (fuera javascript:, data:, file:…).
function safeLinks(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  for (const a of doc.querySelectorAll('[href]')) {
    if (!/^(https?:|mailto:|#)/i.test(a.getAttribute('href').trim())) a.removeAttribute('href');
  }
  return doc.body.innerHTML;
}

const page = (css, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${css}</style></head><body>${body}</body></html>`;

export default {
  id: 'office',
  name: 'Documentos',
  glyph: '📘',
  extensions: ['docx', ...SHEETS],
  hidden: true,
  launch({ path } = {}) {
    const ext = fs.extname(path);
    const isSheet = SHEETS.includes(ext);
    const win = createWindow({ title: `${fs.basename(path)} — ${isSheet ? 'Hoja de cálculo' : 'Documento'}`, width: 900, height: 640 });
    win.body.innerHTML = `
      <div class="app-fill">
        <div class="toolbar office-bar">
          <span class="office-info">Cargando…</span>
          <span class="spacer"></span>
          <a class="btn office-dl">⤓ Descargar</a>
        </div>
        <div class="office-tabs" hidden></div>
        <iframe class="office-frame grow" sandbox="allow-popups allow-popups-to-escape-sandbox" title="Vista del documento"></iframe>
      </div>`;
    const info = win.body.querySelector('.office-info');
    const frame = win.body.querySelector('.office-frame');
    const tabs = win.body.querySelector('.office-tabs');
    const dl = win.body.querySelector('.office-dl');
    const remote = fs.getRemote(path);
    dl.href = remote ? storage.url(remote.key, { download: fs.basename(path) }) : fs.readFile(path);
    dl.download = fs.basename(path);

    (async () => {
      try {
        if (remote && remote.size > MAX_BYTES) {
          throw new Error(`Es demasiado grande para verlo aquí (${formatSize(remote.size)}). Descárgalo para abrirlo.`);
        }
        const res = await fetch(remote ? storage.url(remote.key) : fs.readFile(path));
        if (!res.ok) throw new Error(`No se pudo leer el archivo (${res.status})`);
        const data = await res.arrayBuffer();

        if (!isSheet) {
          await loadScript(`${VENDOR}mammoth/mammoth.browser.min.js`);
          const { value, messages } = await window.mammoth.convertToHtml({ arrayBuffer: data });
          frame.srcdoc = page(DOC_CSS, `<div class="page">${value ? safeLinks(value) : '<p><i>(Documento vacío)</i></p>'}</div>`);
          const lost = messages.filter((m) => m.type === 'warning').length;
          info.textContent = `${fs.basename(path)} · solo lectura${lost ? ' · algunos formatos no se muestran igual que en Word' : ''}`;
          return;
        }

        await loadScript(`${VENDOR}sheetjs/xlsx.full.min.js`);
        const XLSX = window.XLSX;
        const book = XLSX.read(data, { type: 'array', cellDates: true, dense: true });
        const showSheet = (name) => {
          const ws = book.Sheets[name];
          tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.textContent === name));
          if (!ws['!ref']) {
            frame.srcdoc = page(SHEET_CSS, '<p class="note">Hoja vacía</p>');
            return;
          }
          const range = XLSX.utils.decode_range(ws['!ref']);
          const rows = range.e.r - range.s.r + 1;
          const cols = range.e.c - range.s.c + 1;
          const cut = rows > MAX_ROWS || cols > MAX_COLS;
          if (cut) {
            range.e.r = Math.min(range.e.r, range.s.r + MAX_ROWS - 1);
            range.e.c = Math.min(range.e.c, range.s.c + MAX_COLS - 1);
          }
          const html = XLSX.utils.sheet_to_html(ws, { editable: false, header: '', footer: '', range });
          const note = cut ? `<div class="note">Se muestran ${Math.min(rows, MAX_ROWS)} de ${rows} filas y ${Math.min(cols, MAX_COLS)} de ${cols} columnas. Descarga el archivo para verlo entero.</div>` : '';
          frame.srcdoc = page(SHEET_CSS, note + html);
          info.textContent = `${fs.basename(path)} · ${name} · ${rows} filas × ${cols} columnas · solo lectura`;
        };
        tabs.hidden = book.SheetNames.length < 2;
        for (const name of book.SheetNames) {
          const b = Object.assign(document.createElement('button'), { textContent: name });
          b.onclick = () => showSheet(name);
          tabs.appendChild(b);
        }
        showSheet(book.SheetNames[0]);
      } catch (e) {
        info.textContent = fs.basename(path);
        frame.srcdoc = page(DOC_CSS, `<div class="page"><p>${escapeHtml(e.message)}</p></div>`);
      }
    })();
    return win;
  },
};
