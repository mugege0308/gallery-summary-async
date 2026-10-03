from __future__ import annotations

import json
import os
import threading
import unittest
from http.cookiejar import CookieJar
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, build_opener, urlopen

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
        content_type = self.headers.get("Content-Type", "")
        body = self.rfile.read(length)
        if content_type.casefold().startswith("multipart/form-data"):
            FakeGenerationBackendHandler.last_payload = {"multipart": True, "length": len(body)}
            return self._json(
                {"reference_image_id": "asset-123", "content_type": "image/png", "width": 32, "height": 24},
                201,
            )
        FakeGenerationBackendHandler.last_payload = json.loads(body.decode("utf-8"))
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
        gallery_server._GENERATION_SESSIONS.clear()
        self.cookie_jar = CookieJar()
        self.opener = build_opener(gallery_server.urllib_request.HTTPCookieProcessor(self.cookie_jar))
        root = Path(self.temporary.name)
        configured_web_root = root / "web"
        configured_web_root.mkdir()

        class ConfiguredHandler(gallery_server.GalleryRequestHandler):
            store = None  # type: ignore[assignment]
            web_root = configured_web_root

        self.handler_class = ConfiguredHandler
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self.handler_class)
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"
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
            f"{self.base_url}{path}",
            data=data,
            headers={"Content-Type": "application/json", **(headers or {})},
            method=method,
        )
        try:
            with self.opener.open(request, timeout=3) as response:
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

    def test_localhost_reference_upload_forwards_multipart(self) -> None:
        boundary = "----codex-reference"
        body = (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="file"; filename="reference.png"\r\n'
            "Content-Type: image/png\r\n\r\n"
            "fake-image-bytes\r\n"
            f"--{boundary}--\r\n"
        ).encode("utf-8")
        request = Request(
            f"http://127.0.0.1:{self.server.server_address[1]}/api/generation/references",
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        with urlopen(request, timeout=3) as response:
            status = response.status
            value = json.loads(response.read().decode("utf-8"))
        self.assertEqual(201, status)
        self.assertEqual("asset-123", value["reference_image_id"])
        self.assertTrue(FakeGenerationBackendHandler.last_payload["multipart"])

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

    def test_tailscale_generation_requires_authentication(self) -> None:
        with patch.object(gallery_server, "_client_network", return_value="tailscale"):
            status, value = self.request("POST", "/api/generation/jobs", {"model_key": "animagine"})
        self.assertEqual(status, 401)
        self.assertIn("認証", value["error"])

    def test_tailscale_auth_session_allows_job_with_csrf(self) -> None:
        headers = {"Origin": self.base_url}
        with patch.dict(os.environ, {gallery_server.GENERATION_AUTH_TOKEN_ENV: "test-secret"}), patch.object(
            gallery_server, "_client_network", return_value="tailscale"
        ):
            status, value = self.request("POST", "/api/generation/auth/session", {"token": "test-secret"}, headers)
            self.assertEqual(status, 200)
            self.assertTrue(value["authenticated"])
            csrf = value["csrf_token"]
            status, value = self.request(
                "POST",
                "/api/generation/jobs",
                {"model_key": "animagine"},
                {**headers, gallery_server.GENERATION_CSRF_HEADER: csrf},
            )
        self.assertEqual(status, 202, value)
        self.assertEqual(value["job_id"], "job-1")

    def test_remember_device_persists_across_memory_session_reset(self) -> None:
        headers = {"Origin": self.base_url}
        environment = {
            gallery_server.GENERATION_AUTH_TOKEN_ENV: "test-secret",
            gallery_server.GENERATION_SESSION_SECRET_ENV: "test-session-secret",
        }
        with patch.dict(os.environ, environment), patch.object(gallery_server, "_client_network", return_value="tailscale"):
            status, value = self.request(
                "POST",
                "/api/generation/auth/session",
                {"token": "test-secret", "remember_device": True},
                headers,
            )
            self.assertEqual(status, 200)
            self.assertTrue(value["remembered"])
            self.assertTrue(any(cookie.name == gallery_server.GENERATION_PERSISTENT_COOKIE for cookie in self.cookie_jar))
            self.assertNotIn("test-secret", "".join(cookie.value for cookie in self.cookie_jar))

            # Simulate a Gallery restart: the in-memory short session is gone,
            # while the signed device cookie remains in the browser jar.
            gallery_server._GENERATION_SESSIONS.clear()
            status, value = self.request("GET", "/api/generation/auth/status")
            self.assertEqual(status, 200)
            self.assertTrue(value["authenticated"])
            self.assertTrue(value["remembered"])
            status, value = self.request(
                "POST",
                "/api/generation/jobs",
                {"model_key": "animagine"},
                {**headers, gallery_server.GENERATION_CSRF_HEADER: value["csrf_token"]},
            )
        self.assertEqual(status, 202, value)

    def test_persistent_cookie_expiry_tamper_and_peer_binding(self) -> None:
        now = 1_800_000_000
        with patch.dict(
            os.environ,
            {gallery_server.GENERATION_SESSION_SECRET_ENV: "test-session-secret"},
            clear=False,
        ):
            value = gallery_server._encode_signed_persistent_session("100.100.133.17", now=now)
            self.assertIsNotNone(value)
            assert value is not None
            self.assertIsNotNone(
                gallery_server._decode_signed_persistent_session(value, "100.100.133.17", now=now + 1)
            )
            self.assertIsNone(
                gallery_server._decode_signed_persistent_session(
                    value[:-1] + ("0" if value[-1] != "0" else "1"), "100.100.133.17", now=now + 1
                )
            )
            self.assertIsNone(
                gallery_server._decode_signed_persistent_session(value, "100.100.133.18", now=now + 1)
            )
            self.assertIsNone(
                gallery_server._decode_signed_persistent_session(
                    value, "100.100.133.17", now=now + gallery_server.GENERATION_PERSISTENT_MAX_AGE_SECONDS
                )
            )

    def test_remember_requires_a_separate_signing_secret(self) -> None:
        headers = {"Origin": self.base_url}
        with patch.dict(
            os.environ,
            {
                gallery_server.GENERATION_AUTH_TOKEN_ENV: "test-secret",
                gallery_server.GENERATION_SESSION_SECRET_ENV: "",
            },
            clear=False,
        ), patch.object(gallery_server, "_client_network", return_value="tailscale"):
            status, value = self.request(
                "POST",
                "/api/generation/auth/session",
                {"token": "test-secret", "remember_device": True},
                headers,
            )
        self.assertEqual(status, 503)
        self.assertIn("署名secret", value["error"])
        self.assertFalse(gallery_server._GENERATION_SESSIONS)

    def test_logout_clears_short_and_persistent_sessions(self) -> None:
        headers = {"Origin": self.base_url}
        environment = {
            gallery_server.GENERATION_AUTH_TOKEN_ENV: "test-secret",
            gallery_server.GENERATION_SESSION_SECRET_ENV: "test-session-secret",
        }
        with patch.dict(os.environ, environment), patch.object(gallery_server, "_client_network", return_value="tailscale"):
            status, value = self.request(
                "POST",
                "/api/generation/auth/session",
                {"token": "test-secret", "remember_device": True},
                headers,
            )
            self.assertEqual(status, 200)
            status, value = self.request(
                "POST",
                "/api/generation/auth/logout",
                None,
                {**headers, gallery_server.GENERATION_CSRF_HEADER: value["csrf_token"]},
            )
            self.assertEqual(status, 200)
            status, value = self.request("GET", "/api/generation/auth/status")
        self.assertEqual(status, 200)
        self.assertFalse(value["authenticated"])
        self.assertFalse(any(cookie.name == gallery_server.GENERATION_PERSISTENT_COOKIE for cookie in self.cookie_jar))

    def test_wrong_token_and_expired_session_are_rejected(self) -> None:
        headers = {"Origin": self.base_url}
        with patch.dict(os.environ, {gallery_server.GENERATION_AUTH_TOKEN_ENV: "test-secret"}), patch.object(
            gallery_server, "_client_network", return_value="tailscale"
        ):
            status, _value = self.request("POST", "/api/generation/auth/session", {"token": "wrong"}, headers)
            self.assertEqual(status, 401)
            status, value = self.request("POST", "/api/generation/auth/session", {"token": "test-secret"}, headers)
            self.assertEqual(status, 200)
            csrf = value["csrf_token"]
            for session in gallery_server._GENERATION_SESSIONS.values():
                session["expires_at"] = 0
            status, value = self.request(
                "POST",
                "/api/generation/jobs",
                {"model_key": "animagine"},
                {**headers, gallery_server.GENERATION_CSRF_HEADER: csrf},
            )
        self.assertEqual(status, 401)
        self.assertIn("認証", value["error"])

    def test_lan_and_forwarded_for_clients_cannot_use_remote_auth(self) -> None:
        headers = {"Origin": self.base_url, "X-Forwarded-For": "100.100.133.17"}
        with patch.dict(os.environ, {gallery_server.GENERATION_AUTH_TOKEN_ENV: "test-secret"}), patch.object(
            gallery_server, "_client_network", return_value="other"
        ):
            status, value = self.request("POST", "/api/generation/auth/session", {"token": "test-secret"}, headers)
        self.assertEqual(status, 403)
        self.assertIn("Tailscale", value["error"])

    def test_remote_mutation_requires_same_origin_and_csrf(self) -> None:
        with patch.dict(os.environ, {gallery_server.GENERATION_AUTH_TOKEN_ENV: "test-secret"}), patch.object(
            gallery_server, "_client_network", return_value="tailscale"
        ):
            status, value = self.request(
                "POST", "/api/generation/auth/session", {"token": "test-secret"}, {"Origin": self.base_url}
            )
            csrf = value["csrf_token"]
            status, value = self.request(
                "POST", "/api/generation/jobs", {"model_key": "animagine"}, {"Origin": self.base_url}
            )
            self.assertEqual(status, 403)
            self.assertIn("検証", value["error"])
            status, value = self.request(
                "POST",
                "/api/generation/jobs",
                {"model_key": "animagine"},
                {"Origin": "https://evil.example", gallery_server.GENERATION_CSRF_HEADER: csrf},
            )
        self.assertEqual(status, 403)
        self.assertIn("送信元", value["error"])

    def test_remote_job_status_requires_the_same_authenticated_session(self) -> None:
        with patch.object(gallery_server, "_client_network", return_value="tailscale"):
            status, value = self.request("GET", "/api/generation/jobs/job-1")
        self.assertEqual(status, 401)
        self.assertIn("認証", value["error"])

    def test_authenticated_tailscale_reference_upload_is_forwarded(self) -> None:
        boundary = "----codex-reference-auth"
        body = (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="file"; filename="reference.png"\r\n'
            "Content-Type: image/png\r\n\r\n"
            "fake-image-bytes\r\n"
            f"--{boundary}--\r\n"
        ).encode("utf-8")
        headers = {"Origin": self.base_url}
        with patch.dict(os.environ, {gallery_server.GENERATION_AUTH_TOKEN_ENV: "test-secret"}), patch.object(
            gallery_server, "_client_network", return_value="tailscale"
        ):
            status, value = self.request("POST", "/api/generation/auth/session", {"token": "test-secret"}, headers)
            self.assertEqual(status, 200)
            request = Request(
                f"{self.base_url}/api/generation/references",
                data=body,
                headers={
                    "Content-Type": f"multipart/form-data; boundary={boundary}",
                    "Origin": self.base_url,
                    gallery_server.GENERATION_CSRF_HEADER: value["csrf_token"],
                },
                method="POST",
            )
            with self.opener.open(request, timeout=3) as response:
                status = response.status
                value = json.loads(response.read().decode("utf-8"))
        self.assertEqual(status, 201)
        self.assertEqual(value["reference_image_id"], "asset-123")

    def test_remote_read_only_options_remain_available(self) -> None:
        with patch.object(gallery_server, "_client_network", return_value="other"):
            status, value = self.request("GET", "/api/generation/options")
        self.assertEqual(status, 200)
        self.assertEqual(value["models"][0]["key"], "animagine")

    def test_remote_reference_upload_is_forbidden_before_backend_call(self) -> None:
        with patch.object(gallery_server, "_is_loopback_client", return_value=False):
            boundary = "----codex-reference"
            body = f"--{boundary}--\r\n".encode("utf-8")
            request = Request(
                f"http://127.0.0.1:{self.server.server_address[1]}/api/generation/references",
                data=body,
                headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
                method="POST",
            )
            try:
                urlopen(request, timeout=3)
            except HTTPError as error:
                self.assertEqual(403, error.code)
                self.assertIn("生成用画像", error.read().decode("utf-8"))
            else:
                self.fail("remote reference upload was accepted")

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
        css = (root / "gallery_web" / "style.css").read_text(encoding="utf-8")
        self.assertIn('id="generation-submit"', html)
        self.assertIn('id="generation-freeform-character"', html)
        self.assertIn('id="generation-appearance"', html)
        self.assertIn('id="generation-request"', html)
        self.assertIn('id="generation-count"', html)
        self.assertIn('id="generation-variation"', html)
        self.assertIn('id="generation-reference-mode"', html)
        self.assertIn('id="generation-reference-file"', html)
        self.assertIn('id="generation-reference-help"', html)
        self.assertIn('id="generation-reference-selection"', html)
        self.assertIn('id="generation-reference-clear"', html)
        self.assertIn('id="generation-reference-strength"', html)
        self.assertIn('id="generation-reference-fit"', html)
        self.assertIn('id="generation-request-summary"', html)
        self.assertIn('id="generation-request-summary-list"', html)
        self.assertIn('id="generation-result-summary"', html)
        self.assertIn('id="generation-result-job-id"', html)
        self.assertIn('id="generation-copy-job-id"', html)
        self.assertIn('id="generation-result-link"', html)
        self.assertIn('id="generation-auth-token"', html)
        self.assertIn('id="generation-auth-submit"', html)
        self.assertIn('/api/generation/jobs', app)
        self.assertIn('/api/generation/references', app)
        self.assertIn('/api/generation/auth/session', app)
        self.assertIn('/api/generation/auth/logout', app)
        self.assertIn('/api/generation/auth/status', app)
        self.assertIn('id="generation-auth-remember"', html)
        self.assertIn('id="generation-auth-logout"', html)
        self.assertNotIn("localStorage", app)
        self.assertIn('X-Gallery-Generation-CSRF', app)
        self.assertIn('reference_mode: generationReferenceMode()', app)
        self.assertIn('freeform_character: $("#generation-freeform-character").value.trim() || null', app)
        self.assertNotIn("freeform_character: null", app)
        self.assertIn('character_preset: $("#generation-character-preset").value || null', app)
        self.assertIn('explicit_tags: generationTags($("#generation-explicit-tags").value)', app)
        self.assertIn('appearance_text: $("#generation-appearance").value.trim() || null', app)
        self.assertIn('request_text: $("#generation-request").value.trim() || null', app)
        self.assertIn('count: Number($("#generation-count").value || 1)', app)
        self.assertIn('variation: $("#generation-variation").value || "off"', app)
        self.assertIn('renderGenerationRequestSummary', app)
        self.assertIn('renderGenerationResultSummary', app)
        self.assertIn('navigator.clipboard', app)
        self.assertIn('generationResultUrl', app)
        self.assertIn('clearGenerationReferenceSelection', app)
        self.assertIn('Reference image selected:', app)
        self.assertIn('Galleryで結果を見る', html)
        self.assertIn('generation-result-summary', css)
        self.assertIn('generation-job-id', css)
        self.assertIn('@media (max-width: 560px)', css)
        self.assertIn('overflow-wrap: anywhere', css)
        self.assertNotIn("127.0.0.1:8787", app)


if __name__ == "__main__":
    unittest.main()
