import * as fs from './fs.js';
import { register, list, launch } from './registry.js';
import * as storage from './storage.js';
import { renderIcons, folderMenu, moveInto, importFiles } from './fileActions.js';
import { hideContextMenu, reportError, escapeHtml } from './ui.js';
import { applySettings } from './apps/settings.js';

import files from './apps/files.js';
import editor from './apps/editor.js';
import terminal from './apps/terminal.js';
import claude from './apps/claude.js';
import calculator from './apps/calculator.js';
import browser from './apps/browser.js';
import viewer from './apps/viewer.js';
import settings from './apps/settings.js';

const DESKTOP_DIR = '/Escritorio';

[files, editor, terminal, claude, calculator, browser, viewer, settings].forEach(register);

function appIcon(app) {
  const el = document.createElement('div');
  el.className = 'icon';
  el.innerHTML = `<span class="glyph">${app.glyph}</span><span>${escapeHtml(app.name)}</span>`;
  el.ondblclick = () => launch(app.id);
  return el;
}

function renderDesktop() {
  const container = document.getElementById('desktop-icons');
  if (!fs.isDir(DESKTOP_DIR)) fs.mkdir(DESKTOP_DIR);
  renderIcons(container, DESKTOP_DIR);
  const shortcuts = list().filter((a) => !a.hidden && a.id !== 'editor').map(appIcon);
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

function wireDesktop() {
  const desktop = document.getElementById('desktop');
  desktop.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.window')) return;
    folderMenu(e, DESKTOP_DIR, ['sep', { label: 'Ajustes del escritorio', action: () => launch('settings') }]);
  });
  desktop.addEventListener('dragover', (e) => e.preventDefault());
  desktop.addEventListener('drop', (e) => {
    if (e.target.closest('.window')) return;
    e.preventDefault();
    if (e.dataTransfer.files.length) {
      // Archivos arrastrados desde el ordenador real.
      importFiles(DESKTOP_DIR, [...e.dataTransfer.files]);
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
storage.init().then(renderStartMenu);
startClock();
wireDesktop();
fs.onChange(renderDesktop);
