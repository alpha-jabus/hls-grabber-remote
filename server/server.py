#!/usr/bin/env python3
"""Authenticated HLS preview/download HTTP backend. Python 3.9+ + ffmpeg/ffprobe."""
import base64
import hashlib
import queue
import hmac
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from hlscrypto import load_key, encrypt_stream

TOKEN = os.environ.get("HLS_API_TOKEN", "")
BIND = os.environ.get("HLS_BIND", "127.0.0.1")
PORT = int(os.environ.get("HLS_PORT", "8765"))
TLS_CERT = os.environ.get("HLS_TLS_CERT", "")
TLS_KEY = os.environ.get("HLS_TLS_KEY", "")
DATA_DIR = Path(os.environ.get("HLS_DATA_DIR", str(Path.home() / "hls-grabber-data"))).expanduser()
MAX_BYTES = int(os.environ.get("HLS_MAX_DOWNLOAD_GB", "8")) * (1024 ** 3)
MAX_JOBS = int(os.environ.get("HLS_MAX_JOBS", "2"))
KEY_FILE = os.environ.get("HLS_ENCRYPTION_KEY_FILE", str(Path.home() / ".config/hls-grabber-server/encryption.key"))
ENCRYPTION_KEY = None  # loaded at startup; never returned over API
PENDING = queue.Queue()
WORKERS_STARTED = False
PROBE_LIMIT = threading.BoundedSemaphore(2)
JOB_LOCK = threading.Lock()
HEADER_NAMES = re.compile(r"^[A-Za-z0-9-]{1,64}$")
HEADERS_ALLOWED = {
    "origin", "referer", "authorization", "authorizations", "accepts-controls",
    "cookie", "user-agent", "accept", "accept-language"
}


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def check_url(value):
    if not isinstance(value, str) or not 8 <= len(value) <= 200000:
        raise ApiError("Недопустимая длина URL")
    try:
        p = urlsplit(value)
        port = p.port
    except ValueError:
        raise ApiError("Недопустимый URL")
    if p.scheme not in ("http", "https") or not p.hostname or p.username or p.password or p.fragment:
        raise ApiError("Допустимы только URL http(s) без userinfo и fragment")
    if port is not None and port not in (80, 443):
        raise ApiError("Разрешены только порты 80 и 443")
    host = p.hostname.strip(".").lower()
    if host in ("localhost",) or host.endswith((".localhost", ".local", ".internal", ".test", ".invalid")):
        raise ApiError("Локальные адреса запрещены")
    try:
        addresses = socket.getaddrinfo(host, port or (443 if p.scheme == "https" else 80), type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError):
        raise ApiError("Не удалось разрешить DNS-имя")
    if not addresses:
        raise ApiError("DNS не вернул адресов")
    for addr in addresses:
        ip = ipaddress.ip_address(addr[4][0])
        if not ip.is_global:
            raise ApiError("Адрес указывает на внутреннюю или служебную сеть")
    return value


def check_headers(value):
    if not isinstance(value, list) or len(value) > 24:
        raise ApiError("Недопустимый список заголовков")
    result, total = [], 0
    for item in value:
        if not isinstance(item, dict):
            raise ApiError("Недопустимый заголовок")
        name, val = item.get("name"), item.get("value")
        if not isinstance(name, str) or not HEADER_NAMES.fullmatch(name):
            raise ApiError("Недопустимое имя заголовка")
        if name.lower() not in HEADERS_ALLOWED and not re.fullmatch(r"x-[a-z0-9-]+", name.lower()):
            continue
        if not isinstance(val, str) or any(ch in val for ch in "\r\n\x00") or len(val) > 32768:
            raise ApiError("Недопустимое значение заголовка")
        total += len(name) + len(val)
        if total > 100000:
            raise ApiError("Слишком много данных заголовков")
        result.append({"name":name, "value":val})
    return result


def clean_name(name):
    if not isinstance(name, str):
        return "video"
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f\x7f]', "_", name[:125]).strip(" .")
    name = re.sub(r"\.(mp4|mkv)$", "", name, flags=re.I)
    return name or "video"


