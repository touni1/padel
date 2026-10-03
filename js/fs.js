// Sistema de archivos virtual persistido en localStorage.
// Nodo directorio: { type: 'dir', children: {}, mtime }
// Nodo archivo:    { type: 'file', content: '', mtime }
// Archivo en B2:   { type: 'file', content: '', remote: { key, size, type }, mtime }
import * as storage from './storage.js';

const STORAGE_KEY = 'miputer.fs.v1';
const listeners = new Set();

function now() {
  return Date.now();
}

function defaultTree() {
  const dir = (children = {}) => ({ type: 'dir', children, mtime: now() });
  const file = (content) => ({ type: 'file', content, mtime: now() });
  return dir({
    Escritorio: dir({
      'Bienvenida.txt': file(
        '¡Bienvenido a MiPuter!\n\n' +
        'Esto es tu propio escritorio en el navegador.\n\n' +
        '- Doble clic en un icono para abrirlo.\n' +
        '- Clic derecho en el escritorio para crear archivos y carpetas.\n' +
        '- Abre la Terminal y escribe "help" para ver los comandos.\n\n' +
        'Tus carpetas se guardan en el servidor: las ves igual desde cualquier navegador.\n'
      ),
    }),
    Documentos: dir({
      'notas.md': file('# Mis notas\n\n- [ ] Probar el explorador de archivos\n- [ ] Personalizar el fondo en Ajustes\n'),
    }),
    Imágenes: dir(),
    Descargas: dir(),
  });
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    console.warn('No se pudo leer el sistema de archivos, se reinicia.', e);
  }
  return defaultTree();
}

let root = load();

function saveLocal() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(root));
  } catch (e) {
    console.error('No se pudo guardar el sistema de archivos', e);
  }
}

function persist() {
  saveLocal();
  markDirty();
  listeners.forEach((fn) => fn());
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------------------------------------------------------------------------
// Sincronización con el servidor (/api/tree)
// ---------------------------------------------------------------------------
//
// localStorage es solo una copia para arrancar rápido: el árbol de verdad vive en
// el servidor. Cada cambio se envía con la versión sobre la que se hizo; si otro
// navegador guardó antes (409), se adopta la versión del servidor.

const SYNC_KEY = 'miputer.fs.sync';
const syncListeners = new Set();
let sync = (() => {
  try {
    return { version: 0, dirty: true, ...JSON.parse(localStorage.getItem(SYNC_KEY) || '{}') };
  } catch {
    return { version: 0, dirty: true };
  }
})();
let serverAvailable = false;
let seq = 0; // cuenta los cambios locales para saber si hubo otros mientras se enviaba
let pushTimer = null;
let pushing = null;

function saveSync() {
  try {
    localStorage.setItem(SYNC_KEY, JSON.stringify(sync));
  } catch {}
}

function markDirty() {
  seq++;
  sync.dirty = true;
  saveSync();
  if (!serverAvailable) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(push, 300);
}

// Avisos de sincronización: ({ type: 'remote' | 'conflict' | 'error', message })
export function onSync(fn) {
  syncListeners.add(fn);
  return () => syncListeners.delete(fn);
}
const emitSync = (event) => syncListeners.forEach((fn) => fn(event));

function adopt(server) {
  root = server.tree;
  sync = { version: server.version, dirty: false };
  saveSync();
  saveLocal();
  listeners.forEach((fn) => fn());
}

async function push() {
  if (pushing) return pushing.then(() => sync.dirty && push());
  const sent = seq;
  pushing = (async () => {
    try {
      const body = JSON.stringify({ baseVersion: sync.version, tree: root });
      // keepalive deja terminar el envío aunque se cierre la pestaña (solo admite cuerpos pequeños).
      const res = await fetch('api/tree', { method: 'PUT', headers: { 'content-type': 'application/json' }, body, keepalive: body.length < 60_000 });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        adopt(data);
        emitSync({ type: 'conflict', message: 'Se cargaron los cambios hechos desde otro navegador' });
      } else if (!res.ok) {
        throw new Error(data.error || `Error ${res.status}`);
      } else {
        sync.version = data.version;
        if (seq === sent) sync.dirty = false;
        saveSync();
      }
    } catch (e) {
      emitSync({ type: 'error', message: `No se pudieron guardar los cambios en el servidor: ${e.message}` });
    } finally {
      pushing = null;
    }
  })();
  await pushing;
  if (sync.dirty && seq !== sent) return push();
}

