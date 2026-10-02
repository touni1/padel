import * as fs from '../fs.js';
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
      status.textContent = `${current || 'Archivo nuevo'} · ${lines} líneas · ${area.value.length} caracteres`;
    };

    const save = async (as = false) => {
      if (!current || as) {
        const suggested = current || '/Documentos/Sin título.txt';
        const target = await prompt('Guardar como', 'Ruta del archivo:', suggested);
        if (!target) return false;
        current = fs.normalize(target);
      }
      await reportError(() => fs.writeFile(current, area.value));
      dirty = false;
      refresh();
      return true;
    };

    if (current) {
      try {
        area.value = fs.readFile(current);
      } catch (e) {
        area.value = '';
      }
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
