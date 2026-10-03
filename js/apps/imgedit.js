// Editor de imágenes: rotar, voltear, recortar, cambiar tamaño y ajustar brillo,
// contraste y saturación. Trabaja sobre la imagen a resolución completa.
import * as fs from '../fs.js';
import * as storage from '../storage.js';
import { createWindow } from '../wm.js';
import { prompt, confirm, alert, toast, reportError } from '../ui.js';
import { makeThumb, uploadThumb } from '../thumbs.js';

const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

async function loadBitmap(path) {
  const remote = fs.getRemote(path);
  const res = await fetch(remote ? storage.url(remote.key) : fs.readFile(path));
  if (!res.ok) throw new Error(`No se pudo leer la imagen (${res.status})`);
  return createImageBitmap(await res.blob(), { imageOrientation: 'from-image' });
}

const copyCanvas = (src) => {
  const c = document.createElement('canvas');
  [c.width, c.height] = [src.width, src.height];
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
};

export default {
  id: 'imgedit',
  name: 'Editor de imágenes',
  glyph: '🎨',
  hidden: true,
  launch({ path } = {}) {
    if (!path) throw new Error('Abre una imagen desde el explorador (clic derecho → Editar imagen)');
    let current = fs.normalize(path);
    const win = createWindow({ title: `${fs.basename(current)} — Editor de imágenes`, width: 900, height: 620 });
    win.body.classList.add('imgedit');
    win.body.tabIndex = -1;
    win.body.innerHTML = `
      <div class="toolbar imgedit-tools">
        <button data-act="save" class="primary">💾 Guardar</button>
        <button data-act="saveas">Guardar copia</button>
        <span class="sep"></span>
        <button data-act="left" title="Rotar a la izquierda">⟲</button>
        <button data-act="right" title="Rotar a la derecha">⟳</button>
        <button data-act="flipx" title="Voltear horizontal">⇋</button>
        <button data-act="flipy" title="Voltear vertical">⇵</button>
        <button data-act="crop" title="Recortar: arrastra sobre la imagen">✂️ Recortar</button>
        <button data-act="resize">Tamaño…</button>
        <span class="sep"></span>
        <button data-act="undo" title="Deshacer (Ctrl+Z)">↶</button>
      </div>
      <div class="imgedit-body">
        <div class="imgedit-stage"><canvas></canvas><div class="imgedit-crop" hidden></div></div>
        <aside class="imgedit-adjust">
          <h3>Ajustes</h3>
          <label>Brillo <input type="range" name="brightness" min="0" max="200" value="100"></label>
          <label>Contraste <input type="range" name="contrast" min="0" max="200" value="100"></label>
          <label>Saturación <input type="range" name="saturate" min="0" max="200" value="100"></label>
          <div class="imgedit-adjust-actions"><button class="btn" data-act="resetadj">Restablecer</button><button class="btn primary" data-act="applyadj">Aplicar</button></div>
          <p class="imgedit-hint">Recortar: pulsa ✂️, arrastra sobre la imagen y pulsa ✂️ otra vez (Esc cancela).</p>
        </aside>
      </div>
      <div class="statusbar imgedit-status">Cargando…</div>`;
    const canvas = win.body.querySelector('canvas');
    const stage = win.body.querySelector('.imgedit-stage');
    const cropEl = win.body.querySelector('.imgedit-crop');
    const status = win.body.querySelector('.imgedit-status');
    const sliders = [...win.body.querySelectorAll('input[type="range"]')];
    let work = null; // canvas con la imagen actual a tamaño real
    let history = [];
    let dirty = false;
    let crop = null; // { x, y, w, h } en píxeles de la imagen

    const filterString = () => sliders.map((s) => `${s.name}(${s.value}%)`).join(' ');
    const adjusting = () => sliders.some((s) => s.value !== '100');

    function show() {
      canvas.width = work.width;
      canvas.height = work.height;
      canvas.getContext('2d').drawImage(work, 0, 0);
      canvas.style.filter = adjusting() ? filterString() : '';
      status.textContent = `${work.width} × ${work.height} px · ${current}${dirty ? ' · sin guardar' : ''}`;
      win.setTitle(`${dirty ? '● ' : ''}${fs.basename(current)} — Editor de imágenes`);
    }

    // Aplica una transformación: fn recibe el canvas actual y devuelve uno nuevo.
    function change(fn) {
      history.push(work);
      if (history.length > 15) history.shift();
      work = fn(work);
      dirty = true;
      show();
    }

    const transformed = (w, h, draw) => (src) => {
      const c = document.createElement('canvas');
      [c.width, c.height] = [w(src), h(src)];
      draw(c.getContext('2d'), src);
      return c;
    };

    const rotate = (deg) =>
      change(
        transformed(
          (s) => s.height,
          (s) => s.width,
          (ctx, s) => {
            ctx.translate(deg > 0 ? s.height : 0, deg > 0 ? 0 : s.width);
            ctx.rotate((deg * Math.PI) / 180);
            ctx.drawImage(s, 0, 0);
          },
        ),
      );
    const flip = (x) =>
      change(
        transformed(
          (s) => s.width,
          (s) => s.height,
          (ctx, s) => {
            ctx.translate(x ? s.width : 0, x ? 0 : s.height);
            ctx.scale(x ? -1 : 1, x ? 1 : -1);
            ctx.drawImage(s, 0, 0);
          },
        ),
      );

    // ---- Recorte ------------------------------------------------------------
    let cropping = false;
    const toImage = (e) => {
      const r = canvas.getBoundingClientRect();
      return [Math.round(((e.clientX - r.left) / r.width) * work.width), Math.round(((e.clientY - r.top) / r.height) * work.height)].map((v, i) =>
        Math.min(Math.max(0, v), i ? work.height : work.width),
      );
    };
    const drawCropBox = () => {
      if (!crop) return (cropEl.hidden = true);
      const r = canvas.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      const k = r.width / work.width;
      Object.assign(cropEl.style, { left: `${r.left - s.left + stage.scrollLeft + crop.x * k}px`, top: `${r.top - s.top + stage.scrollTop + crop.y * k}px`, width: `${crop.w * k}px`, height: `${crop.h * k}px` });
      cropEl.hidden = false;
    };
    const endCrop = () => {
      cropping = false;
      crop = null;
      cropEl.hidden = true;
      stage.classList.remove('cropping');
      win.body.querySelector('[data-act="crop"]').classList.remove('active');
    };
    canvas.onpointerdown = (e) => {
      if (!cropping) return;
      e.preventDefault();
      const [x0, y0] = toImage(e);
      canvas.setPointerCapture(e.pointerId);
      canvas.onpointermove = (ev) => {
        const [x1, y1] = toImage(ev);
        crop = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
        drawCropBox();
      };
      canvas.onpointerup = () => (canvas.onpointermove = canvas.onpointerup = null);
    };

    // ---- Guardar --------------------------------------------------------------
    async function save(asCopy) {
      const ext = fs.extname(current);
      let target = current;
      let type = TYPES[ext];
      if (asCopy || !type) {
        const dir = fs.dirname(current);
        const base = fs.basename(current).replace(/\.[^.]+$/, '');
        const name = await prompt('Guardar copia', type ? 'Nombre de la copia:' : 'Este formato se guarda como PNG. Nombre:', fs.uniqueName(dir, `${base} (editada).${type ? ext : 'png'}`));
        if (!name) return;
        target = fs.join(dir, name);
        type = TYPES[fs.extname(target)] || 'image/png';
        if (fs.exists(target) && !(await confirm('Reemplazar', `"${name}" ya existe. ¿Reemplazarlo?`))) return;
      }
      // Los ajustes que estén a la vista también se guardan.
      let out = work;
      if (adjusting()) {
        out = copyCanvas(work);
        const ctx = out.getContext('2d');
        ctx.filter = filterString();
        ctx.drawImage(work, 0, 0);
      }
      const note = toast('Guardando imagen…');
      try {
        const blob = await new Promise((r) => out.toBlob(r, type, 0.92));
        const remote = !asCopy && fs.getRemote(target);
        if (storage.enabled()) {
          const saved = remote ? { key: remote.key, size: blob.size, type } : await storage.upload(blob, fs.basename(target));
          if (remote) await storage.writeText(remote.key, blob, type);
          const thumb = await makeThumb(blob, target);
          saved.thumb = Boolean(thumb) && (await uploadThumb(saved.key, thumb));
          fs.writeRemote(target, saved);
        } else {
          fs.writeFile(target, await new Promise((r) => Object.assign(new FileReader(), { onload: (e) => r(e.target.result) }).readAsDataURL(blob)));
        }
        current = target;
        work = out;
        sliders.forEach((s) => (s.value = 100));
        history = [];
        dirty = false;
        show();
        note.done(`Guardada: ${fs.basename(target)}`);
      } catch (e) {
        note.done('No se pudo guardar la imagen', true);
        await alert('Error al guardar', e.message);
      }
    }

    const actions = {
      save: () => save(false),
      saveas: () => save(true),
      left: () => rotate(-90),
      right: () => rotate(90),
      flipx: () => flip(true),
      flipy: () => flip(false),
      crop: () => {
        if (!cropping) {
          cropping = true;
          stage.classList.add('cropping');
          win.body.querySelector('[data-act="crop"]').classList.add('active');
          return;
        }
        const c = crop;
        endCrop();
        if (c && c.w > 2 && c.h > 2) change(transformed(() => c.w, () => c.h, (ctx, s) => ctx.drawImage(s, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h)));
      },
      resize: async () => {
        const value = await prompt('Cambiar tamaño', `Ancho en píxeles (ahora ${work.width}; el alto se ajusta solo):`, String(work.width));
        const w = Math.round(Number(value));
        if (!w || w < 1 || w > 20000) return;
        const h = Math.max(1, Math.round((work.height * w) / work.width));
        change(
          transformed(
            () => w,
            () => h,
            (ctx, s) => {
              ctx.imageSmoothingQuality = 'high';
              ctx.drawImage(s, 0, 0, w, h);
            },
          ),
        );
      },
      undo: () => {
        if (!history.length) return;
        work = history.pop();
        dirty = true;
        show();
      },
      resetadj: () => {
        sliders.forEach((s) => (s.value = 100));
        show();
      },
      applyadj: () => {
        if (!adjusting()) return;
        const f = filterString();
        sliders.forEach((s) => (s.value = 100));
        change(
          transformed(
            (s) => s.width,
            (s) => s.height,
            (ctx, s) => {
              ctx.filter = f;
              ctx.drawImage(s, 0, 0);
            },
          ),
        );
      },
    };
    win.body.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => reportError(actions[b.dataset.act])));
    sliders.forEach((s) => (s.oninput = () => (canvas.style.filter = filterString())));
    win.body.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        actions.undo();
      }
      if (e.key === 'Escape' && cropping) endCrop();
    });
    win.beforeClose = async () => !(dirty || adjusting()) || confirm('Cambios sin guardar', '¿Cerrar sin guardar los cambios?');

    loadBitmap(current).then(
      (bitmap) => {
        work = copyCanvas(bitmap);
        bitmap.close();
        show();
        win.body.focus();
      },
      (e) => (status.textContent = `No se pudo abrir la imagen: ${e.message}`),
    );
    return win;
  },
};