def input_args(url, headers):
    # Limit protocols of nested HLS references; prohibit file:, ftp:, data:, etc.
    args = ["-protocol_whitelist", "http,https,tcp,tls,crypto",
            "-rw_timeout", "9000000"]
    extra = []
    for h in headers:
        k = h["name"].lower()
        if k == "user-agent":
            args += ["-user_agent", h["value"]]
        elif k == "referer":
            args += ["-referer", h["value"]]
        else:
            extra.append(f'{h["name"]}: {h["value"]}\r\n')
    if extra:
        args += ["-headers", "".join(extra)]
    return args + ["-i", url]


def quiet_run(args, timeout, max_output=2_000_000):
    # communicate() has a timeout; stdout is capped after process finishes. ffmpeg images
    # are kept small by scale filters, and the subprocess is killed on timeout.
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            stdin=subprocess.DEVNULL, start_new_session=True)
    try:
        out, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        raise ApiError("Истекло время ожидания ffmpeg/ffprobe", 504)
    if proc.returncode:
        raise ApiError("Не удалось прочитать поток. Возможно, истёк токен сайта.", 422)
    if len(out) > max_output:
        raise ApiError("Предпросмотр слишком большой", 422)
    return out


def probe(url, headers):
    args = ["ffprobe", "-v", "error", "-show_entries",
            "format=duration:stream=codec_type,width,height", "-of", "json"]
    args += input_args(url, headers)
    try:
        obj = json.loads(quiet_run(args, 17, 100000))
    except (ValueError, UnicodeError):
        raise ApiError("Некорректный ответ ffprobe", 422)
    duration = None
    try:
        number = float(obj.get("format", {}).get("duration"))
        if math.isfinite(number) and 0 < number < 86400 * 3:
            duration = round(number, 1)
    except (ValueError, TypeError):
        pass
    streams = [s for s in obj.get("streams", []) if s.get("codec_type") == "video"]
    video = streams[0] if streams else {}
    return {"duration":duration, "width":video.get("width"), "height":video.get("height")}


