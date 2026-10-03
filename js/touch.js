// Ajustes para pantallas táctiles (celular, tablet).

export const isTouch = () => matchMedia('(pointer: coarse)').matches;
export const isNarrow = () => matchMedia('(max-width: 700px)').matches;

// Mantener pulsado = clic derecho. Android ya lo hace solo; iOS no, así que si en
// 550 ms el navegador no lanzó su propio "contextmenu", se lanza uno.
export function enableLongPress() {
  let timer = 0;
  let start = null;
  let fired = false;
  let native = false;
  const skip = (el) => el.closest('input, textarea, select, [contenteditable], .xterm');

  document.addEventListener(
    'touchstart',
    (e) => {
      clearTimeout(timer);
      if (e.touches.length !== 1 || skip(e.target)) return;
      const t = e.touches[0];
      const target = e.target;
      start = [t.clientX, t.clientY];
      fired = false;
      native = false;
      timer = setTimeout(() => {
        if (native) return;
        fired = true;
        target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: start[0], clientY: start[1] }));
      }, 550);
    },
    { passive: true },
  );
  document.addEventListener(
    'touchmove',
    (e) => {
      const t = e.touches[0];
      if (start && Math.hypot(t.clientX - start[0], t.clientY - start[1]) > 10) clearTimeout(timer);
    },
    { passive: true },
  );
  // Tras abrir el menú, el dedo al levantarse no debe "tocar" (y abrir) el archivo.
  document.addEventListener(
    'touchend',
    (e) => {
      clearTimeout(timer);
      if (fired) {
        e.preventDefault();
        fired = false;
      }
    },
    { passive: false },
  );
  document.addEventListener('contextmenu', (e) => e.isTrusted && (native = true), true);
}
