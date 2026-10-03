// Versiones anteriores de un archivo de B2: verlas, descargarlas y restaurarlas.
import * as fs from './fs.js';
import * as storage from './storage.js';
import { createWindow } from './wm.js';
import { confirm, reportError, toast, formatSize } from './ui.js';

const when = (iso) => new Date(iso).toLocaleString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function showVersions(path) {
  const win = createWindow({ title: `Versiones · ${fs.basename(path)}`, width: 520, height: 420 });
  win.body.innerHTML = `
    <div class="share">
      <p class="muted">Backblaze guarda las versiones anteriores según la regla de ciclo de vida de tu bucket (30 días).</p>
      <div class="share-list">Cargando…</div>
    </div>`;
  const list = win.body.querySelector('.share-list');

  async function render() {
    const remote = fs.getRemote(path);
    if (!remote) return (list.textContent = 'Este archivo no está en B2.');
    const res = await fetch(`api/versions?key=${encodeURIComponent(remote.key)}`);
    const versions = await res.json();
    if (!res.ok) throw new Error(versions.error || `Error ${res.status}`);
    list.innerHTML = versions.length > 1 ? '' : '<p class="muted">No hay versiones anteriores de este archivo.</p>';
    if (versions.length <= 1) return;
    for (const v of versions) {
      const row = document.createElement('div');
      row.className = 'share-row';
      row.innerHTML = `<div class="share-meta"><b></b><small></small></div><a class="btn">Descargar</a>${v.latest ? '' : '<button class="btn">Restaurar</button>'}`;
      row.querySelector('b').textContent = `${when(v.date)}${v.latest ? ' · actual' : ''}`;
      row.querySelector('small').textContent = formatSize(v.size);
      const dl = row.querySelector('a');
      const name = fs.basename(path).replace(/(\.[^.]+)?$/, (ext) => ` (${new Date(v.date).toISOString().slice(0, 16).replace('T', ' ').replace(':', 'h')})${ext}`);
      dl.href = `${storage.url(remote.key, { download: name })}&version=${encodeURIComponent(v.id)}`;
      dl.download = name;
      row.querySelector('button')?.addEventListener('click', async () => {
        if (!(await confirm('Restaurar versión', `¿Volver "${fs.basename(path)}" a como estaba el ${when(v.date)}? La versión actual queda guardada como anterior.`))) return;
        await reportError(async () => {
          const r = await fetch(`api/versions?key=${encodeURIComponent(remote.key)}&version=${encodeURIComponent(v.id)}`, { method: 'POST' });
          const data = await r.json();
          if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
          // Sin "thumb": la miniatura se vuelve a hacer con el contenido restaurado.
          fs.writeRemote(path, { key: remote.key, size: data.size, type: remote.type });
          toast('Versión restaurada').done();
          await render();
        });
      });
      list.appendChild(row);
    }
  }
  reportError(render);
  return win;
}
