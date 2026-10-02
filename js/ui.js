// Utilidades de interfaz: diálogos modales en ventana y menú contextual.
import { createWindow } from './wm.js';

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function dialog({ title, message, input, okText = 'Aceptar', cancel = true }) {
  return new Promise((resolve) => {
    let result = null;
    const win = createWindow({ title, width: 380, height: input !== undefined ? 200 : 170, onClose: () => resolve(result) });
    win.body.innerHTML = `
      <div class="dialog">
        <div>${escapeHtml(message)}</div>
        ${input !== undefined ? '<input type="text">' : ''}
        <div class="actions">
          ${cancel ? '<button class="btn cancel">Cancelar</button>' : ''}
          <button class="btn ok">${escapeHtml(okText)}</button>
        </div>
      </div>`;
    const field = win.body.querySelector('input');
    const ok = () => {
      result = input !== undefined ? field.value : true;
      win.close();
    };
    win.body.querySelector('.ok').onclick = ok;
    win.body.querySelector('.cancel')?.addEventListener('click', () => win.close());
    win.body.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') ok();
      if (e.key === 'Escape') win.close();
    });
    if (field) {
      field.value = input;
      field.focus();
      const dot = input.lastIndexOf('.');
      field.setSelectionRange(0, dot > 0 ? dot : input.length);
    } else {
      win.body.querySelector('.ok').focus();
    }
  });
}

export const prompt = (title, message, value = '') => dialog({ title, message, input: value });
export const confirm = (title, message) => dialog({ title, message }).then(Boolean);
export const alert = (title, message) => dialog({ title, message, cancel: false });

// items: [{ label, action } | 'sep']
export function contextMenu(x, y, items) {
  const menu = document.getElementById('context-menu');
  menu.innerHTML = '';
  for (const item of items) {
    const div = document.createElement('div');
    if (item === 'sep') {
      div.className = 'ctx-sep';
    } else {
      div.className = 'ctx-item';
      div.textContent = item.label;
      div.onclick = () => {
        hideContextMenu();
        item.action();
      };
    }
    menu.appendChild(div);
  }
  menu.hidden = false;
  const { innerWidth, innerHeight } = window;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 4)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 4)}px`;
}

export function hideContextMenu() {
  document.getElementById('context-menu').hidden = true;
}

export async function reportError(fn) {
  try {
    return await fn();
  } catch (e) {
    await alert('Error', e.message);
  }
}

// Aviso pequeño en la esquina. Devuelve { done(texto, error) } para cerrarlo.
export function toast(text) {
  let box = document.getElementById('toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  box.appendChild(el);
  return {
    done(finalText = text, error = false) {
      el.textContent = finalText;
      el.classList.toggle('error', error);
      setTimeout(() => el.remove(), error ? 6000 : 2500);
    },
  };
}
