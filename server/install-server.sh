#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$HOME/.local/share/hls-grabber-server"
CONF_DIR="$HOME/.config/hls-grabber-server"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$BIN_DIR" "$CONF_DIR" "$UNIT_DIR"
chmod 700 "$CONF_DIR"
install -m 700 "$HERE/server.py" "$BIN_DIR/server.py"
if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
  echo 'Установи ffmpeg + ffprobe перед запуском (например, sudo apt install ffmpeg).' >&2
fi
if [[ ! -f "$CONF_DIR/server.env" ]]; then
  TOKEN="$(python3 -c 'import secrets;print(secrets.token_hex(32))')"
  ( umask 077; printf 'HLS_API_TOKEN=%s\nHLS_BIND=127.0.0.1\nHLS_PORT=8765\nHLS_DATA_DIR=%s/hls-grabber-data\nHLS_MAX_DOWNLOAD_GB=8\nHLS_MAX_JOBS=2\n' "$TOKEN" "$HOME" > "$CONF_DIR/server.env" )
fi
chmod 600 "$CONF_DIR/server.env"
cat > "$UNIT_DIR/hls-grabber-server.service" <<EOF
[Unit]
Description=Private HLS Grabber HTTP backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$BIN_DIR
EnvironmentFile=$CONF_DIR/server.env
ExecStart=$(command -v python3) $BIN_DIR/server.py
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
EOF
if command -v systemctl >/dev/null && systemctl --user daemon-reload 2>/dev/null; then
  systemctl --user enable --now hls-grabber-server.service
  echo 'Сервис запущен через systemd --user'
else
  echo 'systemd --user недоступен. Запусти вручную:'
  echo '  set -a; source ~/.config/hls-grabber-server/server.env; set +a; python3 ~/.local/share/hls-grabber-server/server.py'
fi
cat <<EOF
API: http://127.0.0.1:8765 (слушает ТОЛЬКО loopback сервера)
Токен: $CONF_DIR/server.env (права 600)
Файлы: $HOME/hls-grabber-data/downloads/
Для подключения с другого ПК используй SSH-туннель или HTTPS reverse proxy.
EOF
