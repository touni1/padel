// Herramientas de MiPuter para Claude Code (servidor MCP por stdio).
// Claude Code lo lanza como "mpclaude" junto a cada conversación del chat. Cada
// pedido va al puente por un socket local (MIPUTER_FS_SOCKET) y el puente lo pasa
// a MiPuter, que es quien toca tus carpetas y B2. Sin dependencias.
//
// Se instala en /opt/miputer-claude-chat/mcp.mjs.
import net from 'node:net';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const HOME = process.env.HOME;
const WORKDIR = process.env.CHAT_WORKDIR || resolve(HOME, 'trabajo');
const MAX = 35 * 1024 * 1024;

const ruta = { type: 'string', description: 'Ruta dentro de MiPuter, empezando por /. Por ejemplo /Escritorio/notas.txt o /Documentos/Proyecto' };
const TOOLS = [
  { name: 'miputer_listar', description: 'Lista el contenido de una carpeta de MiPuter (el escritorio web de la persona). Usa "/" para ver las carpetas principales (Escritorio, Documentos, Imágenes…).', inputSchema: { type: 'object', properties: { ruta }, required: ['ruta'] } },
  { name: 'miputer_leer', description: 'Lee un archivo de texto de MiPuter (hasta 2 MB). Para archivos binarios (imágenes, PDF, zip…) usa miputer_traer.', inputSchema: { type: 'object', properties: { ruta }, required: ['ruta'] } },
  { name: 'miputer_escribir', description: 'Crea o reemplaza un archivo de texto en MiPuter con el contenido dado (aparece al instante en el escritorio o la carpeta). Si ya existía, la versión anterior queda guardada.', inputSchema: { type: 'object', properties: { ruta, contenido: { type: 'string', description: 'Texto completo del archivo' } }, required: ['ruta', 'contenido'] } },
  { name: 'miputer_crear_carpeta', description: 'Crea una carpeta en MiPuter (y las intermedias que falten).', inputSchema: { type: 'object', properties: { ruta }, required: ['ruta'] } },
  { name: 'miputer_mover', description: 'Mueve o renombra un archivo o carpeta de MiPuter.', inputSchema: { type: 'object', properties: { origen: ruta, destino: ruta }, required: ['origen', 'destino'] } },
  { name: 'miputer_eliminar', description: 'Manda un archivo o carpeta de MiPuter a la papelera (se puede restaurar durante 30 días).', inputSchema: { type: 'object', properties: { ruta }, required: ['ruta'] } },
  { name: 'miputer_guardar', description: 'Copia un archivo de tu carpeta de trabajo del VPS a MiPuter (sirve para cualquier tipo de archivo, hasta 35 MB). Úsalo para entregarle a la persona lo que generaste.', inputSchema: { type: 'object', properties: { origen: { type: 'string', description: 'Ruta del archivo en tu carpeta de trabajo (relativa a ~/trabajo o absoluta dentro de tu home)' }, destino: ruta }, required: ['origen', 'destino'] } },
  { name: 'miputer_traer', description: 'Copia un archivo de MiPuter a tu carpeta de trabajo del VPS (hasta 35 MB) para poder procesarlo, ejecutarlo o analizarlo.', inputSchema: { type: 'object', properties: { ruta, destino: { type: 'string', description: 'Dónde guardarlo en tu carpeta de trabajo (relativo a ~/trabajo). Si se omite, va a adjuntos/<nombre>' } }, required: ['ruta'] } },
];

// ---- Conexión con el puente ---------------------------------------------------------
let seq = 0;
const waiting = new Map();
const sock = net.connect(process.env.MIPUTER_FS_SOCKET);
let sbuf = '';
sock.on('data', (d) => {
  sbuf += d;
  let nl;
  while ((nl = sbuf.indexOf('\n')) >= 0) {
    const msg = JSON.parse(sbuf.slice(0, nl));
    sbuf = sbuf.slice(nl + 1);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  }
});
sock.on('error', () => {});
const ask = (action, args) =>
  new Promise((ok, fail) => {
    const id = ++seq;
    waiting.set(id, (m) => (m.ok ? ok(m.result) : fail(new Error(m.error))));
    sock.write(`${JSON.stringify({ id, action, args })}\n`);
  });

// Rutas de la carpeta de trabajo: relativas a ~/trabajo y siempre dentro del home.
function local(p) {
  const full = resolve(WORKDIR, String(p || ''));
  if (full !== HOME && !full.startsWith(`${HOME}/`)) throw new Error('Esa ruta está fuera de tu carpeta');
  return full;
}

async function call(name, a) {
  switch (name) {
    case 'miputer_listar':
      return JSON.stringify(await ask('listar', { ruta: a.ruta }), null, 1);
    case 'miputer_leer':
      return ask('leer', { ruta: a.ruta });
    case 'miputer_escribir':
      return JSON.stringify(await ask('escribir', { ruta: a.ruta, contenido: a.contenido }));
    case 'miputer_crear_carpeta':
      return JSON.stringify(await ask('crear_carpeta', { ruta: a.ruta }));
    case 'miputer_mover':
      return JSON.stringify(await ask('mover', { origen: a.origen, destino: a.destino }));
    case 'miputer_eliminar':
      return JSON.stringify(await ask('eliminar', { ruta: a.ruta }));
    case 'miputer_guardar': {
      const file = local(a.origen);
      if (statSync(file).size > MAX) throw new Error('El archivo supera 35 MB');
      return JSON.stringify(await ask('subir', { ruta: a.destino, datos: readFileSync(file).toString('base64') }));
    }
    case 'miputer_traer': {
      const { datos, bytes } = await ask('bajar', { ruta: a.ruta });
      const dest = local(a.destino || `adjuntos/${String(a.ruta).split('/').pop()}`);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, Buffer.from(datos, 'base64'));
      return `Copiado a ${dest} (${bytes} bytes)`;
    }
  }
  throw new Error(`Herramienta desconocida: ${name}`);
}

// ---- MCP (JSON-RPC 2.0, un mensaje por línea) ----------------------------------------
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const replyError = (id, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message } })}\n`);
let ibuf = '';
process.stdin.on('data', async (d) => {
  ibuf += d;
  let nl;
  while ((nl = ibuf.indexOf('\n')) >= 0) {
    const line = ibuf.slice(0, nl).trim();
    ibuf = ibuf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === undefined) continue; // notificaciones
    if (msg.method === 'initialize') reply(msg.id, { protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'miputer', version: '1.0.0' } });
    else if (msg.method === 'tools/list') reply(msg.id, { tools: TOOLS });
    else if (msg.method === 'ping') reply(msg.id, {});
    else if (msg.method === 'tools/call') {
      call(msg.params?.name, msg.params?.arguments || {}).then(
        (text) => reply(msg.id, { content: [{ type: 'text', text: String(text) }] }),
        (e) => reply(msg.id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }),
      );
    } else replyError(msg.id, `Método no soportado: ${msg.method}`);
  }
});
process.stdin.on('end', () => process.exit(0));
