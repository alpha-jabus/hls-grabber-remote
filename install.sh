#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.local/share/hls-grabber"
MANIFEST_DIR="$HOME/.mozilla/native-messaging-hosts"
mkdir -p "$DEST" "$MANIFEST_DIR"
install -m 700 "$HERE/native/hls_native.py" "$DEST/hls_native.py"
install -m 600 "$HERE/native/pinned_client.py" "$DEST/pinned_client.py"
python3 - "$DEST/hls_native.py" "$MANIFEST_DIR/local.hls_grabber.json" <<'PY'
import json, sys
from pathlib import Path
host_path = str(Path(sys.argv[1]).resolve())
manifest_path = Path(sys.argv[2])
manifest = {
    "name": "local.hls_grabber",
    "description": "Local ffmpeg downloader for the HLS Grabber Firefox extension",
    "path": host_path,
    "type": "stdio",
    "allowed_extensions": ["hls-grabber@local.invalid"]
}
manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
manifest_path.chmod(0o600)
PY
printf 'Помощник установлен: %s\n' "$DEST/hls_native.py"
if command -v ffmpeg >/dev/null; then
  printf 'ffmpeg найден: %s\n' "$(command -v ffmpeg)"
else
  echo 'ВНИМАНИЕ: ffmpeg не найден. Установи: sudo apt install ffmpeg (Debian/Ubuntu)' >&2
fi
echo 'Теперь открой Firefox -> about:debugging -> Этот Firefox -> Загрузить временное дополнение -> extension/manifest.json'
