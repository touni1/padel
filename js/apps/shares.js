// Enlaces de descarga para compartir archivos con quien no tiene acceso a MiPuter.
import * as fs from '../fs.js';
import * as storage from '../storage.js';
import { createWindow } from '../wm.js';
import { confirm, reportError, toast } from '../ui.js';

const DURATIONS = [
  [1, '1 hora'],
  [24, '1 día'],
  [24 * 7, '7 días'],
  [24 * 30, '30 días'],
];
const LIMITS = [
  [0, 'Sin límite'],
  [1, '1 descarga'],
  [5, '5 descargas'],
  [10, '10 descargas'],
];

async function api(method, query = '', body) {
  const res = await fetch(`api/shares${query}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

const when = (ms) => new Date(ms).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Enlace copiado').done();
  } catch {
    toast('No se pudo copiar: selecciónalo y cópialo a mano').done(undefined, true);
  }
}

// Pinta una lista de enlaces con botones de copiar y desactivar.
const ICONS = { file: '📄', folder: '📁', upload: '📤' };
const fmt = (n) => (n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`);

function linkSummary(link) {
  if (link.type === 'upload') {
    return `Caduca ${when(link.expires)} · ${link.files} archivo${link.files === 1 ? '' : 's'} recibido${link.files === 1 ? '' : 's'}${link.maxFiles ? ` de ${link.maxFiles}` : ''} · ${fmt(link.bytes)} de ${fmt(link.maxBytes)}`;
  }
  return `Caduca ${when(link.expires)} · ${link.downloads} descarga${link.downloads === 1 ? '' : 's'}${link.maxDownloads ? ` de ${link.maxDownloads}` : ''}`;
}

// Pinta una lista de enlaces con botones de copiar y desactivar.
function renderLinks(container, links, onChange, showFile = false) {
  container.innerHTML = links.length ? '' : '<p class="muted">No hay enlaces activos.</p>';
  for (const link of links) {
    const row = document.createElement('div');
    row.className = 'share-row';
    row.innerHTML = `
      <div class="share-meta"><b></b><small></small></div>
      <button class="btn" data-act="copy">Copiar</button>
      <button class="btn" data-act="off">Desactivar</button>`;
    row.querySelector('b').textContent = showFile ? `${ICONS[link.type] || ''} ${link.type === 'upload' ? `Recibir en ${link.dir}` : link.name}` : link.url;
    row.querySelector('small').textContent = linkSummary(link);
    row.querySelector('[data-act="copy"]').onclick = () => copy(link.url);
    row.querySelector('[data-act="off"]').onclick = async () => {
      const what = link.type === 'upload' ? 'subir archivos con este enlace' : `descargar "${link.name}"`;
      if (!(await confirm('Desactivar enlace', `Quien tenga el enlace ya no podrá ${what}. ¿Desactivar?`))) return;
      await reportError(async () => {
        await api('DELETE', `?token=${encodeURIComponent(link.token)}`);
        onChange();
      });
    };
    container.appendChild(row);
  }
}

// Si el archivo vive solo en el navegador, primero se sube a B2.
async function ensureRemote(path) {
  const existing = fs.getRemote(path);
  if (existing) return existing;
  const content = fs.readFile(path);
  const blob = content.startsWith('data:') ? await (await fetch(content)).blob() : new Blob([content], { type: 'text/plain;charset=utf-8' });
  const remote = await storage.upload(blob, fs.basename(path));
  fs.writeRemote(path, remote);
  return remote;
}

const FILE_LIMITS = [
  [0, 'Sin límite'],
  [1, '1 archivo'],
  [10, '10 archivos'],
  [50, '50 archivos'],
];
const SIZE_LIMITS = [
  [1024 ** 3, '1 GB en total'],
  [5 * 1024 ** 3, '5 GB en total'],
  [20 * 1024 ** 3, '20 GB en total'],
];
const KINDS = {
  file: { title: 'Compartir', intro: 'Crea un enlace para que alguien descargue <b></b> sin entrar en tu MiPuter.', listTitle: 'Enlaces activos de este archivo' },
  folder: { title: 'Compartir carpeta', intro: 'Crea un enlace para que alguien descargue la carpeta <b></b> entera (como .zip) sin entrar. Si agregas archivos después, también se incluyen.', listTitle: 'Enlaces activos de esta carpeta' },
  upload: { title: 'Pedir archivos', intro: 'Crea un enlace para que alguien te <b>suba</b> archivos a <b></b> sin entrar ni ver lo que hay. Aparecen en la carpeta a medida que llegan.', listTitle: 'Enlaces activos para esta carpeta' },
};

const shareDialog = (kind) => (path) => {
  const name = fs.basename(path);
  const k = KINDS[kind];
  const win = createWindow({ title: `${k.title} · ${name}`, width: 540, height: 450 });
  const limits =
    kind === 'upload'
      ? `<label>Archivos <select name="maxFiles">${FILE_LIMITS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
         <label>Tamaño <select name="maxBytes">${SIZE_LIMITS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>`
      : `<label>Descargas <select name="max">${LIMITS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>`;
  win.body.innerHTML = `
    <div class="share">
      <p>${k.intro}</p>
      <div class="share-form">
        <label>Caduca en <select name="hours">${DURATIONS.map(([v, l]) => `<option value="${v}"${v === (kind === 'upload' ? 24 * 7 : 24) ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        ${limits}
        <button class="btn primary" data-act="create">Crear enlace</button>
      </div>
      <div class="share-result" hidden>
        <input readonly>
        <button class="btn" data-act="copy">Copiar</button>
      </div>
      <h3>${k.listTitle}</h3>
      <div class="share-list"></div>
    </div>`;
  [...win.body.querySelectorAll('p b')].at(-1).textContent = name;
  const value = (n) => Number(win.body.querySelector(`[name="${n}"]`)?.value) || null;
  const listEl = win.body.querySelector('.share-list');
  const result = win.body.querySelector('.share-result');
  const createBtn = win.body.querySelector('[data-act="create"]');

  const refresh = async () => {
    const all = await api('GET');
    const remote = kind === 'file' && fs.getRemote(path);
    const links = kind === 'file' ? (remote ? all.filter((l) => l.type === 'file' && l.key === remote.key) : []) : all.filter((l) => l.type === kind && l.dir === fs.normalize(path));
    renderLinks(listEl, links, refresh);
  };

  createBtn.onclick = () =>
    reportError(async () => {
      createBtn.disabled = true;
      createBtn.textContent = 'Creando…';
      try {
        const body = { type: kind, hours: value('hours') };
        if (kind === 'file') Object.assign(body, { key: (await ensureRemote(path)).key, name, maxDownloads: value('max') });
        else if (kind === 'folder') Object.assign(body, { path: fs.normalize(path), maxDownloads: value('max') });
        else Object.assign(body, { path: fs.normalize(path), maxFiles: value('maxFiles'), maxBytes: value('maxBytes') });
        // La carpeta tiene que existir ya en el servidor: se envía lo pendiente antes.
        if (kind !== 'file') await fs.syncWithServer();
        const link = await api('POST', '', body);
        result.hidden = false;
        result.querySelector('input').value = link.url;
        result.querySelector('input').select();
        await copy(link.url);
        await refresh();
      } finally {
        createBtn.disabled = false;
        createBtn.textContent = 'Crear enlace';
      }
    });
  result.querySelector('[data-act="copy"]').onclick = () => copy(result.querySelector('input').value);
  reportError(refresh);
  return win;
};

export const shareFile = shareDialog('file');
export const shareFolder = shareDialog('folder');
export const requestFiles = shareDialog('upload');

export default {
  id: 'shares',
  name: 'Enlaces compartidos',
  glyph: '🔗',
  desktop: false,
  launch() {
    const win = createWindow({ title: 'Enlaces compartidos', width: 560, height: 420 });
    win.body.innerHTML = `
      <div class="share">
        <p class="muted">Para crear uno: clic derecho en un archivo → <b>Compartir enlace…</b>, o en una carpeta → <b>Compartir carpeta…</b> / <b>Pedir archivos…</b></p>
        <div class="share-list"></div>
      </div>`;
    const listEl = win.body.querySelector('.share-list');
    const refresh = async () => renderLinks(listEl, await api('GET'), refresh, true);
    reportError(refresh);
    return win;
  },
};
