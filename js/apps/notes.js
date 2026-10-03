// Notas rápidas tipo post-it sobre el escritorio. Se guardan en el árbol del
// servidor (fs.setData), así que se ven igual desde cualquier navegador.
import * as fs from '../fs.js';
import { confirm } from '../ui.js';

const COLORS = { amarillo: '#fff3a0', rosa: '#ffc6d9', verde: '#c8f2c2', celeste: '#c4e3ff' };
const load = () => fs.getData('notes', []);
let pending = null; // cambios esperando a guardarse (mientras se escribe)
let timer = 0;

function save(notes, delay = 400) {
  pending = notes;
  clearTimeout(timer);
  timer = setTimeout(() => {
    fs.setData('notes', pending);
    pending = null;
  }, delay);
}

function update(id, change, delay) {
  const notes = pending || load();
  const note = notes.find((n) => n.id === id);
  if (!note) return;
  Object.assign(note, change);
  save(notes, delay);
}

function layer() {
  let el = document.getElementById('notes-layer');
  if (!el) {
    el = Object.assign(document.createElement('div'), { id: 'notes-layer' });
    document.getElementById('windows').before(el);
  }
  return el;
}

function createNoteEl(note) {
  const el = document.createElement('div');
  el.className = 'note';
  el.dataset.id = note.id;
  el.innerHTML = `
    <div class="note-bar">
      ${Object.entries(COLORS).map(([name, c]) => `<button class="note-color" data-color="${name}" title="${name}" style="background:${c}"></button>`).join('')}
      <span class="note-grip"></span>
      <button class="note-close" title="Borrar nota">✕</button>
    </div>
    <textarea placeholder="Escribe aquí…" spellcheck="true"></textarea>`;
  const area = el.querySelector('textarea');
  area.oninput = () => update(note.id, { text: area.value });
  el.querySelectorAll('.note-color').forEach((b) => (b.onclick = () => update(note.id, { color: b.dataset.color }, 0)));
  el.querySelector('.note-close').onclick = async () => {
    const current = (pending || load()).find((n) => n.id === note.id);
    if (current?.text.trim() && !(await confirm('Borrar nota', '¿Borrar esta nota? No va a la papelera.'))) return;
    save((pending || load()).filter((n) => n.id !== note.id), 0);
  };
  // Arrastrar desde la barra.
  el.querySelector('.note-bar').onpointerdown = (e) => {
    if (e.target.tagName === 'BUTTON') return;
    e.preventDefault();
    const start = [e.clientX - el.offsetLeft, e.clientY - el.offsetTop];
    const desk = document.getElementById('desktop');
    el.style.zIndex = 6;
    const move = (ev) => {
      el.style.left = `${Math.min(Math.max(0, ev.clientX - start[0]), desk.clientWidth - 60)}px`;
      el.style.top = `${Math.min(Math.max(0, ev.clientY - start[1]), desk.clientHeight - 30)}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      el.style.zIndex = '';
      update(note.id, { x: el.offsetLeft, y: el.offsetTop }, 0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  // Cambiar de tamaño con la esquina (resize de CSS).
  new ResizeObserver(() => {
    const current = (pending || load()).find((n) => n.id === note.id);
    if (current && (current.w !== el.offsetWidth || current.h !== el.offsetHeight)) update(note.id, { w: el.offsetWidth, h: el.offsetHeight });
  }).observe(el);
  return el;
}

// Pinta las notas; se llama al arrancar y cada vez que cambia el árbol (también
// cuando llegan cambios de otro navegador).
export function renderNotes() {
  const box = layer();
  const notes = pending || load();
  const ids = new Set(notes.map((n) => n.id));
  box.querySelectorAll('.note').forEach((el) => !ids.has(el.dataset.id) && el.remove());
  for (const note of notes) {
    const el = box.querySelector(`.note[data-id="${note.id}"]`) || box.appendChild(createNoteEl(note));
    Object.assign(el.style, { left: `${note.x}px`, top: `${note.y}px`, width: `${note.w}px`, height: `${note.h}px`, background: COLORS[note.color] || COLORS.amarillo });
    const area = el.querySelector('textarea');
    // No se pisa lo que se está escribiendo.
    if (document.activeElement !== area && area.value !== note.text) area.value = note.text;
  }
}

export function newNote() {
  const notes = pending || load();
  const offset = (notes.length % 6) * 24;
  const desk = document.getElementById('desktop');
  const note = { id: crypto.randomUUID(), x: Math.max(120, desk.clientWidth - 300) - offset, y: 40 + offset, w: 220, h: 200, color: 'amarillo', text: '' };
  save([...notes, note], 0);
  setTimeout(() => document.querySelector(`.note[data-id="${note.id}"] textarea`)?.focus(), 50);
}

export default {
  id: 'notes',
  name: 'Nota nueva',
  glyph: '🗒️',
  desktop: false,
  launch: newNote,
};
