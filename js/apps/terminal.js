import * as fs from '../fs.js';
import { createWindow } from '../wm.js';
import * as storage from '../storage.js';
import { escapeHtml } from '../ui.js';
import { openPath, launch, list as listApps } from '../registry.js';

// Divide una línea en argumentos respetando comillas.
function tokenize(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const HELP = `Comandos disponibles:
  help                 Muestra esta ayuda
  ls [ruta]            Lista el contenido de una carpeta
  cd [ruta]            Cambia de carpeta
  pwd                  Muestra la carpeta actual
  cat <archivo>        Muestra el contenido de un archivo
  echo <texto> [> f]   Escribe texto (o lo guarda en un archivo con > o >>)
  touch <archivo>      Crea un archivo vacío
  mkdir <carpeta>      Crea una carpeta
  rm <ruta>            Mueve a la papelera (dentro de ella, borra)
  mv <origen> <dest>   Mueve o renombra
  cp <origen> <dest>   Copia
  open <ruta|app>      Abre un archivo, carpeta o aplicación
  b2                   Muestra dónde se guardan las subidas
  apps                 Lista las aplicaciones
  date                 Fecha y hora actual
  whoami               Usuario actual
  neofetch             Información del sistema
  clear                Limpia la pantalla`;

export default {
  id: 'terminal',
  name: 'Terminal',
  glyph: '💻',
  launch() {
    const win = createWindow({ title: 'Terminal', width: 640, height: 400 });
    win.body.innerHTML = '<div class="terminal"><div class="out"></div><div class="line-input"><span class="prompt"></span><input spellcheck="false" autocomplete="off"></div></div>';
    const term = win.body.querySelector('.terminal');
    const out = term.querySelector('.out');
    const input = term.querySelector('input');
    const promptEl = term.querySelector('.prompt');
    const history = [];
    let hIndex = 0;
    let cwd = '/';

    const print = (text, cls = '') => {
      const div = document.createElement('div');
      if (cls) div.className = cls;
      div.innerHTML = text;
      out.appendChild(div);
    };
    const updatePrompt = () => (promptEl.textContent = `usuario@miputer:${cwd}$ `);
    const resolve = (p) => fs.normalize(p || '/', cwd);
    const need = (arg, usage) => {
      if (!arg) throw new Error(`uso: ${usage}`);
    };

    const commands = {
      help: () => print(escapeHtml(HELP)),
      pwd: () => print(escapeHtml(cwd)),
      clear: () => (out.innerHTML = ''),
      whoami: () => print('usuario'),
      date: () => print(escapeHtml(new Date().toLocaleString('es-ES'))),
      ls: ([p]) => {
        const entries = fs.readdir(resolve(p || cwd));
        print(entries.map((e) => (e.type === 'dir' ? `<span class="dir">${escapeHtml(e.name)}/</span>` : escapeHtml(e.name))).join('  ') || '');
      },
      cd: ([p]) => {
        const target = resolve(p || '/');
        if (!fs.isDir(target)) throw new Error(`cd: no es una carpeta: ${p}`);
        cwd = target;
      },
      cat: async ([p]) => {
        need(p, 'cat <archivo>');
        const remote = fs.getRemote(resolve(p));
        if (remote && !storage.isTextType(remote.type, p)) {
          return print(escapeHtml(`(archivo binario en B2, ${remote.size} bytes)`));
        }
        print(escapeHtml(await fs.readFileAsync(resolve(p))));
      },
      b2: () =>
        print(escapeHtml(storage.enabled() ? `Subidas → Backblaze B2, bucket "${storage.bucket()}"` : 'B2 no configurado: las subidas se guardan en el navegador')),
      echo: (args) => {
        const i = args.findIndex((a) => a === '>' || a === '>>');
        if (i === -1) return print(escapeHtml(args.join(' ')));
        const text = args.slice(0, i).join(' ') + '\n';
        const target = resolve(args[i + 1]);
        need(args[i + 1], 'echo <texto> > <archivo>');
        if (fs.getRemote(target)) throw new Error('echo: no se puede escribir con > en un archivo de B2; usa el Editor');
        const prev = args[i] === '>>' && fs.exists(target) ? fs.readFile(target) : '';
        fs.writeFile(target, prev + text);
      },
      touch: ([p]) => {
        need(p, 'touch <archivo>');
        if (!fs.exists(resolve(p))) fs.writeFile(resolve(p), '');
      },
      mkdir: ([p]) => {
        need(p, 'mkdir <carpeta>');
        fs.mkdir(resolve(p));
      },
      rm: ([p]) => {
        need(p, 'rm <ruta>');
        fs.trash(resolve(p));
      },
      mv: ([a, b]) => {
        need(a && b, 'mv <origen> <destino>');
        const dst = fs.isDir(resolve(b)) ? fs.join(resolve(b), fs.basename(a)) : resolve(b);
        fs.rename(resolve(a), dst);
      },
      cp: ([a, b]) => {
        need(a && b, 'cp <origen> <destino>');
        const dst = fs.isDir(resolve(b)) ? fs.join(resolve(b), fs.basename(a)) : resolve(b);
        return fs.copy(resolve(a), dst);
      },
      open: ([p]) => {
        need(p, 'open <ruta|app>');
        if (fs.exists(resolve(p))) openPath(resolve(p));
        else launch(p);
      },
      apps: () => print(listApps().map((a) => `${a.glyph} ${a.id.padEnd(10)} ${a.name}`).join('\n')),
      neofetch: () =>
        print(
          escapeHtml(`   ◆◆◆      usuario@miputer
  ◆   ◆     ---------------
  ◆◆◆◆◆     SO: MiPuter 1.0
  ◆   ◆     Navegador: ${navigator.userAgent.split(' ').pop()}
  ◆   ◆     Resolución: ${screen.width}x${screen.height}
            Apps: ${listApps().length}`)
        ),
    };

    const run = async (line) => {
      print(`<span class="prompt">${escapeHtml(promptEl.textContent)}</span>${escapeHtml(line)}`);
      const [cmd, ...args] = tokenize(line);
      if (!cmd) return;
      const fn = commands[cmd];
      if (!fn) return print(`${escapeHtml(cmd)}: comando no encontrado. Escribe "help".`, 'err');
      try {
        await fn(args);
      } catch (e) {
        print(escapeHtml(e.message), 'err');
      }
    };

    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        const line = input.value;
        if (line.trim()) history.push(line);
        hIndex = history.length;
        input.value = '';
        input.disabled = true;
        run(line).finally(() => {
          input.disabled = false;
          input.focus();
          updatePrompt();
          term.scrollTop = term.scrollHeight;
        });
      } else if (e.key === 'ArrowUp' && hIndex > 0) {
        input.value = history[--hIndex];
        e.preventDefault();
      } else if (e.key === 'ArrowDown') {
        hIndex = Math.min(history.length, hIndex + 1);
        input.value = history[hIndex] ?? '';
        e.preventDefault();
      } else if (e.key === 'l' && e.ctrlKey) {
        out.innerHTML = '';
        e.preventDefault();
      }
    };
    term.onclick = () => window.getSelection().isCollapsed && input.focus();

    print('MiPuter Terminal — escribe "help" para ver los comandos.');
    updatePrompt();
    input.focus();
    return win;
  },
};
