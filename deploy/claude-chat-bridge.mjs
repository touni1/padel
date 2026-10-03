// Puente entre el chat de MiPuter y Claude Code. Corre como el usuario sin
// privilegios "mpclaude" (servicio miputer-claude-chat) y escucha en un socket
// local que solo MiPuter puede abrir. Cada conexión es una ventana de chat: lanza
// `claude` en modo sin pantalla (stream-json) en ~/trabajo y pasa mensajes en
// los dos sentidos. Los permisos que pide Claude llegan a la ventana para que la
// persona los apruebe (protocolo de control de Claude Code, como el Agent SDK).
//
// Se instala en /opt/miputer-claude-chat/bridge.mjs. Sin dependencias.
import net from 'node:net';
import { spawn } from 'node:child_process';
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const SOCKET = process.env.CHAT_SOCKET || '/run/miputer-claude-chat/chat.sock';
const WORKDIR = process.env.CHAT_WORKDIR || join(process.env.HOME, 'trabajo');
const MAX_CHATS = 3;
const MCP_SCRIPT = process.env.CHAT_MCP || join(dirname(new URL(import.meta.url).pathname), 'mcp.mjs');
// Lo que Claude tiene que saber de su entorno: "el escritorio" de la persona es MiPuter.
const SYSTEM_PROMPT = `Estás integrado en MiPuter, el escritorio web de la persona con la que hablas (lo usa desde el navegador).
Cuando habla de "el escritorio", "mis archivos", "mis documentos", una carpeta suya o un archivo que ve en pantalla, se refiere a MiPuter (rutas como /Escritorio, /Documentos, /Imágenes), NO a tu carpeta del VPS. Para verlos, leerlos, crearlos, moverlos o borrarlos usa SIEMPRE las herramientas mcp__miputer__* (miputer_listar, miputer_leer, miputer_escribir, miputer_crear_carpeta, miputer_mover, miputer_eliminar, miputer_guardar, miputer_traer).
Tu carpeta de trabajo (${WORKDIR}) es un espacio privado tuyo en un servidor Linux: úsala para programar, ejecutar y procesar. Si el resultado es para la persona, guárdalo en MiPuter con miputer_escribir o miputer_guardar y dile dónde quedó.
Los archivos que adjunta desde MiPuter quedan copiados en ${WORKDIR}/adjuntos.
Responde en el idioma de la persona (normalmente español).`;
// Leer y listar no piden permiso; crear, cambiar o borrar sí (salvo en modo automático o sin preguntar).
const READ_ONLY_TOOLS = ['mcp__miputer__miputer_listar', 'mcp__miputer__miputer_leer', 'mcp__miputer__miputer_traer'];
// Desde Claude Code 2.1.288 "default" se llama "manual"; se acepta el nombre viejo.
const MODES = ['manual', 'acceptEdits', 'auto', 'bypassPermissions', 'plan'];
const modeOf = (m) => (m === 'default' ? 'manual' : MODES.includes(m) ? m : 'acceptEdits');
// Claude Code guarda cada conversación en ~/.claude/projects/<carpeta con "/" → "-">/<id>.jsonl
const PROJECT_DIR = join(process.env.HOME, '.claude', 'projects', WORKDIR.replace(/[^a-zA-Z0-9]/g, '-'));
let running = 0;

// Títulos puestos a mano desde MiPuter (Claude Code no guarda uno propio).
const TITLES_FILE = join(process.env.HOME, '.claude', 'miputer-titulos.json');
const loadTitles = () => {
  try {
    return JSON.parse(readFileSync(TITLES_FILE, 'utf8'));
  } catch {
    return {};
  }
};
const saveTitles = (t) => writeFileSync(TITLES_FILE, JSON.stringify(t), { mode: 0o600 });
const validId = (id) => /^[\w-]{8,64}$/.test(String(id || ''));

