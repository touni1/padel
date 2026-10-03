// Buscar archivos y carpetas por nombre en todo MiPuter (sin la papelera).
import * as fs from '../fs.js';
import { createWindow } from '../wm.js';
import { openPath, launch, glyphFor } from '../registry.js';
import { entryMenu } from '../fileActions.js';
import { formatSize } from '../ui.js';
import { isTouch } from '../touch.js';

const when = (ms) => new Date(ms).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });

export default {
  id: 'search',
  name: 'Buscar',
  glyph: '🔍',
  launch({ query = '' } = {}) {
    const win = createWindow({ title: 'Buscar', width: 620, height: 460, onClose: () => unsubscribe() });
    win.body.innerHTML = `
      <div class="app-fill">
        <div class="toolbar"><input class="search-input" placeholder="Nombre del archivo o carpeta…" spellcheck="false"></div>
        <div class="search-results grow"></div>
        <div class="statusbar"></div>
      </div>`;
    const input = win.body.querySelector('.search-input');
    const results = win.body.querySelector('.search-results');
    const status = win.body.querySelector('.statusbar');
    input.value = query;

    const render = () => {
      const q = input.value.trim();
      results.innerHTML = '';
      if (!q) {
        status.textContent = 'Escribe para buscar (no distingue mayúsculas ni acentos)';
        return;
      }
      const found = fs.search(q);
      status.textContent = found.length >= 300 ? 'Más de 300 resultados: afina la búsqueda' : `${found.length} resultado${found.length === 1 ? '' : 's'}`;
      for (const item of found) {
        const row = document.createElement('div');
        row.className = 'search-row';
        row.innerHTML = '<span class="glyph"></span><div class="search-meta"><b></b><small></small></div><span class="search-size"></span>';
        row.querySelector('.glyph').textContent = glyphFor(item);
        row.querySelector('b').textContent = item.name;
        row.querySelector('small').textContent = `${fs.dirname(item.path)} · ${when(item.mtime)}`;
        row.querySelector('.search-size').textContent = item.type === 'dir' ? `${item.size} elementos` : `${item.remote ? '☁ ' : ''}${formatSize(item.size)}`;
        row.ondblclick = () => (item.type === 'dir' ? launch('files', { path: item.path }) : openPath(item.path));
        if (isTouch()) row.onclick = row.ondblclick;
        row.oncontextmenu = (e) => entryMenu(e, item.path);
        row.title = 'Doble clic para abrir · clic derecho para más opciones';
        results.appendChild(row);
      }
    };

    let timer = 0;
    input.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(render, 150);
    };
    const unsubscribe = fs.onChange(render);
    render();
    input.focus();
    return win;
  },
};