// Trae la versión del servidor (al arrancar, al volver a la pestaña y cada cierto
// tiempo). La primera vez sube el árbol que ya hubiera en este navegador.
export async function syncWithServer() {
  let res;
  try {
    res = await fetch('api/tree');
  } catch {
    return;
  }
  if (!res.ok) return; // sin server.js (servidor estático) todo sigue solo en el navegador
  serverAvailable = true;
  const server = await res.json();
  if (!server.tree) {
    sync.version = server.version;
    return push();
  }
  if (server.version === sync.version) {
    if (sync.dirty) return push();
    return;
  }
  if (sync.dirty && sync.version === 0 && hasOwnContent(root)) {
    // Este navegador nunca sincronizó pero tiene archivos propios: no se pierden,
    // se guardan en una carpeta dentro del árbol del servidor.
    const local = root;
    delete local.children.Papelera;
    adopt(server);
    const name = uniqueName('/', 'Recuperado de otro navegador');
    root.children[name] = { ...local, mtime: now() };
    persist();
    emitSync({ type: 'conflict', message: `Lo que había en este navegador está en "/${name}"` });
    return;
  }
  if (sync.dirty && sync.version !== 0) emitSync({ type: 'conflict', message: 'Se cargaron los cambios hechos desde otro navegador' });
  else emitSync({ type: 'remote' });
  adopt(server);
}

// ¿El árbol tiene algo distinto del contenido de ejemplo?
function hasOwnContent(node) {
  const strip = (n) => (n.type === 'dir' ? { d: Object.fromEntries(Object.entries(n.children).filter(([k]) => k !== 'Papelera').map(([k, c]) => [k, strip(c)])) } : { f: n.content, r: n.remote?.key });
  return JSON.stringify(strip(node)) !== JSON.stringify(strip(defaultTree()));
}

export const pendingChanges = () => sync.dirty;

// Envía ya lo pendiente (al cerrar u ocultar la pestaña).
export function flush() {
  if (!serverAvailable || !sync.dirty) return;
  clearTimeout(pushTimer);
  push();
}

export function normalize(path, cwd = '/') {
  const parts = (path.startsWith('/') ? path : `${cwd}/${path}`).split('/');
  const out = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return '/' + out.join('/');
}

