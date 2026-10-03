import * as fs from './fs.js';
import { register, list, launch } from './registry.js';
import * as storage from './storage.js';
import { renderIcons, folderMenu, moveInto, importDrop, deleteEntries, renameEntry, pasteInto } from './fileActions.js';
import * as sel from './selection.js';
import { hideContextMenu, reportError, escapeHtml, toast } from './ui.js';
import { applySettings } from './apps/settings.js';
import { isTouch, enableLongPress } from './touch.js';

import files from './apps/files.js';
import editor from './apps/editor.js';
import terminal from './apps/terminal.js';
import claude from './apps/claude.js';
import claudeTerminal from './apps/claude-terminal.js';
import calculator from './apps/calculator.js';
import browser from './apps/browser.js';
import celebgo from './apps/celebgo.js';
import viewer from './apps/viewer.js';
import settings from './apps/settings.js';
import trash from './apps/trash.js';
import shares from './apps/shares.js';
import pdf from './apps/pdf.js';
import search from './apps/search.js';
import player from './apps/player.js';
import office from './apps/office.js';
import imgedit from './apps/imgedit.js';
import pdftools from './apps/pdftools.js';
import windowsApp from './apps/windows.js';
import notes, { renderNotes, newNote } from './apps/notes.js';
import calendar, { checkReminders } from './apps/calendar.js';

const DESKTOP_DIR = '/Escritorio';

[files, search, editor, terminal, claude, claudeTerminal, windowsApp, calculator, browser, celebgo, viewer, imgedit, pdf, pdftools, player, office, calendar, notes, settings, shares, trash].forEach(register);

function appIcon(app) {
  const el = document.createElement('div');
  el.className = 'icon';
  el.innerHTML = `<span class="glyph">${app.glyph}</span><span>${escapeHtml(app.name)}</span>`;
  el.ondblclick = () => launch(app.id);
  if (isTouch()) el.onclick = () => launch(app.id); // en pantallas táctiles, un toque abre
  if (app.onDrop) {
    el.ondragover = (e) => e.preventDefault();
    el.ondrop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      let paths;
      try {
        paths = JSON.parse(e.dataTransfer.getData('text/x-miputer-paths') || 'null');
      } catch {}
      app.onDrop(paths ?? [e.dataTransfer.getData('text/x-miputer-path')].filter(Boolean));
    };
  }
  return el;
}

function renderDesktop() {
  const container = document.getElementById('desktop-icons');
  if (!fs.isDir(DESKTOP_DIR)) fs.mkdir(DESKTOP_DIR);
  renderIcons(container, DESKTOP_DIR);
  const shortcuts = list().filter((a) => !a.hidden && a.desktop !== false && a.id !== 'editor').map(appIcon);
  container.prepend(...shortcuts);
}

function renderStartMenu() {
  const menu = document.getElementById('start-menu');
  const appsEl = document.getElementById('start-apps');
  appsEl.innerHTML = '';
  for (const app of list().filter((a) => !a.hidden)) {
    const item = document.createElement('div');
    item.className = 'start-item';
    item.innerHTML = `<span class="glyph">${app.glyph}</span><span>${escapeHtml(app.name)}</span>`;
    item.onclick = () => {
      menu.hidden = true;
      reportError(() => launch(app.id));
    };
    appsEl.appendChild(item);
  }
  if (storage.authEnabled()) {
    const change = document.createElement('div');
    change.className = 'start-item';
    change.innerHTML = '<span class="glyph">🔑</span><span>Cambiar contraseña</span>';
    change.onclick = () => location.assign('cambiar-clave');
    appsEl.appendChild(change);
    const logout = document.createElement('div');
    logout.className = 'start-item start-logout';
    logout.innerHTML = '<span class="glyph">🔒</span><span>Cerrar sesión</span>';
    logout.onclick = storage.logout;
    appsEl.appendChild(logout);
  }
  document.getElementById('start-btn').onclick = (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  };
}

