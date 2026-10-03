// Acciones de archivos compartidas por el escritorio y el explorador.
import * as fs from './fs.js';
import { openPath, glyphFor, launch } from './registry.js';
import * as storage from './storage.js';
import { prompt, confirm, alert, contextMenu, reportError, escapeHtml, toast, formatSize } from './ui.js';
import { shareFile, shareFolder, requestFiles } from './apps/shares.js';
import { canThumb, makeThumb, uploadThumb, ensureThumb, thumbUrl } from './thumbs.js';
import { isTouch } from './touch.js';
import * as sel from './selection.js';
import { showVersions } from './versions.js';

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

// Varios a la vez: a la papelera (o para siempre si ya estaban en ella).
export async function deleteEntries(paths) {
  if (paths.length === 1) return deleteEntry(paths[0]);
  const inTrash = paths.every((p) => p.startsWith(fs.TRASH + '/'));
  if (inTrash && !(await confirm('Eliminar', `¿Eliminar ${paths.length} elementos para siempre? Esta acción no se puede deshacer.`))) return;
  await reportError(() => {
    paths.forEach((p) => (inTrash ? fs.rm(p) : fs.trash(p)));
    toast(inTrash ? `${paths.length} elementos eliminados` : `${paths.length} elementos movidos a la papelera`).done();
  });
}

