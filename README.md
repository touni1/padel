# MiPuter

Mi propio "puter.com": un escritorio completo que se ejecuta en el navegador, hecho con HTML, CSS y JavaScript puros (sin dependencias ni paso de compilación).

![Captura](docs/screenshot.png)

## Funciones

- **Escritorio** con iconos, menú contextual (clic derecho), arrastrar y soltar, y barra de tareas con reloj.
- **Gestor de ventanas**: mover, redimensionar, minimizar, maximizar (doble clic en la barra de título) y enfocar.
- **Sistema de archivos virtual** persistente en `localStorage` (carpetas, archivos, renombrar, duplicar, eliminar, mover).
- Subida de archivos desde tu ordenador (botón ⤒ o arrastrándolos al escritorio) y descarga.

### Aplicaciones

| App | Descripción |
| --- | --- |
| 🗂️ Archivos | Explorador con navegación, ruta editable, historial y arrastrar a carpetas |
| 📝 Editor de texto | Abre/guarda `.txt`, `.md`, `.js`… (`Ctrl+S`), avisa de cambios sin guardar |
| 💻 Terminal | `ls`, `cd`, `cat`, `echo > archivo`, `mkdir`, `rm`, `mv`, `cp`, `open`, `neofetch`… |
| 🧮 Calculadora | Con paréntesis y soporte de teclado (sin `eval`) |
| 🌐 Navegador | Navega URLs en un iframe o muestra archivos `.html` del sistema virtual |
| 🖼️ Visor de imágenes | Abre imágenes subidas |
| ⚙️ Ajustes | Fondos de escritorio, tema claro/oscuro y restablecer archivos |

## Cómo ejecutarlo

Los módulos ES necesitan servirse por HTTP (no funciona abriendo el archivo directamente):

```bash
python3 -m http.server 8000
# abre http://localhost:8000
```

También se puede publicar tal cual en GitHub Pages, Netlify, Vercel, etc.

## Estructura

```
index.html
css/style.css
js/
  main.js         arranque: escritorio, menú inicio, reloj
  wm.js           gestor de ventanas y barra de tareas
  fs.js           sistema de archivos virtual (localStorage)
  registry.js     registro de apps y asociación por extensión
  fileActions.js  acciones de archivos compartidas (crear, renombrar, mover…)
  ui.js           diálogos y menú contextual
  apps/           una app por archivo
```

### Añadir una app

Crea `js/apps/miapp.js`:

```js
import { createWindow } from '../wm.js';

export default {
  id: 'miapp',
  name: 'Mi app',
  glyph: '✨',
  extensions: ['xyz'], // opcional: abre estos archivos
  launch({ path } = {}) {
    const win = createWindow({ title: 'Mi app', width: 400, height: 300 });
    win.body.innerHTML = '<p style="padding:16px">¡Hola!</p>';
    return win;
  },
};
```

y regístrala en `js/main.js` añadiéndola a la lista de `register`.
