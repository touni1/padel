// Editor de PDF: ver, anotar (texto, resaltar, tapar, dibujar, firmar), rellenar
// formularios, rotar/mover/borrar páginas, unir PDFs y guardar.
//
// pdf.js (Mozilla) dibuja las páginas y pdf-lib escribe el PDF nuevo. Las
// anotaciones se guardan en coordenadas del PDF (puntos, sin rotar), así que
// siguen en su sitio al hacer zoom o rotar la página.
import * as fs from '../fs.js';
import * as storage from '../storage.js';
import { createWindow } from '../wm.js';
import { prompt, confirm, alert, toast, reportError } from '../ui.js';
import { loadLibs, readBytes, pdfjsOptions, pickFiles } from '../pdfkit.js';

const SIGNATURE_KEY = 'miputer.firma';

// pdf-lib minificado no conserva los nombres de clase: el tipo se averigua con instanceof.
function fieldKind(f, L) {
  if (f instanceof L.PDFTextField) return 'text';
  if (f instanceof L.PDFCheckBox) return 'check';
  if (f instanceof L.PDFDropdown || f instanceof L.PDFOptionList) return 'list';
  if (f instanceof L.PDFRadioGroup) return 'radio';
  return null;
}

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);

const pickPdf = async (exclude) => (await pickFiles({ title: 'Insertar PDF', exts: ['pdf'], exclude: [exclude] }))?.[0] || null;

// Panel para dibujar la firma. Devuelve un PNG recortado (dataURL) o null.
function signaturePad() {
  return new Promise((resolve) => {
    let result = null;
    const win = createWindow({ title: 'Tu firma', width: 460, height: 300, onClose: () => resolve(result) });
    win.body.innerHTML = `
      <div class="pdf-sign">
        <p>Firma con el ratón o el dedo:</p>
        <canvas width="420" height="160"></canvas>
        <div class="actions"><button class="btn" data-act="clear">Borrar</button><button class="btn primary" data-act="ok">Usar esta firma</button></div>
      </div>`;
    const canvas = win.body.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    ctx.lineWidth = 2.5;
    ctx.lineCap = ctx.lineJoin = 'round';
    let drawing = false;
    let empty = true;
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      return [((e.clientX - r.left) * canvas.width) / r.width, ((e.clientY - r.top) * canvas.height) / r.height];
    };
    canvas.onpointerdown = (e) => {
      drawing = true;
      empty = false;
      canvas.setPointerCapture(e.pointerId);
      ctx.beginPath();
      ctx.moveTo(...pos(e));
    };
    canvas.onpointermove = (e) => {
      if (!drawing) return;
      ctx.lineTo(...pos(e));
      ctx.stroke();
    };
    canvas.onpointerup = () => (drawing = false);
    win.body.querySelector('[data-act="clear"]').onclick = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      empty = true;
    };
    win.body.querySelector('[data-act="ok"]').onclick = () => {
      if (empty) return;
      // Recorta el margen vacío alrededor del trazo.
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let [x0, y0, x1, y1] = [width, height, 0, 0];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (data[(y * width + x) * 4 + 3]) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
        }
      }
      const out = document.createElement('canvas');
      out.width = x1 - x0 + 7;
      out.height = y1 - y0 + 7;
      out.getContext('2d').drawImage(canvas, x0 - 3, y0 - 3, out.width, out.height, 0, 0, out.width, out.height);
      result = { data: out.toDataURL('image/png'), ratio: out.height / out.width };
      try {
        localStorage.setItem(SIGNATURE_KEY, JSON.stringify(result));
      } catch {}
      win.close();
    };
  });
}

function savedSignature() {
  try {
    return JSON.parse(localStorage.getItem(SIGNATURE_KEY) || 'null');
  } catch {
    return null;
  }
}

