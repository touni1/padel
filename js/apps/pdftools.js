// Herramientas PDF al estilo iLovePDF. Casi todo se hace en el navegador con
// pdf-lib y pdf.js; comprimir, proteger, quitar contraseña y reparar las hace el
// servidor (Ghostscript y qpdf). Los resultados se guardan junto al original.
import * as fs from '../fs.js';
import { createWindow } from '../wm.js';
import { escapeHtml, formatSize, toast } from '../ui.js';
import { launch } from '../registry.js';
import { loadLibs, readBytes, pdfjsOptions, pickFiles, saveOutput, parseRanges } from '../pdfkit.js';

const IMAGES = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'];
const base = (p) => fs.basename(p).replace(/\.[^.]+$/, '');
const MM = 72 / 25.4;

// Campos de formulario: [nombre, etiqueta, tipo, valor por defecto, opciones]
const TOOLS = [
  { id: 'merge', icon: '🧩', name: 'Unir PDF', desc: 'Junta varios PDF en uno, en el orden que elijas', input: { exts: ['pdf'], multiple: true } },
  { id: 'split', icon: '✂️', name: 'Dividir PDF', desc: 'Una página por archivo o por rangos', input: { exts: ['pdf'] }, fields: [['mode', 'Cómo dividir', 'select', 'each', [['each', 'Cada página en un archivo'], ['ranges', 'Por rangos']]], ['ranges', 'Rangos (si elegiste rangos)', 'text', '1-3, 4-6']] },
  { id: 'extract', icon: '📑', name: 'Extraer páginas', desc: 'Saca algunas páginas a un PDF nuevo', input: { exts: ['pdf'] }, fields: [['pages', 'Páginas', 'text', '1, 3-5']] },
  { id: 'remove', icon: '🗑️', name: 'Quitar páginas', desc: 'Borra páginas de un PDF', input: { exts: ['pdf'] }, fields: [['pages', 'Páginas a quitar', 'text', '2']] },
  { id: 'rotate', icon: '🔄', name: 'Rotar PDF', desc: 'Gira todas o algunas páginas', input: { exts: ['pdf'] }, fields: [['angle', 'Ángulo', 'select', '90', [['90', '90° a la derecha'], ['180', '180°'], ['270', '90° a la izquierda']]], ['pages', 'Páginas (vacío = todas)', 'text', '']] },
  { id: 'number', icon: '🔢', name: 'Numerar páginas', desc: 'Agrega el número de página', input: { exts: ['pdf'] }, fields: [['pos', 'Posición', 'select', 'bc', [['bc', 'Abajo al centro'], ['br', 'Abajo a la derecha'], ['bl', 'Abajo a la izquierda'], ['tr', 'Arriba a la derecha']]], ['format', 'Formato', 'select', 'n', [['n', '1'], ['nofm', 'Página 1 de 10']]], ['start', 'Empezar en', 'number', '1'], ['size', 'Tamaño de letra', 'number', '11']] },
  { id: 'watermark', icon: '💧', name: 'Marca de agua', desc: 'Texto en diagonal sobre cada página', input: { exts: ['pdf'] }, fields: [['text', 'Texto', 'text', 'CONFIDENCIAL'], ['size', 'Tamaño', 'number', '60'], ['opacity', 'Opacidad (%)', 'number', '20'], ['color', 'Color', 'color', '#d0021b']] },
  { id: 'crop', icon: '📐', name: 'Recortar márgenes', desc: 'Recorta el mismo margen en todas las páginas', input: { exts: ['pdf'] }, fields: [['mm', 'Margen a recortar (mm)', 'number', '10']] },
  { id: 'tojpg', icon: '🖼️', name: 'PDF a JPG', desc: 'Cada página como una imagen', input: { exts: ['pdf'] }, fields: [['pages', 'Páginas (vacío = todas)', 'text', ''], ['dpi', 'Calidad', 'select', '150', [['100', 'Normal (100 ppp)'], ['150', 'Buena (150 ppp)'], ['300', 'Alta (300 ppp)']]]] },
  { id: 'fromimg', icon: '📷', name: 'JPG a PDF', desc: 'Junta fotos o imágenes en un PDF', input: { exts: IMAGES, multiple: true }, fields: [['page', 'Tamaño de página', 'select', 'image', [['image', 'Igual que cada imagen'], ['a4', 'A4 (con margen)']]]] },
  { id: 'compress', icon: '🗜️', name: 'Comprimir PDF', desc: 'Achica el PDF reduciendo las imágenes', input: { exts: ['pdf'] }, server: true, fields: [['level', 'Compresión', 'select', 'media', [['baja', 'Baja (máxima calidad)'], ['media', 'Recomendada'], ['alta', 'Alta (menor tamaño)']]]] },
  { id: 'protect', icon: '🔒', name: 'Proteger PDF', desc: 'Pide contraseña para abrirlo (AES-256)', input: { exts: ['pdf'] }, server: true, fields: [['password', 'Contraseña', 'password', ''], ['repeat', 'Repite la contraseña', 'password', '']] },
  { id: 'unlock', icon: '🔓', name: 'Desbloquear PDF', desc: 'Quita la contraseña o las restricciones (hay que saberla)', input: { exts: ['pdf'] }, server: true, fields: [['password', 'Contraseña (vacío si solo tiene restricciones)', 'password', '']] },
  { id: 'repair', icon: '🩹', name: 'Reparar PDF', desc: 'Intenta recuperar un PDF dañado', input: { exts: ['pdf'] }, server: true },
  { id: 'edit', icon: '✏️', name: 'Editar, firmar y tachar', desc: 'Texto, firma, resaltar, tachar datos, formularios y organizar páginas', input: { exts: ['pdf'] }, editor: true },
];

