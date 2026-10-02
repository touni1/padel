import * as fs from '../fs.js';
import * as storage from '../storage.js';
import { createWindow } from '../wm.js';
import { prompt, confirm, reportError } from '../ui.js';

export default {
  id: 'editor',
  name: 'Editor de texto',
  glyph: '📝',
  extensions: ['txt', 'md', 'js', 'json', 'css', 'py', 'csv'],
  launch({ path } = {}) {
    const win = createWindow({ title: 'Editor', width: 640, height: 460 });
    win.body.innerHTML = `
      <div class="app-fill">
        <div class="toolbar">
          <button data-act="save">💾 Guardar</button>
          <button data-act="saveas">Guardar como…</button>
          <span style="flex:1"></span>
        </div>
        <textarea class="editor-area grow" spellcheck="false"></textarea>
        <div class="statusbar"></div>
      </div>`;

    const area = win.body.querySelector('textarea');
    const status = win.body.querySelector('.statusbar');
    let current = path ? fs.normalize(path) : null;
    let dirty = false;

    const refresh = () => {
      const name = current ? fs.basename(current) : 'Sin título';
      win.setTitle(`${dirty ? '● ' : ''}${name} — Editor`);
      const lines = area.value.split('\n').length;
      const where = current && fs.getRemote(current) ? ' · ☁ Backblaze B2' : '';
      status.textContent = `${current || 'Archivo nuevo'} · ${lines} líneas · ${area.value.length} caracteres${where}`;
    };

    const save = async (as = false) => {
      if (area.disabled) return false; // todavía cargando o la carga falló
      if (!current || as) {
        const suggested = current || '/Documentos/Sin título.txt';
        const target = await prompt('Guardar como', 'Ruta del archivo:', suggested);
        if (!target) return false;
        current = fs.normalize(target);
      }
      const remote = !as && fs.getRemote(current);
      const ok = await reportError(async () => {
        if (remote) {
          // Archivo de B2: se sobrescribe en Backblaze.
          const { size } = await storage.writeText(remote.key, area.value, remote.type || 'text/plain; charset=utf-8');
          fs.writeRemote(current, { ...remote, size });
        } else {
          fs.writeFile(current, area.value);
        }
        return true;
      });
      if (!ok) return false;
      dirty = false;
      refresh();
      return true;
    };

    if (current && fs.exists(current)) {
      area.disabled = true;
      area.value = fs.getRemote(current) ? 'Cargando desde B2…' : '';
      fs.readFileAsync(current)
        .then((text) => (area.value = text))
        .then(() => (area.disabled = false))
        .catch((e) => (area.value = `No se pudo cargar: ${e.message}`))
        .finally(() => {
          refresh();
          area.focus();
        });
    }

    area.oninput = () => {
      dirty = true;
      refresh();
    };
    area.onkeydown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        save();
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
        area.oninput();
      }
    };
    win.body.querySelector('.toolbar').onclick = (e) => {
      if (e.target.dataset.act === 'save') save();
      if (e.target.dataset.act === 'saveas') save(true);
    };
    win.beforeClose = async () => !dirty || confirm('Cambios sin guardar', '¿Cerrar sin guardar los cambios?');

    refresh();
    area.focus();
    return win;
  },
};
