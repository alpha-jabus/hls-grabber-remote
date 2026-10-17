#!/usr/bin/env python3
"""Firefox native messaging host and detached ffmpeg worker. Linux, Python 3.9+."""
import json
import base64
from pinned_client import read_config, write_config, pinned_request, CONFIG_FILE
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import time
import uuid
from urllib.parse import urlsplit

APP = "local.hls_grabber"
STATE_DIR = Path.home() / ".cache" / "hls-grabber" / "jobs"
HEADER_NAMES = re.compile(r"^[A-Za-z0-9-]+$")
SUPPORTED_HEADERS = {
    "origin", "referer", "authorization", "authorizations", "accepts-controls",
    "cookie", "user-agent", "accept", "accept-language"
}


def ensure_state_dir():
    STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(STATE_DIR, 0o700)


def file_for(job_id):
    return STATE_DIR / (job_id + ".json")


def write_state(state):
    ensure_state_dir()
    dst = file_for(state["id"])
    tmp = dst.with_name(dst.name + ".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
    tmp.replace(dst)


def download_directory():
    try:
        result = subprocess.run(["xdg-user-dir", "DOWNLOAD"], capture_output=True,
                                text=True, timeout=2, check=True)
        value = result.stdout.strip()
        if value and value.startswith("/"):
            return Path(value)
    except (OSError, subprocess.SubprocessError):
        pass
    return Path.home() / "Downloads"


def cleaned_name(name):
    name = str(name or "video")[:150]
    name = re.sub(r"[\\/:*?\"<>|\x00-\x1f\x7f]", "_", name)
    name = name.strip(" .") or "video"
    return name[:100]


def select_output(name, file_format):
    folder = download_directory()
    folder.mkdir(parents=True, exist_ok=True)
    name = cleaned_name(name)
    ext = "mkv" if file_format == "mkv" else "mp4"
    # Avoid repeated extensions when the tab title already includes one.
    name = re.sub(r"\.(mp4|mkv)$", "", name, flags=re.I)
    candidate = folder / (name + "." + ext)
    n = 2
    while candidate.exists():
        candidate = folder / (f"{name} ({n}).{ext}")
        n += 1
    return candidate


def validate_stream(msg):
    url = msg.get("url", "")
    if not isinstance(url, str) or not (0 < len(url) <= 250000):
        raise ValueError("Invalid HLS URL")
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("Only HTTP(S) URLs can be downloaded")
    file_format = msg.get("format")
    if file_format not in ("mp4", "mkv"):
        raise ValueError("Choose MP4 or MKV")
    result = []
    for h in msg.get("headers", []):
        if not isinstance(h, dict):
            continue
        name, value = h.get("name"), h.get("value")
        if not isinstance(name, str) or not isinstance(value, str):
            continue
        if not HEADER_NAMES.fullmatch(name):
            continue
        lower = name.lower()
        if lower not in SUPPORTED_HEADERS and not re.fullmatch(r"x-[a-z0-9-]+", lower):
            continue
        if "\r" in value or "\n" in value or "\x00" in value:
            continue
        result.append({"name":name,"value":value})
    return url, result, file_format


def ffmpeg_args(msg):
    url, headers, file_format = validate_stream(msg)
    args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
            "-n", "-stats_period", "1", "-progress", "pipe:1"]
    user_agent, referer, extra = None, None, []
    for h in headers:
        key = h["name"].lower()
        if key == "user-agent":
            user_agent = h["value"]
        elif key == "referer":
            referer = h["value"]
        else:
            extra.append(f"{h['name']}: {h['value']}\r\n")
    if user_agent:
        args.extend(["-user_agent", user_agent])
    if referer:
        args.extend(["-referer", referer])
    if extra:
        args.extend(["-headers", "".join(extra)])
    args += ["-i", url]
    if file_format == "mp4":
        args += ["-c", "copy", "-movflags", "+faststart"]
    else:
        args += ["-map", "0", "-c", "copy"]
    args.append(msg["output"])
    return args


