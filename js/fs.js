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
        'Todo se guarda en tu navegador (localStorage).\n'
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

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(root));
  } catch (e) {
    console.error('No se pudo guardar el sistema de archivos', e);
  }
  listeners.forEach((fn) => fn());
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
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
  parent.children[name] = { type: 'file', content: '', remote: { key: remote.key, size: remote.size, type: remote.type }, mtime: now() };
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

export function rename(from, to) {
  const src = getParent(from);
  const node = src.parent.children[src.name];
  if (!node) throw new Error(`No existe: ${from}`);
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
  root = defaultTree();
  persist();
}
