import * as fs from '../fs.js';
import { createWindow } from '../wm.js';
import { confirm, toast, formatSize, escapeHtml } from '../ui.js';
import * as storage from '../storage.js';

const SETTINGS_KEY = 'miputer.settings.v1';

export const WALLPAPERS = {
  Océano: 'radial-gradient(circle at 20% 20%, #3a5a8c 0%, #1d2b44 55%, #111a2b 100%)',
  Atardecer: 'linear-gradient(135deg, #ff7e5f 0%, #c94b7b 50%, #3a1c71 100%)',
  Bosque: 'linear-gradient(160deg, #2f6b4f 0%, #1b3d2f 60%, #0e1f18 100%)',
  Aurora: 'linear-gradient(120deg, #0f2027 0%, #203a43 40%, #2c7a7b 75%, #7ee8a2 100%)',
  Lavanda: 'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)',
  Grafito: 'linear-gradient(180deg, #3a3f47 0%, #1e2126 100%)',
};

export function loadSettings() {
  try {
    return { wallpaper: 'Océano', theme: 'light', ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { wallpaper: 'Océano', theme: 'light' };
  }
}

export function applySettings(s = loadSettings()) {
  document.getElementById('desktop').style.background = WALLPAPERS[s.wallpaper] || WALLPAPERS.Océano;
  document.documentElement.dataset.theme = s.theme;
}

function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  applySettings(s);
}

export default {
  id: 'settings',
  name: 'Ajustes',
  glyph: '⚙️',
  launch() {
    const win = createWindow({ title: 'Ajustes', width: 500, height: 640 });
    const s = loadSettings();
    win.body.innerHTML = `
      <div class="settings">
        <section>
          <h3>Fondo de escritorio</h3>
          <div class="swatches">
            ${Object.entries(WALLPAPERS)
              .map(([name, bg]) => `<div class="swatch" title="${name}" data-name="${name}" style="background:${bg}"></div>`)
              .join('')}
          </div>
        </section>
        <section>
          <h3>Tema de las ventanas</h3>
          <select class="theme">
            <option value="light">Claro</option>
            <option value="dark">Oscuro</option>
          </select>
        </section>
        <section>
          <h3>Espacio usado</h3>
          <div class="usage"></div>
        </section>
        <section class="b2-config" hidden>
          <h3>Backblaze B2 (dónde se guardan las subidas)</h3>
          <p class="b2-state muted"></p>
          <form class="b2-form">
            <input name="keyId" placeholder="keyID" autocomplete="off" spellcheck="false" required>
            <input name="appKey" type="password" placeholder="applicationKey" autocomplete="new-password" required>
            <input name="bucket" placeholder="Nombre del bucket" autocomplete="off" spellcheck="false" required>
            <input name="endpoint" placeholder="Endpoint, tal como lo muestra B2" autocomplete="off" spellcheck="false" required>
            <button class="btn" type="submit">Probar y guardar</button>
          </form>
        </section>
        <section>
          <h3>Sistema</h3>
          <button class="btn reset">Restablecer archivos de fábrica</button>
        </section>
      </div>`;

    const swatches = win.body.querySelectorAll('.swatch');
    const markActive = () => swatches.forEach((el) => el.classList.toggle('active', el.dataset.name === s.wallpaper));
    swatches.forEach((el) => {
      el.onclick = () => {
        s.wallpaper = el.dataset.name;
        saveSettings(s);
        markActive();
      };
    });
    markActive();

    const theme = win.body.querySelector('.theme');
    theme.value = s.theme;
    theme.onchange = () => {
      s.theme = theme.value;
      saveSettings(s);
    };

    win.body.querySelector('.reset').onclick = async () => {
      if (await confirm('Restablecer', 'Se borrarán todos tus archivos y se restaurarán los de ejemplo. ¿Continuar?')) fs.reset();
    };
    renderUsage(win.body.querySelector('.usage'));
    setupB2(win.body.querySelector('.b2-config'));
    return win;
  },
};

function renderUsage(el) {
  const u = fs.usage();
  const max = Math.max(1, ...u.folders.map((f) => f.bytes), u.trash.bytes);
  const row = (name, bytes, files) => `
    <div class="usage-row">
      <span class="usage-name">${escapeHtml(name)}</span>
      <span class="usage-bar"><span style="width:${Math.max(bytes ? 2 : 0, (bytes / max) * 100)}%"></span></span>
      <span class="usage-size">${formatSize(bytes)} · ${files} archivo${files === 1 ? '' : 's'}</span>
    </div>`;
  el.innerHTML = `
    <p class="muted"><b>${formatSize(u.bytes)}</b> en ${u.files} archivo${u.files === 1 ? '' : 's'}</p>
    ${u.folders.map((f) => row(f.name, f.bytes, f.files)).join('')}
    ${row('🗑️ Papelera', u.trash.bytes, u.trash.files)}
    <p class="muted">No incluye las versiones antiguas que B2 guarda según la regla de ciclo de vida del bucket.</p>`;
}

// Solo con el servidor de MiPuter (sin él, /api/b2-config no existe y la sección queda oculta).
async function setupB2(section) {
  const state = section.querySelector('.b2-state');
  const form = section.querySelector('.b2-form');
  const show = (cfg) => {
    state.textContent = cfg.enabled
      ? `Configurado: bucket "${cfg.bucket}" (clave ${cfg.keyId}). Rellena el formulario solo si quieres cambiarlo.`
      : 'Sin configurar: las subidas se guardan solo en este navegador.';
    if (cfg.endpoint && !form.endpoint.value) form.endpoint.value = cfg.endpoint.replace(/^https:\/\//, '');
  };
  try {
    const res = await fetch('api/b2-config');
    if (!res.ok) return;
    show(await res.json());
    section.hidden = false;
  } catch {
    return;
  }
  form.onsubmit = async (e) => {
    e.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    button.textContent = 'Probando conexión…';
    try {
      const res = await fetch('api/b2-config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      form.appKey.value = '';
      toast(`B2 configurado: bucket "${data.bucket}"`).done();
      await storage.init();
      show(await (await fetch('api/b2-config')).json());
    } catch (err) {
      toast(err.message).done(err.message, true);
    } finally {
      button.disabled = false;
      button.textContent = 'Probar y guardar';
    }
  };
}
