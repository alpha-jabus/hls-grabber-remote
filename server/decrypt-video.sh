#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -ne 3 ]; then
  echo "Usage: $0 /path/encrypted.mp4.hlsaes /path/output.mp4 /path/encryption.key" >&2
  exit 2
fi
python3 "$(dirname "$0")/hlscrypto.py" --key-file "$3" "$1" "$2"
