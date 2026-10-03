// Reproductor de música y vídeo: la lista es todo lo reproducible de la carpeta.
// Sigue sonando con la ventana minimizada y responde a las teclas multimedia.
import * as fs from '../fs.js';
import * as storage from '../storage.js';
import { createWindow } from '../wm.js';
import { escapeHtml } from '../ui.js';

const AUDIO = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus'];
const VIDEO = ['mp4', 'webm', 'mov', 'm4v', 'ogv'];

const srcOf = (path) => {
  const remote = fs.getRemote(path);
  return remote ? storage.url(remote.key) : fs.readFile(path);
};
const clock = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');

export default {
  id: 'player',
  name: 'Reproductor',
  glyph: '🎵',
  extensions: [...AUDIO, ...VIDEO],
  hidden: true,
  launch({ path } = {}) {
    const dir = fs.dirname(path);
    const list = fs.readdir(dir).filter((e) => e.type === 'file' && [...AUDIO, ...VIDEO].includes(fs.extname(e.name))).map((e) => e.path);
    let index = Math.max(0, list.indexOf(fs.normalize(path)));
    let shuffle = false;
    let repeat = false;

    const win = createWindow({ title: 'Reproductor', width: 760, height: 520 });
    win.body.classList.add('player');
    win.body.tabIndex = -1;
    win.body.innerHTML = `
      <div class="player-main">
        <div class="player-screen">
          <video playsinline></video>
          <div class="player-cover"><span>🎵</span><b></b></div>
        </div>
        <div class="player-bar">
          <button data-act="prev" title="Anterior (P)">⏮</button>
          <button data-act="next" title="Siguiente (N)">⏭</button>
          <button data-act="shuffle" title="Aleatorio">🔀</button>
          <button data-act="repeat" title="Repetir la lista">🔁</button>
          <span class="player-now"></span>
        </div>
      </div>
      <ol class="player-list"></ol>`;
    const video = win.body.querySelector('video');
    const cover = win.body.querySelector('.player-cover');
    const listEl = win.body.querySelector('.player-list');
    const now = win.body.querySelector('.player-now');
    video.controls = true;

    function renderList() {
      listEl.innerHTML = list
        .map((p, i) => `<li data-i="${i}" class="${i === index ? 'playing' : ''}"><span>${VIDEO.includes(fs.extname(p)) ? '🎬' : '🎵'}</span>${escapeHtml(fs.basename(p))}</li>`)
        .join('');
      listEl.querySelector('.playing')?.scrollIntoView({ block: 'nearest' });
    }

    function play(i) {
      if (!list.length) return;
      index = (i + list.length) % list.length;
      const p = list[index];
      const isVideo = VIDEO.includes(fs.extname(p));
      cover.hidden = isVideo;
      cover.querySelector('b').textContent = fs.basename(p).replace(/\.[^.]+$/, '');
      video.src = srcOf(p);
      video.play().catch(() => {}); // si el navegador pide un clic antes de sonar, queda en pausa
      win.setTitle(`${fs.basename(p)} — Reproductor`);
      now.textContent = `${index + 1} de ${list.length}`;
      renderList();
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({ title: fs.basename(p).replace(/\.[^.]+$/, ''), album: fs.basename(dir) || 'MiPuter' });
      }
    }

    const next = () => {
      if (shuffle && list.length > 1) {
        let r;
        do r = Math.floor(Math.random() * list.length);
        while (r === index);
        return play(r);
      }
      if (index === list.length - 1 && !repeat) return video.pause();
      play(index + 1);
    };
    const prev = () => (video.currentTime > 3 ? (video.currentTime = 0) : play(index - 1));

    video.onended = next;
    video.ontimeupdate = () => (now.textContent = `${index + 1} de ${list.length} · ${clock(video.currentTime)} / ${clock(video.duration)}`);
    video.onerror = () => (now.textContent = `No se puede reproducir este archivo (${fs.extname(list[index])}) en este navegador`);
    listEl.onclick = (e) => {
      const li = e.target.closest('li');
      if (li) play(Number(li.dataset.i));
    };
    const actions = {
      prev,
      next,
      shuffle: (b) => b.classList.toggle('active', (shuffle = !shuffle)),
      repeat: (b) => b.classList.toggle('active', (repeat = !repeat)),
    };
    win.body.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => actions[b.dataset.act](b)));
    win.body.addEventListener('keydown', (e) => {
      if (e.target === video) return; // los controles del propio vídeo ya manejan sus teclas
      const keys = {
        ' ': () => (video.paused ? video.play() : video.pause()),
        ArrowRight: () => (video.currentTime += 5),
        ArrowLeft: () => (video.currentTime -= 5),
        n: next,
        N: next,
        p: prev,
        P: prev,
        f: () => (document.fullscreenElement ? document.exitFullscreen() : video.requestFullscreen?.()),
      };
      if (keys[e.key]) {
        e.preventDefault();
        keys[e.key]();
      }
    });
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('nexttrack', next);
      navigator.mediaSession.setActionHandler('previoustrack', prev);
    }
    win.beforeClose = () => {
      video.pause();
      video.removeAttribute('src');
      video.load();
      return true;
    };

    play(index);
    win.body.focus();
    return win;
  },
};
