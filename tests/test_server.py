import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("hls_server", ROOT / "server" / "server.py")
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)


class Tests(unittest.TestCase):
    def test_reject_private_and_header_injection(self):
        for bad in ["http://127.0.0.1/private.m3u8", "http://localhost/a.m3u8",
                    "file:///etc/passwd", "http://169.254.169.254/latest/meta-data",
                    "http://a.com:22/foo", "https://user:pass@public.com/a.m3u8"]:
            with self.subTest(url=bad), self.assertRaises(s.ApiError):
                s.check_url(bad)
        with patch.object(s.socket, "getaddrinfo", return_value=[(2,1,6,'',('192.168.1.5',80))]):
            with self.assertRaises(s.ApiError): s.check_url("https://mypublic.domain/master.m3u8")
        with patch.object(s.socket, "getaddrinfo", return_value=[(2,1,6,'',('8.8.8.8',443))]):
            self.assertEqual(s.check_url("https://mypublic.domain/master.m3u8"), "https://mypublic.domain/master.m3u8")
        with self.assertRaises(s.ApiError):
            s.check_headers([{"name":"Cookie", "value":"ok\r\nHost:127.0.0.1"}])
        self.assertEqual(s.clean_name("../../evil:name"), "_.._evil_name")

    def test_auth_preview_gif_download_hls(self):
        if not all(subprocess.run([p, "-version"], capture_output=True).returncode == 0 for p in ("ffmpeg","ffprobe")):
            self.skipTest("ffmpeg binaries are required")
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            media = root / "media"; media.mkdir()
            subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
                "-i", "testsrc2=size=320x180:rate=12", "-t", "7", "-c:v", "mpeg2video",
                "-g", "24", "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod",
                str(media / "master.m3u8")
            ], check=True)
            # Need loopback as the test media source; production check_url must never be bypassed.
            class QuietSimple(SimpleHTTPRequestHandler):
                def __init__(self, *a, **kw): super().__init__(*a, directory=str(media), **kw)
                def log_message(self, *args): pass
            media_http = ThreadingHTTPServer(("127.0.0.1", 0), QuietSimple)
            threading.Thread(target=media_http.serve_forever, daemon=True).start()
            media_url = f"http://127.0.0.1:{media_http.server_port}/master.m3u8"
            s.TOKEN = "test_" + "a" * 64
            s.DATA_DIR = root / "jobs_and_media"
            s.MAX_BYTES = 20_000_000
            api = ThreadingHTTPServer(("127.0.0.1", 0), s.Handler)
            threading.Thread(target=api.serve_forever, daemon=True).start()
            base = f"http://127.0.0.1:{api.server_port}"
            def post(path, payload, token=s.TOKEN):
                req = urllib.request.Request(base+path, data=json.dumps(payload).encode(),
                      headers={"Authorization":"Bearer " + token,"Content-Type":"application/json"}, method="POST")
                with urllib.request.urlopen(req, timeout=45) as f:
                    return json.load(f)
            def get(path, token=s.TOKEN):
                req = urllib.request.Request(base+path,headers={"Authorization":"Bearer " + token})
                with urllib.request.urlopen(req,timeout=10) as f: return json.load(f)
            try:
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    get("/api/v1/health", "badtoken")
                self.assertEqual(caught.exception.code, 401)
                self.assertTrue(get("/api/v1/health")["ok"])
                with patch.object(s, "check_url", lambda url: url):
                    jpg = post("/api/v1/preview", {"url":media_url,"headers":[],"mode":"image"})
                    self.assertEqual(jpg["mime"], "image/jpeg")
                    self.assertGreater(jpg["info"]["width"], 100)
                    import base64
                    self.assertTrue(base64.b64decode(jpg["image"]).startswith(b"\xff\xd8"))
                    gif = post("/api/v1/preview", {"url":media_url,"headers":[],"mode":"gif"})
                    self.assertTrue(base64.b64decode(gif["image"]).startswith(b"GIF8"))
                    job = post("/api/v1/download", {"url":media_url, "headers":[], "name":"smoke", "format":"mp4"})
                    self.assertTrue(job["ok"])
                    for _ in range(50):
                        status = next(j for j in get("/api/v1/jobs")["jobs"] if j["id"] == job["id"])
                        if status["status"] in ("done", "failed"): break
                        time.sleep(.15)
                    self.assertEqual(status["status"], "done", status)
                    self.assertGreater(Path(status["path"]).stat().st_size, 1000)
            finally:
                api.shutdown(); api.server_close()
                media_http.shutdown(); media_http.server_close()

if __name__ == "__main__": unittest.main()
