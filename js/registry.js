// Registro de aplicaciones y asociación de archivos por extensión.
import * as fs from './fs.js';

const apps = new Map();

export function register(app) {
  apps.set(app.id, app);
}

export function list() {
  return [...apps.values()];
}

export function get(id) {
  return apps.get(id);
}

export function launch(id, args = {}) {
  const app = apps.get(id);
  if (!app) throw new Error(`Aplicación desconocida: ${id}`);
  return app.launch(args);
}

// Abre una ruta con la aplicación adecuada.
export function openPath(path) {
  if (fs.normalize(path) === fs.TRASH) return launch('trash');
  if (fs.isDir(path)) return launch('files', { path });
  const ext = fs.extname(path);
  const app = list().find((a) => a.extensions?.includes(ext)) || apps.get('editor');
  return app.launch({ path });
}

export function glyphFor(entry) {
  if (entry.type === 'dir') return '📁';
  const ext = fs.extname(entry.name);
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return '🖼️';
  if (['html', 'htm'].includes(ext)) return '🌐';
  if (['md', 'txt'].includes(ext)) return '📝';
  if (['js', 'json', 'css', 'py'].includes(ext)) return '📜';
  return '📄';
}