export default {
  id: 'pdf',
  name: 'Editor de PDF',
  glyph: '📕',
  extensions: ['pdf'],
  hidden: true,
  launch({ path } = {}) {
    if (!path) throw new Error('Abre un PDF desde el explorador o el escritorio');
    const win = createWindow({ title: `${fs.basename(path)} — PDF`, width: 980, height: 680 });
    win.body.classList.add('pdf-app');
    win.body.innerHTML = `
      <div class="toolbar pdf-tools">
        <button data-act="save" class="primary" title="Guardar sobre el mismo archivo">💾 Guardar</button>
        <button data-act="saveas">Guardar copia</button>
        <span class="sep"></span>
        <button data-tool="select" title="Seleccionar y mover (Supr borra)">🖱️</button>
        <button data-tool="text" title="Texto">T</button>
        <button data-tool="highlight" title="Resaltar">🖍️</button>
        <button data-tool="whiteout" title="Tapar (rectángulo blanco)">⬜</button>
        <button data-tool="redact" title="Tachar: al guardar, el contenido debajo se borra de verdad (la página pasa a imagen)">⬛</button>
        <button data-tool="ink" title="Dibujar">✏️</button>
        <button data-tool="sign" title="Firma">✍️</button>
        <input type="color" value="#d0021b" title="Color">
        <select data-opt="size" title="Tamaño del texto / grosor">
          <option value="10">10</option><option value="12" selected>12</option><option value="16">16</option><option value="20">20</option><option value="28">28</option>
        </select>
        <button data-act="newsign" title="Dibujar otra firma">Nueva firma</button>
        <span class="sep"></span>
        <button data-act="undo" title="Deshacer (Ctrl+Z)">↶</button>
        <button data-act="zoomout" title="Alejar">−</button>
        <span class="pdf-zoom">100%</span>
        <button data-act="zoomin" title="Acercar">+</button>
        <button data-act="insert" title="Añadir las páginas de otro PDF al final">Insertar PDF</button>
        <button data-act="form" hidden>📋 Formulario</button>
        <button data-act="tab" title="Abrir en una pestaña (para imprimir)">↗</button>
      </div>
      <div class="pdf-body">
        <div class="pdf-pages"><p class="pdf-loading">Cargando…</p></div>
        <aside class="pdf-form" hidden></aside>
      </div>
      <div class="statusbar pdf-status"></div>`;

    const $ = (sel) => win.body.querySelector(sel);
    const pagesEl = $('.pdf-pages');
    const statusEl = $('.pdf-status');
    const formEl = $('.pdf-form');
    const colorEl = $('input[type="color"]');
    const sizeEl = $('[data-opt="size"]');

    let libs;
    let sources = []; // [{ name, bytes, pdf }]
    let pages = []; // [{ src, index, rot, annots: [] }]
    const proxies = new Map(); // "src:index" -> PDFPageProxy
    let fields = []; // campos del formulario del PDF original
    let formValues = {};
    let zoom = 1.25;
    let fitted = false;
    let tool = 'select';
    let selected = null; // { page, i }
    let history = [];
    let dirty = false;
    let current = fs.normalize(path);
    const views = []; // por página mostrada: { viewport, svg, rotation }

    const setStatus = (t) => (statusEl.textContent = t);
    const markDirty = () => {
      dirty = true;
      win.setTitle(`● ${fs.basename(current)} — PDF`);
    };
    const snapshot = () => {
      history.push(JSON.stringify({ pages, formValues }));
      if (history.length > 100) history.shift();
    };
    const setTool = (t) => {
      tool = t;
      selected = null;
      win.body.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
      pagesEl.dataset.tool = t;
      views.forEach((v, i) => v && drawOverlay(i));
    };

    async function proxy(p) {
      const k = `${p.src}:${p.index}`;
      if (!proxies.has(k)) proxies.set(k, await sources[p.src].pdf.getPage(p.index + 1));
      return proxies.get(k);
    }

    async function addSource(name, bytes) {
      // pdf.js se queda con el buffer: se le pasa una copia.
      const pdf = await libs.pdfjs.getDocument(pdfjsOptions(bytes.slice())).promise;
      sources.push({ name, bytes, pdf });
      return sources.length - 1;
    }

    async function open(bytes) {
      sources = [];
      proxies.clear();
      const src = await addSource(fs.basename(current), bytes);
      pages = Array.from({ length: sources[src].pdf.numPages }, (_, index) => ({ src, index, rot: 0, annots: [] }));
      history = [];
      formValues = {};
      dirty = false;
      win.setTitle(`${fs.basename(current)} — PDF`);
      // Campos de formulario (con pdf-lib, que es quien los rellena al guardar).
      try {
        const doc = await libs.PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
        fields = doc
          .getForm()
          .getFields()
          .map((f) => {
            const kind = fieldKind(f, libs.PDFLib);
            const field = { name: f.getName(), kind };
            if (kind === 'text') field.value = f.getText() || '';
            else if (kind === 'check') field.value = f.isChecked();
            else if (kind === 'list') [field.options, field.value] = [f.getOptions(), f.getSelected()[0] || ''];
            else if (kind === 'radio') [field.options, field.value] = [f.getOptions(), f.getSelected() || ''];
            return field;
          })
          .filter((f) => f.kind);
      } catch {
        fields = [];
      }
      $('[data-act="form"]').hidden = !fields.length;
      $('[data-act="form"]').textContent = `📋 Formulario (${fields.length})`;
      renderForm();
      // Al abrir, la primera página se ajusta al ancho de la ventana (sin pasar de 125 %).
      if (!fitted) {
        const first = (await proxy(pages[0])).getViewport({ scale: 1 });
        zoom = Math.max(0.4, Math.min(1.25, (pagesEl.clientWidth - 40) / first.width));
        fitted = true;
      }
      await renderAll();
    }

    // ---- Páginas ----------------------------------------------------------

    let renderToken = 0;
    async function renderAll() {
      const token = ++renderToken;
      const scrollTop = pagesEl.scrollTop;
      pagesEl.innerHTML = '';
      views.length = 0;
      const observer = new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) paint(Number(e.target.dataset.i), token), observer.unobserve(e.target);
      }, { root: pagesEl, rootMargin: '400px' });
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        const pg = await proxy(p);
        if (token !== renderToken) return;
        const rotation = (pg.rotate + p.rot) % 360;
        const viewport = pg.getViewport({ scale: zoom, rotation });
        const wrap = document.createElement('div');
        wrap.className = 'pdf-page';
        wrap.dataset.i = i;
        wrap.innerHTML = `
          <div class="pdf-page-bar">
            <span>Página ${i + 1} de ${pages.length}${p.src ? ` · de ${sources[p.src].name}` : ''}</span>
            <button data-p="left" title="Rotar a la izquierda">⟲</button>
            <button data-p="right" title="Rotar a la derecha">⟳</button>
            <button data-p="up" title="Subir"${i ? '' : ' disabled'}>↑</button>
            <button data-p="down" title="Bajar"${i < pages.length - 1 ? '' : ' disabled'}>↓</button>
            <button data-p="delete" title="Borrar página"${pages.length > 1 ? '' : ' disabled'}>🗑</button>
          </div>
          <div class="pdf-stage" style="width:${viewport.width}px;height:${viewport.height}px">
            <canvas></canvas>
            <svg width="${viewport.width}" height="${viewport.height}"></svg>
          </div>`;
        wrap.querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => pageAction(i, b.dataset.p)));
        pagesEl.appendChild(wrap);
        views[i] = { viewport, rotation, svg: wrap.querySelector('svg'), canvas: wrap.querySelector('canvas'), painted: false };
        wireStage(i);
        drawOverlay(i);
        observer.observe(wrap);
      }
      pagesEl.scrollTop = scrollTop;
      $('.pdf-zoom').textContent = `${Math.round(zoom * 100)}%`;
      setStatus(`${pages.length} página${pages.length === 1 ? '' : 's'} · ${current}${fs.getRemote(current) ? ' · ☁ B2' : ''}`);
    }

    async function paint(i, token) {
      const v = views[i];
      if (!v || v.painted || token !== renderToken) return;
      v.painted = true;
      const dpr = window.devicePixelRatio || 1;
      v.canvas.width = Math.floor(v.viewport.width * dpr);
      v.canvas.height = Math.floor(v.viewport.height * dpr);
      v.canvas.style.width = `${v.viewport.width}px`;
      v.canvas.style.height = `${v.viewport.height}px`;
      const pg = await proxy(pages[i]);
      await pg.render({ canvas: v.canvas, canvasContext: v.canvas.getContext('2d'), viewport: v.viewport, transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0] }).promise;
    }

    function pageAction(i, action) {
      snapshot();
      const p = pages[i];
      if (action === 'left') p.rot = (p.rot + 270) % 360;
      if (action === 'right') p.rot = (p.rot + 90) % 360;
      if (action === 'up') [pages[i - 1], pages[i]] = [pages[i], pages[i - 1]];
      if (action === 'down') [pages[i + 1], pages[i]] = [pages[i], pages[i + 1]];
      if (action === 'delete') pages.splice(i, 1);
      markDirty();
      renderAll();
    }

    // ---- Anotaciones --------------------------------------------------------

    const SVG = 'http://www.w3.org/2000/svg';
    const el = (tag, attrs) => {
      const n = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      return n;
    };

    function drawOverlay(i) {
      const v = views[i];
      if (!v) return;
      v.svg.innerHTML = '';
      const vp = v.viewport;
      pages[i].annots.forEach((a, j) => {
        let node;
        const delta = (v.rotation - (a.rot || 0) + 360) % 360;
        if (a.type === 'text') {
          const [x, y] = vp.convertToViewportPoint(a.x, a.y);
          node = el('text', { x, y, 'font-size': a.size * zoom, fill: a.color, 'font-family': 'Helvetica, Arial, sans-serif', transform: `rotate(${delta} ${x} ${y})` });
          node.textContent = a.text;
        } else if (a.type === 'image') {
          const [x, y] = vp.convertToViewportPoint(a.x, a.y);
          node = el('image', { href: a.data, x, y: y - a.h * zoom, width: a.w * zoom, height: a.h * zoom, transform: `rotate(${delta} ${x} ${y})` });
        } else if (a.type === 'rect') {
          const [x1, y1] = vp.convertToViewportPoint(a.x1, a.y1);
          const [x2, y2] = vp.convertToViewportPoint(a.x2, a.y2);
          node = el('rect', { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), fill: a.color, 'fill-opacity': a.opacity });
          if (a.opacity < 1) node.style.mixBlendMode = 'multiply';
        } else if (a.type === 'ink') {
          node = el('polyline', { points: a.points.map((pt) => vp.convertToViewportPoint(...pt).join(',')).join(' '), fill: 'none', stroke: a.color, 'stroke-width': a.width * zoom, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
        }
        node.dataset.j = j;
        if (selected?.page === i && selected.i === j) node.classList.add('pdf-selected');
        v.svg.appendChild(node);
      });
    }

    const moveAnnot = (a, dx, dy) => {
      if ('x' in a) [a.x, a.y] = [a.x + dx, a.y + dy];
      if ('x1' in a) [a.x1, a.y1, a.x2, a.y2] = [a.x1 + dx, a.y1 + dy, a.x2 + dx, a.y2 + dy];
      if (a.points) a.points = a.points.map(([x, y]) => [x + dx, y + dy]);
    };

    function wireStage(i) {
      const v = views[i];
      const svg = v.svg;
      const local = (e) => {
        const r = svg.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
      };
      const toPdf = (pt) => v.viewport.convertToPdfPoint(...pt);

      svg.onpointerdown = async (e) => {
        if (e.button !== 0) return;
        const start = local(e);
        const annots = pages[i].annots;

        if (tool === 'select') {
          const j = e.target.dataset?.j;
          selected = j === undefined ? null : { page: i, i: Number(j) };
          views.forEach((_, k) => drawOverlay(k));
          if (!selected) return;
          snapshot();
          let last = toPdf(start);
          let moved = false;
          svg.setPointerCapture(e.pointerId);
          svg.onpointermove = (ev) => {
            const now = toPdf(local(ev));
            moveAnnot(annots[selected.i], now[0] - last[0], now[1] - last[1]);
            last = now;
            moved = true;
            drawOverlay(i);
          };
          svg.onpointerup = () => {
            svg.onpointermove = svg.onpointerup = null;
            if (moved) markDirty();
            else history.pop();
          };
          return;
        }

        if (tool === 'text') {
          const text = await prompt('Texto', 'Escribe el texto:', '');
          if (!text) return;
          snapshot();
          const size = Number(sizeEl.value);
          const [x, y] = toPdf([start[0], start[1] + size * zoom * 0.8]);
          annots.push({ type: 'text', x, y, text, size, color: colorEl.value, rot: v.rotation });
          markDirty();
          return drawOverlay(i);
        }

        if (tool === 'sign') {
          const sig = savedSignature() || (await signaturePad());
          if (!sig) return;
          snapshot();
          const w = 160;
          const h = w * sig.ratio;
          const [x, y] = toPdf([start[0], start[1] + h * zoom]);
          annots.push({ type: 'image', x, y, w, h, data: sig.data, rot: v.rotation });
          markDirty();
          return drawOverlay(i);
        }

        // Resaltar, tapar y dibujar se hacen arrastrando.
        snapshot();
        svg.setPointerCapture(e.pointerId);
        let a;
        if (tool === 'ink') {
          a = { type: 'ink', points: [toPdf(start)], color: colorEl.value, width: Math.max(1, Number(sizeEl.value) / 6) };
        } else {
          const [x, y] = toPdf(start);
          a =
            tool === 'highlight'
              ? { type: 'rect', x1: x, y1: y, x2: x, y2: y, color: '#ffe14d', opacity: 0.45 }
              : { type: 'rect', x1: x, y1: y, x2: x, y2: y, color: tool === 'redact' ? '#000000' : '#ffffff', opacity: 1, redact: tool === 'redact' };
        }
        annots.push(a);
        svg.onpointermove = (ev) => {
          const pt = toPdf(local(ev));
          if (a.points) a.points.push(pt);
          else [a.x2, a.y2] = pt;
          drawOverlay(i);
        };
        svg.onpointerup = () => {
          svg.onpointermove = svg.onpointerup = null;
          const tiny = a.points ? a.points.length < 2 : Math.abs(a.x2 - a.x1) < 2 || Math.abs(a.y2 - a.y1) < 2;
          if (tiny) {
            annots.pop();
            history.pop();
          } else markDirty();
          drawOverlay(i);
        };
      };
    }

    // ---- Formulario -----------------------------------------------------------

    function renderForm() {
      formEl.innerHTML = '<h3>Formulario</h3>';
      for (const f of fields) {
        const row = document.createElement('label');
        row.className = 'pdf-field';
        const value = f.name in formValues ? formValues[f.name] : f.value;
        let input;
        if (f.kind === 'check') {
          input = Object.assign(document.createElement('input'), { type: 'checkbox', checked: value });
        } else if (f.options) {
          input = document.createElement('select');
          for (const o of ['', ...f.options]) input.add(new Option(o || '—', o));
          input.value = value;
        } else {
          input = Object.assign(document.createElement('input'), { type: 'text', value });
        }
        input.onchange = () => {
          snapshot();
          formValues[f.name] = input.type === 'checkbox' ? input.checked : input.value;
          markDirty();
        };
        row.append(Object.assign(document.createElement('span'), { textContent: f.name }), input);
        formEl.appendChild(row);
      }
    }

    // ---- Guardar ----------------------------------------------------------------

    async function build() {
      const { PDFDocument, StandardFonts, rgb, degrees, BlendMode } = libs.PDFLib;
      const docs = await Promise.all(sources.map((s) => PDFDocument.load(s.bytes, { ignoreEncryption: true })));
      const form = docs[0].getForm();
      for (const [name, value] of Object.entries(formValues)) {
        try {
          const f = form.getField(name);
          const kind = fieldKind(f, libs.PDFLib);
          if (kind === 'text') f.setText(value);
          else if (kind === 'check') value ? f.check() : f.uncheck();
          else if (kind && value) f.select(value);
        } catch (e) {
          console.warn('Campo no aplicado', name, e);
        }
      }
      // Si cambian las páginas (orden, borradas, de otro PDF) se arma un PDF nuevo
      // y los formularios se "aplanan" para no perder lo rellenado.
      // Tachar borra de verdad: esas páginas se rehacen como imagen, así que también se arma un PDF nuevo.
      const redacted = pages.map((p) => p.annots.some((a) => a.redact));
      const structural = redacted.some(Boolean) || pages.length !== sources[0].pdf.numPages || pages.some((p, i) => p.src !== 0 || p.index !== i);
      let out;
      let outPages;
      if (!structural) {
        out = docs[0];
        outPages = out.getPages();
      } else {
        for (const d of docs) {
          try {
            d.getForm().flatten();
          } catch {}
        }
        out = await PDFDocument.create();
        outPages = [];
        for (const [i, p] of pages.entries()) {
          if (redacted[i]) {
            outPages.push(await rasterize(out, p));
            continue;
          }
          const [copy] = await out.copyPages(docs[p.src], [p.index]);
          outPages.push(out.addPage(copy));
        }
      }
      const font = await out.embedFont(StandardFonts.Helvetica);
      const images = new Map();
      // Helvetica solo tiene el alfabeto latino (WinAnsi): lo demás se sustituye.
      const safe = (s) =>
        [...s]
          .map((ch) => {
            try {
              font.encodeText(ch);
              return ch;
            } catch {
              return '?';
            }
          })
          .join('');
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        const page = outPages[i];
        if (p.rot) page.setRotation(degrees((page.getRotation().angle + p.rot) % 360));
        for (const a of p.annots) {
          const color = a.color ? rgb(...hex(a.color)) : undefined;
          if (a.type === 'text') {
            page.drawText(safe(a.text), { x: a.x, y: a.y, size: a.size, font, color, rotate: degrees(a.rot || 0) });
          } else if (a.type === 'image') {
            if (!images.has(a.data)) images.set(a.data, await out.embedPng(a.data));
            page.drawImage(images.get(a.data), { x: a.x, y: a.y, width: a.w, height: a.h, rotate: degrees(a.rot || 0) });
          } else if (a.type === 'rect') {
            page.drawRectangle({
              x: Math.min(a.x1, a.x2),
              y: Math.min(a.y1, a.y2),
              width: Math.abs(a.x2 - a.x1),
              height: Math.abs(a.y2 - a.y1),
              color,
              opacity: a.opacity,
              blendMode: a.opacity < 1 ? BlendMode.Multiply : undefined,
            });
          } else if (a.type === 'ink') {
            for (let k = 1; k < a.points.length; k++) {
              const [[x1, y1], [x2, y2]] = [a.points[k - 1], a.points[k]];
              page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: a.width, color, lineCap: 1 });
            }
          }
        }
      }
      return out.save();
    }

    // Rehace una página como imagen (150 ppp) con los recuadros de "tachar" ya pintados:
    // el texto y las imágenes que había debajo dejan de existir en el archivo.
    async function rasterize(out, p) {
      const pg = await proxy(p);
      const viewport = pg.getViewport({ scale: 150 / 72, rotation: 0 });
      const canvas = Object.assign(document.createElement('canvas'), { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height) });
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await pg.render({ canvas, canvasContext: ctx, viewport }).promise;
      ctx.fillStyle = '#000';
      for (const a of p.annots.filter((x) => x.redact)) {
        const [x1, y1] = viewport.convertToViewportPoint(a.x1, a.y1);
        const [x2, y2] = viewport.convertToViewportPoint(a.x2, a.y2);
        ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      }
      const jpg = await out.embedJpg(await (await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92))).arrayBuffer());
      const [vx0, vy0, vx1, vy1] = pg.view;
      const page = out.addPage([vx1 - vx0, vy1 - vy0]);
      page.setMediaBox(vx0, vy0, vx1 - vx0, vy1 - vy0);
      page.drawImage(jpg, { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 });
      page.setRotation(libs.PDFLib.degrees(pg.rotate));
      return page;
    }

    async function save(asCopy) {
      let target = current;
      if (asCopy) {
        const dir = fs.dirname(current);
        const base = fs.basename(current).replace(/\.pdf$/i, '');
        const name = await prompt('Guardar copia', 'Nombre de la copia:', fs.uniqueName(dir, `${base} (editado).pdf`));
        if (!name) return;
        target = fs.join(dir, name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`);
        if (fs.exists(target) && !(await confirm('Reemplazar', `"${fs.basename(target)}" ya existe. ¿Reemplazarlo?`))) return;
      }
      const note = toast('Guardando PDF…');
      try {
        const bytes = await build();
        const blob = new Blob([bytes], { type: 'application/pdf' });
        const remote = !asCopy && fs.getRemote(target);
        if (remote) {
          await storage.writeText(remote.key, blob, 'application/pdf');
          fs.writeRemote(target, { key: remote.key, size: bytes.length, type: 'application/pdf' });
        } else if (storage.enabled()) {
          fs.writeRemote(target, await storage.upload(blob, fs.basename(target)));
        } else {
          const data = await new Promise((r) => {
            const reader = new FileReader();
            reader.onload = () => r(reader.result);
            reader.readAsDataURL(blob);
          });
          fs.writeFile(target, data);
        }
        current = target;
        await open(bytes);
        note.done(`Guardado: ${fs.basename(target)}`);
      } catch (e) {
        note.done('No se pudo guardar el PDF', true);
        await alert('Error al guardar', e.message);
      }
    }

    // ---- Barra de herramientas -------------------------------------------------

    win.body.querySelectorAll('[data-tool]').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
    const actions = {
      save: () => save(false),
      saveas: () => save(true),
      undo: () => {
        if (!history.length) return;
        ({ pages, formValues } = JSON.parse(history.pop()));
        selected = null;
        markDirty();
        renderForm();
        renderAll();
      },
      zoomin: () => {
        zoom = Math.min(4, zoom * 1.2);
        renderAll();
      },
      zoomout: () => {
        zoom = Math.max(0.4, zoom / 1.2);
        renderAll();
      },
      newsign: async () => {
        if (await signaturePad()) setTool('sign');
      },
      insert: async () => {
        const other = await pickPdf(current);
        if (!other) return;
        setStatus(`Cargando ${other}…`);
        const src = await addSource(fs.basename(other), await readBytes(other));
        snapshot();
        for (let index = 0; index < sources[src].pdf.numPages; index++) pages.push({ src, index, rot: 0, annots: [] });
        markDirty();
        await renderAll();
        pagesEl.scrollTop = pagesEl.scrollHeight;
      },
      form: () => (formEl.hidden = !formEl.hidden),
      tab: () => {
        const remote = fs.getRemote(current);
        window.open(remote ? storage.url(remote.key) : fs.readFile(current), '_blank', 'noopener');
      },
    };
    win.body.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => reportError(actions[b.dataset.act])));

    win.body.addEventListener('keydown', (e) => {
      if (e.target.matches('input, select, textarea')) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        actions.undo();
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        snapshot();
        pages[selected.page].annots.splice(selected.i, 1);
        const pg = selected.page;
        selected = null;
        markDirty();
        drawOverlay(pg);
      }
    });
    win.body.tabIndex = -1;
    win.beforeClose = async () => !dirty || confirm('Cambios sin guardar', '¿Cerrar el PDF sin guardar los cambios?');

    setTool('select');
    (async () => {
      try {
        libs = await loadLibs();
        await open(await readBytes(current));
      } catch (e) {
        pagesEl.innerHTML = '';
        pagesEl.append(Object.assign(document.createElement('p'), { className: 'pdf-loading', textContent: `No se pudo abrir el PDF: ${e.message}` }));
      }
    })();
    return win;
  },
};
