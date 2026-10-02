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
function renderLinks(container, links, onChange, showFile = false) {
  container.innerHTML = links.length ? '' : '<p class="muted">No hay enlaces activos.</p>';
  for (const link of links) {
    const row = document.createElement('div');
    row.className = 'share-row';
    row.innerHTML = `
      <div class="share-meta"><b></b><small></small></div>
      <button class="btn" data-act="copy">Copiar</button>
      <button class="btn" data-act="off">Desactivar</button>`;
    row.querySelector('b').textContent = showFile ? link.name : link.url;
    row.querySelector('small').textContent =
      `Caduca ${when(link.expires)} · ${link.downloads} descarga${link.downloads === 1 ? '' : 's'}` +
      (link.maxDownloads ? ` de ${link.maxDownloads}` : '');
    row.querySelector('[data-act="copy"]').onclick = () => copy(link.url);
    row.querySelector('[data-act="off"]').onclick = async () => {
      if (!(await confirm('Desactivar enlace', `Quien tenga el enlace de "${link.name}" ya no podrá descargarlo. ¿Desactivar?`))) return;
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

export function shareFile(path) {
  const name = fs.basename(path);
  const win = createWindow({ title: `Compartir · ${name}`, width: 520, height: 430 });
  win.body.innerHTML = `
    <div class="share">
      <p>Crea un enlace para que alguien descargue <b></b> sin entrar en tu MiPuter.</p>
      <div class="share-form">
        <label>Caduca en <select name="hours">${DURATIONS.map(([v, l]) => `<option value="${v}"${v === 24 ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>Descargas <select name="max">${LIMITS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
        <button class="btn primary" data-act="create">Crear enlace</button>
      </div>
      <div class="share-result" hidden>
        <input readonly>
        <button class="btn" data-act="copy">Copiar</button>
      </div>
      <h3>Enlaces activos de este archivo</h3>
      <div class="share-list"></div>
    </div>`;
  win.body.querySelector('p b').textContent = name;
  const listEl = win.body.querySelector('.share-list');
  const result = win.body.querySelector('.share-result');
  const createBtn = win.body.querySelector('[data-act="create"]');

  const refresh = async () => {
    const remote = fs.getRemote(path);
    const links = remote ? (await api('GET')).filter((l) => l.key === remote.key) : [];
    renderLinks(listEl, links, refresh);
  };

  createBtn.onclick = () =>
    reportError(async () => {
      createBtn.disabled = true;
      createBtn.textContent = 'Creando…';
      try {
        const remote = await ensureRemote(path);
        const link = await api('POST', '', {
          key: remote.key,
          name,
          hours: Number(win.body.querySelector('[name="hours"]').value),
          maxDownloads: Number(win.body.querySelector('[name="max"]').value) || null,
        });
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
}

export default {
  id: 'shares',
  name: 'Enlaces compartidos',
  glyph: '🔗',
  desktop: false,
  launch() {
    const win = createWindow({ title: 'Enlaces compartidos', width: 560, height: 420 });
    win.body.innerHTML = `
      <div class="share">
        <p class="muted">Para crear uno: clic derecho en un archivo → <b>Compartir enlace…</b></p>
        <div class="share-list"></div>
      </div>`;
    const listEl = win.body.querySelector('.share-list');
    const refresh = async () => renderLinks(listEl, await api('GET'), refresh, true);
    reportError(refresh);
    return win;
  },
};
