#!/usr/bin/env bash
# Actualiza MiPuter en el servidor: trae la última versión de la rama, instala
# dependencias si cambiaron, actualiza los servicios si cambiaron y reinicia.
#
# Uso:  sudo bash /home/miputer/miputer/deploy/update.sh
set -euo pipefail

APP_DIR=/home/miputer/miputer
as_app() { sudo -u miputer -H "$@"; }

[ "$(id -u)" -eq 0 ] || { echo "Ejecútalo con sudo." >&2; exit 1; }

before=$(as_app git -C "$APP_DIR" rev-parse HEAD)
as_app git -C "$APP_DIR" pull --ff-only
after=$(as_app git -C "$APP_DIR" rev-parse HEAD)
changed() { [ "$before" != "$after" ] && ! as_app git -C "$APP_DIR" diff --quiet "$before" "$after" -- "$@"; }

if changed package.json package-lock.json || [ ! -d "$APP_DIR/node_modules" ]; then
  echo "→ Instalando dependencias"
  (cd "$APP_DIR" && as_app npm ci --omit=dev --no-audit --no-fund)
fi

if changed deploy/miputer.service deploy/miputer-claude.service deploy/tmux.conf deploy/miputer-claude-chat.service deploy/claude-chat-bridge.mjs deploy/miputer-mcp.mjs; then
  echo "→ Actualizando servicios"
  install -m 644 "$APP_DIR/deploy/miputer.service" /etc/systemd/system/miputer.service
  install -m 644 "$APP_DIR/deploy/miputer-claude.service" /etc/systemd/system/miputer-claude.service
  install -m 644 "$APP_DIR/deploy/tmux.conf" /etc/miputer-claude/tmux.conf
  install -m 644 "$APP_DIR/deploy/miputer-claude-chat.service" /etc/systemd/system/miputer-claude-chat.service
  install -d -m 755 /opt/miputer-claude-chat
  install -m 644 "$APP_DIR/deploy/claude-chat-bridge.mjs" /opt/miputer-claude-chat/bridge.mjs
  install -m 644 "$APP_DIR/deploy/miputer-mcp.mjs" /opt/miputer-claude-chat/mcp.mjs
  systemctl daemon-reload
  systemctl restart miputer-claude-chat
  echo "  (miputer-claude no se reinicia solo para no cortar sesiones abiertas:"
  echo "   sudo systemctl restart miputer-claude)"
fi

systemctl restart miputer
sleep 2
systemctl is-active --quiet miputer && echo "✓ MiPuter actualizado a $(as_app git -C "$APP_DIR" log -1 --format='%h %s')" \
  || { journalctl -u miputer -n 30 --no-pager; exit 1; }