// ---- Operaciones en el navegador ----------------------------------------------

async function runLocal(tool, files, opt, note) {
  const { PDFLib, pdfjs } = await loadLibs();
  const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;
  const dir = fs.dirname(files[0]);
  const load = async (p) => PDFDocument.load(await readBytes(p), { ignoreEncryption: true });
  const copyOf = async (src, indices) => {
    const out = await PDFDocument.create();
    for (const page of await out.copyPages(src, indices)) out.addPage(page);
    return out.save();
  };
  const save = (name, bytes) => saveOutput(dir, name, bytes, 'application/pdf');

  switch (tool.id) {
    case 'merge': {
      const out = await PDFDocument.create();
      for (const [i, p] of files.entries()) {
        note.update(`Uniendo ${i + 1} de ${files.length}…`);
        const src = await load(p);
        for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
      }
      return [await save(`${base(files[0])} (unido).pdf`, await out.save())];
    }
    case 'split': {
      const src = await load(files[0]);
      const n = src.getPageCount();
      const groups = opt.mode === 'ranges' ? parseRanges(opt.ranges, n) : src.getPageIndices().map((i) => [i]);
      const folder = fs.join(dir, fs.uniqueName(dir, `${base(files[0])} (dividido)`));
      fs.ensureDir(folder); // se crea ya, para que otra conversión en paralelo no elija la misma
      const out = [];
      for (const [k, g] of groups.entries()) {
        note.update(`Dividiendo: ${k + 1} de ${groups.length}…`);
        const label = g.length === 1 ? `${g[0] + 1}` : `${g[0] + 1}-${g.at(-1) + 1}`;
        out.push(await saveOutput(folder, `${base(files[0])} - págs ${label}.pdf`, await copyOf(src, g), 'application/pdf'));
      }
      return out;
    }
    case 'extract':
    case 'remove': {
      const src = await load(files[0]);
      const picked = new Set(parseRanges(opt.pages, src.getPageCount()).flat());
      const keep = src.getPageIndices().filter((i) => (tool.id === 'extract' ? picked.has(i) : !picked.has(i)));
      if (!keep.length) throw new Error('No quedaría ninguna página');
      return [await save(`${base(files[0])} (${tool.id === 'extract' ? 'extracto' : 'sin páginas'}).pdf`, await copyOf(src, keep))];
    }
    case 'rotate': {
      const doc = await load(files[0]);
      const which = opt.pages.trim() ? new Set(parseRanges(opt.pages, doc.getPageCount()).flat()) : null;
      doc.getPages().forEach((p, i) => (!which || which.has(i)) && p.setRotation(degrees((p.getRotation().angle + Number(opt.angle)) % 360)));
      return [await save(`${base(files[0])} (rotado).pdf`, await doc.save())];
    }
    case 'number': {
      const doc = await load(files[0]);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const pages = doc.getPages();
      const size = Math.max(6, Number(opt.size) || 11);
      pages.forEach((page, i) => {
        const n = (Number(opt.start) || 1) + i;
        const text = opt.format === 'nofm' ? `Página ${n} de ${pages.length + (Number(opt.start) || 1) - 1}` : String(n);
        const { x, y, width, height } = page.getCropBox();
        const w = font.widthOfTextAtSize(text, size);
        const m = 28;
        const px = { bc: x + (width - w) / 2, br: x + width - m - w, bl: x + m, tr: x + width - m - w }[opt.pos];
        const py = opt.pos === 'tr' ? y + height - m : y + m - size / 2;
        page.drawText(text, { x: px, y: py, size, font, color: rgb(0.2, 0.2, 0.2) });
      });
      return [await save(`${base(files[0])} (numerado).pdf`, await doc.save())];
    }
    case 'watermark': {
      const doc = await load(files[0]);
      const font = await doc.embedFont(StandardFonts.HelveticaBold);
      const size = Math.max(8, Number(opt.size) || 60);
      const [r, g, b] = [1, 3, 5].map((k) => parseInt(opt.color.slice(k, k + 2), 16) / 255);
      const text = [...opt.text].map((ch) => { try { font.encodeText(ch); return ch; } catch { return '?'; } }).join('');
      if (!text.trim()) throw new Error('Escribe el texto de la marca');
      for (const page of doc.getPages()) {
        const { x, y, width, height } = page.getCropBox();
        const w = font.widthOfTextAtSize(text, size);
        const a = Math.PI / 4;
        // Centro de la página, en diagonal.
        const cx = x + width / 2 - (Math.cos(a) * w) / 2 + (Math.sin(a) * size) / 3;
        const cy = y + height / 2 - (Math.sin(a) * w) / 2 - (Math.cos(a) * size) / 3;
        page.drawText(text, { x: cx, y: cy, size, font, color: rgb(r, g, b), opacity: Math.min(1, Math.max(0.05, Number(opt.opacity) / 100)), rotate: degrees(45) });
      }
      return [await save(`${base(files[0])} (marca de agua).pdf`, await doc.save())];
    }
    case 'crop': {
      const doc = await load(files[0]);
      const m = Math.max(0, Number(opt.mm) || 0) * MM;
      for (const page of doc.getPages()) {
        const { x, y, width, height } = page.getCropBox();
        if (width <= 2 * m + 20 || height <= 2 * m + 20) throw new Error('El margen es demasiado grande para estas páginas');
        page.setCropBox(x + m, y + m, width - 2 * m, height - 2 * m);
      }
      return [await save(`${base(files[0])} (recortado).pdf`, await doc.save())];
    }
    case 'tojpg': {
      const pdf = await pdfjs.getDocument(pdfjsOptions(await readBytes(files[0]))).promise;
      const indices = opt.pages.trim() ? parseRanges(opt.pages, pdf.numPages).flat() : [...Array(pdf.numPages).keys()];
      const folder = fs.join(dir, fs.uniqueName(dir, `${base(files[0])} (imágenes)`));
      fs.ensureDir(folder); // se crea ya, para que otra conversión en paralelo no elija la misma
      const out = [];
      for (const [k, i] of indices.entries()) {
        note.update(`Convirtiendo página ${k + 1} de ${indices.length}…`);
        const page = await pdf.getPage(i + 1);
        const viewport = page.getViewport({ scale: Number(opt.dpi) / 72 });
        const canvas = Object.assign(document.createElement('canvas'), { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height) });
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas, canvasContext: ctx, viewport }).promise;
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
        out.push(await saveOutput(folder, `${base(files[0])} - pág ${String(i + 1).padStart(String(pdf.numPages).length, '0')}.jpg`, blob, 'image/jpeg'));
      }
      return out;
    }
    case 'fromimg': {
      const doc = await PDFDocument.create();
      for (const [k, p] of files.entries()) {
        note.update(`Añadiendo imagen ${k + 1} de ${files.length}…`);
        // Todo pasa por un canvas: así sirven también webp, gif o bmp, y la foto queda derecha.
        const bitmap = await createImageBitmap(new Blob([await readBytes(p)]), { imageOrientation: 'from-image' });
        const canvas = Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const img = await doc.embedJpg(await (await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92))).arrayBuffer());
        if (opt.page === 'a4') {
          const [W, H] = img.width > img.height ? [842, 595] : [595, 842];
          const s = Math.min((W - 40) / img.width, (H - 40) / img.height, 1);
          doc.addPage([W, H]).drawImage(img, { x: (W - img.width * s) / 2, y: (H - img.height * s) / 2, width: img.width * s, height: img.height * s });
        } else {
          // 1 px de la imagen = 1 punto de PDF a 96 ppp.
          const s = 72 / 96;
          doc.addPage([img.width * s, img.height * s]).drawImage(img, { x: 0, y: 0, width: img.width * s, height: img.height * s });
        }
      }
      return [await save(`${base(files[0])}${files.length > 1 ? ' y más' : ''}.pdf`, await doc.save())];
    }
  }
  throw new Error('Herramienta desconocida');
}