def preview(request):
    url, headers = check_url(request.get("url")), check_headers(request.get("headers", []))
    mode = request.get("mode", "image")
    if mode not in ("image", "gif"):
        raise ApiError("Режим должен быть image или gif")
    if not PROBE_LIMIT.acquire(blocking=False):
        raise ApiError("Сервер занят предпросмотрами, повтори запрос", 429)
    try:
        info = probe(url, headers)
        # Representative frame, not the m3u8's first frame (often a slate/intro).
        at = min(20.0, max(0.0, (info["duration"] or 30.0) * 0.15))
        args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin"]
        args += input_args(url, headers)
        args += ["-ss", f"{at:g}", "-an", "-sn"]
        if mode == "gif":
            args += ["-t", "3", "-vf", "fps=3,scale=320:-2:flags=bicubic",
                     "-loop", "0", "-f", "gif", "pipe:1"]
            mime, limit = "image/gif", 1_600_000
        else:
            args += ["-frames:v", "1", "-vf", "scale=480:-2:flags=bicubic",
                     "-q:v", "5", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"]
            mime, limit = "image/jpeg", 400_000
        try:
            raw = quiet_run(args, 25, limit)
        except ApiError:
            # Live or very short streams may not support seeking to the midpoint.
            # For those, try a frame at the start before declaring the preview broken.
            if at == 0:
                raise
            fallback = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin"]
            fallback += input_args(url, headers) + ["-an", "-sn"]
            if mode == "gif":
                fallback += ["-t", "3", "-vf", "fps=3,scale=320:-2:flags=bicubic",
                             "-loop", "0", "-f", "gif", "pipe:1"]
            else:
                fallback += ["-frames:v", "1", "-vf", "scale=480:-2:flags=bicubic",
                             "-q:v", "5", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"]
            raw = quiet_run(fallback, 20, limit)
        if not raw:
            raise ApiError("Пустой предпросмотр", 422)
        return {"ok":True, "info":info, "mime":mime,
                "image":base64.b64encode(raw).decode("ascii")}
    finally:
        PROBE_LIMIT.release()


def job_dir():
    p = DATA_DIR / "jobs"
    p.mkdir(parents=True, exist_ok=True, mode=0o700)
    return p


def save_job(job):
    p = job_dir() / (job["id"] + ".json")
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, p)


def get_jobs():
    jobs = []
    for path in job_dir().glob("*.json"):
        try:
            job = json.loads(path.read_text(encoding="utf-8"))
            if job.get("status") == "done" and not Path(job.get("path", "")).is_file():
                job.update(status="failed", error="Файл удалён с сервера, загрузку можно повторить")
                save_job(job)
            jobs.append(job)
        except (OSError, ValueError, TypeError):
            continue
    jobs.sort(key=lambda s: s.get("created", 0), reverse=True)
    return jobs


def source_id(url):
    # No signed playlist URL or HTTP headers are persisted in job metadata.
    return hashlib.sha256(url.encode("utf-8")).hexdigest()


def worker(job, url, headers, file_format):
    job.update(status="running", started=time.time(), bytes=0, seconds=0)
    save_job(job)
    # MP4 needs fragmented output, because normal faststart MP4 cannot write to a pipe.
    args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y"]
    args += input_args(url, headers)
    if file_format == "mp4":
        args += ["-map", "0:v:0?", "-map", "0:a:0?", "-c", "copy",
                 "-movflags", "frag_keyframe+empty_moov+default_base_moof",
                 "-f", "mp4", "pipe:1"]
    else:
        args += ["-map", "0", "-c", "copy", "-f", "matroska", "pipe:1"]
    partial = Path(job["path"] + ".part")
    output = Path(job["path"])
    process = None
    try:
        process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   stdin=subprocess.DEVNULL, start_new_session=True)
        # Don't use Popen as context manager: on disk-full/size-limit errors it would
        # WAIT on ffmpeg while its output pipe is blocked. Terminate explicitly instead.
        last_save = time.monotonic()
        def report_progress(count):
            nonlocal last_save
            job["bytes"] = count
            if time.monotonic() - last_save >= 1:
                save_job(job)
                last_save = time.monotonic()
        plaintext_bytes = encrypt_stream(process.stdout, partial, ENCRYPTION_KEY, MAX_BYTES, report_progress)
        process.stdout.close()
        code = process.wait(timeout=20)
        if code:
            raise RuntimeError("ffmpeg завершился с ошибкой. Поток/токен мог устареть.")
        if plaintext_bytes == 0:
            raise RuntimeError("ffmpeg вернул пустое видео")
        os.replace(partial, output)
        job.update(status="done", bytes=plaintext_bytes, returncode=0)
    except Exception as exc:
        if process is not None and process.poll() is None:
            process.kill()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        job.update(status="failed", error=str(exc)[:160])
    finally:
        if process is not None and process.stdout is not None:
            process.stdout.close()
        partial.unlink(missing_ok=True)
        job["finished"] = time.time()
        save_job(job)


def _queue_worker():
    while True:
        job, url, headers, file_format = PENDING.get()
        try:
            worker(job, url, headers, file_format)
        except BaseException:
            job.update(status="failed", error="Неожиданная ошибка обработчика", finished=time.time())
            save_job(job)
        finally:
            PENDING.task_done()


def ensure_workers():
    global WORKERS_STARTED
    with JOB_LOCK:
        if WORKERS_STARTED:
            return
        if MAX_JOBS < 1:
            raise ApiError("HLS_MAX_JOBS должен быть не меньше 1", 503)
        # We intentionally don't store playlist URLs or browser cookies in the queue file.
        # After a restart such tasks cannot resume and must be requested again.
        for job in get_jobs():
            if job.get("status") in ("queued", "running"):
                job.update(status="failed", finished=time.time(),
                           error="Сервер перезапущен, повтори загрузку")
                save_job(job)
        for index in range(MAX_JOBS):
            threading.Thread(target=_queue_worker, name=f"hls-worker-{index}", daemon=True).start()
        WORKERS_STARTED = True


