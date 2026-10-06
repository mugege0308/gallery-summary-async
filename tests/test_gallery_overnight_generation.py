from __future__ import annotations

import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import gallery_server


class _OvernightBackendHandler(BaseHTTPRequestHandler):
    last_payload: dict[str, object] | None = None
    requests: list[str] = []

    def _json(self, value: object, status: int = 200) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        self.__class__.requests.append(self.path)
        if self.path == "/api/generation/overnight-jobs/overnight-1":
            return self._json(
                {
                    "overnight_job_id": "overnight-1",
                    "state": "paused",
                    "total_requested": 128,
                    "generated_count": 32,
                    "failed_count": 0,
                    "rounds": [],
                    "final_selected": [],
                }
            )
        return self._json({"error": "not found"}, 404)

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        self.__class__.requests.append(self.path)
        self.__class__.last_payload = json.loads(body.decode("utf-8")) if body else {}
        if self.path == "/api/generation/overnight-jobs":
            return self._json({"overnight_job_id": "overnight-1", "state": "queued", "total_requested": 128}, 202)
        if self.path.endswith("/pause"):
            return self._json({"overnight_job_id": "overnight-1", "state": "paused"}, 202)
        if self.path.endswith("/resume"):
            return self._json({"overnight_job_id": "overnight-1", "state": "running"}, 202)
        if self.path.endswith("/stop"):
            return self._json({"overnight_job_id": "overnight-1", "state": "stopping"}, 202)
        return self._json({"error": "not found"}, 404)

    def log_message(self, _format: str, *_args: object) -> None:
        return


class GalleryOvernightGenerationProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.backend = ThreadingHTTPServer(("127.0.0.1", 0), _OvernightBackendHandler)
        cls.thread = threading.Thread(target=cls.backend.serve_forever, daemon=True)
        cls.thread.start()
        cls.previous = os.environ.get("GALLERY_GENERATION_BACKEND_URL")
        os.environ["GALLERY_GENERATION_BACKEND_URL"] = f"http://127.0.0.1:{cls.backend.server_address[1]}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.backend.shutdown()
        cls.backend.server_close()
        cls.thread.join(timeout=2)
        if cls.previous is None:
            os.environ.pop("GALLERY_GENERATION_BACKEND_URL", None)
        else:
            os.environ["GALLERY_GENERATION_BACKEND_URL"] = cls.previous

    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        root = Path(self.temporary.name)
        configured_web_root = root / "web"
        configured_web_root.mkdir()

        class ConfiguredHandler(gallery_server.GalleryRequestHandler):
            store = None  # type: ignore[assignment]
            web_root = configured_web_root

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), ConfiguredHandler)
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temporary.cleanup()

    def request(self, method: str, path: str, payload: object) -> tuple[int, dict[str, object]]:
        request = Request(
            f"{self.base_url}{path}",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method=method,
        )
        try:
            with urlopen(request, timeout=3) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            return error.code, json.loads(error.read().decode("utf-8"))

    def test_overnight_create_poll_and_actions_are_forwarded(self) -> None:
        status, value = self.request("POST", "/api/generation/overnight-jobs", {"total_count": 128, "count": 1})
        self.assertEqual(202, status)
        self.assertEqual("overnight-1", value["overnight_job_id"])
        status, value = self.request("GET", "/api/generation/overnight-jobs/overnight-1", {})
        self.assertEqual(200, status)
        self.assertEqual("paused", value["state"])
        for action in ("pause", "resume", "stop"):
            status, value = self.request("POST", f"/api/generation/overnight-jobs/overnight-1/{action}", {})
            self.assertEqual(202, status)
            self.assertEqual("overnight-1", value["overnight_job_id"])
        self.assertIn("/api/generation/overnight-jobs", _OvernightBackendHandler.requests)
        self.assertIn("/api/generation/overnight-jobs/overnight-1/pause", _OvernightBackendHandler.requests)

    def test_frontend_contains_overnight_controls_and_no_backend_url(self) -> None:
        root = Path(__file__).resolve().parents[1]
        html = (root / "gallery_web" / "index.html").read_text(encoding="utf-8")
        app = (root / "gallery_web" / "app.js").read_text(encoding="utf-8")
        self.assertIn('id="generation-overnight-panel"', html)
        self.assertIn('id="generation-overnight-count"', html)
        self.assertIn('value="128"', html)
        self.assertIn('value="256"', html)
        self.assertIn('value="512"', html)
        self.assertIn('id="generation-overnight-pause"', html)
        self.assertIn('id="generation-overnight-resume"', html)
        self.assertIn('id="generation-overnight-stop"', html)
        self.assertIn('/api/generation/overnight-jobs', app)
        self.assertIn('gallery.generation.overnight_job_id', app)
        self.assertIn('Final Best4だけを見る', app)
        self.assertIn('state.generation.bulk.selectedOnly = true', app)
        self.assertIn('loadGenerationAuthStatus().finally(() => restoreOvernightJobState())', app)
        self.assertNotIn("127.0.0.1:8787", app)
