# MiPuter

Mi propio "puter.com": un escritorio completo que se ejecuta en el navegador, hecho con HTML, CSS y JavaScript puros (sin dependencias ni paso de compilación).

![Captura](docs/screenshot.png)

## Funciones

- **Escritorio** con iconos, menú contextual (clic derecho), arrastrar y soltar, y barra de tareas con reloj.
- **Gestor de ventanas**: mover, redimensionar, minimizar, maximizar (doble clic en la barra de título) y enfocar.
- **Sistema de archivos virtual** persistente en `localStorage` (carpetas, archivos, renombrar, duplicar, eliminar, mover).
- Subida de archivos desde tu ordenador (botón ⤒ o arrastrándolos al escritorio o al explorador) y descarga.
- **Archivos subidos guardados en Backblaze B2** (llevan una nube ☁ en el icono). Se pueden abrir, editar, duplicar, descargar y borrar; los cambios se aplican también en B2.

### Aplicaciones

| App | Descripción |
| --- | --- |
| 🗂️ Archivos | Explorador con navegación, ruta editable, historial y arrastrar a carpetas |
| 📝 Editor de texto | Abre/guarda `.txt`, `.md`, `.js`… (`Ctrl+S`), avisa de cambios sin guardar |
| 💻 Terminal | `ls`, `cd`, `cat`, `echo > archivo`, `mkdir`, `rm`, `mv`, `cp`, `open`, `neofetch`… |
| ✳️ Claude | Terminal **real** del servidor con [Claude Code](https://claude.com/claude-code) (ver [App Claude](#app-claude)) |
| 🧮 Calculadora | Con paréntesis y soporte de teclado (sin `eval`) |
| 🌐 Navegador | Navega URLs en un iframe o muestra archivos `.html` del sistema virtual |
| 🖼️ Visor de imágenes | Abre imágenes subidas |
| ⚙️ Ajustes | Fondos de escritorio, tema claro/oscuro y restablecer archivos |

## Cómo ejecutarlo

Necesitas Node.js 20.12 o superior. Las dependencias (`node-pty` y `ws`) solo hacen falta para la app Claude; sin ellas el resto funciona igual.

```bash
cp .env.example .env   # y rellénalo con tu contraseña y tus datos de B2
npm install            # opcional: solo para la app Claude
npm start
# abre http://localhost:8000
```

### Contraseña

Define `MIPUTER_PASSWORD` en `.env` y MiPuter pedirá esa contraseña antes de mostrar nada (la web, los archivos y la API quedan protegidos). La sesión dura 30 días (`SESSION_DAYS`), y se cierra desde **Inicio → Cerrar sesión**. Al cambiar la contraseña se cierran todas las sesiones abiertas. Tras 5 intentos fallidos seguidos, esa IP queda bloqueada 15 minutos.

Si lo publicas en internet, sírvelo siempre con **HTTPS**, porque si no la contraseña viaja sin cifrar. Detrás de un proxy (nginx, Caddy…) añade `TRUST_PROXY=true` para que el límite de intentos use la IP real.

### Configurar Backblaze B2

1. En el panel de Backblaze, crea un **bucket privado** (Buckets → Create a Bucket).
2. Copia su **Endpoint** (por ejemplo `s3.us-west-004.backblazeb2.com`).
3. En **Application Keys → Add a New Application Key**, crea una clave con acceso de lectura y escritura **solo a ese bucket**. Guarda el `keyID` y la `applicationKey` (esta última solo se muestra una vez).
4. Pon los cuatro valores en `.env`:

   ```env
   B2_KEY_ID=...
   B2_APPLICATION_KEY=...
   B2_BUCKET=nombre-de-tu-bucket
   B2_ENDPOINT=https://s3.us-west-004.backblazeb2.com
   ```

5. Arranca con `npm start`. En la consola debe aparecer `Subidas → Backblaze B2 (bucket "…")`. En la Terminal de MiPuter, el comando `b2` también te dice dónde se guardan las subidas.

**Cómo funciona:** el navegador nunca ve tus claves. Las subidas van a `server.js`, que las firma (AWS Signature V4, la API compatible con S3 de B2) y las guarda en el bucket bajo `miputer/<id>-<nombre>`. Al abrir un archivo, el servidor lo lee de B2 y se lo pasa al navegador, así que no hace falta configurar CORS en el bucket. El árbol de carpetas sigue guardándose en el navegador (`localStorage`) y apunta a esos objetos.

> ⚠️ Si no defines `MIPUTER_PASSWORD`, cualquiera que pueda abrir la dirección del servidor puede leer y borrar los archivos subidos.

### Sin B2

Si `.env` no está configurado (o sirves la carpeta con un servidor estático, como `python3 -m http.server`), todo sigue funcionando y las subidas se guardan en el navegador como antes.

## Estructura

```
server.js         servidor Node: inicio de sesión, web estática, API de archivos en B2 y WebSocket de Claude
.env.example      plantilla de configuración
deploy/           servicios systemd, tmux, nginx y update.sh (ver "Despliegue")
index.html
css/style.css
js/
  main.js         arranque: escritorio, menú inicio, reloj
  wm.js           gestor de ventanas y barra de tareas
  fs.js           sistema de archivos virtual (localStorage)
  registry.js     registro de apps y asociación por extensión
  fileActions.js  acciones de archivos compartidas (crear, renombrar, mover…)
  storage.js      cliente de la API de archivos en B2
  ui.js           diálogos, avisos y menú contextual
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

## App Claude

La app **✳️ Claude** abre una terminal real del servidor (con [xterm.js](https://xtermjs.org)) en la que corre Claude Code, para pedirle cosas como en Claude Code Desktop.

**Cómo funciona**

```
navegador ──wss /api/pty──▶ server.js (usuario miputer)
                              └─ node-pty: cliente tmux ──socket──▶ tmux (usuario mpclaude) ──▶ claude
```

- `server.js` nunca ejecuta `claude` él mismo: lanza un *cliente* de tmux que se conecta al servidor tmux del servicio `miputer-claude`, que corre como `mpclaude`, un usuario sin sudo y con su carpeta de trabajo propia (`/home/mpclaude/trabajo`).
- Hay hasta `CLAUDE_MAX_SESSIONS` (3) sesiones, y como mucho esas mismas ventanas conectadas a la vez.
- **Cerrar la ventana o perder la conexión** mata el cliente, pero Claude sigue en segundo plano y se puede **retomar** desde la lista de sesiones. **Terminar sesión** cierra Claude de verdad. Las sesiones que pasan `CLAUDE_IDLE_HOURS` (24 h) sin nadie conectado se cierran solas.
- Si sales de Claude te queda un shell de `mpclaude`; escribe `claude` (o `claude --continue`) para volver.

**Seguridad**

- El WebSocket solo se acepta con la cookie de sesión válida (`isAuthenticated`) y con la cabecera `Origin` del propio sitio (o una de `ALLOWED_ORIGINS`). Sin `MIPUTER_PASSWORD` la app no se activa nunca.
- `mpclaude` no tiene sudo, y su servicio usa `NoNewPrivileges`, sistema de archivos de solo lectura salvo su carpeta, `/tmp` privado y no ve `/home/miputer`, `/home/ubuntu`, `/home/jaz`, `/var/www`, `/etc/nginx` ni `/etc/letsencrypt`. Tampoco puede leer el `.env` de MiPuter.
- En red, Claude tiene internet pero no llega a nada del propio servidor: `IPAddressDeny` bloquea `127.0.0.0/8`, `::1` y las IPs públicas del VPS (Redis, Postgres, pgbouncer y las otras apps), salvo el DNS local `127.0.0.53`.
- La configuración de tmux (`/etc/miputer-claude/tmux.conf`) es de root, así que Claude no puede cambiar quién se conecta a sus sesiones.
- xterm.js se carga desde jsDelivr con hash de integridad (SRI).

> ⚠️ **Riesgos.** Quien entre en MiPuter tiene un shell en el servidor como `mpclaude`, y Claude puede ejecutar comandos ahí. La contraseña de MiPuter pasa a proteger también eso, así que usa una larga y única. `mpclaude` tiene salida a internet y puede leer lo que sea legible para cualquier usuario del sistema. Además, la cuenta de Claude con la que inicies sesión queda guardada en `/home/mpclaude/.claude`.

**Activarla:** instala las dependencias (`npm ci`) y define en `.env` `CLAUDE_TMUX_SOCKET` y `CLAUDE_WORKDIR` (ver `.env.example`). El resto está en el apartado siguiente.

## Despliegue

Así está desplegado en un VPS Ubuntu 24.04 que ya tenía nginx y otras apps.

| Pieza | Dónde |
| --- | --- |
| Código | `/home/miputer/miputer` (rama `claude/nuevo-proyecto-puter-skm4dr`), usuario de sistema `miputer` sin shell ni sudo |
| Configuración | `/home/miputer/miputer/.env` (600, de `miputer`) con `PORT=8000`, `HOST=127.0.0.1`, `TRUST_PROXY=true`, `COOKIE_SECURE=true` y las variables `CLAUDE_*` |
| Node.js | el del sistema (24 LTS) |
| Servicio web | `miputer.service` ([deploy/miputer.service](deploy/miputer.service)): `Restart=always`, arranca con el sistema, `NoNewPrivileges`, `ProtectSystem=strict` + `ReadWritePaths=/home/miputer`, `PrivateTmp` |
| Servicio Claude | `miputer-claude.service` ([deploy/miputer-claude.service](deploy/miputer-claude.service)): servidor tmux como `mpclaude`, con [deploy/tmux.conf](deploy/tmux.conf) en `/etc/miputer-claude/` |
| Proxy + HTTPS | nginx ([deploy/nginx-miputer.conf](deploy/nginx-miputer.conf)) → `127.0.0.1:8000`, con WebSocket. Certificado de Let's Encrypt con `certbot --nginx`, que se renueva solo |
| nginx por defecto | `/etc/nginx/sites-available/00-default-https`: un dominio que llega por HTTPS sin server block propio recibe la conexión rechazada (`ssl_reject_handshake`) en vez de ver otro sitio del servidor |
| Firewall | ufw: SSH, 80 y 443 (más los puertos de otras apps que ya había). El 8000 solo escucha en `127.0.0.1` |

**Editar la configuración** (contraseña y claves de B2):

```bash
sudo -u miputer nano /home/miputer/miputer/.env
sudo systemctl restart miputer
```

**Actualizar** a la última versión de la rama (hace `git pull`, `npm ci` si cambiaron las dependencias, reinstala los servicios si cambiaron y reinicia):

```bash
sudo bash /home/miputer/miputer/deploy/update.sh
```

**Iniciar sesión en Claude** (una sola vez): abre la app Claude en MiPuter y sigue los pasos de Claude Code (copia el enlace en tu navegador e inicia sesión, y pega el código que te dé). También se puede hacer por SSH con `sudo -u mpclaude -i claude`.

**Logs y estado:**

```bash
journalctl -u miputer -f
systemctl status miputer miputer-claude
sudo -u miputer tmux -S /run/miputer-claude/tmux.sock ls   # sesiones de Claude abiertas
```

**Instalación desde cero** (resumen de lo que se hizo):

```bash
sudo apt install -y build-essential tmux nginx certbot python3-certbot-nginx   # build-essential: compilar node-pty
sudo useradd --system --create-home --shell /usr/sbin/nologin miputer
sudo useradd --create-home --shell /bin/bash mpclaude && sudo passwd -l mpclaude
sudo chmod 750 /home/miputer && sudo chmod 700 /home/mpclaude
sudo usermod -aG mpclaude miputer                     # para poder abrir el socket de tmux
sudo -u miputer git clone -b claude/nuevo-proyecto-puter-skm4dr https://github.com/touni1/padel.git /home/miputer/miputer
cd /home/miputer/miputer && sudo -u miputer -H npm ci --omit=dev
sudo -u miputer sh -c 'umask 077; cp .env.example .env'   # y editarlo
sudo -u mpclaude -i sh -c 'mkdir -p ~/trabajo && curl -fsSL https://claude.ai/install.sh | bash'
sudo install -d /etc/miputer-claude && sudo install -m 644 deploy/tmux.conf /etc/miputer-claude/
sudo install -m 644 deploy/miputer.service deploy/miputer-claude.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now miputer-claude miputer
sudo install -m 644 deploy/nginx-miputer.conf /etc/nginx/sites-available/miputer
sudo ln -s /etc/nginx/sites-available/miputer /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d miputer.cloudar.co --redirect
```
