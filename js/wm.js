// Gestor de ventanas: crear, arrastrar, redimensionar, minimizar, maximizar y barra de tareas.
import { isNarrow } from './touch.js';

const windowsEl = () => document.getElementById('windows');
const taskListEl = () => document.getElementById('task-list');

const windows = new Map();
let zTop = 10;
let nextId = 1;
let cascade = 0;

function desktopRect() {
  return document.getElementById('desktop').getBoundingClientRect();
}

export function createWindow({ title = 'Ventana', width = 640, height = 440, onClose } = {}) {
  const id = nextId++;
  const rect = desktopRect();
  width = Math.min(width, rect.width - 20);
  height = Math.min(height, rect.height - 20);
  const offset = (cascade++ % 8) * 28;
  const left = Math.max(10, (rect.width - width) / 2 - 100 + offset);
  const top = Math.max(10, (rect.height - height) / 2 - 60 + offset);

  const el = document.createElement('div');
  el.className = 'window';
  el.style.cssText = `left:${left}px;top:${top}px;width:${width}px;height:${height}px`;
  el.innerHTML = `
    <div class="titlebar">
      <span class="title"></span>
      <button class="min" title="Minimizar">—</button>
      <button class="max" title="Maximizar">▢</button>
      <button class="close" title="Cerrar">✕</button>
    </div>
    <div class="window-body"></div>
    <div class="resize-handle"></div>`;
  windowsEl().appendChild(el);
  // En el celular las ventanas van siempre a pantalla completa.
  if (isNarrow()) el.classList.add('maximized');

  const task = document.createElement('button');
  task.className = 'task';
  taskListEl().appendChild(task);

  const win = {
    id,
    el,
    body: el.querySelector('.window-body'),
    beforeClose: null,
    setTitle(t) {
      el.querySelector('.title').textContent = t;
      task.textContent = t;
      task.title = t;
    },
    focus() {
      el.classList.remove('minimized');
      el.style.zIndex = ++zTop;
      windows.forEach((w) => {
        w.el.classList.toggle('focused', w === win);
        w.task.classList.toggle('active', w === win);
      });
    },
    minimize() {
      el.classList.add('minimized');
      el.classList.remove('focused');
      task.classList.remove('active');
    },
    toggleMaximize() {
      if (isNarrow()) return;
      el.classList.toggle('maximized');
    },
    async close() {
      if (win.beforeClose && (await win.beforeClose()) === false) return;
      el.remove();
      task.remove();
      windows.delete(id);
      onClose?.();
      focusTopmost();
    },
    task,
  };
  win.setTitle(title);
  windows.set(id, win);

  el.addEventListener('mousedown', () => win.focus(), true);
  el.querySelector('.min').onclick = () => win.minimize();
  el.querySelector('.max').onclick = () => win.toggleMaximize();
  el.querySelector('.close').onclick = () => win.close();
  task.onclick = () => {
    const isActive = el.classList.contains('focused') && !el.classList.contains('minimized');
    isActive ? win.minimize() : win.focus();
  };

  const titlebar = el.querySelector('.titlebar');
  titlebar.addEventListener('dblclick', (e) => {
    if (e.target.tagName !== 'BUTTON') win.toggleMaximize();
  });
  makeDraggable(win, titlebar);
  makeResizable(win, el.querySelector('.resize-handle'));

  win.focus();
  return win;
}

function focusTopmost() {
  let top = null;
  windows.forEach((w) => {
    if (w.el.classList.contains('minimized')) return;
    if (!top || Number(w.el.style.zIndex) > Number(top.el.style.zIndex)) top = w;
  });
  top?.focus();
}

function startPointerDrag(e, onMove) {
  e.preventDefault();
  const startX = e.clientX;
  const startY = e.clientY;
  // Evita que los iframes capturen el ratón durante el arrastre.
  document.body.style.pointerEvents = 'none';
  const move = (ev) => onMove(ev.clientX - startX, ev.clientY - startY);
  const up = () => {
    document.body.style.pointerEvents = '';
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function makeDraggable(win, handle) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.tagName === 'BUTTON') return;
    if (win.el.classList.contains('maximized')) return;
    const left = win.el.offsetLeft;
    const top = win.el.offsetTop;
    const rect = desktopRect();
    startPointerDrag(e, (dx, dy) => {
      const x = Math.min(Math.max(left + dx, -win.el.offsetWidth + 80), rect.width - 80);
      const y = Math.min(Math.max(top + dy, 0), rect.height - 36);
      win.el.style.left = `${x}px`;
      win.el.style.top = `${y}px`;
    });
  });
}

function makeResizable(win, handle) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || win.el.classList.contains('maximized')) return;
    const w = win.el.offsetWidth;
    const h = win.el.offsetHeight;
    startPointerDrag(e, (dx, dy) => {
      win.el.style.width = `${Math.max(260, w + dx)}px`;
      win.el.style.height = `${Math.max(160, h + dy)}px`;
    });
  });
}
