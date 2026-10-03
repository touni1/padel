// Claude: chat con Claude Code al estilo de Claude Desktop. Por debajo es el mismo
// Claude Code del VPS (usuario mpclaude, carpeta ~/trabajo) en modo sin pantalla;
// el servidor solo pasa mensajes con el puente (ver deploy/claude-chat-bridge.mjs).
import * as fs from '../fs.js';
import { createWindow } from '../wm.js';
import { escapeHtml, toast, reportError } from '../ui.js';
import { launch } from '../registry.js';
import { pickFiles, readBytes } from '../pdfkit.js';

const VENDOR = new URL('../vendor/', import.meta.url).href;
let libs;
function loadLibs() {
  libs ??= (async () => {
    const [{ marked }, { default: DOMPurify }, { default: hljs }] = await Promise.all([
      import(`${VENDOR}marked/marked.esm.js`),
      import(`${VENDOR}dompurify/purify.es.mjs`),
      import(`${VENDOR}highlight/highlight.min.js`),
    ]);
    if (!document.querySelector('link[data-hljs]')) document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: `${VENDOR}highlight/github-dark.min.css`, dataset: { hljs: '1' } }));
    // Los enlaces de las respuestas se abren aparte y sin acceso a MiPuter.
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') node.setAttribute('target', '_blank'), node.setAttribute('rel', 'noopener noreferrer');
    });
    marked.setOptions({ gfm: true, breaks: false });
    return { marked, DOMPurify, hljs };
  })();
  return libs;
}

const MODES = [
  ['acceptEdits', 'Aceptar ediciones'],
  ['manual', 'Preguntar todo'],
  ['auto', 'Automático (Claude decide qué es seguro)'],
  ['bypassPermissions', 'Sin preguntar'],
  ['plan', 'Solo planificar'],
];
const MODE_KEY = 'miputer.claude.modo';
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const SUGGESTIONS = ['Escribe un script en Python que ordene mis fotos por fecha', 'Explícame qué hace este archivo', 'Crea una página web simple de presentación', 'Revisa este texto y corrige la ortografía'];

const when = (ms) => {
  const d = new Date(ms);
  const days = Math.floor((Date.now() - ms) / 86400000);
  return days < 1 ? d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : days < 7 ? d.toLocaleDateString('es-ES', { weekday: 'short' }) : d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
};
const short = (s, n = 80) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));
const resultText = (content) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[imagen]' : '')).join('\n') : '';

// Cómo se resume cada herramienta en su tarjeta.
function describeTool(name, input = {}) {
  const file = (p) => (p ? String(p).replace('/home/mpclaude/trabajo/', '') : '');
  switch (name) {
    case 'Bash':
      return { icon: '⌨️', title: input.description || 'Ejecutó un comando', detail: `$ ${input.command || ''}` };
    case 'Read':
      return { icon: '📖', title: `Leyó ${file(input.file_path)}` };
    case 'Write':
      return { icon: '📝', title: `Creó ${file(input.file_path)}`, code: input.content };
    case 'Edit':
      return { icon: '✏️', title: `Editó ${file(input.file_path)}`, diff: [[input.old_string, input.new_string]] };
    case 'MultiEdit':
      return { icon: '✏️', title: `Editó ${file(input.file_path)}`, diff: (input.edits || []).map((e) => [e.old_string, e.new_string]) };
    case 'Glob':
      return { icon: '🔎', title: `Buscó archivos: ${input.pattern}` };
    case 'Grep':
      return { icon: '🔎', title: `Buscó "${short(input.pattern, 40)}"` };
    case 'WebFetch':
      return { icon: '🌐', title: `Abrió ${short(input.url, 60)}` };
    case 'WebSearch':
      return { icon: '🌐', title: `Buscó en la web: ${short(input.query, 60)}` };
    case 'TodoWrite':
      return { icon: '✅', title: 'Lista de tareas', todos: input.todos || [] };
    case 'Task':
    case 'Agent':
      return { icon: '🤖', title: `Delegó: ${short(input.description || input.prompt || '', 60)}` };
    default:
      return { icon: '🛠️', title: name, detail: JSON.stringify(input, null, 2) };
  }
}

