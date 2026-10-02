from __future__ import annotations

import json
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import gallery_server


class FakeGenerationBackendHandler(BaseHTTPRequestHandler):
    last_payload: dict[str, object] | None = None

    def _json(self, value: object, status: int = 200) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/api/generation/options":
            return self._json(
                {
                    "models": [{"key": "animagine", "display_name": "Animagine"}],
                    "ratings": ["safe"],
                    "sizes": [{"key": "square", "label": "1024", "width": 1024, "height": 1024}],
                    "character_presets": [],
                    "loras": {"character": [], "style": [], "additional": []},
                }
            )
        if self.path == "/api/generation/jobs/job-1":
            return self._json({"job_id": "job-1", "state": "completed", "progress": 1.0, "output": {"image_count": 1}})
        if self.path == "/api/generation/health":
            return self._json({"service_ready": True})
        return self._json({"error": "not found"}, 404)

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        FakeGenerationBackendHandler.last_payload = json.loads(self.rfile.read(length).decode("utf-8"))
        return self._json(
            {
                "job_id": "job-1",
                "state": "queued",
                "progress": 0.0,
                "path": r"C:\private\should-not-leak.png",
            },
            202,
        )

    def log_message(self, _format: str, *_args: object) -> None:
        return


class GalleryGenerationProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.backend = ThreadingHTTPServer(("127.0.0.1", 0), FakeGenerationBackendHandler)
        cls.backend_thread = threading.Thread(target=cls.backend.serve_forever, daemon=True)
        cls.backend_thread.start()
        cls.previous_backend_url = os.environ.get("GALLERY_GENERATION_BACKEND_URL")
        os.environ["GALLERY_GENERATION_BACKEND_URL"] = f"http://127.0.0.1:{cls.backend.server_address[1]}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.backend.shutdown()
        cls.backend.server_close()
        cls.backend_thread.join(timeout=2)
        if cls.previous_backend_url is None:
            os.environ.pop("GALLERY_GENERATION_BACKEND_URL", None)
        else:
            os.environ["GALLERY_GENERATION_BACKEND_URL"] = cls.previous_backend_url

    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        root = Path(self.temporary.name)
        configured_web_root = root / "web"
        configured_web_root.mkdir()

        class ConfiguredHandler(gallery_server.GalleryRequestHandler):
            store = None  # type: ignore[assignment]
            web_root = configured_web_root

        self.handler_class = ConfiguredHandler
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self.handler_class)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temporary.cleanup()

    def request(self, method: str, path: str, payload: object | None = None, headers: dict[str, str] | None = None):
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        request = Request(
            f"http://127.0.0.1:{self.server.server_address[1]}{path}",
            data=data,
            headers={"Content-Type": "application/json", **(headers or {})},
            method=method,
        )
        try:
            with urlopen(request, timeout=3) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            return error.code, json.loads(error.read().decode("utf-8"))

    def test_options_proxy_forwards_backend_contract(self) -> None:
        status, value = self.request("GET", "/api/generation/options")
        self.assertEqual(status, 200)
        self.assertEqual(value["models"][0]["key"], "animagine")

    def test_localhost_post_forwards_safe_json_and_returns_job(self) -> None:
        payload = {"model_key": "animagine", "count": 1, "loras": []}
        status, value = self.request("POST", "/api/generation/jobs", payload)
        self.assertEqual(status, 202)
        self.assertEqual(value["job_id"], "job-1")
        self.assertEqual(FakeGenerationBackendHandler.last_payload, payload)
        self.assertNotIn(r"C:\private", json.dumps(value))

    def test_job_status_proxy(self) -> None:
        status, value = self.request("GET", "/api/generation/jobs/job-1")
        self.assertEqual(status, 200)
        self.assertEqual(value["state"], "completed")

    def test_only_loopback_clients_are_allowed_for_generation(self) -> None:
        self.assertTrue(gallery_server._is_loopback_client("127.0.0.1"))
        self.assertTrue(gallery_server._is_loopback_client("::1"))
        self.assertFalse(gallery_server._is_loopback_client("100.64.0.2"))
        self.assertFalse(gallery_server._is_loopback_client("192.168.1.20"))

    def test_remote_generation_post_is_forbidden_before_backend_call(self) -> None:
        with patch.object(gallery_server, "_is_loopback_client", return_value=False):
            status, value = self.request("POST", "/api/generation/jobs", {"model_key": "animagine"})
        self.assertEqual(status, 403)
        self.assertIn("生成を実行できません", value["error"])

    def test_backend_unavailable_is_sanitized_502(self) -> None:
        old = os.environ["GALLERY_GENERATION_BACKEND_URL"]
        os.environ["GALLERY_GENERATION_BACKEND_URL"] = "http://127.0.0.1:1"
        try:
            status, value = self.request("GET", "/api/generation/health")
        finally:
            os.environ["GALLERY_GENERATION_BACKEND_URL"] = old
        self.assertEqual(status, 502)
        self.assertEqual(value["error"], "Generation Backendに接続できません。")
        self.assertNotIn("Traceback", json.dumps(value))

    def test_invalid_json_and_content_type_are_rejected(self) -> None:
        status, value = self.request("POST", "/api/generation/jobs", {"x": 1}, {"Content-Type": "text/plain"})
        self.assertEqual(status, 415)
        self.assertIn("Content-Type", value["error"])

        request = Request(
            f"http://127.0.0.1:{self.server.server_address[1]}/api/generation/jobs",
            data=b"not-json",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            urlopen(request, timeout=3)
        except HTTPError as error:
            self.assertEqual(error.code, 400)
            self.assertIn("JSON", error.read().decode("utf-8"))

    def test_generation_body_limit_is_enforced(self) -> None:
        self.handler_class.generation_max_body_bytes = 16
        try:
            status, value = self.request("POST", "/api/generation/jobs", {"large": "x" * 100})
        finally:
            self.handler_class.generation_max_body_bytes = gallery_server.GENERATION_PROXY_MAX_BODY_BYTES
        self.assertEqual(status, 413)
        self.assertIn("大きすぎ", value["error"])

    def test_frontend_contains_proxy_only_generation_contract(self) -> None:
        root = Path(__file__).resolve().parents[1]
        html = (root / "gallery_web" / "index.html").read_text(encoding="utf-8")
        app = (root / "gallery_web" / "app.js").read_text(encoding="utf-8")
        self.assertIn('id="generation-submit"', html)
        self.assertIn('id="generation-freeform-character"', html)
        self.assertIn('id="generation-appearance"', html)
        self.assertIn('id="generation-request"', html)
        self.assertIn('id="generation-count"', html)
        self.assertIn('id="generation-variation"', html)
        self.assertIn('/api/generation/jobs', app)
        self.assertIn('freeform_character: $("#generation-freeform-character").value.trim() || null', app)
        self.assertNotIn("freeform_character: null", app)
        self.assertIn('character_preset: $("#generation-character-preset").value || null', app)
        self.assertIn('explicit_tags: generationTags($("#generation-explicit-tags").value)', app)
        self.assertIn('appearance_text: $("#generation-appearance").value.trim() || null', app)
        self.assertIn('request_text: $("#generation-request").value.trim() || null', app)
        self.assertIn('count: Number($("#generation-count").value || 1)', app)
        self.assertIn('variation: $("#generation-variation").value || "off"', app)
        self.assertNotIn("127.0.0.1:8787", app)


if __name__ == "__main__":
    unittest.main()
