// Galería: abre una foto y deja pasar por todas las de su carpeta con las flechas,
// con zoom (rueda o + / −), arrastrar para moverse y pantalla completa.
import * as fs from '../fs.js';
import * as storage from '../storage.js';
import { createWindow } from '../wm.js';
import { thumbUrl } from '../thumbs.js';
import { formatSize } from '../ui.js';

const EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'avif'];

function srcOf(path) {
  const remote = fs.getRemote(path);
  if (remote) return storage.url(remote.key);
  const content = fs.readFile(path);
  // SVG guardado como texto.
  return content.startsWith('data:') ? content : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`;
}

export default {
  id: 'viewer',
  name: 'Fotos',
  glyph: '🖼️',
  extensions: EXTENSIONS,
  hidden: true,
  launch({ path } = {}) {
    const dir = fs.dirname(path);
    const photos = fs.readdir(dir).filter((e) => e.type === 'file' && EXTENSIONS.includes(fs.extname(e.name))).map((e) => e.path);
    let index = Math.max(0, photos.indexOf(fs.normalize(path)));

    const win = createWindow({ title: 'Fotos', width: 820, height: 600 });
    win.body.classList.add('gallery');
    win.body.tabIndex = -1;
    win.body.innerHTML = `
      <div class="gallery-stage">
        <img alt="" draggable="false">
        <button class="gallery-nav prev" title="Anterior (←)">‹</button>
        <button class="gallery-nav next" title="Siguiente (→)">›</button>
      </div>
      <div class="gallery-bar">
        <span class="gallery-info"></span>
        <button data-act="out" title="Alejar (−)">−</button>
        <button data-act="fit" title="Ajustar (0)">Ajustar</button>
        <button data-act="in" title="Acercar (+)">+</button>
        <button data-act="full" title="Pantalla completa (F)">⛶</button>
        <a class="gallery-dl" title="Descargar">⤓</a>
      </div>`;
    const stage = win.body.querySelector('.gallery-stage');
    const img = stage.querySelector('img');
    const info = win.body.querySelector('.gallery-info');
    const dl = win.body.querySelector('.gallery-dl');
    let zoom = 1;
    let pan = [0, 0];
    let preload = null;

    const apply = () => {
      img.style.transform = `translate(${pan[0]}px, ${pan[1]}px) scale(${zoom})`;
      stage.classList.toggle('zoomed', zoom > 1);
    };
    const fit = () => {
      zoom = 1;
      pan = [0, 0];
      apply();
    };

    function show(i) {
      if (!photos.length) return;
      index = (i + photos.length) % photos.length;
      const p = photos[index];
      const remote = fs.getRemote(p);
      fit();
      // La miniatura sale al instante mientras llega la foto entera.
      img.classList.add('loading');
      if (remote?.thumb) img.src = thumbUrl(remote.key);
      const full = new Image();
      full.onload = () => {
        if (photos[index] !== p) return;
        img.src = full.src;
        img.classList.remove('loading');
      };
      full.src = srcOf(p);
      win.setTitle(`${fs.basename(p)} — Fotos`);
      info.textContent = `${index + 1} de ${photos.length} · ${fs.basename(p)}${remote ? ` · ${formatSize(remote.size)}` : ''}`;
      dl.href = remote ? storage.url(remote.key, { download: fs.basename(p) }) : srcOf(p);
      dl.download = fs.basename(p);
      const multi = photos.length > 1;
      stage.querySelectorAll('.gallery-nav').forEach((b) => (b.hidden = !multi));
      // Deja pedida la siguiente para que pasar sea instantáneo.
      if (multi) {
        preload = new Image();
        preload.src = srcOf(photos[(index + 1) % photos.length]);
      }
    }

    const zoomBy = (factor, cx = stage.clientWidth / 2, cy = stage.clientHeight / 2) => {
      const next = Math.min(8, Math.max(1, zoom * factor));
      // Mantiene quieto el punto bajo el cursor.
      const ox = cx - stage.clientWidth / 2;
      const oy = cy - stage.clientHeight / 2;
      pan = [ox - ((ox - pan[0]) * next) / zoom, oy - ((oy - pan[1]) * next) / zoom];
      zoom = next;
      if (zoom === 1) pan = [0, 0];
      apply();
    };

    stage.querySelector('.prev').onclick = () => show(index - 1);
    stage.querySelector('.next').onclick = () => show(index + 1);
    const actions = {
      in: () => zoomBy(1.4),
      out: () => zoomBy(1 / 1.4),
      fit,
      full: () => (document.fullscreenElement ? document.exitFullscreen() : win.body.requestFullscreen?.()),
    };
    win.body.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => actions[b.dataset.act]()));

    stage.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = stage.getBoundingClientRect();
        zoomBy(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - r.left, e.clientY - r.top);
      },
      { passive: false },
    );
    img.ondblclick = () => (zoom > 1 ? fit() : zoomBy(2.5));
    stage.onpointerdown = (e) => {
      if (zoom === 1 || e.target.closest('button')) return;
      const start = [e.clientX - pan[0], e.clientY - pan[1]];
      stage.setPointerCapture(e.pointerId);
      stage.onpointermove = (ev) => {
        pan = [ev.clientX - start[0], ev.clientY - start[1]];
        apply();
      };
      stage.onpointerup = () => (stage.onpointermove = stage.onpointerup = null);
    };
    win.body.addEventListener('keydown', (e) => {
      const keys = { ArrowLeft: () => show(index - 1), ArrowRight: () => show(index + 1), '+': actions.in, '=': actions.in, '-': actions.out, 0: fit, f: actions.full, F: actions.full };
      if (keys[e.key]) {
        e.preventDefault();
        keys[e.key]();
      }
    });

    show(index);
    win.body.focus();
    return win;
  },
};
