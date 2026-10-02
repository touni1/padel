import { createWindow } from '../wm.js';

// Evalúa una expresión aritmética simple sin usar eval (descenso recursivo).
export function evaluate(expr) {
  const tokens = expr.replace(/×/g, '*').replace(/÷/g, '/').match(/\d+(?:\.\d+)?|[-+*/%()]/g) || [];
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];

  const primary = () => {
    const t = next();
    if (t === '-') return -primary();
    if (t === '+') return primary();
    if (t === '(') {
      const v = sum();
      if (next() !== ')') throw new Error('Falta ")"');
      return v;
    }
    const n = Number(t);
    if (t === undefined || Number.isNaN(n)) throw new Error('Expresión no válida');
    return n;
  };
  const product = () => {
    let v = primary();
    while (['*', '/', '%'].includes(peek())) {
      const op = next();
      const r = primary();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  };
  const sum = () => {
    let v = product();
    while (['+', '-'].includes(peek())) {
      const op = next();
      const r = product();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };

  const result = sum();
  if (i < tokens.length) throw new Error('Expresión no válida');
  if (!Number.isFinite(result)) throw new Error('División por cero');
  return Math.round(result * 1e10) / 1e10;
}

export default {
  id: 'calculator',
  name: 'Calculadora',
  glyph: '🧮',
  launch() {
    const win = createWindow({ title: 'Calculadora', width: 300, height: 420 });
    const keys = ['C', '(', ')', '÷', '7', '8', '9', '×', '4', '5', '6', '-', '1', '2', '3', '+', '0', '.', '⌫', '='];
    win.body.innerHTML = `
      <div class="calc">
        <div class="calc-display">0</div>
        <div class="calc-keys">${keys.map((k) => `<button class="btn ${'÷×-+='.includes(k) ? 'op' : ''}">${k}</button>`).join('')}</div>
      </div>`;
    const display = win.body.querySelector('.calc-display');
    let expr = '';

    const press = (k) => {
      if (k === 'C') expr = '';
      else if (k === '⌫') expr = expr.slice(0, -1);
      else if (k === '=') {
        try {
          expr = String(evaluate(expr));
        } catch (e) {
          display.textContent = e.message;
          expr = '';
          return;
        }
      } else expr += k;
      display.textContent = expr || '0';
    };

    win.body.querySelector('.calc-keys').onclick = (e) => e.target.tagName === 'BUTTON' && press(e.target.textContent);
    win.el.tabIndex = 0;
    win.el.addEventListener('keydown', (e) => {
      const map = { '*': '×', '/': '÷', Enter: '=', Backspace: '⌫', Escape: 'C' };
      const k = map[e.key] || e.key;
      if (keys.includes(k)) {
        e.preventDefault();
        press(k);
      }
    });
    win.el.focus();
    return win;
  },
};
