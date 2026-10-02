import * as fs from '../fs.js';
import { createWindow } from '../wm.js';
import { glyphFor } from '../registry.js';
import { confirm, reportError, toast } from '../ui.js';

const fmt = (ms) => new Date(ms).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export default {
  id: 'trash',
  name: 'Papelera',
  glyph: '🗑️',
  // Arrastrar un icono encima de la papelera del escritorio lo elimina.
  onDrop(path) {
    if (path) reportError(() => fs.trash(path));
  },
  launch() {
    const win = createWindow({ title: 'Papelera', width: 620, height: 420, onClose: () => unsubscribe() });
    win.body.innerHTML = `
      <div class="app-fill">
        <div class="toolbar">
          <span class="trash-info">Lo que lleva más de ${fs.TRASH_DAYS} días aquí se borra solo.</span>
          <span class="spacer"></span>
          <button data-act="empty">Vaciar papelera</button>
        </div>
        <div class="trash-list grow"></div>
      </div>`;
    const listEl = win.body.querySelector('.trash-list');
    const emptyBtn = win.body.querySelector('[data-act="empty"]');

    function render() {
      const items = fs.listTrash();
      emptyBtn.disabled = !items.length;
      win.setTitle(items.length ? `Papelera (${items.length})` : 'Papelera');
      if (!items.length) {
        listEl.innerHTML = '<p class="trash-empty">La papelera está vacía.</p>';
        return;
      }
      listEl.innerHTML = '';
      for (const item of items) {
        const row = document.createElement('div');
        row.className = 'trash-row';
        row.innerHTML = `
          <span class="glyph">${glyphFor(item)}</span>
          <div class="trash-meta">
            <b></b>${item.remote ? ' <span title="Guardado en Backblaze B2">☁</span>' : ''}
            <small></small>
          </div>
          <button class="btn" data-act="restore">Restaurar</button>
          <button class="btn" data-act="delete">Eliminar</button>`;
        row.querySelector('b').textContent = item.name;
        row.querySelector('small').textContent =
          `${item.from ? `Estaba en ${fs.dirname(item.from)}` : 'Origen desconocido'} · eliminado ${fmt(item.at)} · ` +
          (item.daysLeft ? `se borra en ${item.daysLeft} ${item.daysLeft === 1 ? 'día' : 'días'}` : 'se borra hoy');
        row.querySelector('[data-act="restore"]').onclick = () =>
          reportError(() => toast(`Restaurado en ${fs.dirname(fs.restore(item.path))}`).done());
        row.querySelector('[data-act="delete"]').onclick = async () => {
          if (await confirm('Eliminar para siempre', `¿Eliminar "${item.name}" definitivamente? No se puede deshacer.`)) {
            reportError(() => fs.rm(item.path));
          }
        };
        listEl.appendChild(row);
      }
    }

    emptyBtn.onclick = async () => {
      const n = fs.listTrash().length;
      if (await confirm('Vaciar papelera', `¿Eliminar definitivamente ${n === 1 ? 'el elemento' : `los ${n} elementos`} de la papelera? No se puede deshacer.`)) {
        reportError(() => fs.emptyTrash());
      }
    };

    const unsubscribe = fs.onChange(render);
    render();
    return win;
  },
};