// Atajos sobre los archivos del último sitio donde se hizo clic (escritorio o explorador),
// salvo que se esté escribiendo en un campo o usando una terminal, el escritorio remoto, etc.
function fileShortcuts(e) {
  const ctx = sel.activeContext();
  if (!ctx || e.target.closest('input, textarea, select, [contenteditable], .xterm, .rdp, .pdf-app, .imgedit, .gallery, .player')) return;
  const mod = e.ctrlKey || e.metaKey;
  const chosen = [...sel.selected(ctx.container)];
  const key = e.key.toLowerCase();
  const run = (fn) => {
    e.preventDefault();
    fn();
  };
  if (mod && key === 'a') run(() => sel.selectOnly(ctx.container, [...ctx.container.querySelectorAll('.icon[data-path]')].map((i) => i.dataset.path)));
  else if (mod && key === 'c' && chosen.length) run(() => sel.copyPaths(chosen));
  else if (mod && key === 'x' && chosen.length) run(() => sel.cutPaths(chosen));
  else if (mod && key === 'v' && !sel.clipboardEmpty()) run(() => pasteInto(ctx.getDir()));
  else if (e.key === 'Delete' && chosen.length) run(() => deleteEntries(chosen));
  else if (e.key === 'F2' && chosen.length === 1) run(() => renameEntry(chosen[0]));
  else if (e.key === 'Enter' && chosen.length === 1) run(() => ctx.container.querySelector(`.icon[data-path="${CSS.escape(chosen[0])}"]`)?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
}

function startClock() {
  const clock = document.getElementById('clock');
  const tick = () => {
    const d = new Date();
    clock.textContent = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    clock.title = d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  };
  tick();
  setInterval(tick, 10_000);
}

// Clic en el reloj: calendario.
document.getElementById('clock').onclick = () => launch('calendar');

function wireDesktop() {
  const desktop = document.getElementById('desktop');
  desktop.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.window')) return;
    folderMenu(e, DESKTOP_DIR, ['sep', { label: 'Nueva nota', action: newNote }, { label: 'Ajustes del escritorio', action: () => launch('settings') }]);
  });
  desktop.addEventListener('dragover', (e) => e.preventDefault());
  desktop.addEventListener('drop', (e) => {
    if (e.target.closest('.window')) return;
    e.preventDefault();
    if (e.dataTransfer.files.length) {
      // Archivos arrastrados desde el ordenador real.
      importDrop(DESKTOP_DIR, e.dataTransfer);
    } else {
      moveInto(e, DESKTOP_DIR);
    }
  });
  // Seleccionar varios en el escritorio (Ctrl/Shift+clic o arrastrando un rectángulo).
  sel.setup(document.getElementById('desktop-icons'), () => DESKTOP_DIR);

  document.addEventListener('click', (e) => {
    hideContextMenu();
    if (!e.target.closest('#start-menu')) document.getElementById('start-menu').hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideContextMenu();
      document.getElementById('start-menu').hidden = true;
    }
    fileShortcuts(e);
  });
}

enableLongPress();
applySettings();
renderDesktop();
renderStartMenu();
storage.init().then(async () => {
  renderStartMenu();
  await fs.syncWithServer();
  fs.purgeTrash();
  renderNotes();
  checkReminders();
});
fs.onChange(renderNotes);
renderNotes();
setInterval(checkReminders, 30_000);

// El árbol de carpetas vive en el servidor: se trae al volver a la pestaña y cada 20 s,
// y lo pendiente se envía al ocultarla o cerrarla.
fs.onSync((e) => e.message && toast(e.message).done(e.message, e.type === 'error'));
setInterval(() => document.visibilityState === 'visible' && fs.syncWithServer(), 20_000);
document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? fs.syncWithServer() : fs.flush()));
window.addEventListener('pagehide', fs.flush);
startClock();
wireDesktop();
fs.onChange(renderDesktop);
