// Calendario con eventos y recordatorios. Los eventos se guardan en el árbol del
// servidor (fs.setData), así que se ven desde cualquier navegador. Los avisos
// salen mientras MiPuter esté abierto en alguna pestaña.
import * as fs from '../fs.js';
import { createWindow } from '../wm.js';
import { toast, confirm } from '../ui.js';

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DAYS = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];
const REMINDERS = [
  ['', 'Sin aviso'],
  ['0', 'A la hora'],
  ['15', '15 min antes'],
  ['60', '1 hora antes'],
  ['1440', '1 día antes'],
];

const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const load = () => fs.getData('calendar', []);
const sortEvents = (list) => list.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));

// Momento en que hay que avisar (ms) o null. Sin hora, el evento es a las 9:00.
function remindAt(ev) {
  if (ev.remind === null || ev.remind === undefined || ev.remind === '') return null;
  const [y, m, d] = ev.date.split('-').map(Number);
  const [hh, mm] = (ev.time || '09:00').split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm).getTime() - Number(ev.remind) * 60_000;
}

// Avisos: cada navegador recuerda cuáles ya mostró, para no repetirlos.
const SHOWN_KEY = 'miputer.avisos';
function shown() {
  try {
    return new Set(JSON.parse(localStorage.getItem(SHOWN_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

export function checkReminders() {
  const done = shown();
  const now = Date.now();
  for (const ev of load()) {
    const at = remindAt(ev);
    // Solo avisos de las últimas 12 h: si la pestaña estuvo cerrada, no salen todos de golpe.
    if (at === null || at > now || now - at > 12 * 3600_000 || done.has(ev.id + at)) continue;
    done.add(ev.id + at);
    const text = `${ev.time ? `${ev.time} · ` : ''}${ev.title}`;
    toast(`📅 ${text}`).done(`📅 ${text}`, true);
    if ('Notification' in window && Notification.permission === 'granted') new Notification('MiPuter · Calendario', { body: text, tag: ev.id });
  }
  try {
    localStorage.setItem(SHOWN_KEY, JSON.stringify([...done].slice(-500)));
  } catch {}
}

export default {
  id: 'calendar',
  name: 'Calendario',
  glyph: '📅',
  launch({ date } = {}) {
    const win = createWindow({ title: 'Calendario', width: 760, height: 520, onClose: () => unsubscribe() });
    win.body.innerHTML = `
      <div class="cal">
        <div class="cal-month">
          <div class="cal-head">
            <button data-act="prev" title="Mes anterior">‹</button>
            <b class="cal-title"></b>
            <button data-act="next" title="Mes siguiente">›</button>
            <button data-act="today">Hoy</button>
          </div>
          <div class="cal-grid"></div>
        </div>
        <div class="cal-day">
          <h3 class="cal-day-title"></h3>
          <div class="cal-events"></div>
          <form class="cal-form">
            <input name="title" placeholder="Nuevo evento…" required maxlength="200">
            <div class="cal-form-row">
              <input name="time" type="time" title="Hora (opcional)">
              <select name="remind" title="Aviso">${REMINDERS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
              <button class="btn primary">Añadir</button>
            </div>
          </form>
        </div>
      </div>`;
    const grid = win.body.querySelector('.cal-grid');
    const form = win.body.querySelector('.cal-form');
    const today = new Date();
    let selected = date ? new Date(`${date}T00:00`) : new Date(today.getFullYear(), today.getMonth(), today.getDate());
    let month = new Date(selected.getFullYear(), selected.getMonth(), 1);

    function render() {
      const events = load();
      const byDay = events.reduce((m, ev) => m.set(ev.date, [...(m.get(ev.date) || []), ev]), new Map());
      win.body.querySelector('.cal-title').textContent = `${MONTHS[month.getMonth()]} ${month.getFullYear()}`;
      grid.innerHTML = DAYS.map((d) => `<div class="cal-dow">${d}</div>`).join('');
      // La semana empieza en lunes.
      const start = new Date(month);
      start.setDate(1 - ((month.getDay() + 6) % 7));
      for (let i = 0; i < 42; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        const key = isoDay(d);
        const cell = document.createElement('button');
        cell.className = 'cal-cell';
        cell.classList.toggle('other', d.getMonth() !== month.getMonth());
        cell.classList.toggle('today', key === isoDay(today));
        cell.classList.toggle('selected', key === isoDay(selected));
        const list = byDay.get(key) || [];
        cell.innerHTML = `<span class="cal-num">${d.getDate()}</span>${list
          .slice(0, 2)
          .map(() => '<i></i>')
          .join('')}${list.length > 2 ? '<small>+</small>' : ''}`;
        cell.title = list.map((ev) => `${ev.time ? `${ev.time} ` : ''}${ev.title}`).join('\n');
        cell.onclick = () => {
          selected = d;
          if (d.getMonth() !== month.getMonth()) month = new Date(d.getFullYear(), d.getMonth(), 1);
          render();
        };
        grid.appendChild(cell);
      }
      // Eventos del día elegido.
      const key = isoDay(selected);
      win.body.querySelector('.cal-day-title').textContent = selected.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
      const box = win.body.querySelector('.cal-events');
      const list = sortEvents(byDay.get(key) || []);
      box.innerHTML = list.length ? '' : '<p class="cal-empty">Sin eventos</p>';
      for (const ev of list) {
        const row = document.createElement('div');
        row.className = 'cal-event';
        row.innerHTML = '<span class="cal-time"></span><span class="cal-text"></span><button title="Borrar">✕</button>';
        row.querySelector('.cal-time').textContent = ev.time || 'Todo el día';
        row.querySelector('.cal-text').textContent = `${ev.title}${ev.remind !== null && ev.remind !== '' ? ' 🔔' : ''}`;
        row.querySelector('button').onclick = async () => {
          if (await confirm('Borrar evento', `¿Borrar "${ev.title}"?`)) fs.setData('calendar', load().filter((e) => e.id !== ev.id));
        };
        box.appendChild(row);
      }
    }

    form.onsubmit = async (e) => {
      e.preventDefault();
      const ev = { id: crypto.randomUUID(), date: isoDay(selected), time: form.time.value, title: form.title.value.trim(), remind: form.remind.value === '' ? null : Number(form.remind.value) };
      if (!ev.title) return;
      fs.setData('calendar', sortEvents([...load(), ev]));
      form.reset();
      // Para avisar aunque la pestaña esté en segundo plano, se piden notificaciones del sistema.
      if (ev.remind !== null && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    };
    win.body.querySelector('[data-act="prev"]').onclick = () => {
      month = new Date(month.getFullYear(), month.getMonth() - 1, 1);
      render();
    };
    win.body.querySelector('[data-act="next"]').onclick = () => {
      month = new Date(month.getFullYear(), month.getMonth() + 1, 1);
      render();
    };
    win.body.querySelector('[data-act="today"]').onclick = () => {
      selected = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      month = new Date(today.getFullYear(), today.getMonth(), 1);
      render();
    };

    const unsubscribe = fs.onChange(render);
    render();
    return win;
  },
};