function conversations() {
  if (!existsSync(PROJECT_DIR)) return [];
  const titles = loadTitles();
  return readdirSync(PROJECT_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const file = join(PROJECT_DIR, f);
      let title = '';
      // El título es el primer mensaje de la persona (se leen solo las primeras líneas).
      for (const line of readFileSync(file, 'utf8').split('\n').slice(0, 80)) {
        try {
          const e = JSON.parse(line);
          if (e.type === 'summary' && e.summary) title = e.summary;
          if (!title && e.type === 'user' && !e.isMeta) {
            const c = e.message?.content;
            const text = typeof c === 'string' ? c : c?.find?.((b) => b.type === 'text')?.text;
            if (text && !text.startsWith('<')) title = text;
          }
        } catch {}
        if (title) break;
      }
      const id = basename(f, '.jsonl');
      return { id, title: (titles[id] || title || 'Conversación').slice(0, 80), updated: statSync(file).mtimeMs };
    })
    .sort((a, b) => b.updated - a.updated)
    .slice(0, 100);
}

// Mensajes de una conversación guardada, para mostrarla al retomarla.
function history(id) {
  if (!/^[\w-]{8,64}$/.test(id)) return [];
  const file = join(PROJECT_DIR, `${id}.jsonl`);
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    try {
      const e = JSON.parse(line);
      if ((e.type === 'user' || e.type === 'assistant') && e.message && !e.isMeta && !e.isSidechain) out.push({ type: e.type, message: e.message });
    } catch {}
  }
  return out.slice(-400);
}

