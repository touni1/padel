// CelebGO: sube carpetas de imágenes y videos a celebgo.net (lo que hacía el
// "CelebGO Uploader" de Windows). Los archivos salen de una carpeta de MiPuter o
// directo de tu equipo/celular; el servidor de MiPuter es quien habla con celebgo
// (la API key queda guardada allí, nunca en el navegador). Todo entra como PENDING.
import * as fs from '../fs.js';
import { createWindow } from '../wm.js';
import { toast, formatSize, confirm } from '../ui.js';

const IMAGE = /\.(jpe?g|png|webp|gif)$/i;
const VIDEO = /\.(mp4|mov|webm|mkv|m4v)$/i;
const MAX_ATTEMPTS = 3;
const IMG_BATCH = 50;
const CONC_KEY = 'miputer.celebgo.concurrencia';

const titleFrom = (name) => name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, body) {
  const res = await fetch(`api/celebgo/${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

// Archivo de tu equipo: va crudo al servidor, con barra de progreso.
function sendLocal(file, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `api/celebgo/file?name=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      xhr.status === 200 ? resolve(data) : reject(new Error(data.error || `Error ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Se cortó la conexión'));
    signal.addEventListener('abort', () => xhr.abort());
    xhr.send(file);
  });
}

// Carpetas de MiPuter (fuera de la papelera) con cuántas fotos y videos tienen.
function mediaIn(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdir(d)) {
      if (e.path === fs.TRASH) continue;
      if (e.type === 'dir') walk(e.path);
      else if (IMAGE.test(e.name) || VIDEO.test(e.name)) out.push(e.path);
    }
  };
  walk(dir);
  return out;
}
function allDirs(dir = '/', out = []) {
  for (const e of fs.readdir(dir)) if (e.type === 'dir' && e.path !== fs.TRASH) out.push(e.path), allDirs(e.path, out);
  return out;
}

export default {
  id: 'celebgo',
  name: 'CelebGO',
  glyph: '📤',
  launch({ path } = {}) {
    const win = createWindow({ title: 'CelebGO', width: 760, height: 560 });
    win.body.classList.add('cg');
    win.body.innerHTML = `
      <div class="toolbar cg-bar">
        <select class="cg-dir" title="Carpeta de MiPuter"><option value="">📁 Carpeta de MiPuter…</option></select>
        <button data-act="local-dir" title="Elegir una carpeta de tu equipo">💻 Carpeta del equipo</button>
        <button data-act="local-files" title="Elegir fotos o videos sueltos (en el celular, de la galería)">🖼 Archivos</button>
        <span class="spacer"></span>
        <button data-act="settings" title="Configuración">⚙</button>
      </div>
      <div class="toolbar cg-bar">
        <input class="cg-tags grow" placeholder="tags separados por coma (ej: charlotte caniggia, argentina)" spellcheck="false">
        <button class="btn primary" data-act="start" disabled>▶ Subir</button>
        <button class="btn" data-act="stop" hidden>⏸ Detener</button>
      </div>
      <div class="cg-stats muted"></div>
      <div class="cg-list"><p class="muted cg-empty">Elige una carpeta de MiPuter, una carpeta de tu equipo o archivos sueltos. Quedan en <b>PENDING</b> en celebgo para que los apruebes.</p></div>
      <form class="cg-settings win-form" hidden>
        <h3>Configuración de CelebGO</h3>
        <label>URL del sitio <input name="apiUrl" placeholder="https://celebgo.net" spellcheck="false" required></label>
        <label>API key (X-Admin-API-Key) <input name="apiKey" type="password" autocomplete="off" spellcheck="false"></label>
        <small class="muted cg-key-hint"></small>
        <label>Subidas a la vez <input name="conc" type="number" min="1" max="10" value="3"></label>
        <div class="cg-row"><button class="btn primary">Guardar</button><button type="button" class="btn" data-act="close-settings">Cancelar</button></div>
      </form>
      <input type="file" class="cg-pick-dir" webkitdirectory multiple hidden>
      <input type="file" class="cg-pick-files" accept="image/*,video/*,.mkv,.m4v" multiple hidden>`;
    const $ = (s) => win.body.querySelector(s);
    const dirSelect = $('.cg-dir');
    const tagsInput = $('.cg-tags');
    const listEl = $('.cg-list');
    const statsEl = $('.cg-stats');
    const startBtn = $('[data-act="start"]');
    const stopBtn = $('[data-act="stop"]');
    const form = $('.cg-settings');
    let items = [];
    let running = null; // AbortController mientras sube
    let config = { configured: false };

    let concurrency = 3;
    try {
      concurrency = Math.min(10, Math.max(1, Number(localStorage.getItem(CONC_KEY)) || 3));
    } catch {}

    for (const d of allDirs()) {
      const n = mediaIn(d).length;
      if (n) dirSelect.add(new Option(`${d} (${n})`, d));
    }

    function render() {
      listEl.innerHTML = items.length ? '' : listEl.innerHTML;
      if (!items.length) return;
      for (const it of items) {
        if (!it.row) {
          it.row = document.createElement('div');
          it.row.className = 'cg-item';
          it.row.innerHTML = '<div class="cg-bar-fill"></div><span class="cg-icon"></span><span class="cg-name"></span><span class="cg-size muted"></span><span class="cg-state"></span>';
          it.row.querySelector('.cg-icon').textContent = it.kind === 'image' ? '🖼' : '🎬';
          it.row.querySelector('.cg-name').textContent = it.name;
          it.row.querySelector('.cg-size').textContent = formatSize(it.size);
        }
        listEl.appendChild(it.row);
        paint(it);
      }
      stats();
    }
    function paint(it) {
      const labels = { pending: 'espera', uploading: `${it.progress || 0}%`, waiting: 'subido', submitting: 'enviando…', done: '✓ ok', error: `✗ ${it.error || 'error'}` };
      const state = it.row.querySelector('.cg-state');
      state.textContent = labels[it.status];
      state.className = `cg-state cg-${it.status}`;
      state.title = it.error || '';
      it.row.querySelector('.cg-bar-fill').style.width = it.status === 'uploading' ? `${it.progress || 0}%` : '0';
      stats();
    }
    function stats() {
      const c = (s) => items.filter((i) => i.status === s).length;
      const bytes = items.reduce((a, i) => a + i.size, 0);
      statsEl.textContent = items.length
        ? `📦 ${items.length} archivos · ${formatSize(bytes)} · 🖼 ${items.filter((i) => i.kind === 'image').length} · 🎬 ${items.filter((i) => i.kind === 'video').length} · ✓ ${c('done')} ok${c('error') ? ` · ✗ ${c('error')} con error` : ''}`
        : '';
      startBtn.disabled = Boolean(running) || !items.some((i) => i.status === 'pending' || i.status === 'error');
      startBtn.textContent = items.some((i) => i.status === 'error') && !items.some((i) => i.status === 'pending') ? '↻ Reintentar fallidos' : `▶ Subir ${items.filter((i) => i.status === 'pending' || i.status === 'error').length || ''}`;
    }

    function load(list, folderName) {
      if (running) return;
      items = list
        .filter((x) => IMAGE.test(x.name) || VIDEO.test(x.name))
        .map((x) => ({ ...x, kind: IMAGE.test(x.name) ? 'image' : 'video', status: 'pending', progress: 0 }));
      listEl.innerHTML = items.length ? '' : '<p class="muted cg-empty">No hay imágenes ni videos ahí.</p>';
      if (folderName && !tagsInput.value.trim()) tagsInput.value = folderName.toLowerCase();
      render();
    }

    dirSelect.onchange = () => {
      const d = dirSelect.value;
      if (!d) return;
      load(
        mediaIn(d).map((p) => {
          const remote = fs.getRemote(p);
          return { name: fs.basename(p), size: remote?.size ?? fs.stat(p)?.size ?? 0, remote, path: p };
        }),
        fs.basename(d),
      );
    };
    const pickDir = $('.cg-pick-dir');
    const pickFiles = $('.cg-pick-files');
    pickDir.onchange = () => {
      const files = [...pickDir.files];
      load(files.map((f) => ({ name: f.name, size: f.size, file: f })), files[0]?.webkitRelativePath.split('/')[0]);
      pickDir.value = '';
      dirSelect.value = '';
    };
    pickFiles.onchange = () => {
      load([...pickFiles.files].map((f) => ({ name: f.name, size: f.size, file: f })));
      pickFiles.value = '';
      dirSelect.value = '';
    };

    async function uploadOne(it, signal) {
      it.status = 'uploading';
      it.progress = 0;
      it.error = '';
      paint(it);
      let r;
      if (it.file) r = await sendLocal(it.file, (pct) => ((it.progress = pct), paint(it)), signal);
      else if (it.remote) r = await api('file', { key: it.remote.key, size: it.remote.size, name: it.name });
      else throw new Error('Este archivo todavía no está subido a MiPuter');
      it.r2Key = r.r2Key;
      if (it.kind === 'video') {
        it.status = 'submitting';
        paint(it);
        await api('submit', { kind: 'video', items: [{ title: titleFrom(it.name), r2Key: it.r2Key }], tags: it.tags });
        it.status = 'done';
      } else it.status = 'waiting';
      paint(it);
    }

    async function flushImages(batch) {
      if (!batch.length) return;
      const slice = batch.splice(0, IMG_BATCH);
      slice.forEach((i) => ((i.status = 'submitting'), paint(i)));
      try {
        await api('submit', { kind: 'image', items: slice.map((i) => ({ title: titleFrom(i.name), r2Key: i.r2Key })), tags: slice[0].tags });
        slice.forEach((i) => ((i.status = 'done'), paint(i)));
      } catch (e) {
        slice.forEach((i) => ((i.status = 'error'), (i.error = `envío: ${e.message.slice(0, 120)}`), (i.r2Key = null), paint(i)));
      }
    }

    async function start() {
      if (!config.configured) return showSettings();
      const tags = tagsInput.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
      if (!tags.length) return toast('Escribe al menos un tag').done(undefined, true);
      const queue = items.filter((i) => i.status === 'pending' || i.status === 'error');
      queue.forEach((i) => ((i.tags = tags), (i.status = 'pending'), paint(i)));
      running = new AbortController();
      const { signal } = running;
      stopBtn.hidden = false;
      stats();
      const images = [];
      let next = 0;
      const worker = async () => {
        while (next < queue.length && !signal.aborted) {
          const it = queue[next++];
          for (let attempt = 1; attempt <= MAX_ATTEMPTS && !signal.aborted; attempt++) {
            try {
              await uploadOne(it, signal);
              break;
            } catch (e) {
              it.status = 'error';
              it.error = signal.aborted ? 'detenido' : e.message.slice(0, 150);
              paint(it);
              if (attempt < MAX_ATTEMPTS && !signal.aborted) await sleep(800 * attempt);
            }
          }
          if (it.status === 'waiting') {
            images.push(it);
            if (images.length >= IMG_BATCH) await flushImages(images);
          }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      while (images.length) await flushImages(images);
      const ok = queue.filter((i) => i.status === 'done').length;
      const bad = queue.filter((i) => i.status === 'error').length;
      running = null;
      stopBtn.hidden = true;
      stats();
      toast(`CelebGO: ${ok} subido${ok === 1 ? '' : 's'}${bad ? `, ${bad} con error` : ''}. Quedan en PENDING para aprobar.`).done(undefined, Boolean(bad));
    }

    async function showSettings() {
      form.hidden = false;
      form.apiUrl.value = config.apiUrl || 'https://celebgo.net';
      form.apiKey.value = '';
      form.apiKey.placeholder = config.configured ? 'Guardada (déjalo vacío para no cambiarla)' : 'Pega la API key';
      form.apiKey.required = !config.configured;
      $('.cg-key-hint').textContent = 'Es el ADMIN_UPLOAD_API_KEY del .env de celebgo. Queda guardada solo en el servidor de MiPuter.';
      form.conc.value = concurrency;
      form.apiUrl.focus();
    }
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        config = await api('config', { apiUrl: form.apiUrl.value, apiKey: form.apiKey.value });
        concurrency = Math.min(10, Math.max(1, Number(form.conc.value) || 3));
        try {
          localStorage.setItem(CONC_KEY, String(concurrency));
        } catch {}
        form.hidden = true;
        toast('CelebGO configurado').done();
      } catch (err) {
        toast(err.message).done(undefined, true);
      }
    };

    const actions = {
      'local-dir': () => pickDir.click(),
      'local-files': () => pickFiles.click(),
      settings: showSettings,
      'close-settings': () => (form.hidden = true),
      start,
      stop: () => running?.abort(),
    };
    win.body.querySelectorAll('[data-act]').forEach((b) => (b.onclick = (e) => (e.preventDefault(), actions[b.dataset.act]())));
    win.beforeClose = async () => {
      if (running && !(await confirm('Cerrar CelebGO', 'Hay subidas en curso: si cierras se detienen. ¿Cerrar igual?'))) return false;
      running?.abort();
      return true;
    };

    api('config').then((c) => {
      config = c;
      if (!c.configured) showSettings();
    });
    if (path && fs.isDir(path)) {
      dirSelect.value = path;
      if (dirSelect.value === path) dirSelect.onchange();
    }
    return win;
  },
};
