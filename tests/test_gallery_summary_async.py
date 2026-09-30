from __future__ import annotations

import json
import struct
import tempfile
import threading
import time
import unittest
import urllib.parse
import urllib.request
import zlib
from pathlib import Path
from typing import Any

from gallery_db import GalleryStore
from gallery_server import GalleryRequestHandler
from http.server import ThreadingHTTPServer


def png_bytes() -> bytes:
    signature = b"\x89PNG\r\n\x1a\n"

    def chunk(name: bytes, body: bytes) -> bytes:
        return (
            struct.pack(">I", len(body))
            + name
            + body
            + struct.pack(">I", zlib.crc32(name + body) & 0xFFFFFFFF)
        )

    raw = b"\x00\xff\xff\xff"
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    return signature + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def wait_for(predicate: Any, timeout: float = 3.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError("background sync did not reach the expected state")


class GallerySummaryAsyncTests(unittest.TestCase):
    def test_summary_returns_from_existing_index_while_scan_runs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "output"
            root.mkdir()
            store = GalleryStore(root, Path(temporary) / "gallery.sqlite3")
            server: ThreadingHTTPServer | None = None
            server_thread: threading.Thread | None = None
            try:
                store.sync()
                image = root / "new.png"
                image.write_bytes(png_bytes())
                image.with_name(image.name + ".metadata.json").write_text(
                    json.dumps({"job_id": "job-1", "batch_id": "batch-1"}),
                    encoding="utf-8",
                )
                # The real five-second signature throttle is retained; this
                # test forces the same changed-root path without sleeping.
                store._last_signature_check_at = 0.0
                original_sync = store.sync

                def slow_sync(*, force: bool = False) -> int:
                    time.sleep(0.25)
                    return original_sync(force=force)

                store.sync = slow_sync  # type: ignore[method-assign]
                handler = type(
                    "TestGalleryRequestHandler",
                    (GalleryRequestHandler,),
                    {"store": store, "web_root": root},
                )
                server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
                server_thread = threading.Thread(target=server.serve_forever, daemon=True)
                server_thread.start()
                url = "http://127.0.0.1:%d/api/images/summary?%s" % (
                    server.server_port,
                    urllib.parse.urlencode({"job_id": "job-1"}),
                )
                started = time.perf_counter()
                with urllib.request.urlopen(url, timeout=2) as response:
                    payload = json.loads(response.read().decode("utf-8"))
                elapsed = time.perf_counter() - started

                self.assertLess(elapsed, 0.20)
                self.assertEqual(
                    set(payload["summary"]),
                    {
                        "job_id",
                        "total",
                        "batch_count",
                        "ai_scored",
                        "adopt_candidate",
                        "hold_candidate",
                        "reject_candidate",
                    },
                )
                self.assertEqual(payload["summary"]["total"], 0)
                self.assertTrue(store.sync_status()["running"])
                wait_for(lambda: not store.sync_status()["running"])
                self.assertEqual(store.job_summary("job-1")["total"], 1)
                self.assertEqual(store.job_summary("missing")["total"], 0)
            finally:
                if server is not None:
                    server.shutdown()
                    server.server_close()
                if server_thread is not None:
                    server_thread.join(timeout=2)
                store.close()

    def test_failed_background_sync_keeps_existing_index(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "output"
            root.mkdir()
            image = root / "existing.png"
            image.write_bytes(png_bytes())
            image.with_name(image.name + ".metadata.json").write_text(
                json.dumps({"job_id": "job-existing"}), encoding="utf-8"
            )
            store = GalleryStore(root, Path(temporary) / "gallery.sqlite3")
            try:
                store.sync()
                store._last_signature_check_at = 0.0

                def failed_sync(*, force: bool = False) -> int:
                    raise OSError("test scan failure")

                store.sync = failed_sync  # type: ignore[method-assign]
                store.request_background_sync()
                wait_for(lambda: not store.sync_status()["running"])
                self.assertIn("OSError", str(store.sync_status()["last_error"]))
                self.assertEqual(store.job_summary("job-existing")["total"], 1)
            finally:
                store.close()


if __name__ == "__main__":
    unittest.main()
