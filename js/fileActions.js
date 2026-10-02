// Acciones de archivos compartidas por el escritorio y el explorador.
import * as fs from './fs.js';
import { openPath, glyphFor } from './registry.js';
import * as storage from './storage.js';
import { prompt, confirm, alert, contextMenu, reportError, escapeHtml, toast } from './ui.js';

export async function newFolder(dir) {
  const name = await prompt('Nueva carpeta', 'Nombre de la carpeta:', fs.uniqueName(dir, 'Nueva carpeta'));
  if (name) await reportError(() => fs.mkdir(fs.join(dir, name)));
}

export async function newFile(dir) {
  const name = await prompt('Nuevo archivo', 'Nombre del archivo:', fs.uniqueName(dir, 'Nuevo documento.txt'));
  if (name) await reportError(() => fs.writeFile(fs.join(dir, name), ''));
}

export async function renameEntry(path) {
  const name = await prompt('Renombrar', 'Nuevo nombre:', fs.basename(path));
  if (name && name !== fs.basename(path)) {
    await reportError(() => fs.rename(path, fs.join(fs.dirname(path), name)));
  }
}

export async function deleteEntry(path) {
  if (await confirm('Eliminar', `¿Eliminar "${fs.basename(path)}"? Esta acción no se puede deshacer.`)) {
    await reportError(() => fs.rm(path));
  }
}

export function duplicateEntry(path) {
  const dir = fs.dirname(path);
  return reportError(() => fs.copy(path, fs.join(dir, fs.uniqueName(dir, fs.basename(path)))));
}

function readLocal(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    storage.isTextType(file.type, file.name) ? reader.readAsText(file) : reader.readAsDataURL(file);
  });
}

// Importa archivos del ordenador real a `dir`. Si el servidor tiene B2
// configurado se suben a Backblaze; si no, se guardan en el navegador.
export async function importFiles(dir, files) {
  const errors = [];
  for (const file of files) {
    const target = () => fs.join(dir, fs.uniqueName(dir, file.name));
    const note = toast(storage.enabled() ? `Subiendo "${file.name}" a B2…` : `Importando "${file.name}"…`);
    try {
      if (storage.enabled()) fs.writeRemote(target(), await storage.upload(file));
      else fs.writeFile(target(), await readLocal(file));
      note.done(storage.enabled() ? `"${file.name}" guardado en B2` : `"${file.name}" importado`);
    } catch (e) {
      note.done(`Error con "${file.name}"`, true);
      errors.push(`${file.name}: ${e.message}`);
    }
  }
  if (errors.length) await alert('Error al subir', errors.join('\n'));
}

export function uploadInto(dir) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.onchange = () => importFiles(dir, [...input.files]);
  input.click();
}

// Descarga un archivo virtual al ordenador real.
export function download(path) {
  const a = document.createElement('a');
  const remote = fs.getRemote(path);
  if (remote) {
    a.href = storage.url(remote.key, { download: fs.basename(path) });
  } else {
    const content = fs.readFile(path);
    a.href = content.startsWith('data:') ? content : URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
  }
  a.download = fs.basename(path);
  a.click();
}

export function entryMenu(e, path) {
  e.preventDefault();
  e.stopPropagation();
  const items = [
    { label: 'Abrir', action: () => openPath(path) },
    'sep',
    { label: 'Renombrar', action: () => renameEntry(path) },
    { label: 'Duplicar', action: () => duplicateEntry(path) },
  ];
  if (!fs.isDir(path)) items.push({ label: 'Descargar', action: () => download(path) });
  items.push('sep', { label: 'Eliminar', action: () => deleteEntry(path) });
  contextMenu(e.clientX, e.clientY, items);
}

export function folderMenu(e, dir, extra = []) {
  e.preventDefault();
  contextMenu(e.clientX, e.clientY, [
    { label: 'Nueva carpeta', action: () => newFolder(dir) },
    { label: 'Nuevo archivo de texto', action: () => newFile(dir) },
    { label: 'Subir archivos…', action: () => uploadInto(dir) },
    ...extra,
  ]);
}

// Pinta las entradas de `dir` como iconos dentro de `container`.
export function renderIcons(container, dir, { onOpen = openPath } = {}) {
  container.innerHTML = '';
  for (const entry of fs.readdir(dir)) {
    const el = document.createElement('div');
    el.className = 'icon';
    el.draggable = true;
    el.dataset.path = entry.path;
    el.innerHTML = `<span class="glyph">${glyphFor(entry)}</span><span>${escapeHtml(entry.name)}</span>`;
    if (entry.remote) {
      el.classList.add('remote');
      el.title = 'Guardado en Backblaze B2';
    }
    el.onclick = () => {
      container.querySelectorAll('.icon.selected').forEach((i) => i.classList.remove('selected'));
      el.classList.add('selected');
    };
    el.ondblclick = () => onOpen(entry.path, entry);
    el.oncontextmenu = (e) => entryMenu(e, entry.path);
    el.ondragstart = (e) => e.dataTransfer.setData('text/x-miputer-path', entry.path);
    if (entry.type === 'dir') {
      el.ondragover = (e) => e.preventDefault();
      el.ondrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        moveInto(e, entry.path);
      };
    }
    container.appendChild(el);
  }
}

// Mueve el elemento arrastrado a `dir`.
export function moveInto(e, dir) {
  const src = e.dataTransfer.getData('text/x-miputer-path');
  if (!src || fs.dirname(src) === fs.normalize(dir) || src === fs.normalize(dir)) return;
  reportError(() => fs.rename(src, fs.join(dir, fs.uniqueName(dir, fs.basename(src)))));
}
