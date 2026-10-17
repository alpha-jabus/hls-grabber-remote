"""Local pinned TLS transport for HLS Grabber. No HTTP request before the pin matches.

Pin format: SHA-256 of the *entire DER leaf certificate*, not SPKI. This supports
self-signed certificates with independent out-of-band bootstrap. Rotate it on renewal.
"""
import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path
import re
import ssl
import tempfile
from urllib.parse import urlsplit

CONFIG_FILE = Path.home() / '.config' / 'hls-grabber' / 'client.json'
VALID_PATHS = {'health', 'jobs', 'preview', 'download'}
MAX_RESPONSE = 6_000_000


def clean_pin(value):
    if not isinstance(value, str):
        raise ValueError('SHA-256 отпечаток должен быть строкой')
    pin = re.sub(r'[:\s]', '', value).lower()
    if not re.fullmatch(r'[0-9a-f]{64}', pin):
        raise ValueError('Нужен SHA-256 отпечаток сертификата (64 hex-символа)')
    return pin


def validate_config(value):
    if not isinstance(value, dict):
        raise ValueError('Ожидается объект JSON')
    if set(value) != {'url', 'token', 'fingerprint'}:
        raise ValueError('Конфигурация должна содержать только url, token, fingerprint')
    url, token = value['url'], value['token']
    if not isinstance(url, str) or len(url) > 300:
        raise ValueError('Недопустимый URL')
    parsed = urlsplit(url.strip())
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
        raise ValueError('Pinning требует URL вида https://server:8765 без пути или пароля')
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError('Недопустимый TCP-порт') from exc
    if not isinstance(token, str) or not 32 <= len(token) <= 1024 or any(ord(c) < 33 or ord(c) > 126 for c in token):
        raise ValueError('Токен должен содержать 32–1024 печатных ASCII-символа без пробелов')
    return {'url': f'https://{parsed.netloc}', 'token': token, 'fingerprint': clean_pin(value['fingerprint'])}


def read_config():
    if CONFIG_FILE.is_symlink():
        raise ValueError('Конфигурация не должна быть символьной ссылкой')
    try:
        fd = os.open(str(CONFIG_FILE), os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    except FileNotFoundError:
        return None
    with os.fdopen(fd, 'r', encoding='utf-8') as f:
        data = f.read(16385)
    if len(data) > 16384:
        raise ValueError('Конфигурация слишком большая')
    return validate_config(json.loads(data))


def write_config(value):
    valid = validate_config(value)
    folder = CONFIG_FILE.parent
    folder.mkdir(parents=True, mode=0o700, exist_ok=True)
    os.chmod(folder, 0o700)
    if CONFIG_FILE.is_symlink():
        raise ValueError('Конфигурация не должна быть символьной ссылкой')
    fd, name = tempfile.mkstemp(prefix='.client-', suffix='.tmp', dir=folder)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            os.fchmod(f.fileno(), 0o600)
            json.dump(valid, f, indent=2, ensure_ascii=False)
            f.write('\n')
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, CONFIG_FILE)
    finally:
        if os.path.exists(name):
            os.unlink(name)
    return valid


def pinned_request(path, payload=None, *, config=None, timeout=None):
    if path not in VALID_PATHS:
        raise ValueError('Недопустимый API-метод')
    cfg = validate_config(config) if config is not None else read_config()
    if cfg is None:
        raise ValueError('Сначала сохрани конфигурацию pinned HTTPS')
    u = urlsplit(cfg['url'])
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    # A pinned full certificate is the trust anchor. We must not send HTTP
    # bytes until the certificate has been checked, including with self-signed TLS.
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    conn = http.client.HTTPSConnection(u.hostname, port=u.port or 443,
                                       timeout=timeout or (65 if path == 'preview' else 20), context=context)
    try:
        conn.connect()  # TLS handshake only; sends no bearer/cookies/body.
        der = conn.sock.getpeercert(binary_form=True)
        received = hashlib.sha256(der).hexdigest()
        if not der or not hmac.compare_digest(received, cfg['fingerprint']):
            raise ValueError('TLS PIN MISMATCH: сертификат сервера не совпадает. Данные НЕ отправлены.')
        body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode('utf-8')
        headers = {'Authorization': 'Bearer ' + cfg['token'], 'Accept': 'application/json'}
        if body is not None:
            headers['Content-Type'] = 'application/json'
        conn.request('GET' if body is None else 'POST', '/api/v1/' + path, body=body, headers=headers)
        response = conn.getresponse()
        if response.status in (301, 302, 303, 307, 308):
            raise ValueError('TLS: сервер пытается перенаправить запрос (редиректы запрещены)')
        limit = MAX_RESPONSE if path == 'preview' else 1_000_000
        data = response.read(limit + 1)
        if len(data) > limit:
            raise ValueError('Слишком большой ответ API')
        try:
            result = json.loads(data.decode('utf-8'))
        except (ValueError, UnicodeDecodeError) as exc:
            raise ValueError('Некорректный JSON-ответ сервера') from exc
        if not isinstance(result, dict):
            raise ValueError('Некорректный ответ API')
        if response.status >= 400 or not result.get('ok'):
            raise ValueError(str(result.get('error', 'HTTP ' + str(response.status)))[:250])
        return result
    finally:
        conn.close()
