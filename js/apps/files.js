import * as fs from '../fs.js';
import { createWindow } from '../wm.js';
import * as storage from '../storage.js';
import { renderIcons, folderMenu, moveInto, newFolder, newFile, uploadInto, uploadFolderInto, importDrop } from '../fileActions.js';
import { openPath } from '../registry.js';

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
        </div>
        <div class="files-grid grow"></div>
        <div class="statusbar"></div>
      </div>`;

    const grid = win.body.querySelector('.files-grid');
    const pathInput = win.body.querySelector('.path');
    const status = win.body.querySelector('.statusbar');
    const history = [];
    let cwd = fs.isDir(path) ? fs.normalize(path) : '/';

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
      });
      const n = grid.children.length;
      if (!n) grid.innerHTML = '<div class="files-empty">Carpeta vacía</div>';
      status.textContent = `${n} elemento${n === 1 ? '' : 's'} · Subidas: ${storage.enabled() ? `Backblaze B2 (${storage.bucket()})` : 'navegador'}`;
    };

    win.body.querySelector('.toolbar').onclick = (e) => {
      const act = e.target.dataset.act;
      if (act === 'back' && history.length) navigate(history.pop(), false);
      if (act === 'up') navigate(fs.dirname(cwd));
      if (act === 'folder') newFolder(cwd);
      if (act === 'file') newFile(cwd);
      if (act === 'upload') uploadInto(cwd);
      if (act === 'uploaddir') uploadFolderInto(cwd);
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