export default {
  id: 'claude',
  name: 'Claude',
  glyph: '✳️',
  launch() {
    const win = createWindow({ title: 'Claude', width: 1000, height: 680, onClose: () => ws?.close() });
    win.body.classList.add('cc');
    win.body.innerHTML = `
      <aside class="cc-side">
        <div class="cc-brand"><span class="cc-logo">✳</span> Claude</div>
        <button class="cc-new">＋ Nueva conversación</button>
        <div class="cc-convs"></div>
        <button class="cc-term" title="Claude Code en una terminal, como en la consola">⌨️ Abrir la terminal</button>
      </aside>
      <section class="cc-main">
        <header class="cc-head">
          <button class="cc-toggle" title="Conversaciones">☰</button>
          <span class="cc-title">Nueva conversación</span>
          <span class="cc-status"></span>
          <select class="cc-mode" title="Qué puede hacer Claude sin preguntar">${MODES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        </header>
        <div class="cc-scroll"><div class="cc-msgs"></div></div>
        <footer class="cc-composer">
          <div class="cc-chips"></div>
          <div class="cc-box">
            <textarea rows="1" placeholder="Escribe a Claude…  (Enter envía, Shift+Enter salto de línea)"></textarea>
            <div class="cc-actions">
              <button class="cc-attach" title="Adjuntar archivos de MiPuter">📎</button>
              <span class="cc-hint">Trabaja en su carpeta del VPS</span>
              <button class="cc-send" title="Enviar">↑</button>
            </div>
          </div>
        </footer>
      </section>`;
    const $ = (s) => win.body.querySelector(s);
    const msgsEl = $('.cc-msgs');
    const scroller = $('.cc-scroll');
    const input = $('textarea');
    const sendBtn = $('.cc-send');
    const statusEl = $('.cc-status');
    const modeSel = $('.cc-mode');
    const chips = $('.cc-chips');
    try {
      modeSel.value = (localStorage.getItem(MODE_KEY) || 'acceptEdits').replace(/^default$/, 'manual');
      if (!modeSel.value) modeSel.value = 'acceptEdits';
    } catch {}

    let ws = null;
    let session = null; // id de la conversación de Claude Code
    let started = false;
    let busy = false;
    let attachments = []; // { name, path?, image? }
    const tools = new Map(); // tool_use_id -> tarjeta
    let live = null; // mensaje que se está escribiendo (streaming)

    const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    const toBottom = (force) => (force || atBottom()) && requestAnimationFrame(() => (scroller.scrollTop = scroller.scrollHeight));
    const setBusy = (b, text = '') => {
      busy = b;
      sendBtn.textContent = b ? '■' : '↑';
      sendBtn.title = b ? 'Detener' : 'Enviar';
      statusEl.textContent = text;
      statusEl.classList.toggle('on', b);
    };

    // ---- Conexión con el puente --------------------------------------------------
    function connect() {
      return new Promise((resolve, reject) => {
        const url = new URL('api/claude-chat', location.href);
        url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(url);
        ws = socket;
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error('No se pudo conectar con Claude en el servidor'));
        // Una conexión vieja (de la conversación anterior) que se cierra tarde no toca la nueva.
        socket.onclose = () => {
          if (ws !== socket) return;
          ws = null;
          started = false;
          if (busy) setBusy(false);
        };
        socket.onmessage = (e) => ws === socket && onEvent(JSON.parse(e.data));
      });
    }
    async function op(msg) {
      if (!ws) await connect();
      ws.send(JSON.stringify(msg));
    }

    // ---- Pintar mensajes -------------------------------------------------------------
    async function markdown(el, text) {
      const { marked, DOMPurify, hljs } = await loadLibs();
      el.innerHTML = DOMPurify.sanitize(marked.parse(text || ''));
      el.querySelectorAll('pre code').forEach((code) => {
        hljs.highlightElement(code);
        const btn = Object.assign(document.createElement('button'), { className: 'cc-copy', textContent: 'Copiar' });
        btn.onclick = () => navigator.clipboard?.writeText(code.textContent).then(() => (btn.textContent = 'Copiado'));
        code.parentElement.appendChild(btn);
      });
    }

    function userBubble(text, names = []) {
      const el = document.createElement('div');
      el.className = 'cc-msg user';
      el.innerHTML = `<div class="cc-bubble"></div>`;
      el.firstChild.textContent = text;
      if (names.length) el.firstChild.insertAdjacentHTML('beforeend', `<div class="cc-attached">${names.map((n) => `📎 ${escapeHtml(n)}`).join(' · ')}</div>`);
      msgsEl.appendChild(el);
      toBottom(true);
    }

    function assistantEl(id) {
      let el = id && msgsEl.querySelector(`.cc-msg.assistant[data-id="${CSS.escape(id)}"]`);
      if (!el) {
        el = document.createElement('div');
        el.className = 'cc-msg assistant';
        if (id) el.dataset.id = id;
        msgsEl.appendChild(el);
      }
      return el;
    }

    function toolCard(block) {
      const d = describeTool(block.name, block.input);
      const card = document.createElement('details');
      card.className = 'cc-tool';
      card.innerHTML = `<summary><span class="cc-tool-icon">${d.icon}</span><span class="cc-tool-title"></span><span class="cc-tool-state">…</span></summary><div class="cc-tool-body"></div>`;
      card.querySelector('.cc-tool-title').textContent = d.title;
      const body = card.querySelector('.cc-tool-body');
      if (d.detail) body.appendChild(Object.assign(document.createElement('pre'), { className: 'cc-pre', textContent: d.detail }));
      if (d.code) body.appendChild(Object.assign(document.createElement('pre'), { className: 'cc-pre', textContent: short(d.code, 6000) }));
      if (d.diff) {
        for (const [a, b] of d.diff) {
          const pre = document.createElement('pre');
          pre.className = 'cc-pre cc-diff';
          for (const l of String(a ?? '').split('\n')) pre.appendChild(Object.assign(document.createElement('div'), { className: 'del', textContent: `- ${l}` }));
          for (const l of String(b ?? '').split('\n')) pre.appendChild(Object.assign(document.createElement('div'), { className: 'add', textContent: `+ ${l}` }));
          body.appendChild(pre);
        }
      }
      if (d.todos) {
        card.open = true;
        const ul = document.createElement('ul');
        ul.className = 'cc-todos';
        for (const t of d.todos) {
          const li = document.createElement('li');
          li.className = t.status;
          li.textContent = `${t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '◐' : '☐'} ${t.content || t.activeForm || ''}`;
          ul.appendChild(li);
        }
        body.appendChild(ul);
      }
      tools.set(block.id, card);
      return card;
    }

    function toolResult(block) {
      const card = tools.get(block.tool_use_id);
      if (!card) return;
      const state = card.querySelector('.cc-tool-state');
      state.textContent = block.is_error ? '✗' : '✓';
      state.classList.add(block.is_error ? 'err' : 'ok');
      const text = resultText(block.content).trim();
      if (text && !card.querySelector('.cc-todos')) {
        card.querySelector('.cc-tool-body').appendChild(Object.assign(document.createElement('pre'), { className: `cc-pre cc-out${block.is_error ? ' err' : ''}`, textContent: short(text, 8000) }));
      }
    }

    // Mensaje completo del asistente (al terminar de escribirse o del historial).
    function renderAssistant(message) {
      const el = assistantEl(message.id);
      el.innerHTML = '';
      for (const block of message.content || []) {
        if (block.type === 'text' && block.text.trim()) {
          const div = Object.assign(document.createElement('div'), { className: 'cc-md' });
          el.appendChild(div);
          markdown(div, block.text);
        } else if (block.type === 'thinking' && block.thinking) {
          const det = document.createElement('details');
          det.className = 'cc-thinking';
          det.innerHTML = '<summary>Pensamiento</summary>';
          det.appendChild(Object.assign(document.createElement('div'), { textContent: block.thinking }));
          el.appendChild(det);
        } else if (block.type === 'tool_use') {
          el.appendChild(tools.get(block.id) || toolCard(block));
        }
      }
      toBottom();
    }

    function renderUser(message) {
      const c = message.content;
      if (typeof c === 'string') return c.startsWith('<') ? null : userBubble(c);
      for (const block of c || []) {
        if (block.type === 'tool_result') toolResult(block);
        else if (block.type === 'text' && !block.text.startsWith('<')) userBubble(block.text);
      }
    }

    // Texto que va llegando (con --include-partial-messages).
    let liveTimer = 0;
    function onStream(ev) {
      if (ev.type === 'message_start') live = { id: ev.message?.id, blocks: [] };
      if (!live) return;
      if (ev.type === 'content_block_start') live.blocks[ev.index] = { ...ev.content_block, text: ev.content_block.text || '', thinking: '' };
      if (ev.type === 'content_block_delta') {
        const b = live.blocks[ev.index];
        if (!b) return;
        if (ev.delta.type === 'text_delta') b.text += ev.delta.text;
        if (ev.delta.type === 'thinking_delta') b.thinking += ev.delta.thinking;
      }
      clearTimeout(liveTimer);
      liveTimer = setTimeout(() => {
        if (!live) return;
        const el = assistantEl(live.id);
        const text = live.blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n\n');
        let div = el.querySelector('.cc-md.live');
        if (!div) el.appendChild((div = Object.assign(document.createElement('div'), { className: 'cc-md live' })));
        markdown(div, text);
        statusEl.textContent = live.blocks.some((b) => b?.type === 'thinking') && !text ? 'Pensando…' : 'Escribiendo…';
        toBottom();
      }, 50);
    }

    function permissionCard({ id, tool, input }) {
      const d = describeTool(tool, input);
      const card = document.createElement('div');
      card.className = 'cc-perm';
      card.innerHTML = `
        <div class="cc-perm-q">Claude quiere usar <b></b></div>
        <pre class="cc-pre"></pre>
        <div class="cc-perm-actions">
          <button class="btn primary" data-a="allow">Permitir</button>
          <button class="btn" data-a="always">Permitir siempre en esta conversación</button>
          <button class="btn" data-a="deny">Rechazar</button>
        </div>`;
      card.querySelector('b').textContent = tool;
      card.querySelector('pre').textContent = d.detail || d.title;
      card.querySelectorAll('[data-a]').forEach(
        (b) =>
          (b.onclick = () => {
            const a = b.dataset.a;
            op({ op: 'permission', id, tool, allow: a !== 'deny', always: a === 'always' });
            card.classList.add('done');
            card.querySelector('.cc-perm-actions').textContent = a === 'deny' ? '✗ Rechazado' : a === 'always' ? '✓ Permitido siempre en esta conversación' : '✓ Permitido';
          }),
      );
      msgsEl.appendChild(card);
      setBusy(true, 'Esperando tu permiso');
      toBottom(true);
    }

    function notice(html, cls = '') {
      const el = document.createElement('div');
      el.className = `cc-notice ${cls}`;
      el.innerHTML = html;
      msgsEl.appendChild(el);
      toBottom(true);
      return el;
    }

    function loginNotice() {
      const el = notice('<b>Falta iniciar sesión en Claude Code.</b> Se hace una sola vez: abre la terminal, escribe <code>/login</code>, elige tu cuenta de Claude y sigue los pasos.<br><button class="btn primary">Abrir la terminal</button>', 'warn');
      el.querySelector('button').onclick = () => launch('claudeterm');
    }

    function onEvent(e) {
      if (e.ev === 'list') return renderConvs(e.items);
      if (e.ev === 'history') {
        for (const m of e.messages) m.type === 'assistant' ? renderAssistant(m.message) : renderUser(m.message);
        return toBottom(true);
      }
      if (e.ev === 'permission') return permissionCard(e);
      if (e.ev === 'attached') return;
      if (e.ev === 'error') {
        setBusy(false);
        return notice(escapeHtml(e.message), 'err');
      }
      if (e.ev === 'exit') {
        started = false;
        setBusy(false);
        if (e.code && e.stderr) notice(`Claude Code se cerró: ${escapeHtml(e.stderr)}`, 'err');
        return;
      }
      if (e.ev !== 'claude') return;
      const m = e.data;
      if (m.type === 'system' && m.subtype === 'init') {
        session = m.session_id;
        statusEl.title = `Modelo: ${m.model || ''}`;
        return;
      }
      if (m.type === 'stream_event') return onStream(m.event);
      if (m.type === 'assistant') {
        live = null;
        win.body.querySelector('.cc-md.live')?.remove();
        setBusy(true, 'Trabajando…');
        return renderAssistant(m.message);
      }
      if (m.type === 'user') return renderUser(m.message);
      if (m.type === 'result') {
        live = null;
        win.body.querySelector('.cc-md.live')?.remove();
        setBusy(false);
        const text = String(m.result || '');
        if (m.is_error || m.subtype !== 'success') {
          if (/login|api key|authenticat|credential/i.test(text)) loginNotice();
          else notice(escapeHtml(text || 'Claude no pudo terminar la respuesta'), 'err');
        }
        refreshList();
      }
    }

    // ---- Conversaciones (barra lateral) -----------------------------------------------
    const convsEl = $('.cc-convs');
    function renderConvs(items) {
      convsEl.innerHTML = items.length ? '' : '<p class="cc-empty-list">Aún no hay conversaciones</p>';
      for (const c of items) {
        const b = document.createElement('button');
        b.className = `cc-conv${c.id === session ? ' active' : ''}`;
        b.innerHTML = '<span></span><small></small>';
        b.firstChild.textContent = c.title;
        b.lastChild.textContent = when(c.updated);
        b.onclick = () => reportError(() => openConversation(c));
        convsEl.appendChild(b);
      }
    }
    const refreshList = () => op({ op: 'list' }).catch(() => {});

    function welcome() {
      msgsEl.innerHTML = `
        <div class="cc-welcome">
          <div class="cc-logo big">✳</div>
          <h2>¿En qué te ayudo?</h2>
          <p>Claude Code trabaja en su propia carpeta del VPS: puede crear y editar archivos y ejecutar comandos ahí.</p>
          <div class="cc-sugs">${SUGGESTIONS.map((s) => `<button>${escapeHtml(s)}</button>`).join('')}</div>
        </div>`;
      msgsEl.querySelectorAll('.cc-sugs button').forEach((b) => (b.onclick = () => ((input.value = b.textContent), input.focus(), autosize())));
    }

    async function reset() {
      ws?.close();
      ws = null;
      session = null;
      started = false;
      tools.clear();
      live = null;
      setBusy(false);
      $('.cc-title').textContent = 'Nueva conversación';
      win.setTitle('Claude');
      welcome();
      await connect();
      refreshList();
    }

    async function openConversation(c) {
      await reset();
      session = c.id;
      $('.cc-title').textContent = c.title;
      win.setTitle(`${short(c.title, 40)} — Claude`);
      msgsEl.innerHTML = '';
      await op({ op: 'history', session: c.id });
      await op({ op: 'start', session: c.id, mode: modeSel.value });
      started = true;
      refreshList();
      win.body.classList.remove('side-open');
    }

    // ---- Enviar -------------------------------------------------------------------------
    async function send() {
      const text = input.value.trim();
      if (!text && !attachments.length) return;
      if (msgsEl.querySelector('.cc-welcome')) msgsEl.innerHTML = '';
      if (!started) {
        await op({ op: 'start', session, mode: modeSel.value });
        started = true;
      }
      const files = attachments.filter((a) => a.path).map((a) => a.path);
      const images = attachments.filter((a) => a.image).map((a) => a.image);
      const full = files.length ? `${text}\n\n(Archivos adjuntos en mi carpeta de trabajo: ${files.join(', ')})` : text;
      userBubble(text, attachments.map((a) => a.name));
      if ($('.cc-title').textContent === 'Nueva conversación') $('.cc-title').textContent = short(text, 60);
      await op({ op: 'send', text: full, images, mode: modeSel.value });
      input.value = '';
      attachments = [];
      chips.innerHTML = '';
      autosize();
      setBusy(true, 'Pensando…');
    }

    async function attach(paths) {
      for (const p of paths) {
        const name = fs.basename(p);
        const remote = fs.getRemote(p);
        if (remote && remote.size > 20 * 1024 * 1024) {
          toast(`"${name}" pesa más de 20 MB: no se adjunta`).done(undefined, true);
          continue;
        }
        const chip = Object.assign(document.createElement('span'), { className: 'cc-chip', textContent: `📎 ${name}…` });
        chips.appendChild(chip);
        try {
          const bytes = await readBytes(p);
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          const data = btoa(bin);
          const type = IMAGE_TYPES[fs.extname(p)];
          const entry = { name };
          // Las imágenes chicas van al modelo para que las vea; todo va además a su carpeta.
          if (type && bytes.length <= 5 * 1024 * 1024) entry.image = { type, data };
          await op({ op: 'attach', name, data });
          entry.path = `adjuntos/${name.replace(/[\\/\x00-\x1f]/g, '_')}`;
          attachments.push(entry);
          chip.textContent = `📎 ${name}`;
          const x = Object.assign(document.createElement('button'), { textContent: '×', title: 'Quitar' });
          x.onclick = () => {
            attachments = attachments.filter((a) => a !== entry);
            chip.remove();
          };
          chip.appendChild(x);
        } catch (e) {
          chip.remove();
          toast(`No se pudo adjuntar "${name}": ${e.message}`).done(undefined, true);
        }
      }
    }

    const autosize = () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(220, input.scrollHeight)}px`;
    };
    input.oninput = autosize;
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!busy) reportError(send);
      }
    };
    sendBtn.onclick = () => (busy ? op({ op: 'interrupt' }).then(() => setBusy(false)) : reportError(send));
    $('.cc-attach').onclick = async () => {
      const chosen = await pickFiles({ title: 'Adjuntar a Claude', exts: null, multiple: true });
      if (chosen) reportError(() => attach(chosen));
    };
    $('.cc-new').onclick = () => reportError(reset);
    $('.cc-term').onclick = () => launch('claudeterm');
    $('.cc-toggle').onclick = () => win.body.classList.toggle('side-open');
    modeSel.onchange = () => {
      try {
        localStorage.setItem(MODE_KEY, modeSel.value);
      } catch {}
      if (started) op({ op: 'mode', mode: modeSel.value });
    };
    // Soltar archivos del escritorio o del explorador sobre el chat los adjunta.
    win.body.addEventListener('dragover', (e) => e.preventDefault());
    win.body.addEventListener('drop', (e) => {
      e.preventDefault();
      let paths;
      try {
        paths = JSON.parse(e.dataTransfer.getData('text/x-miputer-paths') || 'null');
      } catch {}
      paths ??= [e.dataTransfer.getData('text/x-miputer-path')].filter(Boolean);
      const files = paths.filter((p) => fs.exists(p) && !fs.isDir(p));
      if (files.length) reportError(() => attach(files));
    });

    welcome();
    reportError(async () => {
      await connect();
      refreshList();
    });
    input.focus();
    return win;
  },
};
