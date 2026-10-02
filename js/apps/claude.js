// Claude: terminal real del servidor donde corre Claude Code (xterm.js + WebSocket /api/pty).
// Cada sesión vive en tmux en el servidor: cerrar la ventana solo se desconecta,
// y "Terminar sesión" es lo que cierra Claude de verdad.
import { createWindow } from '../wm.js';
import { confirm, toast } from '../ui.js';

const CDN = 'https://cdn.jsdelivr.net/npm/';
const ASSETS = [
  { tag: 'link', url: `${CDN}@xterm/xterm@6.0.0/css/xterm.css`, sri: 'sha384-n2n7twoohnW+d3myBKaUgl7DSiwidw6MkQy9oesGzkPpMjejKRR3XlnD+5yCdtBD' },
  { tag: 'script', url: `${CDN}@xterm/xterm@6.0.0/lib/xterm.js`, sri: 'sha384-f/1U6Z9wM4D71a5eRXEZnyOTMOvjqxr2XLwh+Go1OvIl3L3tOcvUrzudnhbECwl4' },
  { tag: 'script', url: `${CDN}@xterm/addon-fit@0.11.0/lib/addon-fit.js`, sri: 'sha384-txoiwu4RR2GD3qySbaj+BbzibkLbSJRcfqGYMu6z1EqHil4A2dyBiBW5dlacG6OR' },
];

let xtermLoaded;
function loadXterm() {
  xtermLoaded ??= Promise.all(
    ASSETS.map(
      ({ tag, url, sri }) =>
        new Promise((resolve, reject) => {
          const el = document.createElement(tag);
          if (tag === 'link') Object.assign(el, { rel: 'stylesheet', href: url });
          else el.src = url;
          Object.assign(el, { integrity: sri, crossOrigin: 'anonymous', onload: resolve });
          el.onerror = () => reject(new Error(`No se pudo cargar ${url}`));
          document.head.appendChild(el);
        }),
    ),
  ).catch((e) => {
    xtermLoaded = null;
    throw e;
  });
  return xtermLoaded;
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

const ago = (ms) => {
  const min = Math.round((Date.now() - ms) / 60000);
  return min < 1 ? 'ahora' : min < 60 ? `hace ${min} min` : `hace ${Math.round(min / 60)} h`;
};

export default {
  id: 'claude',
  name: 'Claude',
  glyph: '✳️',
  launch() {
    const win = createWindow({ title: 'Claude', width: 900, height: 560 });
    win.body.classList.add('claude-app');
    win.body.innerHTML = `
      <div class="toolbar">
        <span class="claude-status">Cargando…</span>
        <span class="spacer"></span>
        <button data-act="sessions" hidden>Sesiones</button>
        <button data-act="reconnect" hidden>Reconectar</button>
        <button data-act="kill" hidden title="Cierra Claude en el servidor">Terminar sesión</button>
      </div>
      <div class="claude-main"></div>`;
    const main = win.body.querySelector('.claude-main');
    const statusEl = win.body.querySelector('.claude-status');
    const buttons = Object.fromEntries([...win.body.querySelectorAll('[data-act]')].map((b) => [b.dataset.act, b]));
    const show = (...names) => Object.entries(buttons).forEach(([n, b]) => (b.hidden = !names.includes(n)));
    let conn = null;
    let slot = null;

    function disconnect() {
      if (!conn) return;
      conn.closing = true;
      conn.ws.close();
      conn.observer.disconnect();
      conn.term.dispose();
      conn = null;
    }

    async function picker() {
      disconnect();
      slot = null;
      win.setTitle('Claude');
      show();
      statusEl.textContent = 'Elige una sesión';
      main.innerHTML = '<div class="claude-picker">Cargando…</div>';
      const box = main.firstChild;
      try {
        const info = await api('api/claude');
        if (!info.enabled) {
          box.textContent = 'La app Claude no está activada en el servidor (mira el apartado "App Claude" del README).';
          return;
        }
        const bySlot = new Map(info.sessions.map((s) => [s.slot, s]));
        box.innerHTML = '<p>Cada sesión sigue viva en el servidor aunque cierres la ventana.</p>';
        for (let n = 1; n <= info.max; n++) {
          const s = bySlot.get(n);
          const row = document.createElement('div');
          row.className = 'claude-slot';
          row.innerHTML = `<span><b>Sesión ${n}</b> · <span class="muted"></span></span><button class="btn"></button>`;
          row.querySelector('.muted').textContent = !s ? 'libre' : s.attached ? `abierta en otra ventana · ${ago(s.activity)}` : `en segundo plano · ${ago(s.activity)}`;
          row.querySelector('button').textContent = s ? 'Retomar' : 'Abrir';
          row.querySelector('button').onclick = () => connect(n);
          box.appendChild(row);
        }
      } catch (e) {
        box.textContent = e.message;
      }
    }

    async function connect(n) {
      disconnect();
      slot = n;
      win.setTitle(`Claude · sesión ${n}`);
      statusEl.textContent = 'Conectando…';
      show('sessions');
      main.innerHTML = '';
      try {
        await loadXterm();
      } catch (e) {
        statusEl.textContent = e.message;
        return;
      }
      const term = new window.Terminal({
        cursorBlink: true,
        fontFamily: 'ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace',
        fontSize: 13,
        scrollback: 5000,
        theme: { background: '#1e1e1e' },
      });
      const fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open(main);
      fit.fit();

      const url = new URL(`api/pty?slot=${n}&cols=${term.cols}&rows=${term.rows}`, location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(url);
      let timer = 0;
      const observer = new ResizeObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(() => main.offsetWidth && fit.fit(), 50);
      });
      observer.observe(main);
      const c = (conn = { ws, term, observer, closing: false, opened: false });
      const send = (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

      ws.onopen = () => {
        c.opened = true;
        statusEl.textContent = `Conectado · sesión ${n}`;
        show('sessions', 'kill');
        send({ t: 'r', c: term.cols, r: term.rows });
        term.focus();
      };
      ws.onmessage = (e) => term.write(e.data);
      ws.onclose = () => {
        if (c.closing) return;
        statusEl.textContent = c.opened
          ? 'Desconectado'
          : 'No se pudo conectar (¿sesión caducada, o demasiadas ventanas de Claude abiertas?)';
        show('sessions', 'reconnect', ...(c.opened ? ['kill'] : []));
      };
      term.onData((d) => send({ t: 'i', d }));
      term.onResize(({ cols, rows }) => send({ t: 'r', c: cols, r: rows }));
    }

    buttons.sessions.onclick = picker;
    buttons.reconnect.onclick = () => connect(slot);
    buttons.kill.onclick = async () => {
      const n = slot;
      if (!(await confirm('Terminar sesión', `¿Cerrar Claude en la sesión ${n}? Se pierde lo que no esté guardado en la conversación.`))) return;
      try {
        await api(`api/claude/kill?slot=${n}`, { method: 'POST' });
        toast(`Sesión ${n} terminada`);
        picker();
      } catch (e) {
        toast(e.message);
      }
    };
    win.beforeClose = () => {
      if (conn?.opened) toast(`La sesión ${slot} sigue en segundo plano. Retómala desde Claude.`);
      disconnect();
      return true;
    };

    picker();
    return win;
  },
};