def run_worker():
    # Payload is received through an anonymous pipe, never saved to disk.
    try:
        message = json.loads(sys.stdin.buffer.readline())
        job_id = message["job_id"]
        if not re.fullmatch(r"[a-f0-9]{32}", job_id):
            return 2
        state = json.loads(file_for(job_id).read_text(encoding="utf-8"))
        args = ffmpeg_args(message)
        state.update(status="running", started=time.time(), bytes=0, seconds=0)
        write_state(state)
        # Keep even stderr free of tokens in persistent logs.
        with subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              text=True, errors="replace", bufsize=1) as proc:
            last_save = 0
            for line in proc.stdout:
                key, _, value = line.strip().partition("=")
                if key == "total_size" and value.isdigit():
                    state["bytes"] = int(value)
                elif key in ("out_time_us", "out_time_ms") and value.isdigit():
                    state["seconds"] = int(value) / 1000000
                elif key == "speed":
                    state["speed"] = value
                if (time.monotonic() - last_save >= 1.0 or key == "progress"):
                    write_state(state)
                    last_save = time.monotonic()
            code = proc.wait()
        state["status"] = "done" if code == 0 else "failed"
        state["finished"] = time.time()
        state["returncode"] = code
        if code:
            state["error"] = f"ffmpeg завершился с кодом {code}. URL/токен мог устареть; попробуй ещё раз."
        write_state(state)
        return code
    except Exception as exc:
        if "state" in locals():
            state.update(status="failed", error=str(exc)[:300], finished=time.time())
            write_state(state)
        return 1


def respond(payload):
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def recv():
    header = sys.stdin.buffer.read(4)
    if len(header) != 4:
        raise EOFError("No native message")
    (size,) = struct.unpack("=I", header)
    if size > 3_000_000:
        raise ValueError("Request too large")
    content = sys.stdin.buffer.read(size)
    if len(content) != size:
        raise ValueError("Truncated message")
    return json.loads(content)


def start_download(msg):
    if shutil.which("ffmpeg") is None:
        raise FileNotFoundError("ffmpeg не установлен. Установи его через пакетный менеджер.")
    url, headers, file_format = validate_stream(msg)
    # Do not persist URL, cookie, or bearer headers.
    output = select_output(msg.get("name", "video"), file_format)
    job_id = uuid.uuid4().hex
    state = {
        "id":job_id, "name":output.name, "path":str(output),
        "status":"queued", "created":time.time()
    }
    write_state(state)
    worker = {
        "job_id":job_id, "url":url, "headers":headers,
        "format":file_format, "output":str(output)
    }
    try:
        process = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "--worker"],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True, close_fds=True)
        process.stdin.write((json.dumps(worker, ensure_ascii=False) + "\n").encode("utf-8"))
        process.stdin.close()
    except OSError:
        state.update(status="failed", error="Не удалось запустить процесс загрузки")
        write_state(state)
        raise
    return {"ok":True, "id":job_id, "path":str(output)}


def recent_jobs():
    ensure_state_dir()
    records = []
    for path in STATE_DIR.glob("*.json"):
        try:
            obj = json.loads(path.read_text(encoding="utf-8"))
            records.append(obj)
        except (OSError, json.JSONDecodeError):
            continue
    records.sort(key=lambda item: item.get("created", 0), reverse=True)
    return records[:12]


def respond_chunks(payload):
    # Firefox native messaging imposes a 1-MB-per-message limit.
    encoded = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    if len(encoded) < 600000:
        respond(payload)
        return
    count = (len(encoded) + 449999) // 450000
    for i in range(count):
        part = encoded[i * 450000:(i + 1) * 450000]
        respond({'native_chunk': True, 'part': i, 'total': count,
                 'data': base64.b64encode(part).decode('ascii')})


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--worker":
        sys.exit(run_worker())
    try:
        msg = recv()
        if not isinstance(msg, dict):
            raise ValueError("Bad message")
        if msg.get("action") == "download":
            respond(start_download(msg))
        elif msg.get("action") == "jobs":
            respond({"ok": True, "jobs":recent_jobs()})
        elif msg.get("action") == "pinned_config_get":
            respond({"ok": True, "config": read_config(), "path": str(CONFIG_FILE)})
        elif msg.get("action") == "pinned_config_save":
            write_config(msg.get("config"))
            respond({"ok": True, "path": str(CONFIG_FILE)})
        elif msg.get("action") == "pinned_request":
            respond_chunks(pinned_request(msg.get("path"), msg.get("payload")))
        else:
            respond({"ok":False,"error":"Unknown native action"})
    except (ValueError, OSError, EOFError, TimeoutError) as exc:
        respond({"ok":False,"error":str(exc)[:400]})


if __name__ == "__main__":
    main()