def start_download(request):
    url, headers = check_url(request.get("url")), check_headers(request.get("headers", []))
    file_format = request.get("format", "mp4")
    if file_format not in ("mp4", "mkv"):
        raise ApiError("Недопустимый формат")
    if ENCRYPTION_KEY is None:
        raise ApiError("Сервер не настроен для AES-256-GCM", 503)
    ensure_workers()
    sid = source_id(url)
    with JOB_LOCK:
        for prev in get_jobs():
            if prev.get("source_id") == sid and prev.get("status") in ("queued", "running", "done"):
                # Preserve idempotency even if multiple requests arrive together.
                return {"ok":True, "id":prev["id"], "path":prev["path"],
                        "status":prev["status"], "existing":True}
        out_dir = DATA_DIR / "downloads"
        out_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        name = clean_name(request.get("name", "video"))
        job_id = uuid.uuid4().hex
        output = out_dir / f"{name}-{job_id[:8]}.{file_format}.hlsaes"
        job = {"id":job_id,"name":output.name,"path":str(output),
               "source_id":sid,"encrypted":True,"format":file_format,
               "created":time.time(),"status":"queued"}
        save_job(job)
        PENDING.put((job, url, headers, file_format))
    return {"ok":True,"id":job_id,"path":str(output),"status":"queued", "existing":False}


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(20)

    server_version = "HLS-Grabber/2"
    sys_version = ""

    def log_message(self, _format, *_args):
        # Never log URLs, tokens, request bodies, or even the requester IP by default.
        pass

    def send_json(self, payload, status=200):
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def authenticated(self):
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer ") or not hmac.compare_digest(header[7:], TOKEN):
            self.send_json({"ok":False,"error":"Неверный API-токен"}, 401)
            return False
        return True

    def do_GET(self):
        if not self.authenticated():
            return
        if self.path == "/api/v1/jobs":
            return self.send_json({"ok":True,"jobs":get_jobs()[:20]})
        if self.path == "/api/v1/health":
            return self.send_json({"ok":True,"service":"hls-grabber"})
        self.send_json({"ok":False,"error":"Неизвестный путь"}, 404)

    def do_POST(self):
        if not self.authenticated():
            return
        if self.path not in ("/api/v1/preview", "/api/v1/download"):
            return self.send_json({"ok":False,"error":"Неизвестный путь"}, 404)
        try:
            length = int(self.headers.get("Content-Length", "-1"))
            if length < 2 or length > 350000:
                raise ApiError("Некорректный размер запроса", 413)
            if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
                raise ApiError("Ожидается JSON")
            raw = self.rfile.read(length)
            request = json.loads(raw)
            if not isinstance(request, dict):
                raise ApiError("Ожидается объект JSON")
            result = preview(request) if self.path.endswith("/preview") else start_download(request)
            self.send_json(result)
        except ApiError as exc:
            self.send_json({"ok":False,"error":str(exc)}, exc.status)
        except (ValueError, UnicodeError):
            self.send_json({"ok":False,"error":"Некорректный JSON"}, 400)


def main():
    global ENCRYPTION_KEY
    if len(TOKEN) < 32 or TOKEN.lower() in ("changeme", "test", "placeholder"):
        sys.exit("HLS_API_TOKEN: задай случайный секрет длиной не менее 32 символов")
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        sys.exit("Не найдены ffmpeg/ffprobe. Установи ffmpeg.")
    try:
        ENCRYPTION_KEY = load_key(KEY_FILE)
    except (OSError, ValueError) as exc:
        sys.exit(f"Не удалось прочитать AES-256-GCM ключ ({KEY_FILE}): {exc}")
    os.umask(0o077)
    DATA_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    ensure_workers()
    server = ThreadingHTTPServer((BIND, PORT), Handler)
    if bool(TLS_CERT) != bool(TLS_KEY):
        sys.exit("Нужно указать одновременно HLS_TLS_CERT и HLS_TLS_KEY")
    if TLS_CERT:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(TLS_CERT, TLS_KEY)
        server.socket = context.wrap_socket(server.socket, server_side=True)
    print(f"HLS Grabber API: {'HTTPS' if TLS_CERT else 'HTTP'} {BIND}:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