// ---- Operaciones en el servidor --------------------------------------------------

async function runServer(tool, files, opt, note) {
  const remote = fs.getRemote(files[0]);
  if (!remote) throw new Error('Este PDF está solo en el navegador: súbelo a B2 para usar esta herramienta');
  if (tool.id === 'protect' && (opt.password.length < 4 || opt.password !== opt.repeat)) {
    throw new Error(opt.password !== opt.repeat ? 'Las contraseñas no coinciden' : 'Usa una contraseña de al menos 4 caracteres');
  }
  const suffix = { compress: 'comprimido', protect: 'protegido', unlock: 'desbloqueado', repair: 'reparado' }[tool.id];
  const name = `${base(files[0])} (${suffix}).pdf`;
  const res = await fetch('api/pdf', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: tool.id, key: remote.key, name, level: opt.level, password: opt.password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const job = await (await fetch(`api/jobs?id=${data.job}`)).json();
    if (job.state === 'error') throw new Error(job.error);
    if (job.state === 'done') {
      if (job.result.unchanged) throw new Error(`Este PDF ya está optimizado: comprimirlo no lo achica (${formatSize(job.result.size)})`);
      const dir = fs.dirname(files[0]);
      const path = fs.join(dir, fs.uniqueName(dir, name));
      fs.writeRemote(path, job.result);
      if (job.result.before) note.update(`${formatSize(job.result.before)} → ${formatSize(job.result.size)}`);
      return [path];
    }
    note.update(`${tool.name}… ${Math.floor((job.progress || 0) * 100)}%`);
  }
}

