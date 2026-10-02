// Registro de aplicaciones y asociación de archivos por extensión.
import * as fs from './fs.js';
import * as storage from './storage.js';

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
  const app = list().find((a) => a.extensions?.includes(ext));
  if (app) return app.launch({ path });
  const remote = fs.getRemote(path);
  // Archivos de B2 que no son texto: lo que el navegador sabe mostrar se abre en una
  // pestaña y el resto (zip, rar, docx…) se descarga.
  if (remote && !storage.isTextType(remote.type, path)) {
    if (OPEN_IN_TAB.includes(ext) || /^(video|audio)\//.test(remote.type) || remote.type === 'application/pdf') {
      return window.open(storage.url(remote.key), '_blank', 'noopener');
    }
    const a = document.createElement('a');
    a.href = storage.url(remote.key, { download: fs.basename(path) });
    a.download = fs.basename(path);
    return a.click();
  }
  return apps.get('editor').launch({ path });
}

const OPEN_IN_TAB = ['mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'm4a'];

export function glyphFor(entry) {
  if (entry.type === 'dir') return '📁';
  const ext = fs.extname(entry.name);
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return '🖼️';
  if (['html', 'htm'].includes(ext)) return '🌐';
  if (['md', 'txt'].includes(ext)) return '📝';
  if (['js', 'json', 'css', 'py'].includes(ext)) return '📜';
  if (ext === 'pdf') return '📕';
  if (['iso', 'img', 'dmg'].includes(ext)) return '💿';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'].includes(ext)) return '🗜️';
  if (['doc', 'docx', 'odt', 'rtf'].includes(ext)) return '📘';
  if (['xls', 'xlsx', 'ods'].includes(ext)) return '📗';
  if (['ppt', 'pptx', 'odp'].includes(ext)) return '📙';
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) return '🎵';
  if (['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(ext)) return '🎬';
  return '📄';
}
