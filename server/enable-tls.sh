#!/usr/bin/env bash
# Run this as the normal user, *after* server/install-server.sh.
set -euo pipefail
host="${1:-}"
if [[ -z "$host" ]]; then
  echo "Использование: ./enable-tls.sh 192.168.0.190  (или api.example.com)" >&2
  exit 2
fi
conf_dir="$HOME/.config/hls-grabber-server"
envfile="$conf_dir/server.env"
[[ -f "$envfile" ]] || { echo "Сначала запусти bash ./install-server.sh (без sudo)" >&2; exit 2; }
command -v openssl >/dev/null || { echo "Установи openssl" >&2; exit 2; }
alt=$(python3 - "$host" <<'PY'
import ipaddress,sys,re
host=sys.argv[1]
try: print('IP:'+str(ipaddress.ip_address(host)))
except ValueError:
    if not re.fullmatch(r'[A-Za-z0-9.-]{1,253}',host) or '..' in host:
        sys.exit('Некорректный хост')
    print('DNS:'+host)
PY
)
cert="$conf_dir/server.crt"
key="$conf_dir/server.key"
if [[ -e "$cert" || -e "$key" ]]; then
  [[ -f "$cert" && -f "$key" ]] || { echo "Частично существующий TLS-ключ или сертификат — исправь вручную" >&2; exit 2; }
  echo "Существующий сертификат сохранён, не заменяю ключ."
else
  ( umask 077; openssl req -x509 -newkey rsa:3072 -sha256 -days 365 -nodes \
      -keyout "$key" -out "$cert" -subj "/CN=$host" \
      -addext "subjectAltName=$alt" >/dev/null 2>&1 )
fi
chmod 600 "$key"
chmod 644 "$cert"
python3 - "$envfile" "$cert" "$key" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1]); text=p.read_text()
values={'HLS_BIND':'0.0.0.0','HLS_TLS_CERT':sys.argv[2],'HLS_TLS_KEY':sys.argv[3]}
lines=[line for line in text.splitlines() if line.partition('=')[0] not in values]
lines += [key+'='+value for key,value in values.items()]
p.write_text('\n'.join(lines)+'\n');p.chmod(0o600)
PY
systemctl --user restart hls-grabber-server.service
printf '\nАдрес клиента: https://%s:8765\n' "$host"
printf 'SHA-256 сертификата (скопируй в настройки Firefox):\n'
openssl x509 -in "$cert" -noout -fingerprint -sha256 | sed 's/^[^=]*=//'
printf '\nВАЖНО: скопируй отпечаток через доверенный канал (локальный терминал/SSH один раз).\n'
echo 'Порт 8765 должен быть доступен только твоему ПК/локальной сети (firewall).'
