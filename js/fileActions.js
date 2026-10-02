// Acciones de archivos compartidas por el escritorio y el explorador.
import * as fs from './fs.js';
import { openPath, glyphFor } from './registry.js';
import * as storage from './storage.js';
import { prompt, confirm, alert, contextMenu, reportError, escapeHtml, toast } from './ui.js';
import { shareFile } from './apps/shares.js';

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

// Fuera de la papelera, eliminar la mueve ahí; dentro, la borra para siempre.
export async function deleteEntry(path) {
  if (!fs.normalize(path).startsWith(fs.TRASH + '/')) {
    await reportError(() => {
      fs.trash(path);
      toast(`"${fs.basename(path)}" movido a la papelera`).done();
    });
  } else if (await confirm('Eliminar', `¿Eliminar "${fs.basename(path)}" para siempre? Esta acción no se puede deshacer.`)) {
    await reportError(() => fs.rm(path));
  }
}

// Espera a que termine una tarea del servidor (zip/unzip) mostrando el progreso.
async function waitJob(id, note, label) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await fetch(`api/jobs?id=${encodeURIComponent(id)}`);
    const job = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(job.error || `Error ${res.status}`);
    if (job.state === 'done') return job.result;
    if (job.state === 'error') throw new Error(job.error);
    note.update(`${label}… ${Math.floor(job.progress * 100)}%`);
  }
}

async function startJob(endpoint, body) {
  const res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data.job;
}

export async function compressEntry(path) {
  const dir = fs.dirname(path);
  const base = fs.isDir(path) ? fs.basename(path) : fs.basename(path).replace(/\.[^.]+$/, '') || fs.basename(path);
  const name = fs.uniqueName(dir, `${base}.zip`);
  const note = toast(`Comprimiendo "${fs.basename(path)}"…`);
  try {
    const job = await startJob('api/zip', { name, entries: fs.collect(path) });
    const result = await waitJob(job, note, `Comprimiendo "${fs.basename(path)}"`);
    fs.writeRemote(fs.join(dir, fs.uniqueName(dir, name)), result);
    note.done(`Creado "${name}"`);
  } catch (e) {
    note.done('No se pudo comprimir', true);
    await alert('Error al comprimir', e.message);
  }
}