function handle(conn) {
  let child = null;
  let buffer = '';
  // Socket propio de esta conversación para las herramientas de MiPuter (servidor MCP).
  const fsSocket = join(dirname(SOCKET), `fs-${randomUUID()}.sock`);
  const fsWaiting = new Map(); // id hacia MiPuter -> [conexión del MCP, id original]
  let fsSeq = 0;
  const fsServer = net.createServer((mcp) => {
    let mbuf = '';
    mcp.on('data', (d) => {
      mbuf += d;
      let nl;
      while ((nl = mbuf.indexOf('\n')) >= 0) {
        const req = JSON.parse(mbuf.slice(0, nl));
        mbuf = mbuf.slice(nl + 1);
        const id = ++fsSeq;
        fsWaiting.set(id, [mcp, req.id]);
        send({ ev: 'fs', id, action: req.action, args: req.args });
      }
    });
    mcp.on('error', () => {});
  });
  fsServer.listen(fsSocket);
  const allowAlways = new Set(); // herramientas permitidas "siempre" en esta conversación
  const pending = new Map(); // request_id -> petición de permiso
  const send = (obj) => conn.writable && conn.write(`${JSON.stringify(obj)}\n`);
  const toClaude = (obj) => child?.stdin.writable && child.stdin.write(`${JSON.stringify(obj)}\n`);
  const control = (request) => toClaude({ type: 'control_request', request_id: randomUUID(), request });

  function start({ session, mode }) {
    if (child) return send({ ev: 'error', message: 'La conversación ya está abierta' });
    if (running >= MAX_CHATS) return send({ ev: 'error', message: `Hay ${MAX_CHATS} conversaciones abiertas a la vez: cierra alguna` });
    mkdirSync(WORKDIR, { recursive: true });
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--permission-mode', modeOf(mode)];
    if (session && /^[\w-]{8,64}$/.test(session)) args.push('--resume', session);
    const mcpConfig = { mcpServers: { miputer: { command: process.execPath, args: [MCP_SCRIPT], env: { MIPUTER_FS_SOCKET: fsSocket, HOME: process.env.HOME, CHAT_WORKDIR: WORKDIR } } } };
    args.push('--mcp-config', JSON.stringify(mcpConfig), '--append-system-prompt', SYSTEM_PROMPT, '--allowedTools', ...READ_ONLY_TOOLS);
    child = spawn('claude', args, { cwd: WORKDIR, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    running++;
    let stderr = '';
    let out = '';
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    child.stdout.on('data', (d) => {
      out += d;
      let nl;
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl);
        out = out.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === 'control_request' && msg.request?.subtype === 'can_use_tool') {
          const { tool_name: tool, input } = msg.request;
          if (allowAlways.has(tool)) {
            toClaude({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { behavior: 'allow', updatedInput: input } } });
          } else {
            pending.set(msg.request_id, input);
            send({ ev: 'permission', id: msg.request_id, tool, input });
          }
          continue;
        }
        if (msg.type === 'control_response') continue; // respuestas a nuestras órdenes (initialize, interrupt…)
        send({ ev: 'claude', data: msg });
      }
    });
    child.on('exit', (code) => {
      running--;
      child = null;
      send({ ev: 'exit', code, stderr: code ? stderr.trim().split('\n').slice(-3).join('\n') : '' });
    });
    child.on('error', (e) => send({ ev: 'error', message: `No se pudo iniciar Claude Code: ${e.message}` }));
    control({ subtype: 'initialize', hooks: null });
    send({ ev: 'started' });
  }

  function handleOp(msg) {
    switch (msg.op) {
      case 'list':
        return send({ ev: 'list', items: conversations() });
      case 'history':
        return send({ ev: 'history', id: msg.session, messages: history(String(msg.session || '')) });
      case 'start':
        return start(msg);
      case 'send': {
        if (!child) start({ mode: msg.mode });
        const content = [];
        for (const img of (msg.images || []).slice(0, 5)) {
          if (/^image\/(png|jpeg|gif|webp)$/.test(img.type) && typeof img.data === 'string') content.push({ type: 'image', source: { type: 'base64', media_type: img.type, data: img.data } });
        }
        content.push({ type: 'text', text: String(msg.text || '').slice(0, 200_000) });
        return toClaude({ type: 'user', message: { role: 'user', content } });
      }
      case 'attach': {
        // Un archivo de MiPuter que Claude podrá leer: se guarda en ~/trabajo/adjuntos.
        const dir = join(WORKDIR, 'adjuntos');
        mkdirSync(dir, { recursive: true });
        const name = String(msg.name || 'archivo').replace(/[\\/\x00-\x1f]/g, '_').slice(-120) || 'archivo';
        writeFileSync(join(dir, name), Buffer.from(String(msg.data || ''), 'base64'));
        return send({ ev: 'attached', name, path: `adjuntos/${name}` });
      }
      case 'permission': {
        const input = pending.get(msg.id);
        if (!input) return;
        pending.delete(msg.id);
        if (msg.allow && msg.always && msg.tool) allowAlways.add(String(msg.tool));
        const response = msg.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'La persona rechazó esta acción desde MiPuter.' };
        return toClaude({ type: 'control_response', response: { subtype: 'success', request_id: msg.id, response } });
      }
      case 'delete': {
        // Borra la conversación (y lo que Claude Code guardó junto a ella).
        if (!validId(msg.session)) return;
        rmSync(join(PROJECT_DIR, `${msg.session}.jsonl`), { force: true });
        rmSync(join(PROJECT_DIR, msg.session), { recursive: true, force: true });
        const t = loadTitles();
        delete t[msg.session];
        saveTitles(t);
        return send({ ev: 'list', items: conversations() });
      }
      case 'rename': {
        if (!validId(msg.session)) return;
        const t = loadTitles();
        const title = String(msg.title || '').trim().slice(0, 80);
        if (title) t[msg.session] = title;
        else delete t[msg.session];
        saveTitles(t);
        return send({ ev: 'list', items: conversations() });
      }
      case 'fsresult': {
        // Respuesta de MiPuter a una herramienta: vuelve al servidor MCP que la pidió.
        const w = fsWaiting.get(msg.id);
        if (!w) return;
        fsWaiting.delete(msg.id);
        const [mcp, originalId] = w;
        if (!mcp.destroyed) mcp.write(`${JSON.stringify({ id: originalId, ok: msg.ok, result: msg.result, error: msg.error })}\n`);
        return;
      }
      case 'interrupt':
        return control({ subtype: 'interrupt' });
      case 'mode':
        control({ subtype: 'set_permission_mode', mode: modeOf(msg.mode) });
        return;
    }
  }

  conn.on('data', (d) => {
    buffer += d;
    if (buffer.length > 60 * 1024 * 1024) return conn.destroy();
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      try {
        handleOp(JSON.parse(line));
      } catch (e) {
        send({ ev: 'error', message: e.message });
      }
    }
  });
  // Al cerrar la ventana se cierra Claude; la conversación queda guardada para retomarla.
  const cleanup = () => {
    child?.kill('SIGTERM');
    fsServer.close();
    try {
      unlinkSync(fsSocket);
    } catch {}
  };
  conn.on('close', cleanup);
  conn.on('error', cleanup);
}

if (existsSync(SOCKET)) unlinkSync(SOCKET);
const server = net.createServer(handle);
server.listen(SOCKET, () => {
  chmodSync(SOCKET, 0o660); // el grupo (miputer está en mpclaude) puede conectarse
  console.log(`Puente de chat de Claude escuchando en ${SOCKET}`);
});
