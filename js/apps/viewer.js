import * as fs from '../fs.js';
import * as storage from '../storage.js';
import { createWindow } from '../wm.js';

export default {
  id: 'viewer',
  name: 'Visor de imágenes',
  glyph: '🖼️',
  extensions: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'],
  hidden: true,
  launch({ path } = {}) {
    const win = createWindow({ title: `${fs.basename(path)} — Visor`, width: 640, height: 480 });
    win.body.innerHTML = '<div class="viewer"><img alt=""></div>';
    const remote = fs.getRemote(path);
    let src = remote ? storage.url(remote.key) : fs.readFile(path);
    if (!remote && !src.startsWith('data:')) {
      // SVG guardado como texto.
      src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(src)}`;
    }
    win.body.querySelector('img').src = src;
    return win;
  },
};
