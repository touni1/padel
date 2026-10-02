import * as fs from '../fs.js';
import { createWindow } from '../wm.js';
import { confirm } from '../ui.js';

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
    const win = createWindow({ title: 'Ajustes', width: 480, height: 420 });
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
    return win;
  },
};