export function dirname(path) {
  const p = normalize(path);
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

export function basename(path) {
  const p = normalize(path);
  return p.slice(p.lastIndexOf('/') + 1);
}

export function join(...parts) {
  return normalize(parts.join('/'));
}

export function extname(path) {
  const name = basename(path);
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

const sizeOf = (node) => (node.remote ? node.remote.size : node.content.length);

// Todas las claves de B2 que cuelgan de un nodo (para borrarlas o copiarlas).
function remoteNodes(node, out = []) {
  if (node.type === 'file' && node.remote) out.push(node);
  if (node.type === 'dir') Object.values(node.children).forEach((c) => remoteNodes(c, out));
  return out;
}

function deleteRemote(node) {
  for (const n of remoteNodes(node)) {
    storage.remove(n.remote.key).catch((e) => console.error('No se pudo borrar de B2', n.remote.key, e));
  }
}

function getNode(path) {
  const parts = normalize(path).split('/').filter(Boolean);
  let node = root;
  for (const p of parts) {
    if (node.type !== 'dir' || !(p in node.children)) return null;
    node = node.children[p];
  }
  return node;
}

function getParent(path) {
  const p = normalize(path);
  if (p === '/') throw new Error('No se puede operar sobre la raíz');
  const parent = getNode(dirname(p));
  if (!parent) throw new Error(`No existe el directorio: ${dirname(p)}`);
  if (parent.type !== 'dir') throw new Error(`No es un directorio: ${dirname(p)}`);
  return { parent, name: basename(p) };
}

function validName(name) {
  if (!name || name.includes('/') || name === '.' || name === '..') {
    throw new Error(`Nombre no válido: "${name}"`);
  }
}

export function exists(path) {
  return getNode(path) !== null;
}

export function stat(path) {
  const node = getNode(path);
  if (!node) return null;
  return {
    type: node.type,
    mtime: node.mtime,
    size: node.type === 'file' ? sizeOf(node) : Object.keys(node.children).length,
    remote: node.remote || null,
  };
}

export function isDir(path) {
  const node = getNode(path);
  return !!node && node.type === 'dir';
}

export function readdir(path) {
  const node = getNode(path);
  if (!node) throw new Error(`No existe: ${path}`);
  if (node.type !== 'dir') throw new Error(`No es un directorio: ${path}`);
  return Object.entries(node.children)
    .map(([name, child]) => ({
      name,
      path: join(path, name),
      type: child.type,
      mtime: child.mtime,
      size: child.type === 'file' ? sizeOf(child) : Object.keys(child.children).length,
      remote: child.remote || null,
    }))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
}

export function readFile(path) {
  const node = getNode(path);
  if (!node) throw new Error(`No existe: ${path}`);
  if (node.type !== 'file') throw new Error(`Es un directorio: ${path}`);
  if (node.remote) throw new Error(`Está en la nube, usa readFileAsync: ${path}`);
  return node.content;
}

// Lee un archivo local o guardado en B2 como texto.
export async function readFileAsync(path) {
  const node = getNode(path);
  if (node?.type === 'file' && node.remote) return storage.readText(node.remote.key);
  return readFile(path);
}

// Datos del archivo en B2, o null si es local.
export function getRemote(path) {
  const node = getNode(path);
  return node?.type === 'file' ? node.remote || null : null;
}

// Registra en `path` un archivo ya subido a B2.
export function writeRemote(path, remote) {
  const { parent, name } = getParent(path);
  validName(name);
  const existing = parent.children[name];
  if (existing && existing.type === 'dir') throw new Error(`Es un directorio: ${path}`);
  if (existing?.remote && existing.remote.key !== remote.key) deleteRemote(existing);
  const r = { key: remote.key, size: remote.size, type: remote.type };
  if (remote.thumb !== undefined) r.thumb = remote.thumb;
  parent.children[name] = { type: 'file', content: '', remote: r, mtime: now() };
  parent.mtime = now();
  persist();
}

export function writeFile(path, content = '') {
  const { parent, name } = getParent(path);
  validName(name);
  const existing = parent.children[name];
  if (existing && existing.type === 'dir') throw new Error(`Es un directorio: ${path}`);
  if (existing?.remote) deleteRemote(existing);
  parent.children[name] = { type: 'file', content: String(content), mtime: now() };
  parent.mtime = now();
  persist();
}

export function mkdir(path) {
  const { parent, name } = getParent(path);
  validName(name);
  if (parent.children[name]) throw new Error(`Ya existe: ${path}`);
  parent.children[name] = { type: 'dir', children: {}, mtime: now() };
  parent.mtime = now();
  persist();
}

export function rm(path) {
  const { parent, name } = getParent(path);
  if (!parent.children[name]) throw new Error(`No existe: ${path}`);
  deleteRemote(parent.children[name]);
  delete parent.children[name];
  parent.mtime = now();
  persist();
}

// ---------------------------------------------------------------------------
// Papelera: los elementos eliminados se mueven a /Papelera con { from, at } y no
// se borran de B2 hasta vaciarla, eliminarlos de ahí o pasar TRASH_DAYS días.
// ---------------------------------------------------------------------------

export const TRASH = '/Papelera';
export const TRASH_DAYS = 30;

export const inTrash = (path) => dirname(path) === TRASH;

function trashDir() {
  if (root.children.Papelera?.type !== 'dir') root.children.Papelera = { type: 'dir', children: {}, mtime: now() };
  return root.children.Papelera;
}

// Mueve a la papelera; si ya está dentro (o dentro de algo que está en ella), la elimina para siempre.
export function trash(path) {
  const p = normalize(path);
  if (p === TRASH) throw new Error('No se puede eliminar la papelera');
  if (p.startsWith(TRASH + '/')) return rm(p);
  const { parent, name } = getParent(p);
  const node = parent.children[name];
  if (!node) throw new Error(`No existe: ${path}`);
  const dir = trashDir();
  const target = uniqueName(TRASH, name);
  delete parent.children[name];
  parent.mtime = now();
  node.trashed = { from: p, at: now() };
  dir.children[target] = node;
  persist();
}

// Lo eliminado, con su ruta original y los días que le quedan antes de borrarse solo.
export function listTrash() {
  return Object.entries(trashDir().children)
    .map(([name, node]) => {
      const at = node.trashed?.at ?? node.mtime;
      return {
        name,
        path: join(TRASH, name),
        type: node.type,
        remote: node.remote || null,
        from: node.trashed?.from ?? null,
        at,
        daysLeft: Math.max(0, Math.ceil((at + TRASH_DAYS * 86400_000 - now()) / 86400_000)),
      };
    })
    .sort((a, b) => b.at - a.at);
}

// Devuelve el elemento a su carpeta original (la recrea si ya no existe) y devuelve la ruta final.
export function restore(path) {
  const p = normalize(path);
  if (!inTrash(p)) throw new Error(`No está en la papelera: ${path}`);
  const dir = trashDir();
  const node = dir.children[basename(p)];
  if (!node) throw new Error(`No existe: ${path}`);
  const from = node.trashed?.from || join('/Escritorio', basename(p));
  const destDir = dirname(from);
  let cur = root;
  for (const part of destDir.split('/').filter(Boolean)) {
    if (cur.children[part]?.type !== 'dir') cur.children[part] = { type: 'dir', children: {}, mtime: now() };
    cur = cur.children[part];
  }
  const target = uniqueName(destDir, basename(from));
  delete dir.children[basename(p)];
  delete node.trashed;
  cur.children[target] = node;
  cur.mtime = now();
  persist();
  return join(destDir, target);
}

export function emptyTrash() {
  const dir = trashDir();
  deleteRemote(dir);
  dir.children = {};
  persist();
}

// Borra para siempre lo que lleva más de TRASH_DAYS días en la papelera.
export function purgeTrash() {
  const dir = root.children.Papelera;
  if (dir?.type !== 'dir') return 0;
  const limit = now() - TRASH_DAYS * 86400_000;
  const old = Object.entries(dir.children).filter(([, n]) => (n.trashed?.at ?? n.mtime) < limit);
  for (const [name, node] of old) {
    deleteRemote(node);
    delete dir.children[name];
  }
  if (old.length) persist();
  return old.length;
}

export function rename(from, to) {
  if (normalize(from) === TRASH) throw new Error('La papelera no se puede renombrar ni mover');
  const src = getParent(from);
  const node = src.parent.children[src.name];
  if (!node) throw new Error(`No existe: ${from}`);
  if (dirname(to) !== TRASH) delete node.trashed;
  const dst = getParent(to);
  validName(dst.name);
  if (dst.parent.children[dst.name]) throw new Error(`Ya existe: ${to}`);
  if (node.type === 'dir' && (normalize(to) + '/').startsWith(normalize(from) + '/')) {
    throw new Error('No se puede mover una carpeta dentro de sí misma');
  }
  delete src.parent.children[src.name];
  dst.parent.children[dst.name] = node;
  node.mtime = now();
  persist();
}

export function copy(from, to) {
  const node = getNode(from);
  if (!node) throw new Error(`No existe: ${from}`);
  const dst = getParent(to);
  validName(dst.name);
  if (dst.parent.children[dst.name]) throw new Error(`Ya existe: ${to}`);
  const clone = JSON.parse(JSON.stringify(node));
  dst.parent.children[dst.name] = clone;
  persist();
  // Los archivos en B2 se duplican también en B2 para que cada copia sea independiente.
  const copies = remoteNodes(clone).map(async (n) => {
    const { key } = await storage.copy(n.remote.key);
    n.remote = { ...n.remote, key };
  });
  return Promise.all(copies).then(
    () => copies.length && persist(),
    (e) => {
      // Si falla, se deshace la copia para que no queden dos nodos con la misma clave.
      if (dst.parent.children[dst.name] === clone) delete dst.parent.children[dst.name];
      persist();
      throw e;
    }
  );
}

// Todo lo que cuelga de `path` para meterlo en un zip, con rutas relativas a su carpeta.
export function collect(path) {
  const node = getNode(path);
  if (!node) throw new Error(`No existe: ${path}`);
  const out = [];
  const walk = (n, rel) => {
    if (n.type === 'dir') {
      out.push({ path: `${rel}/`, dir: true });
      for (const [name, child] of Object.entries(n.children)) walk(child, `${rel}/${name}`);
    } else if (n.remote) {
      out.push({ path: rel, key: n.remote.key, size: n.remote.size });
    } else {
      out.push({ path: rel, data: n.content, size: n.content.length });
    }
  };
  walk(node, basename(path));
  return out;
}

function mkdirp(path) {
  let cur = root;
  for (const part of normalize(path).split('/').filter(Boolean)) {
    if (!cur.children[part]) cur.children[part] = { type: 'dir', children: {}, mtime: now() };
    else if (cur.children[part].type !== 'dir') throw new Error(`No es una carpeta: ${part}`);
    cur = cur.children[part];
  }
  return cur;
}

// Marca si el archivo de B2 `key` tiene miniatura (true) o no se puede hacer (false).
export function setThumb(key, ok) {
  let changed = false;
  const walk = (n) => {
    if (n.type === 'dir') Object.values(n.children).forEach(walk);
    else if (n.remote?.key === key && n.remote.thumb !== ok) {
      n.remote.thumb = ok;
      changed = true;
    }
  };
  walk(root);
  if (changed) persist();
}

// Crea `path` y las carpetas intermedias que falten (como mkdir -p).
export function ensureDir(path) {
  if (isDir(path)) return;
  mkdirp(path);
  persist();
}

// Espacio que ocupa todo, por carpeta de primer nivel, y la papelera.
export function usage() {
  const sizeOfTree = (n) => (n.type === 'dir' ? Object.values(n.children).reduce((a, c) => a + sizeOfTree(c), 0) : sizeOf(n));
  const count = (n) => (n.type === 'dir' ? Object.values(n.children).reduce((a, c) => a + count(c), 0) : 1);
  const folders = Object.entries(root.children)
    .filter(([name]) => name !== 'Papelera')
    .map(([name, n]) => ({ name, bytes: sizeOfTree(n), files: count(n) }))
    .sort((a, b) => b.bytes - a.bytes);
  const trashNode = root.children.Papelera;
  const trash = trashNode ? { bytes: sizeOfTree(trashNode), files: count(trashNode) } : { bytes: 0, files: 0 };
  return { folders, trash, bytes: folders.reduce((a, f) => a + f.bytes, 0) + trash.bytes, files: folders.reduce((a, f) => a + f.files, 0) + trash.files };
}

// Busca por nombre (sin distinguir mayúsculas ni acentos) fuera de la papelera.
export function search(query, limit = 300) {
  const plain = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const q = plain(query.trim());
  const out = [];
  if (!q) return out;
  const walk = (n, path) => {
    for (const [name, child] of Object.entries(n.children)) {
      const p = join(path, name);
      if (p === TRASH) continue;
      if (plain(name).includes(q)) {
        out.push({ name, path: p, type: child.type, mtime: child.mtime, size: child.type === 'file' ? sizeOf(child) : Object.keys(child.children).length, remote: child.remote || null });
        if (out.length >= limit) return;
      }
      if (child.type === 'dir') walk(child, p);
      if (out.length >= limit) return;
    }
  };
  walk(root, '/');
  return out;
}

// Crea en `dest` lo extraído de un zip (archivos ya subidos a B2), guardando una sola vez.
export function importExtracted(dest, files, dirs) {
  mkdirp(dest);
  for (const d of dirs) mkdirp(join(dest, d));
  for (const f of files) {
    const parent = mkdirp(join(dest, dirname(`/${f.path}`)));
    parent.children[basename(`/${f.path}`)] = { type: 'file', content: '', remote: { key: f.key, size: f.size, type: f.type }, mtime: now() };
  }
  persist();
}

// Devuelve un nombre libre en `dir` basado en `name` ("Nueva carpeta (2)").
export function uniqueName(dir, name) {
  if (!exists(join(dir, name))) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!exists(join(dir, candidate))) return candidate;
  }
}

export function reset() {
  deleteRemote(root);
  const apps = root.apps;
  root = defaultTree();
  if (apps) root.apps = apps; // las notas y el calendario no son "archivos": se conservan
  persist();
}

// Datos de las apps (notas, calendario…). Viven en el mismo árbol, así que se
// guardan en el servidor y se sincronizan entre navegadores igual que las carpetas.
export function getData(name, fallback) {
  const value = root.apps?.[name];
  return value === undefined ? structuredClone(fallback) : structuredClone(value);
}

export function setData(name, value) {
  root.apps ??= {};
  root.apps[name] = value;
  persist();
}
