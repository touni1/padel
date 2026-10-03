// Selección de varios elementos (escritorio y explorador) y portapapeles de archivos.
import * as fs from './fs.js';

const sets = new WeakMap(); // contenedor -> Set de rutas seleccionadas
const anchors = new WeakMap(); // contenedor -> última ruta clicada (para Shift+clic)
let active = null; // { container, getDir }: donde se hizo clic por última vez

export const selected = (container) => {
  if (!sets.has(container)) sets.set(container, new Set());
  return sets.get(container);
};
export const activeContext = () => (active?.container.isConnected ? active : null);

function paint(container) {
  const set = selected(container);
  container.querySelectorAll('.icon[data-path]').forEach((el) => el.classList.toggle('selected', set.has(el.dataset.path)));
}

// Tras volver a pintar los iconos: conserva lo seleccionado que siga existiendo.
export function restore(container) {
  const set = selected(container);
  for (const p of set) if (!fs.exists(p)) set.delete(p);
  paint(container);
}

export function selectOnly(container, paths) {
  const set = selected(container);
  set.clear();
  paths.forEach((p) => set.add(p));
  paint(container);
}

// Clic en un icono: normal = solo ese; Ctrl/Cmd = suma o quita; Shift = rango.
export function clickIcon(container, el, e) {
  const set = selected(container);
  const path = el.dataset.path;
  if (e.shiftKey && anchors.get(container)) {
    const icons = [...container.querySelectorAll('.icon[data-path]')];
    const a = icons.findIndex((i) => i.dataset.path === anchors.get(container));
    const b = icons.indexOf(el);
    if (!(e.ctrlKey || e.metaKey)) set.clear();
    icons.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((i) => set.add(i.dataset.path));
  } else if (e.ctrlKey || e.metaKey) {
    set.has(path) ? set.delete(path) : set.add(path);
    anchors.set(container, path);
  } else {
    set.clear();
    set.add(path);
    anchors.set(container, path);
  }
  paint(container);
}

// Lo que se va a mover, copiar, borrar…: la selección si incluye `path`, si no solo `path`.
export function targetsFor(container, path) {
  const set = selected(container);
  return set.has(path) && set.size > 1 ? [...set] : [path];
}

// Se llama una vez por contenedor: recuerda cuál está activo y permite seleccionar
// arrastrando un rectángulo sobre el fondo.
export function setup(container, getDir) {
  container.addEventListener('pointerdown', (e) => {
    active = { container, getDir };
    if (e.button !== 0 || e.pointerType === 'touch' || e.target.closest('.icon, .files-head')) return;
    const add = e.ctrlKey || e.metaKey;
    const base = add ? new Set(selected(container)) : new Set();
    const start = [e.clientX, e.clientY];
    const box = Object.assign(document.createElement('div'), { className: 'rubber-band' });
    let moved = false;
    const move = (ev) => {
      const [x0, y0] = start;
      const [x1, y1] = [ev.clientX, ev.clientY];
      if (!moved && Math.hypot(x1 - x0, y1 - y0) < 4) return;
      if (!moved) document.body.appendChild(box);
      moved = true;
      const r = { left: Math.min(x0, x1), top: Math.min(y0, y1), right: Math.max(x0, x1), bottom: Math.max(y0, y1) };
      Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px` });
      const set = selected(container);
      set.clear();
      base.forEach((p) => set.add(p));
      container.querySelectorAll('.icon[data-path]').forEach((el) => {
        const b = el.getBoundingClientRect();
        if (b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top) set.add(el.dataset.path);
      });
      paint(container);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      box.remove();
      // Un clic en el fondo, sin arrastrar, deselecciona todo.
      if (!moved && !add) selectOnly(container, []);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

// ---- Portapapeles de archivos (Ctrl+C / Ctrl+X / Ctrl+V) -------------------------

const clip = { mode: null, paths: [] };
export const clipboardEmpty = () => !clip.paths.some((p) => fs.exists(p));
export function copyPaths(paths) {
  Object.assign(clip, { mode: 'copy', paths: [...paths] });
}
export function cutPaths(paths) {
  Object.assign(clip, { mode: 'cut', paths: [...paths] });
}

// Pega en `dir`. Devuelve las rutas nuevas.
export async function paste(dir) {
  const target = fs.normalize(dir);
  const out = [];
  for (const src of clip.paths.filter((p) => fs.exists(p))) {
    if (fs.isDir(src) && (target + '/').startsWith(src + '/')) throw new Error(`No se puede pegar "${fs.basename(src)}" dentro de sí misma`);
    if (clip.mode === 'cut' && fs.dirname(src) === target) continue;
    const dest = fs.join(target, fs.uniqueName(target, fs.basename(src)));
    if (clip.mode === 'cut') fs.rename(src, dest);
    else await fs.copy(src, dest);
    out.push(dest);
  }
  // Lo cortado se pega una sola vez.
  if (clip.mode === 'cut') Object.assign(clip, { mode: null, paths: [] });
  return out;
}
