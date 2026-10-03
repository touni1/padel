import * as fs from '../fs.js';
import { createWindow } from '../wm.js';
import * as storage from '../storage.js';
import { renderIcons, folderMenu, moveInto, newFolder, newFile, uploadInto, uploadFolderInto, importDrop } from '../fileActions.js';
import { openPath } from '../registry.js';
import * as sel from '../selection.js';

// Vista y orden del explorador: se recuerdan en este navegador.
const PREFS_KEY = 'miputer.files.vista';
const loadPrefs = () => {
  try {
    return { view: 'icons', key: 'name', desc: false, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return { view: 'icons', key: 'name', desc: false };
  }
};
const COLUMNS = [
  ['name', 'Nombre'],
  ['date', 'Modificado'],
  ['size', 'Tamaño'],
  ['type', 'Tipo'],
];

export default {
  id: 'files',
  name: 'Archivos',
  glyph: '🗂️',
  launch({ path = '/' } = {}) {
    const win = createWindow({ title: 'Archivos', width: 680, height: 460, onClose: () => unsubscribe() });
    win.body.innerHTML = `
      <div class="app-fill">
        <div class="toolbar">
          <button data-act="back" title="Atrás">←</button>
          <button data-act="up" title="Subir">↑</button>
          <input class="path" spellcheck="false">
          <button data-act="folder" title="Nueva carpeta">📁+</button>
          <button data-act="file" title="Nuevo archivo">📄+</button>
          <button data-act="upload" title="Subir archivos">⤒</button>
          <button data-act="uploaddir" title="Subir una carpeta entera">📁⤒</button>
          <select class="files-sort" title="Ordenar por">${COLUMNS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
          <button data-act="view" title="Cambiar entre iconos y lista">☰</button>
        </div>
        <div class="files-grid grow"></div>
        <div class="statusbar"></div>
      </div>`;

    const grid = win.body.querySelector('.files-grid');
    const pathInput = win.body.querySelector('.path');
    const status = win.body.querySelector('.statusbar');
    const history = [];
    let cwd = fs.isDir(path) ? fs.normalize(path) : '/';

    const prefs = loadPrefs();
    const sortSel = win.body.querySelector('.files-sort');
    const savePrefs = () => {
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
      } catch {}
    };
    sel.setup(grid, () => cwd);

    const updateStatus = () => {
      const n = grid.querySelectorAll('.icon[data-path]').length;
      const chosen = sel.selected(grid).size;
      status.textContent = `${n} elemento${n === 1 ? '' : 's'}${chosen > 1 ? ` · ${chosen} seleccionados` : ''} · Subidas: ${storage.enabled() ? `Backblaze B2 (${storage.bucket()})` : 'navegador'}`;
    };
    grid.addEventListener('click', () => setTimeout(updateStatus));
    grid.addEventListener('pointerup', () => setTimeout(updateStatus));

    const navigate = (to, push = true) => {
      to = fs.normalize(to);
      if (!fs.isDir(to)) {
        pathInput.value = cwd;
        return;
      }
      if (push && to !== cwd) history.push(cwd);
      cwd = to;
      render();
    };

    const render = () => {
      if (!fs.isDir(cwd)) cwd = '/';
      pathInput.value = cwd;
      win.setTitle(`Archivos — ${cwd === '/' ? 'Inicio' : fs.basename(cwd)}`);
      renderIcons(grid, cwd, {
        onOpen: (p, entry) => (entry.type === 'dir' ? navigate(p) : openPath(p)),
        view: prefs.view,
        sort: { key: prefs.key, desc: prefs.desc },
      });
      sortSel.value = prefs.key;
      win.body.querySelector('[data-act="view"]').textContent = prefs.view === 'list' ? '▦' : '☰';
      if (prefs.view === 'list') {
        // Encabezados: clic para ordenar por esa columna (otro clic invierte el orden).
        const head = document.createElement('div');
        head.className = 'files-head';
        head.innerHTML = COLUMNS.map(([k, l]) => `<button data-key="${k}">${l}${prefs.key === k ? (prefs.desc ? ' ▼' : ' ▲') : ''}</button>`).join('');
        head.onclick = (e) => {
          const k = e.target.dataset.key;
          if (!k) return;
          prefs.desc = prefs.key === k ? !prefs.desc : false;
          prefs.key = k;
          savePrefs();
          render();
        };
        grid.prepend(head);
      }
      if (!grid.querySelector('.icon')) grid.insertAdjacentHTML('beforeend', '<div class="files-empty">Carpeta vacía</div>');
      updateStatus();
    };

    win.body.querySelector('.toolbar').onclick = (e) => {
      const act = e.target.dataset.act;
      if (act === 'back' && history.length) navigate(history.pop(), false);
      if (act === 'up') navigate(fs.dirname(cwd));
      if (act === 'folder') newFolder(cwd);
      if (act === 'file') newFile(cwd);
      if (act === 'upload') uploadInto(cwd);
      if (act === 'uploaddir') uploadFolderInto(cwd);
      if (act === 'view') {
        prefs.view = prefs.view === 'list' ? 'icons' : 'list';
        savePrefs();
        render();
      }
    };
    sortSel.onchange = () => {
      prefs.key = sortSel.value;
      prefs.desc = sortSel.value === 'date' || sortSel.value === 'size'; // lo más nuevo / grande primero
      savePrefs();
      render();
    };
    pathInput.onkeydown = (e) => e.key === 'Enter' && navigate(pathInput.value);
    grid.oncontextmenu = (e) => folderMenu(e, cwd);
    grid.ondragover = (e) => e.preventDefault();
    grid.ondrop = (e) => {
      e.preventDefault();
      if (e.dataTransfer.files.length) importDrop(cwd, e.dataTransfer);
      else moveInto(e, cwd);
    };

    const unsubscribe = fs.onChange(render);
    render();
    return win;
  },
};