export async function downloadMany(paths) {
  const files = paths.filter((p) => !fs.isDir(p));
  if (paths.length > files.length) toast('Las carpetas no se descargan sueltas: comprímelas en ZIP').done();
  for (const p of files) {
    download(p);
    await new Promise((r) => setTimeout(r, 400)); // los navegadores frenan muchas descargas seguidas
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
  return compressEntries([path]);
}

export async function compressEntries(paths) {
  const path = paths[0];
  const dir = fs.dirname(path);
  const base = paths.length > 1 ? (fs.basename(dir) || 'Archivos') : fs.isDir(path) ? fs.basename(path) : fs.basename(path).replace(/\.[^.]+$/, '') || fs.basename(path);
  const name = fs.uniqueName(dir, `${base}.zip`);
  const label = paths.length > 1 ? `${paths.length} elementos` : `"${fs.basename(path)}"`;
  const note = toast(`Comprimiendo ${label}…`);
  try {
    const job = await startJob('api/zip', { name, entries: paths.flatMap((p) => fs.collect(p)) });
    const result = await waitJob(job, note, `Comprimiendo ${label}`);
    fs.writeRemote(fs.join(dir, fs.uniqueName(dir, name)), result);
    note.done(`Creado "${name}"`);
  } catch (e) {
    note.done('No se pudo comprimir', true);
    await alert('Error al comprimir', e.message);
  }
}

// El servidor baja el archivo de internet directo a B2.
export async function fetchUrlInto(dir) {
  const url = await prompt('Descargar desde una URL', 'Pega el enlace del archivo (http o https):', 'https://');
  if (!url || url === 'https://') return;
  const note = toast('Descargando…');
  try {
    const job = await startJob('api/fetch-url', { url });
    const result = await waitJob(job, note, 'Descargando');
    const path = fs.join(dir, fs.uniqueName(dir, result.name));
    fs.writeRemote(path, result);
    note.done(`Descargado: ${fs.basename(path)} (${formatSize(result.size)})`);
  } catch (e) {
    note.done('No se pudo descargar', true);
    await alert('Error al descargar', e.message);
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
      if (storage.enabled()) {
        const remote = await storage.upload(file, file.name, pct);
        if (canThumb(file.name)) {
          const thumb = await makeThumb(file, file.name);
          remote.thumb = Boolean(thumb) && (await uploadThumb(remote.key, thumb));
        }
        fs.writeRemote(target(), remote);
      } else fs.writeFile(target(), await readLocal(file));
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

export function entryMenu(e, path, container) {
  e.preventDefault();
  e.stopPropagation();
  const targets = container ? sel.targetsFor(container, path) : [path];
  if (container && !sel.selected(container).has(path)) sel.selectOnly(container, [path]);
  const inTrash = path.startsWith(fs.TRASH + '/');
  if (targets.length > 1) {
    const n = targets.length;
    const multi = [
      { label: `Cortar (${n})`, action: () => sel.cutPaths(targets) },
      { label: `Copiar (${n})`, action: () => sel.copyPaths(targets) },
    ];
    if (!inTrash && storage.enabled()) multi.push('sep', { label: `Comprimir en ZIP (${n})`, action: () => compressEntries(targets) });
    multi.push({ label: `Descargar (${n})`, action: () => downloadMany(targets) });
    multi.push('sep', { label: inTrash ? `Eliminar para siempre (${n})` : `Eliminar (${n})`, action: () => deleteEntries(targets) });
    return contextMenu(e.clientX, e.clientY, multi);
  }
  const items = [
    { label: 'Abrir', action: () => openPath(path) },
    'sep',
    { label: 'Cortar', action: () => sel.cutPaths([path]) },
    { label: 'Copiar', action: () => sel.copyPaths([path]) },
    { label: 'Renombrar', action: () => renameEntry(path) },
    { label: 'Duplicar', action: () => duplicateEntry(path) },
  ];
  if (!fs.isDir(path)) items.push({ label: 'Descargar', action: () => download(path) });
  if (/^(jpe?g|png|webp|gif|bmp)$/.test(fs.extname(path)) && !path.startsWith(fs.TRASH + '/')) items.push({ label: 'Editar imagen', action: () => reportError(() => launch('imgedit', { path })) });
  if (/^(pdf|jpe?g|png|webp|gif|bmp)$/.test(fs.extname(path)) && !path.startsWith(fs.TRASH + '/')) items.push({ label: 'Herramientas PDF…', action: () => reportError(() => launch('pdftools', { files: [path] })) });
  if (!fs.isDir(path) && !path.startsWith(fs.TRASH + '/') && storage.enabled()) items.push({ label: 'Compartir enlace…', action: () => shareFile(path) });
  if (fs.getRemote(path)) items.push({ label: 'Versiones anteriores…', action: () => showVersions(path) });
  if (fs.isDir(path) && !path.startsWith(fs.TRASH) && storage.enabled()) {
    items.push({ label: 'Compartir carpeta…', action: () => shareFolder(path) }, { label: 'Pedir archivos…', action: () => requestFiles(path) });
    items.push({ label: 'Subir a CelebGO…', action: () => reportError(() => launch('celebgo', { path })) });
  }
  if (!path.startsWith(fs.TRASH + '/') && storage.enabled()) {
    items.push('sep', { label: 'Comprimir en ZIP', action: () => compressEntry(path) });
    if (fs.extname(path) === 'zip' && fs.getRemote(path)) items.push({ label: 'Extraer aquí', action: () => extractEntry(path) });
  }
  items.push('sep', { label: path.startsWith(fs.TRASH + '/') ? 'Eliminar para siempre' : 'Eliminar', action: () => deleteEntry(path) });
  contextMenu(e.clientX, e.clientY, items);
}

export function folderMenu(e, dir, extra = []) {
  e.preventDefault();
  const pasteItem = sel.clipboardEmpty() ? [] : [{ label: 'Pegar', action: () => pasteInto(dir) }, 'sep'];
  const remoteItems = storage.enabled() && fs.normalize(dir) !== '/' && !fs.normalize(dir).startsWith(fs.TRASH)
    ? ['sep', { label: 'Descargar desde una URL…', action: () => fetchUrlInto(dir) }, { label: 'Pedir archivos aquí…', action: () => requestFiles(dir) }]
    : [];
  contextMenu(e.clientX, e.clientY, [
    ...pasteItem,
    { label: 'Nueva carpeta', action: () => newFolder(dir) },
    { label: 'Nuevo archivo de texto', action: () => newFile(dir) },
    { label: 'Subir archivos…', action: () => uploadInto(dir) },
    { label: 'Subir carpeta…', action: () => uploadFolderInto(dir) },
    ...remoteItems,
    ...extra,
  ]);
}

// Pinta las entradas de `dir` como iconos dentro de `container`.
// Ordena: carpetas primero y después por nombre, fecha, tamaño o tipo.
function sortEntries(entries, { key = 'name', desc = false } = {}) {
  const byName = (a, b) => a.name.localeCompare(b.name, 'es', { numeric: true, sensitivity: 'base' });
  const cmp = {
    name: byName,
    date: (a, b) => a.mtime - b.mtime || byName(a, b),
    size: (a, b) => (a.type === 'dir' ? 0 : a.size - b.size) || byName(a, b),
    type: (a, b) => fs.extname(a.name).localeCompare(fs.extname(b.name)) || byName(a, b),
  }[key];
  return [...entries].sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : (desc ? -1 : 1) * cmp(a, b)));
}

const typeLabel = (entry) => (entry.type === 'dir' ? 'Carpeta' : fs.extname(entry.name).toUpperCase() || 'Archivo');
const dateLabel = (ms) => new Date(ms).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

// Pinta las entradas de `dir` como iconos (o filas, con view: 'list') dentro de `container`.
export function renderIcons(container, dir, { onOpen = openPath, view = 'icons', sort } = {}) {
  container.innerHTML = '';
  container.classList.toggle('list-view', view === 'list');
  for (const entry of sortEntries(fs.readdir(dir), sort)) {
    const el = document.createElement('div');
    el.className = 'icon';
    el.draggable = true;
    el.dataset.path = entry.path;
    el.innerHTML = `<span class="glyph">${glyphFor(entry)}</span><span class="icon-name">${escapeHtml(entry.name)}</span>`;
    if (view === 'list') {
      el.insertAdjacentHTML(
        'beforeend',
        `<span class="icon-col col-date">${dateLabel(entry.mtime)}</span><span class="icon-col col-size">${entry.type === 'dir' ? `${entry.size} elem.` : formatSize(entry.size)}</span><span class="icon-col col-type">${escapeHtml(typeLabel(entry))}</span>`,
      );
    }
    // Fotos y vídeos: su miniatura en vez del icono.
    if (entry.remote?.thumb) {
      const img = Object.assign(document.createElement('img'), { className: 'thumb', src: thumbUrl(entry.remote.key, entry.mtime), loading: 'lazy', alt: '' });
      img.onerror = () => img.replaceWith(Object.assign(document.createElement('span'), { className: 'glyph', textContent: glyphFor(entry) }));
      el.querySelector('.glyph').replaceWith(img);
    } else if (entry.remote && canThumb(entry.name)) {
      ensureThumb(entry.path, entry.remote);
    } else if (!entry.remote && entry.type === 'file' && /^data:image\//.test(fs.readFile(entry.path).slice(0, 11))) {
      el.querySelector('.glyph').replaceWith(Object.assign(document.createElement('img'), { className: 'thumb', src: fs.readFile(entry.path), alt: '' }));
    }
    if (entry.remote) {
      el.classList.add('remote');
      el.title = 'Guardado en Backblaze B2';
    }
    el.onclick = (e) => sel.clickIcon(container, el, e);
    el.ondblclick = () => onOpen(entry.path, entry);
    if (isTouch()) el.onclick = () => onOpen(entry.path, entry); // en pantallas táctiles, un toque abre
    el.oncontextmenu = (e) => entryMenu(e, entry.path, container);
    el.ondragstart = (e) => {
      // Si se arrastra algo que forma parte de la selección, se arrastra toda.
      const paths = sel.targetsFor(container, entry.path);
      e.dataTransfer.setData('text/x-miputer-paths', JSON.stringify(paths));
      e.dataTransfer.setData('text/x-miputer-path', entry.path);
    };
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
  sel.restore(container);
}

export async function pasteInto(dir) {
  await reportError(async () => {
    const pasted = await sel.paste(dir);
    if (pasted.length) toast(`${pasted.length} elemento${pasted.length === 1 ? '' : 's'} pegado${pasted.length === 1 ? '' : 's'}`).done();
  });
}

// Mueve el elemento arrastrado a `dir`.
export function moveInto(e, dir) {
  let paths;
  try {
    paths = JSON.parse(e.dataTransfer.getData('text/x-miputer-paths') || 'null');
  } catch {}
  paths ??= [e.dataTransfer.getData('text/x-miputer-path')].filter(Boolean);
  const target = fs.normalize(dir);
  for (const src of paths) {
    if (fs.dirname(src) === target || src === target || (target + '/').startsWith(src + '/')) continue;
    if (target === fs.TRASH) reportError(() => fs.trash(src));
    else reportError(() => fs.rename(src, fs.join(target, fs.uniqueName(target, fs.basename(src)))));
  }
}
