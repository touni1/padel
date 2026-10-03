#!/usr/bin/env bash
# Navegador de MiPuter: un Google Chrome real corriendo en el VPS, dentro de una
# pantalla virtual (TigerVNC) que MiPuter muestra en una ventana a través de guacd.
#
# Uso (una vez, como root):  sudo bash deploy/setup-web.sh
#
# - Usuario aislado "mpweb" (sin sudo, sin shell). Su carpeta Descargas la puede leer
#   MiPuter (grupo mpweb) para pasar archivos a tus carpetas.
# - Chrome no llega a los servicios internos del VPS ni a redes privadas.
# - La pantalla solo escucha en 127.0.0.1 y pide contraseña VNC (se genera aquí y
#   MiPuter la guarda en .web.json; nadie tiene que escribirla).
set -euo pipefail
APP_DIR=/home/miputer/miputer
cd "$(dirname "$0")"

echo "→ Paquetes (Google Chrome desde el repositorio oficial de Google, TigerVNC)"
if [ ! -f /etc/apt/keyrings/google-chrome.gpg ]; then
  install -d -m 755 /etc/apt/keyrings
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg
fi
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq google-chrome-stable tigervnc-standalone-server tigervnc-tools fonts-noto-color-emoji fonts-liberation >/dev/null
# El paquete de Chrome vuelve a escribir su propia lista de apt; se deja una sola.
rm -f /etc/apt/sources.list.d/google-chrome.list.save

echo "→ Usuario mpweb"
id mpweb >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/mpweb --shell /usr/sbin/nologin mpweb
chmod 710 /home/mpweb
install -d -o mpweb -g mpweb -m 2770 /home/mpweb/Descargas /home/mpweb/MiPuter
usermod -aG mpweb miputer

echo "→ Políticas de Chrome (descargas sin preguntar, sin telemetría)"
install -d -m 755 /etc/opt/chrome/policies/managed
cat > /etc/opt/chrome/policies/managed/miputer.json <<'JSON'
{
  "DownloadDirectory": "/home/mpweb/Descargas",
  "PromptForDownloadLocation": false,
  "DefaultBrowserSettingEnabled": false,
  "MetricsReportingEnabled": false,
  "BackgroundModeEnabled": false,
  "RestoreOnStartup": 1,
  "BrowserSignin": 1
}
JSON

echo "→ Contraseña de la pantalla"
install -d -m 750 -g mpweb /etc/miputer-web
if [ ! -f /etc/miputer-web/vncpasswd ] || [ ! -f "$APP_DIR/.web.json" ]; then
  PASS=$(head -c 64 /dev/urandom | tr -dc 'A-Za-z0-9' | head -c 8)
  printf '%s\n' "$PASS" | vncpasswd -f > /etc/miputer-web/vncpasswd
  chown root:mpweb /etc/miputer-web/vncpasswd
  chmod 640 /etc/miputer-web/vncpasswd
  umask 077
  printf '{"host":"127.0.0.1","port":5905,"password":"%s"}\n' "$PASS" > "$APP_DIR/.web.json"
  chown miputer:miputer "$APP_DIR/.web.json"
  chmod 600 "$APP_DIR/.web.json"
  unset PASS
fi

echo "→ Servicios"
install -m 644 miputer-web-x.service miputer-web.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now miputer-web-x.service miputer-web.service
systemctl restart miputer
echo "✓ Navegador listo"
