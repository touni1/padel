import * as fs from '../fs.js';
import { createWindow } from '../wm.js';

export default {
  id: 'browser',
  name: 'Navegador',
  glyph: '🌐',
  extensions: ['html', 'htm'],
  launch({ path, url = 'https://es.wikipedia.org' } = {}) {
    const win = createWindow({ title: 'Navegador', width: 820, height: 560 });
    win.body.innerHTML = `
      <div class="app-fill">
        <div class="toolbar">
          <input class="url" spellcheck="false">
          <button data-act="go">Ir</button>
          <button data-act="ext" title="Abrir en una pestaña nueva">↗</button>
        </div>
        <iframe class="browser-frame grow" sandbox="allow-scripts allow-forms allow-popups"></iframe>
        <div class="statusbar">Algunos sitios no permiten mostrarse dentro de otra página; usa ↗ para abrirlos aparte.</div>
      </div>`;
    const frame = win.body.querySelector('iframe');
    const urlInput = win.body.querySelector('.url');

    const go = (target) => {
      target = target.trim();
      if (fs.exists(target) && !fs.isDir(target)) {
        frame.removeAttribute('src');
        frame.srcdoc = fs.readFile(target);
        win.setTitle(`${fs.basename(target)} — Navegador`);
      } else {
        if (!/^https?:\/\//.test(target)) target = `https://${target}`;
        frame.removeAttribute('srcdoc');
        frame.src = target;
        win.setTitle(`${target.replace(/^https?:\/\//, '')} — Navegador`);
      }
      urlInput.value = target;
    };

    urlInput.onkeydown = (e) => e.key === 'Enter' && go(urlInput.value);
    win.body.querySelector('.toolbar').onclick = (e) => {
      if (e.target.dataset.act === 'go') go(urlInput.value);
      if (e.target.dataset.act === 'ext' && /^https?:/.test(urlInput.value)) window.open(urlInput.value, '_blank', 'noopener');
    };

    go(path ? fs.normalize(path) : url);
    return win;
  },
};