export async function extractEntry(path) {
  const remote = fs.getRemote(path);
  const dir = fs.dirname(path);
  const dest = fs.join(dir, fs.uniqueName(dir, fs.basename(path).replace(/\.zip$/i, '') || 'Extraído'));
  const note = toast(`Extrayendo "${fs.basename(path)}"…`);
  try {
    const job = await startJob('api/unzip', { key: remote.key });
    const { files, dirs } = await waitJob(job, note, `Extrayendo "${fs.basename(path)}"`);
    fs.importExtracted(dest, files, dirs);
    note.done(`Extraído en "${fs.basename(dest)}" (${files.length} archivo${files.length === 1 ? '' : 's'})`);
  } catch (e) {
    note.done('No se pudo extraer', true);
    await alert('Error al extraer', e.message);
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
// `items` son File o { file, rel } con la ruta dentro de una carpeta subida
// ("Fotos/2024/a.jpg"); `emptyDirs` son carpetas vacías de esa misma subida.
export async function importFiles(dir, items, emptyDirs = []) {
  const list = items.map((it) => (it instanceof File ? { file: it, rel: it.name } : it));
  if (!list.length && !emptyDirs.length) return;
  // Si ya existe una carpeta con el mismo nombre que la subida, se usa "Nombre (2)".
  const tops = new Map();
  const mapRel = (rel) => {
    const [top, ...rest] = rel.split('/');
    if (!rest.length) return rel;
    if (!tops.has(top)) tops.set(top, fs.uniqueName(dir, top));
    return [tops.get(top), ...rest].join('/');
  };
  for (const d of emptyDirs) fs.ensureDir(fs.join(dir, mapRel(d)));
  const many = list.length > 1;
  const totalBytes = list.reduce((a, it) => a + it.file.size, 0) || 1;
  let doneBytes = 0;
  let doneFiles = 0;
  const label = storage.enabled() ? 'Subiendo a B2' : 'Importando';
  const note = toast(many ? `${label} ${list.length} archivos…` : `${label} "${list[0]?.file.name}"…`);
  const errors = [];
  const upload = async ({ file, rel }) => {
    const path = mapRel(rel);
    const parent = fs.join(dir, fs.dirname(`/${path}`));
    fs.ensureDir(parent);
    const target = () => fs.join(parent, fs.uniqueName(parent, file.name));
    let partial = 0;
    const pct = (p) => {
      partial = p * file.size;
      note.update(
        many
          ? `${label}: ${doneFiles} de ${list.length} archivos · ${Math.floor(((doneBytes + partial) / totalBytes) * 100)}%`
          : `${label} "${file.name}"… ${Math.floor(p * 100)}%`,
      );
    };
    try {
      if (storage.enabled()) fs.writeRemote(target(), await storage.upload(file, file.name, pct));
      else fs.writeFile(target(), await readLocal(file));
    } catch (e) {
      errors.push(`${path}: ${e.message}`);
    }
    doneBytes += file.size;
    doneFiles++;
    pct(0);
  };
  // De a 3 a la vez: con muchas fotos chicas es bastante más rápido que de a una.
  let next = 0;
  const worker = async () => {
    while (next < list.length) await upload(list[next++]);
  };
  await Promise.all([worker(), worker(), worker()]);
  const ok = list.length - errors.length;
  if (!list.length) note.done(`Carpeta creada`);
  else if (errors.length) note.done(`${ok} de ${list.length} archivos subidos`, true);
  else note.done(many ? `${list.length} archivos ${storage.enabled() ? 'guardados en B2' : 'importados'}` : `"${list[0].file.name}" ${storage.enabled() ? 'guardado en B2' : 'importado'}`);
  if (errors.length) await alert('Error al subir', errors.slice(0, 20).join('\n') + (errors.length > 20 ? `\n… y ${errors.length - 20} más` : ''));
}

// Lee lo que se soltó al arrastrar desde el ordenador, incluidas carpetas enteras.
// Hay que pedir las entradas dentro del propio evento drop, antes de cualquier await.
export async function importDrop(dir, dataTransfer) {
  const entries = [...dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return importFiles(dir, [...dataTransfer.files]);
  const files = [];
  const emptyDirs = [];
  const readAll = (reader) =>
    new Promise((resolve, reject) => {
      const out = [];
      const batch = () =>
        reader.readEntries((chunk) => (chunk.length ? (out.push(...chunk), batch()) : resolve(out)), reject);
      batch();
    });
  const walk = async (entry, rel) => {
    if (entry.isFile) {
      files.push({ file: await new Promise((res, rej) => entry.file(res, rej)), rel });
    } else if (entry.isDirectory) {
      const children = await readAll(entry.createReader());
      if (!children.length) emptyDirs.push(rel);
      for (const child of children) await walk(child, `${rel}/${child.name}`);
    }
  };
  for (const entry of entries) await walk(entry, entry.name);
  return importFiles(dir, files, emptyDirs);
}

export function uploadInto(dir) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.onchange = () => importFiles(dir, [...input.files]);
  input.click();
}

// "Subir carpeta…": el navegador da cada archivo con su ruta relativa.
export function uploadFolderInto(dir) {
  const input = document.createElement('input');
  input.type = 'file';
  input.webkitdirectory = true;
  input.onchange = () => importFiles(dir, [...input.files].map((file) => ({ file, rel: file.webkitRelativePath || file.name })));
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
  if (!fs.isDir(path) && !path.startsWith(fs.TRASH + '/') && storage.enabled()) items.push({ label: 'Compartir enlace…', action: () => shareFile(path) });
  if (!path.startsWith(fs.TRASH + '/') && storage.enabled()) {
    items.push('sep', { label: 'Comprimir en ZIP', action: () => compressEntry(path) });
    if (fs.extname(path) === 'zip' && fs.getRemote(path)) items.push({ label: 'Extraer aquí', action: () => extractEntry(path) });
  }
  items.push('sep', { label: path.startsWith(fs.TRASH + '/') ? 'Eliminar para siempre' : 'Eliminar', action: () => deleteEntry(path) });
  contextMenu(e.clientX, e.clientY, items);
}

export function folderMenu(e, dir, extra = []) {
  e.preventDefault();
  contextMenu(e.clientX, e.clientY, [
    { label: 'Nueva carpeta', action: () => newFolder(dir) },
    { label: 'Nuevo archivo de texto', action: () => newFile(dir) },
    { label: 'Subir archivos…', action: () => uploadInto(dir) },
    { label: 'Subir carpeta…', action: () => uploadFolderInto(dir) },
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
  if (fs.normalize(dir) === fs.TRASH) return reportError(() => fs.trash(src));
  reportError(() => fs.rename(src, fs.join(dir, fs.uniqueName(dir, fs.basename(src)))));
}
