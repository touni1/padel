// Navegador: un Google Chrome de verdad corriendo en el VPS, que se ve y se maneja
// desde esta ventana (pantalla virtual por VNC a través de guacd, igual que Windows).
// Lo que descargas queda en el servidor y desde aquí lo pasas a tus carpetas.
// Los .html de tus carpetas se siguen abriendo aquí mismo, sin Chrome.
import * as fs from '../fs.js';
import { createWindow } from '../wm.js';
import { escapeHtml, toast, formatSize, confirm, reportError } from '../ui.js';
import { isTouch } from '../touch.js';
import { loadGuacamole } from './windows.js';
import { pickFiles } from '../pdfkit.js';

const STATES = ['Inactivo', 'Conectando…', 'Abriendo Chrome…', 'Conectado', 'Desconectando…', 'Desconectado'];
const SAVE_DIR = '/Descargas';

async function api(path, body) {
  const res = await fetch(`api/web${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

async function waitJob(id, note, label) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await fetch(`api/jobs?id=${encodeURIComponent(id)}`);
    const job = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(job.error || `Error ${res.status}`);
    if (job.state === 'done') return job.result;
    if (job.state === 'error') throw new Error(job.error);
    note.update(`${label}… ${Math.floor(job.progress * 100)}%`);
  }
}

// Un .html de tus carpetas: se muestra tal cual, aislado.
function openLocalHtml(path) {
  const win = createWindow({ title: `${fs.basename(path)} — Navegador`, width: 820, height: 560 });
  win.body.innerHTML = '<iframe class="browser-frame" style="width:100%;height:100%;border:0;background:#fff" sandbox="allow-scripts allow-forms allow-popups"></iframe>';
  const frame = win.body.querySelector('iframe');
  fs.readFileAsync(path).then(
    (html) => (frame.srcdoc = html),
    (e) => (frame.srcdoc = `<p style="font-family:sans-serif">No se pudo abrir: ${escapeHtml(e.message)}</p>`),
  );
  return win;
}

// Pasa una descarga de Chrome a /Descargas de MiPuter (y la quita del servidor).
async function saveDownload(file) {
  const note = toast(`Guardando "${file.name}"…`);
  try {
    const { job } = await api('/save', { name: file.name });
    const result = await waitJob(job, note, 'Guardando');
    fs.ensureDir(SAVE_DIR);
    const path = fs.join(SAVE_DIR, fs.uniqueName(SAVE_DIR, result.name));
    fs.writeRemote(path, result);
    note.done(`Guardado en ${path} (${formatSize(result.size)})`);
    return true;
  } catch (e) {
    note.done(`No se pudo guardar: ${e.message}`, true);
    return false;
  }
}

// Deja archivos de MiPuter donde Chrome los pueda elegir (carpeta "MiPuter").
async function sendFiles(paths) {
  for (const path of paths) {
    const name = fs.basename(path);
    const note = toast(`Pasando "${name}" al navegador…`);
    try {
      const remote = fs.getRemote(path);
      let sent;
      if (remote) {
        const { job } = await api('/send', { name, key: remote.key, size: remote.size });
        sent = await waitJob(job, note, 'Pasando');
      } else {
        const content = await fs.readFileAsync(path);
        if (content.startsWith('data:')) throw new Error('Este archivo todavía no se subió: espera unos segundos y prueba de nuevo');
        sent = await api('/send', { name, text: content });
      }
      note.done(`Listo: en Chrome elige la carpeta "MiPuter" → ${sent.name}`);
    } catch (e) {
      note.done(`No se pudo pasar "${name}": ${e.message}`, true);
    }
  }
}

export default {
  id: 'browser',
  name: 'Navegador',
  glyph: '🌐',
  extensions: ['html', 'htm'],
  launch({ path } = {}) {
    if (path) return openLocalHtml(fs.normalize(path));
    const win = createWindow({ title: 'Navegador', width: 1100, height: 700 });
    win.body.classList.add('rdp', 'web');
    win.body.tabIndex = -1;
    win.body.innerHTML = `
      <div class="toolbar rdp-bar">
        <span class="rdp-status">Cargando…</span>
        <span class="spacer"></span>
        <button data-act="paste" title="Pega en Chrome el texto del portapapeles de tu equipo">📋 Pegar</button>
        <button data-act="send" title="Deja archivos de MiPuter en la carpeta «MiPuter» para subirlos a una web">📤 Pasar archivos</button>
        <button data-act="downloads" title="Lo que bajaste con Chrome">📥 Descargas <b class="web-count" hidden></b></button>
        <button data-act="full" title="Pantalla completa">⛶</button>
        <button data-act="reconnect" hidden>Reconectar</button>
      </div>
      <div class="rdp-screen"></div>
      <div class="web-downloads" hidden>
        <div class="web-downloads-head"><b>Descargas de Chrome</b><button class="btn" data-act="close-dl">✕</button></div>
        <p class="muted">Quedan en el servidor hasta que las guardes en <b>${SAVE_DIR}</b> de MiPuter o las borres.</p>
        <div class="web-dl-list"></div>
      </div>`;
    const screen = win.body.querySelector('.rdp-screen');
    const status = win.body.querySelector('.rdp-status');
    const reconnectBtn = win.body.querySelector('[data-act="reconnect"]');
    const panel = win.body.querySelector('.web-downloads');
    const listEl = win.body.querySelector('.web-dl-list');
    const countEl = win.body.querySelector('.web-count');
    let client = null;
    let keyboard = null;
    let G = null;
    let known = null; // descargas ya vistas (para avisar de las nuevas)

    const fit = () => {
      if (!client) return;
      const display = client.getDisplay();
      const w = display.getWidth();
      const h = display.getHeight();
      if (w && h) display.scale(Math.min(screen.clientWidth / w, screen.clientHeight / h));
    };

    function renderDownloads(files) {
      countEl.hidden = !files.length;
      countEl.textContent = files.length;
      listEl.innerHTML = files.length ? '' : '<p class="muted">No hay descargas.</p>';
      for (const file of files) {
        const row = document.createElement('div');
        row.className = 'share-row';
        row.innerHTML = '<div class="share-meta"><b></b><small></small></div><button class="btn primary" data-a="save">Guardar en MiPuter</button><button class="btn" data-a="del">Borrar</button>';
        row.querySelector('b').textContent = file.name;
        row.querySelector('small').textContent = `${formatSize(file.size)} · ${new Date(file.mtime).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
        row.querySelector('[data-a="save"]').onclick = async (e) => {
          e.target.disabled = true;
          if (await saveDownload(file)) refresh();
          else e.target.disabled = false;
        };
        row.querySelector('[data-a="del"]').onclick = async () => {
          if (!(await confirm('Borrar descarga', `¿Borrar "${file.name}" del servidor? No se guarda en MiPuter.`))) return;
          await reportError(async () => {
            await api('/delete', { name: file.name });
            refresh();
          });
        };
        listEl.appendChild(row);
      }
    }

    async function refresh() {
      let data;
      try {
        data = await api('');
      } catch {
        return null;
      }
      if (known) {
        for (const f of data.files) if (!known.has(f.name)) toast(`Chrome descargó "${f.name}": guárdalo en MiPuter desde 📥 Descargas`).done();
      }
      known = new Set(data.files.map((f) => f.name));
      renderDownloads(data.files);
      return data;
    }

    async function connect() {
      reconnectBtn.hidden = true;
      const data = await refresh();
      if (data && !data.installed) {
        status.textContent = 'El navegador no está instalado en el servidor';
        return;
      }
      G = await loadGuacamole();
      screen.innerHTML = '';
      const url = new URL('api/web', location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      client = new G.Client(new G.WebSocketTunnel(url.href));
      const display = client.getDisplay();
      const el = display.getElement();
      el.classList.add('rdp-display');
      screen.appendChild(el);

      let lastError = '';
      client.onstatechange = (state) => {
        status.textContent = state === 5 && lastError ? lastError : `${STATES[state] || ''} · Chrome en tu servidor`;
        if (state === 3) setTimeout(fit, 100);
        if (state === 5) reconnectBtn.hidden = false;
      };
      client.onerror = (err) => {
        lastError = `Error: ${err.message || 'no se pudo conectar'}`;
        status.textContent = lastError;
        reconnectBtn.hidden = false;
      };
      display.onresize = fit;

      // Lo que copias en Chrome llega al portapapeles de tu equipo.
      client.onclipboard = (stream, mimetype) => {
        if (!/^text\//.test(mimetype)) return;
        const reader = new G.StringReader(stream);
        let text = '';
        reader.ontext = (t) => (text += t);
        reader.onend = () => navigator.clipboard?.writeText(text).catch(() => {});
      };

      const mouse = isTouch() ? new G.Mouse.Touchpad(el) : new G.Mouse(el);
      mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = (state) => {
        const scale = display.getScale();
        client.sendMouseState(new G.Mouse.State(state.x / scale, state.y / scale, state.left, state.middle, state.right, state.up, state.down));
      };

      keyboard?.reset();
      keyboard = new G.Keyboard(win.body);
      keyboard.onkeydown = (keysym) => {
        client.sendKeyEvent(1, keysym);
        return false;
      };
      keyboard.onkeyup = (keysym) => client.sendKeyEvent(0, keysym);

      client.connect('');
      win.body.focus();
    }

    let timer = 0;
    new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(fit, 150);
    }).observe(screen);

    // Revisa las descargas cada pocos segundos mientras la ventana está abierta.
    const poll = setInterval(refresh, 5000);

    const actions = {
      paste: async () => {
        if (!client) return;
        let text;
        try {
          text = await navigator.clipboard.readText();
        } catch {
          return toast('El navegador no dejó leer el portapapeles').done(undefined, true);
        }
        const writer = new G.StringWriter(client.createClipboardStream('text/plain'));
        writer.sendText(text);
        writer.sendEnd();
        // Y Ctrl+V en Chrome, para que quede pegado donde está el cursor.
        setTimeout(() => {
          [0xffe3, 0x76].forEach((k) => client.sendKeyEvent(1, k));
          [0x76, 0xffe3].forEach((k) => client.sendKeyEvent(0, k));
        }, 150);
        win.body.focus();
      },
      send: async () => {
        const paths = await pickFiles({ title: 'Pasar archivos al navegador', exts: null, multiple: true });
        if (paths?.length) await sendFiles(paths);
        win.body.focus();
      },
      downloads: () => {
        panel.hidden = !panel.hidden;
        if (!panel.hidden) refresh();
      },
      'close-dl': () => {
        panel.hidden = true;
        win.body.focus();
      },
      full: () => (document.fullscreenElement ? document.exitFullscreen() : win.body.requestFullscreen?.()),
      reconnect: () => {
        client?.disconnect();
        connect().catch((e) => (status.textContent = e.message));
      },
    };
    win.body.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => actions[b.dataset.act]()));
    screen.addEventListener('mousedown', () => win.body.focus());
    win.beforeClose = async () => {
      clearInterval(poll);
      keyboard?.reset();
      client?.disconnect();
      return true;
    };

    connect().catch((e) => (status.textContent = e.message));
    return win;
  },
};
