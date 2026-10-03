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
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

const SOCKET = process.env.CHAT_SOCKET || '/run/miputer-claude-chat/chat.sock';
const WORKDIR = process.env.CHAT_WORKDIR || join(process.env.HOME, 'trabajo');
const MAX_CHATS = 3;
// Desde Claude Code 2.1.288 "default" se llama "manual"; se acepta el nombre viejo.
const MODES = ['manual', 'acceptEdits', 'auto', 'bypassPermissions', 'plan'];
const modeOf = (m) => (m === 'default' ? 'manual' : MODES.includes(m) ? m : 'acceptEdits');
// Claude Code guarda cada conversación en ~/.claude/projects/<carpeta con "/" → "-">/<id>.jsonl
const PROJECT_DIR = join(process.env.HOME, '.claude', 'projects', WORKDIR.replace(/[^a-zA-Z0-9]/g, '-'));
let running = 0;

function conversations() {
  if (!existsSync(PROJECT_DIR)) return [];
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
      return { id: basename(f, '.jsonl'), title: (title || 'Conversación').slice(0, 80), updated: statSync(file).mtimeMs };
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
  conn.on('close', () => child?.kill('SIGTERM'));
  conn.on('error', () => child?.kill('SIGTERM'));
}

if (existsSync(SOCKET)) unlinkSync(SOCKET);
const server = net.createServer(handle);
server.listen(SOCKET, () => {
  chmodSync(SOCKET, 0o660); // el grupo (miputer está en mpclaude) puede conectarse
  console.log(`Puente de chat de Claude escuchando en ${SOCKET}`);
});
