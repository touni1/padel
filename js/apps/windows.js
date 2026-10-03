// Windows: el escritorio de tu Windows Server dentro de una ventana (RDP a través
// de guacd en el servidor, con la librería oficial de Apache Guacamole).
import { createWindow } from '../wm.js';
import { toast, confirm } from '../ui.js';
import { launch } from '../registry.js';
import { isTouch } from '../touch.js';

const VENDOR = new URL('../vendor/', import.meta.url).href;
let libPromise;
function loadGuacamole() {
  libPromise ??= new Promise((resolve, reject) => {
    const el = Object.assign(document.createElement('script'), { src: `${VENDOR}guacamole/guacamole-common.js`, onload: () => resolve(window.Guacamole) });
    el.onerror = () => {
      libPromise = null;
      reject(new Error('No se pudo cargar el cliente de escritorio remoto'));
    };
    document.head.appendChild(el);
  });
  return libPromise;
}

const STATES = ['Inactivo', 'Conectando…', 'Esperando a Windows…', 'Conectado', 'Desconectando…', 'Desconectado'];

export default {
  id: 'windows',
  name: 'Windows',
  glyph: '🖥️',
  launch() {
    const win = createWindow({ title: 'Windows', width: 1100, height: 720 });
    win.body.classList.add('rdp');
    win.body.tabIndex = -1;
    win.body.innerHTML = `
      <div class="toolbar rdp-bar">
        <span class="rdp-status">Cargando…</span>
        <span class="spacer"></span>
        <button data-act="paste" title="Envía el texto del portapapeles de tu equipo al de Windows">📋 Pegar en Windows</button>
        <button data-act="cad" title="Ctrl+Alt+Supr">Ctrl+Alt+Supr</button>
        <button data-act="full" title="Pantalla completa">⛶</button>
        <button data-act="reconnect" hidden>Reconectar</button>
      </div>
      <div class="rdp-screen"></div>`;
    const screen = win.body.querySelector('.rdp-screen');
    const status = win.body.querySelector('.rdp-status');
    const reconnectBtn = win.body.querySelector('[data-act="reconnect"]');
    let client = null;
    let keyboard = null;
    let G = null;

    const fit = () => {
      if (!client) return;
      const display = client.getDisplay();
      const w = display.getWidth();
      const h = display.getHeight();
      if (w && h) display.scale(Math.min(screen.clientWidth / w, screen.clientHeight / h, 1));
    };

    async function connect() {
      reconnectBtn.hidden = true;
      const cfg = await (await fetch('api/windows-config')).json();
      if (!cfg.configured) {
        status.textContent = 'Falta configurar el acceso a Windows';
        screen.innerHTML = '<div class="rdp-empty"><p>Carga la dirección, el usuario y la contraseña de tu Windows en <b>Ajustes → Windows</b>.</p><button class="btn primary">Abrir Ajustes</button></div>';
        screen.querySelector('button').onclick = () => launch('settings');
        return;
      }
      G = await loadGuacamole();
      screen.innerHTML = '';
      const url = new URL('api/rdp', location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      client = new G.Client(new G.WebSocketTunnel(url.href));
      const display = client.getDisplay();
      const el = display.getElement();
      el.classList.add('rdp-display');
      screen.appendChild(el);

      let lastError = '';
      client.onstatechange = (state) => {
        // Al desconectarse se mantiene el motivo, si lo hubo (p. ej. contraseña incorrecta).
        status.textContent = state === 5 && lastError ? lastError : `${STATES[state] || ''} · ${cfg.username}@${cfg.host}`;
        if (state === 3) setTimeout(fit, 100);
        if (state === 5) reconnectBtn.hidden = false;
      };
      client.onerror = (err) => {
        const auth = err.code === 0x0207 || err.code === 0x0301 || /credential|authentication/i.test(err.message || '');
        lastError = auth ? 'Windows rechazó el usuario o la contraseña: revísalos en Ajustes → Windows' : `Error: ${err.message || 'no se pudo conectar'}`;
        status.textContent = lastError;
        reconnectBtn.hidden = false;
      };
      display.onresize = fit;

      // Lo que se copia en Windows llega al portapapeles de tu equipo.
      client.onclipboard = (stream, mimetype) => {
        if (!/^text\//.test(mimetype)) return;
        const reader = new G.StringReader(stream);
        let text = '';
        reader.ontext = (t) => (text += t);
        reader.onend = () => navigator.clipboard?.writeText(text).catch(() => {});
      };

      // Ratón (o toque: el dedo mueve el puntero como en un portátil).
      const mouse = isTouch() ? new G.Mouse.Touchpad(el) : new G.Mouse(el);
      const sendMouse = (state) => {
        const scale = display.getScale();
        client.sendMouseState(new G.Mouse.State(state.x / scale, state.y / scale, state.left, state.middle, state.right, state.up, state.down));
      };
      mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = sendMouse;

      // Teclado solo cuando la ventana tiene el foco (no captura las teclas del resto de MiPuter).
      keyboard?.reset();
      keyboard = new G.Keyboard(win.body);
      keyboard.onkeydown = (keysym) => {
        client.sendKeyEvent(1, keysym);
        return false;
      };
      keyboard.onkeyup = (keysym) => client.sendKeyEvent(0, keysym);

      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      client.connect(`width=${Math.floor(screen.clientWidth)}&height=${Math.floor(screen.clientHeight)}&dpi=96&tz=${encodeURIComponent(tz)}`);
      win.body.focus();
    }

    // Al cambiar el tamaño de la ventana, Windows cambia su resolución.
    let timer = 0;
    new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!client || !screen.clientWidth) return;
        client.sendSize(Math.floor(screen.clientWidth), Math.floor(screen.clientHeight));
        fit();
      }, 300);
    }).observe(screen);

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
        toast('Texto enviado al portapapeles de Windows: pégalo con Ctrl+V').done();
        win.body.focus();
      },
      cad: () => {
        if (!client) return;
        [0xffe3, 0xffe9, 0xffff].forEach((k) => client.sendKeyEvent(1, k));
        [0xffff, 0xffe9, 0xffe3].forEach((k) => client.sendKeyEvent(0, k));
      },
      full: () => (document.fullscreenElement ? document.exitFullscreen() : win.body.requestFullscreen?.()),
      reconnect: () => {
        client?.disconnect();
        connect();
      },
    };
    win.body.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => actions[b.dataset.act]()));
    win.body.addEventListener('mousedown', () => win.body.focus());
    win.beforeClose = async () => {
      if (client && !(await confirm('Cerrar Windows', 'Se desconecta el escritorio remoto. Tus programas siguen abiertos en Windows.'))) return false;
      keyboard?.reset();
      client?.disconnect();
      return true;
    };

    connect().catch((e) => (status.textContent = e.message));
    return win;
  },
};
