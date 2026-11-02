"""Exercise a real unprotected MPEG-DASH presentation through FFmpeg and encrypted worker."""
import importlib.util
import secrets
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from unittest import TestCase
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))
from hlscrypto import decrypt_file, MAGIC
spec = importlib.util.spec_from_file_location("hls_dash_server", ROOT / "server" / "server.py")
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)


class DASHIntegrationTests(TestCase):
    def test_dash_separate_audio_video_preview_and_encrypted_download(self):
        if not all(subprocess.run([exe, "-version"], capture_output=True).returncode == 0
                   for exe in ("ffmpeg", "ffprobe")):
            self.skipTest("FFmpeg and FFprobe are required")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media = root / "media"
            media.mkdir()
            subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12",
                "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
                "-t", "4", "-c:v", "mpeg4", "-q:v", "3", "-g", "12",
                "-c:a", "aac", "-b:a", "96k", "-f", "dash", "-seg_duration", "2",
                "-adaptation_sets", "id=0,streams=v id=1,streams=a",
                str(media / "manifest.mpd")
            ], check=True, timeout=30)

            class MediaHandler(SimpleHTTPRequestHandler):
                def __init__(self, *args, **kwargs):
                    super().__init__(*args, directory=str(media), **kwargs)

                def log_message(self, *_args):
                    pass

            http = ThreadingHTTPServer(("127.0.0.1", 0), MediaHandler)
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            try:
                url = f"http://127.0.0.1:{http.server_port}/manifest.mpd"
                info = s.probe(url, [])
                self.assertEqual(info["width"], 320)
                self.assertEqual(info["height"], 180)
                with patch.object(s, "check_url", lambda u: u):
                    preview = s.preview({"url": url, "headers": [], "mode": "image"})
                self.assertEqual(preview["mime"], "image/jpeg")
                s.DATA_DIR = root / "data"
                s.ENCRYPTION_KEY = secrets.token_bytes(32)
                job = {"id": "dash-test", "path": str(root / "dash.mp4.hlsaes"), "status": "queued"}
                s.worker(job, url, [], "mp4")
                self.assertEqual(job["status"], "done", job)
                self.assertTrue(Path(job["path"]).read_bytes().startswith(MAGIC))
                output = root / "decrypted.mp4"
                decrypt_file(job["path"], output, s.ENCRYPTION_KEY)
                metadata = subprocess.run([
                    "ffprobe", "-v", "error", "-show_entries", "stream=codec_type",
                    "-of", "csv=p=0", str(output)
                ], check=True, capture_output=True, text=True, timeout=12)
                self.assertIn("video", metadata.stdout)
                self.assertIn("audio", metadata.stdout)
            finally:
                http.shutdown()
                http.server_close()
                thread.join(timeout=5)