// ---- Interfaz ------------------------------------------------------------------------

function fieldHtml([name, label, type, value, options]) {
  const input =
    type === 'select'
      ? `<select name="${name}">${options.map(([v, l]) => `<option value="${v}"${v === value ? ' selected' : ''}>${escapeHtml(l)}</option>`).join('')}</select>`
      : `<input name="${name}" type="${type}" value="${escapeHtml(value)}"${type === 'password' ? ' autocomplete="new-password"' : ''}>`;
  return `<label class="tool-field"><span>${escapeHtml(label)}</span>${input}</label>`;
}

export default {
  id: 'pdftools',
  name: 'Herramientas PDF',
  glyph: '🧰',
  launch({ tool: initial, files: initialFiles = [] } = {}) {
    const win = createWindow({ title: 'Herramientas PDF', width: 820, height: 600 });
    win.body.classList.add('pdftools');

    const home = () => {
      win.setTitle('Herramientas PDF');
      win.body.innerHTML = `<div class="tools-grid">${TOOLS.map(
        (t) => `<button class="tool-card" data-id="${t.id}"><span class="tool-icon">${t.icon}</span><b>${t.name}</b><small>${t.desc}</small>${t.server ? '<em>servidor</em>' : ''}</button>`,
      ).join('')}</div>`;
      win.body.querySelectorAll('.tool-card').forEach((c) => {
        const tool = TOOLS.find((t) => t.id === c.dataset.id);
        // Si se abrió desde un archivo, ya viene elegido.
        c.onclick = () => open(tool, initialFiles.filter((p) => tool.input.exts.includes(fs.extname(p))));
      });
    };

    function open(tool, preset = []) {
      let files = [...preset];
      win.setTitle(`${tool.name} — Herramientas PDF`);
      win.body.innerHTML = `
        <div class="tool-panel">
          <button class="btn tool-back">← Todas las herramientas</button>
          <h2>${tool.icon} ${tool.name}</h2>
          <p class="tool-desc">${tool.desc}</p>
          <div class="tool-files"></div>
          <button class="btn tool-choose">${tool.input.multiple ? 'Elegir archivos…' : 'Elegir archivo…'}</button>
          <form class="tool-form">${(tool.fields || []).map(fieldHtml).join('')}</form>
          <button class="btn primary tool-run" disabled>${tool.editor ? 'Abrir en el editor' : tool.name}</button>
          <div class="tool-result"></div>
        </div>`;
      const filesEl = win.body.querySelector('.tool-files');
      const runBtn = win.body.querySelector('.tool-run');
      const result = win.body.querySelector('.tool-result');
      const showFiles = () => {
        filesEl.innerHTML = files.map((p, i) => `<div class="tool-file">${tool.input.multiple ? `<b>${i + 1}.</b> ` : ''}${escapeHtml(fs.basename(p))} <small>${escapeHtml(fs.dirname(p))}</small></div>`).join('');
        runBtn.disabled = !files.length;
      };
      win.body.querySelector('.tool-back').onclick = home;
      win.body.querySelector('.tool-choose').onclick = async () => {
        const chosen = await pickFiles({ title: tool.name, exts: tool.input.exts, multiple: tool.input.multiple });
        if (chosen) {
          files = chosen;
          showFiles();
        }
      };
      runBtn.onclick = async () => {
        if (tool.editor) return launch('pdf', { path: files[0] });
        const opt = Object.fromEntries(new FormData(win.body.querySelector('.tool-form')));
        runBtn.disabled = true;
        result.textContent = '';
        const note = toast(`${tool.name}…`);
        try {
          const outputs = await (tool.server ? runServer : runLocal)(tool, files, opt, note);
          note.done(`${tool.name}: listo`);
          result.innerHTML = `<p>✅ Listo. ${outputs.length === 1 ? 'Se guardó' : `Se guardaron ${outputs.length} archivos`} en <b>${escapeHtml(fs.dirname(outputs[0]))}</b></p>`;
          const openBtn = Object.assign(document.createElement('button'), { className: 'btn', textContent: outputs.length === 1 ? `Abrir ${fs.basename(outputs[0])}` : 'Abrir la carpeta' });
          openBtn.onclick = () => (outputs.length === 1 ? launch(fs.extname(outputs[0]) === 'pdf' ? 'pdf' : 'viewer', { path: outputs[0] }) : launch('files', { path: fs.dirname(outputs[0]) }));
          result.appendChild(openBtn);
        } catch (e) {
          note.done(`${tool.name}: error`, true);
          result.innerHTML = `<p class="tool-error">❌ ${escapeHtml(e.message)}</p>`;
        } finally {
          runBtn.disabled = !files.length;
        }
      };
      showFiles();
    }

    const start = initial && TOOLS.find((t) => t.id === initial);
    start ? open(start, initialFiles) : home();
    return win;
  },
};
