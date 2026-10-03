import * as fs from './fs.js';
import { register, list, launch } from './registry.js';
import * as storage from './storage.js';
import { renderIcons, folderMenu, moveInto, importDrop } from './fileActions.js';
import { hideContextMenu, reportError, escapeHtml, toast } from './ui.js';
import { applySettings } from './apps/settings.js';

import files from './apps/files.js';
import editor from './apps/editor.js';
import terminal from './apps/terminal.js';
import claude from './apps/claude.js';
import calculator from './apps/calculator.js';
import browser from './apps/browser.js';
import viewer from './apps/viewer.js';
import settings from './apps/settings.js';
import trash from './apps/trash.js';
import shares from './apps/shares.js';
import pdf from './apps/pdf.js';
import search from './apps/search.js';
import player from './apps/player.js';
import office from './apps/office.js';
import notes, { renderNotes, newNote } from './apps/notes.js';
import calendar, { checkReminders } from './apps/calendar.js';

const DESKTOP_DIR = '/Escritorio';

[files, search, editor, terminal, claude, calculator, browser, viewer, pdf, player, office, calendar, notes, settings, shares, trash].forEach(register);

function appIcon(app) {
  const el = document.createElement('div');
  el.className = 'icon';
  el.innerHTML = `<span class="glyph">${app.glyph}</span><span>${escapeHtml(app.name)}</span>`;
  el.ondblclick = () => launch(app.id);
  if (app.onDrop) {
    el.ondragover = (e) => e.preventDefault();
    el.ondrop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      app.onDrop(e.dataTransfer.getData('text/x-miputer-path'));
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
  document.getElementById('desktop-icons').addEventListener('click', (e) => {
    if (e.target.id === 'desktop-icons') e.target.querySelectorAll('.selected').forEach((i) => i.classList.remove('selected'));
  });

  document.addEventListener('click', (e) => {
    hideContextMenu();
    if (!e.target.closest('#start-menu')) document.getElementById('start-menu').hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideContextMenu();
      document.getElementById('start-menu').hidden = true;
    }
  });
}

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
