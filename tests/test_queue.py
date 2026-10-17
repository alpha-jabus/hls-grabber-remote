"""Deterministic queue and repeat-download tests; no network/ffmpeg required."""
import importlib.util
import sys
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))
spec = importlib.util.spec_from_file_location("hls_queue_server", ROOT / "server" / "server.py")
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)


class QueueTests(unittest.TestCase):
    def test_fifo_no_slot_rejection_and_deduplication(self):
        with tempfile.TemporaryDirectory() as t:
            s.DATA_DIR = Path(t)
            s.ENCRYPTION_KEY = b"x" * 32
            s.MAX_JOBS = 1
            gate = threading.Event()
            started = threading.Event()
            execution = []

            def fake_worker(job, url, headers, fmt):
                job["status"] = "running"
                s.save_job(job)
                execution.append(url)
                started.set()
                gate.wait(timeout=4)
                Path(job["path"]).touch()
                job["status"] = "done"
                s.save_job(job)

            with patch.object(s, "check_url", lambda url: url), patch.object(s, "worker", fake_worker):
                jobs = []
                for n in range(4):
                    entry = s.start_download({"url":f"https://public.example/video{n}.m3u8", "headers":[], "format":"mp4"})
                    self.assertTrue(entry["ok"])
                    self.assertFalse(entry["existing"])
                    jobs.append(entry)
                self.assertTrue(started.wait(timeout=3))
                self.assertEqual(execution, ["https://public.example/video0.m3u8"])
                self.assertEqual(sum(j["status"] == "queued" for j in s.get_jobs()),3)
                duplicate = s.start_download({"url":"https://public.example/video2.m3u8","headers":[],"format":"mp4"})
                self.assertTrue(duplicate["existing"])
                self.assertEqual(duplicate["id"], jobs[2]["id"])
                gate.set()
                s.PENDING.join()
                self.assertEqual(execution, [f"https://public.example/video{n}.m3u8" for n in range(4)])
                self.assertEqual(sum(j["status"] == "done" for j in s.get_jobs()),4)


if __name__ == "__main__":
    unittest.main()
