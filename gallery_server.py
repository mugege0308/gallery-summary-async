"""ローカル画像ギャラリーを起動する。

標準ライブラリだけで動作するため、既存のLoRA管理CLIやDiscord bridgeの
依存関係・起動方法を変更しない。既定では lora_datasets/source を対象にするが、
ComfyUIのoutputフォルダなどを --images-root で指定できる。
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hmac
import ipaddress
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
import uuid
from http.cookies import CookieError, SimpleCookie
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import parse_qs, unquote, urlencode, urlsplit

from gallery_db import GalleryError, GalleryStore, REVIEW_STATUSES, STATUS_LABELS, now_iso


PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_IMAGES_ROOT = PROJECT_ROOT / "lora_datasets"
DEFAULT_DB_PATH = PROJECT_ROOT / ".gallery" / "gallery.sqlite3"
WEB_ROOT = PROJECT_ROOT / "gallery_web"
AI_JOB_FILE = PROJECT_ROOT / ".gallery" / "ai_review_job.json"
DEFAULT_GENERATION_BACKEND_URL = "http://127.0.0.1:8787"
GENERATION_PROXY_MAX_BODY_BYTES = 64 * 1024
GENERATION_REFERENCE_MAX_BODY_BYTES = 10 * 1024 * 1024
GENERATION_PROXY_TIMEOUT_SECONDS = 15
GENERATION_AUTH_TOKEN_ENV = "GALLERY_GENERATION_AUTH_TOKEN"
GENERATION_SESSION_SECRET_ENV = "GALLERY_GENERATION_SESSION_SECRET"
GENERATION_SESSION_COOKIE = "gallery_generation_session"
GENERATION_PERSISTENT_COOKIE = "gallery_generation_device"
GENERATION_CSRF_HEADER = "X-Gallery-Generation-CSRF"
GENERATION_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60
GENERATION_PERSISTENT_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
TAILSCALE_IPV4_NETWORK = ipaddress.ip_network("100.64.0.0/10")
TAILSCALE_IPV6_NETWORK = ipaddress.ip_network("fd7a:115c:a1e0::/48")
_ABSOLUTE_PATH_RE = re.compile(r"(?:(?:[A-Za-z]:)?[\\/])(?:[^\s,;]+[\\/])+[^\s,;]+")
_GENERATION_JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_GALLERY_IMAGE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_REFERENCE_ASSET_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
_GENERATION_SESSIONS: dict[str, dict[str, Any]] = {}
_GENERATION_SESSIONS_LOCK = threading.RLock()


class RequestTooLargeError(GalleryError):
    """A request exceeded the endpoint's explicit body limit."""


def _is_loopback_client(address: str) -> bool:
    try:
        return ipaddress.ip_address(address).is_loopback
    except ValueError:
        return False


def _is_tailscale_client(address: str) -> bool:
    """Classify a socket peer as a Tailscale-routed address.

    This is only a network-path gate.  It is deliberately not sufficient for
    generation access; remote clients must also present a valid session.
    """

    try:
        parsed = ipaddress.ip_address(address)
    except ValueError:
        return False
    return parsed in TAILSCALE_IPV4_NETWORK or parsed in TAILSCALE_IPV6_NETWORK


def _client_network(address: str) -> str:
    if _is_loopback_client(address):
        return "loopback"
    if _is_tailscale_client(address):
        return "tailscale"
    return "other"


def _generation_auth_token() -> str:
    return os.environ.get(GENERATION_AUTH_TOKEN_ENV, "").strip()


def _generation_session_secret() -> str:
    return os.environ.get(GENERATION_SESSION_SECRET_ENV, "").strip()


def _safe_generation_settings(image: dict[str, Any], *, count_fallback: int = 1) -> dict[str, Any]:
    """Extract only original request fields that are safe to restore in the UI."""

    metadata = image.get("metadata") if isinstance(image, dict) else {}
    metadata = metadata if isinstance(metadata, dict) else {}
    source_metadata = metadata.get("source_metadata")
    source_metadata = source_metadata if isinstance(source_metadata, dict) else {}
    sidecar = source_metadata.get("sidecar")
    sidecar = sidecar if isinstance(sidecar, dict) else {}
    warnings: list[str] = []

    def value(*keys: str, fallback: Any = None) -> Any:
        for key in keys:
            if key in sidecar and sidecar[key] not in (None, ""):
                return sidecar[key]
        return fallback

    def text(*keys: str, fallback: str = "") -> str:
        raw = value(*keys, fallback=fallback)
        return raw.strip() if isinstance(raw, str) else fallback

    explicit_tags = value("explicit_tags", fallback=[])
    if not isinstance(explicit_tags, list):
        explicit_tags = []
    explicit_tags = [item.strip() for item in explicit_tags if isinstance(item, str) and item.strip()]

    raw_loras = value("loras", fallback=[])
    loras: list[dict[str, Any]] = []
    if isinstance(raw_loras, list):
        for item in raw_loras:
            if not isinstance(item, dict):
                continue
            key = item.get("key")
            lora_type = item.get("lora_type")
            strength = item.get("strength")
            if not isinstance(key, str) or not key or lora_type not in {"character", "style", "additional"}:
                warnings.append("一部のLoRA設定は現在のcatalog形式で復元できません。")
                continue
            try:
                strength = float(strength)
            except (TypeError, ValueError):
                warnings.append(f"LoRA「{key}」のstrengthを復元できません。")
                continue
            if not 0 <= strength <= 1:
                warnings.append(f"LoRA「{key}」のstrengthが範囲外です。")
                continue
            # Deliberately omit lora_name/display_name: those may contain
            # ComfyUI paths. The UI can restore only catalog keys.
            loras.append({"key": key, "lora_type": lora_type, "strength": strength})

    raw_size = value("size", fallback={})
    size = raw_size if isinstance(raw_size, dict) else {"preset": raw_size if isinstance(raw_size, str) else ""}
    size = {
        "preset": str(size.get("preset") or "").strip(),
        "width": size.get("width") if isinstance(size.get("width"), int) else None,
        "height": size.get("height") if isinstance(size.get("height"), int) else None,
    }

    requested_seed = value("requested_seed", fallback=None)
    if requested_seed is None and "actual_seed" not in sidecar:
        requested_seed = value("seed", fallback=-1)
    try:
        requested_seed = int(requested_seed) if requested_seed is not None else -1
    except (TypeError, ValueError):
        requested_seed = -1
        warnings.append("元のrequested seedを復元できないため、自動seed（-1）を使用します。")

    actual_seed = value("actual_seed", fallback=None)
    try:
        actual_seed = int(actual_seed) if actual_seed is not None else None
        if actual_seed is not None and actual_seed < 0:
            raise ValueError
    except (TypeError, ValueError):
        actual_seed = None

    count = value("count", "variation_count", fallback=count_fallback)
    try:
        count = int(count)
    except (TypeError, ValueError):
        count = 1
    if count < 1 or count > 8:
        warnings.append("元の枚数は復元できないため、1枚に戻します。")
        count = 1
    variation = value("variation", fallback="off")
    variation = variation if variation in {"off", "auto"} else "off"

    reference_mode = value("reference_mode", fallback="none")
    reference_mode = reference_mode if reference_mode in {"none", "composition", "pose"} else "none"
    reference_id = text("reference_image_id")
    reference: dict[str, Any] = {"mode": "none"}
    if reference_mode != "none" and _REFERENCE_ASSET_ID_RE.fullmatch(reference_id or ""):
        reference = {
            "mode": reference_mode,
            "image_id": reference_id,
            "strength": value("reference_strength", fallback=None),
            "fit": value("reference_fit", fallback="contain"),
        }
    elif reference_mode != "none":
        warnings.append("元Reference assetが見つからないため、ReferenceはNoneに戻しました。")

    has_request_fields = any(
        key in sidecar
        for key in (
            "character_preset",
            "freeform_character",
            "character",
            "explicit_tags",
            "appearance_text",
            "request_text",
            "model_key",
            "model",
            "rating",
            "loras",
            "size",
            "requested_seed",
            "reference_mode",
        )
    )
    if not has_request_fields:
        warnings.insert(0, "この画像には再生成用の元設定が保存されていません。")

    return {
        "ok": True,
        "available": has_request_fields,
        "filename": str(image.get("filename") or ""),
        "warnings": list(dict.fromkeys(warnings)),
        "settings": {
            "character_preset": text("character_preset") or None,
            "freeform_character": text("freeform_character", "character"),
            "explicit_tags": explicit_tags,
            "appearance_text": text("appearance_text"),
            "request_text": text("request_text"),
            "model_key": text("model_key", "model"),
            "rating": text("rating"),
            "size": size,
            "loras": loras,
            "count": count,
            "variation": variation,
            "seed": requested_seed,
            "actual_seed": actual_seed,
            "reference": reference,
        },
    }


def _peer_binding(client_address: str, secret: str) -> str:
    return hmac.new(secret.encode("utf-8"), client_address.encode("utf-8"), "sha256").hexdigest()


def _encode_signed_persistent_session(client_address: str, *, now: int | None = None) -> str | None:
    secret = _generation_session_secret()
    if not secret:
        return None
    issued_at = int(time.time() if now is None else now)
    payload = {
        "v": 1,
        "issued_at": issued_at,
        "expires_at": issued_at + GENERATION_PERSISTENT_MAX_AGE_SECONDS,
        "peer": _peer_binding(client_address, secret),
        "csrf_token": secrets.token_urlsafe(24),
    }
    encoded = base64.urlsafe_b64encode(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    ).rstrip(b"=").decode("ascii")
    signature = hmac.new(secret.encode("utf-8"), encoded.encode("ascii"), "sha256").hexdigest()
    return f"{encoded}.{signature}"


def _decode_signed_persistent_session(
    value: str, client_address: str, *, now: int | None = None
) -> dict[str, Any] | None:
    secret = _generation_session_secret()
    if not secret or not value:
        return None
    try:
        encoded, signature = value.split(".", 1)
        expected = hmac.new(secret.encode("utf-8"), encoded.encode("ascii"), "sha256").hexdigest()
        if not hmac.compare_digest(signature, expected):
            return None
        padded = encoded + "=" * (-len(encoded) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
    except (ValueError, UnicodeError, json.JSONDecodeError, TypeError, binascii.Error):
        return None
    if not isinstance(payload, dict) or payload.get("v") != 1:
        return None
    issued_at = payload.get("issued_at")
    expires_at = payload.get("expires_at")
    csrf_token = payload.get("csrf_token")
    if not isinstance(issued_at, int) or not isinstance(expires_at, int) or not isinstance(csrf_token, str):
        return None
    current = int(time.time() if now is None else now)
    if expires_at <= current or issued_at > current + 300:
        return None
    if not hmac.compare_digest(str(payload.get("peer", "")), _peer_binding(client_address, secret)):
        return None
    return {
        "csrf_token": csrf_token,
        "expires_at": expires_at,
        "persistent": True,
    }


def _cleanup_generation_sessions(now: float | None = None) -> None:
    current = time.time() if now is None else now
    with _GENERATION_SESSIONS_LOCK:
        expired = [
            session_id
            for session_id, session in _GENERATION_SESSIONS.items()
            if float(session.get("expires_at", 0)) <= current
        ]
        for session_id in expired:
            _GENERATION_SESSIONS.pop(session_id, None)


def _new_generation_session(client_address: str) -> tuple[str, str]:
    _cleanup_generation_sessions()
    session_id = secrets.token_urlsafe(32)
    csrf_token = secrets.token_urlsafe(24)
    with _GENERATION_SESSIONS_LOCK:
        _GENERATION_SESSIONS[session_id] = {
            "client_address": client_address,
            "csrf_token": csrf_token,
            "expires_at": time.time() + GENERATION_SESSION_MAX_AGE_SECONDS,
        }
    return session_id, csrf_token


def _generation_session_from_request(handler: BaseHTTPRequestHandler) -> dict[str, Any] | None:
    cookie = SimpleCookie()
    try:
        cookie.load(handler.headers.get("Cookie", ""))
    except (CookieError, ValueError):
        return None
    morsel = cookie.get(GENERATION_SESSION_COOKIE)
    if morsel is not None and morsel.value:
        session_id = morsel.value
        _cleanup_generation_sessions()
        with _GENERATION_SESSIONS_LOCK:
            session = _GENERATION_SESSIONS.get(session_id)
            if session is not None and session.get("client_address") == handler.client_address[0]:
                return dict(session)
    persistent = cookie.get(GENERATION_PERSISTENT_COOKIE)
    if persistent is not None and persistent.value:
        return _decode_signed_persistent_session(persistent.value, handler.client_address[0])
    return None


def _sanitize_proxy_value(value: Any) -> Any:
    if isinstance(value, str):
        return _ABSOLUTE_PATH_RE.sub("<path>", value)
    if isinstance(value, list):
        return [_sanitize_proxy_value(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _sanitize_proxy_value(item) for key, item in value.items()}
    return value


def _read_ai_job() -> dict[str, Any]:
    try:
        value = json.loads(AI_JOB_FILE.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {"status": "idle", "processed": 0, "total": 0}
    return value if isinstance(value, dict) else {"status": "idle", "processed": 0, "total": 0}


def _write_ai_job(value: dict[str, Any]) -> None:
    AI_JOB_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary = AI_JOB_FILE.with_name(f".{AI_JOB_FILE.name}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(AI_JOB_FILE)


def _ai_job_running(job: dict[str, Any]) -> bool:
    if job.get("status") != "running":
        return False
    try:
        pid = int(job.get("pid"))
        if pid <= 0:
            return False
        os.kill(pid, 0)
        return True
    except (OSError, TypeError, ValueError):
        return False


def _find_ai_python() -> Path:
    configured = os.environ.get("GALLERY_AI_PYTHON", "").strip().strip('"')
    candidates = [Path(configured)] if configured else []
    candidates.extend(
        [
            Path.home() / "Desktop" / "画像生成" / "StabilityMatrix-win-x64" / "Data" / "Packages" / "ComfyUI" / "venv" / "Scripts" / "python.exe",
            PROJECT_ROOT / ".venv" / "Scripts" / "python.exe",
            Path(sys.executable),
        ]
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    return Path(sys.executable)


def _start_ai_review(store: GalleryStore, payload: dict[str, Any]) -> dict[str, Any]:
    current = _read_ai_job()
    if _ai_job_running(current):
        return current
    reference_name = str(payload.get("reference_name") or "").strip()
    target_job_id = str(payload.get("job_id") or "").strip()
    try:
        limit = int(payload.get("limit") or 0)
    except (TypeError, ValueError) as error:
        raise GalleryError("AI評価のlimitは整数で指定してください。") from error
    if limit < 0 or limit > 5_000:
        raise GalleryError("AI評価のlimitは0～5000で指定してください。")
    force = bool(payload.get("force"))
    job_id = uuid.uuid4().hex[:16]
    job = {
        "job_id": job_id,
        "status": "starting",
        "stage": "起動中",
        "processed": 0,
        "total": 0,
        "reference_name": reference_name,
        "target_job_id": target_job_id,
        "limit": limit,
        "force": force,
        "started_at": now_iso(),
    }
    _write_ai_job(job)
    command = [
        str(_find_ai_python()),
        str(PROJECT_ROOT / "gallery_ai.py"),
        "--images-root",
        str(store.images_root),
        "--db-path",
        str(store.db_path),
        "--job-file",
        str(AI_JOB_FILE),
    ]
    if reference_name:
        command.extend(["--reference", reference_name])
    if limit:
        command.extend(["--limit", str(limit)])
    if force:
        command.append("--force")
    if target_job_id:
        command.extend(["--job-id", target_job_id])
    environment = os.environ.copy()
    environment["HF_HUB_OFFLINE"] = "1"
    requested_device = str(payload.get("device") or "").strip().lower()
    if requested_device in {"cpu", "cuda"}:
        # The Discord bot uses CPU for its background queue so a new ComfyUI
        # generation can always keep priority on the RTX3060.  Manual
        # /gallery review keeps the existing auto-device behavior.
        environment["GALLERY_AI_DEVICE"] = requested_device
    try:
        process = subprocess.Popen(
            command,
            cwd=str(PROJECT_ROOT),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=environment,
            shell=False,
            **({"creationflags": getattr(subprocess, "CREATE_NO_WINDOW")} if getattr(subprocess, "CREATE_NO_WINDOW", 0) else {}),
        )
    except (OSError, subprocess.SubprocessError) as error:
        job.update(status="failed", stage="失敗", error=str(error), finished_at=now_iso())
        _write_ai_job(job)
        raise GalleryError(f"AI評価ワーカーを起動できませんでした: {error}") from error
    job.update(status="running", pid=process.pid, python=str(_find_ai_python()))
    _write_ai_job(job)
    return job


class GalleryRequestHandler(BaseHTTPRequestHandler):
    """同一オリジンの静的ファイルと小さなJSON APIを提供する。"""

    store: GalleryStore
    web_root: Path
    max_body_bytes = 4 * 1024 * 1024
    generation_max_body_bytes = GENERATION_PROXY_MAX_BODY_BYTES
    generation_reference_max_body_bytes = GENERATION_REFERENCE_MAX_BODY_BYTES

    server_version = "LocalImageGallery/1.0"

    def _send_bytes(
        self,
        body: bytes,
        content_type: str,
        status: int = HTTPStatus.OK,
        extra_headers: dict[str, str | list[str]] | None = None,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra_headers or {}).items():
            values = value if isinstance(value, list) else [value]
            for item in values:
                self.send_header(key, item)
        self.end_headers()
        self.wfile.write(body)

    def _send_json(
        self,
        value: Any,
        status: int = HTTPStatus.OK,
        extra_headers: dict[str, str | list[str]] | None = None,
    ) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self._send_bytes(body, "application/json; charset=utf-8", status, extra_headers)

    def _send_error_json(self, message: str, status: int = HTTPStatus.BAD_REQUEST) -> None:
        self._send_json({"ok": False, "error": message}, status)

    def _query(self) -> dict[str, str]:
        parsed = parse_qs(urlsplit(self.path).query, keep_blank_values=True)
        return {key: values[-1] if values else "" for key, values in parsed.items()}

    def _page_options(self, query: dict[str, str]) -> tuple[int, int]:
        try:
            page = int(query.get("page", "1") or "1")
            page_size = int(query.get("page_size", "50") or "50")
        except ValueError as error:
            raise GalleryError("pageとpage_sizeは整数で指定してください。") from error
        if page < 1:
            raise GalleryError("pageは1以上で指定してください。")
        if page_size not in range(1, 101):
            raise GalleryError("page_sizeは1～100で指定してください。")
        return page, page_size

    @staticmethod
    def _generation_backend_url() -> str:
        configured = os.environ.get("GALLERY_GENERATION_BACKEND_URL", DEFAULT_GENERATION_BACKEND_URL).strip().rstrip("/")
        parsed = urlsplit(configured)
        if parsed.scheme != "http" or parsed.username or parsed.password or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
            raise GalleryError("Generation Backendの接続先設定が不正です。")
        if not parsed.hostname or not _is_loopback_client(parsed.hostname):
            raise GalleryError("Generation Backendはloopbackにのみ接続できます。")
        try:
            port = parsed.port or 80
        except ValueError as error:
            raise GalleryError("Generation Backendのport設定が不正です。") from error
        if not 1 <= port <= 65_535:
            raise GalleryError("Generation Backendのport設定が不正です。")
        return configured

    def _proxy_generation_json(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
    ) -> None:
        url = f"{self._generation_backend_url()}{path}"
        data = None
        headers = {"Accept": "application/json"}
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib_request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib_request.urlopen(request, timeout=GENERATION_PROXY_TIMEOUT_SECONDS) as response:
                status = int(response.status)
                raw = response.read(512 * 1024)
        except urllib_error.HTTPError as error:
            try:
                raw = error.read(128 * 1024)
                value = json.loads(raw.decode("utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError, ValueError):
                value = {"ok": False, "error": "Generation Backendがエラーを返しました。"}
            if not isinstance(value, dict):
                value = {"ok": False, "error": "Generation Backendが不正な応答を返しました。"}
            value = _sanitize_proxy_value(value)
            status = int(getattr(error, "code", HTTPStatus.BAD_GATEWAY))
            return self._send_json(value, status if 400 <= status <= 599 else HTTPStatus.BAD_GATEWAY)
        except (urllib_error.URLError, TimeoutError, OSError):
            return self._send_error_json("Generation Backendに接続できません。", HTTPStatus.BAD_GATEWAY)
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as error:
            return self._send_error_json("Generation Backendの応答を読み取れません。", HTTPStatus.BAD_GATEWAY)
        if not isinstance(value, dict):
            return self._send_error_json("Generation Backendの応答が不正です。", HTTPStatus.BAD_GATEWAY)
        return self._send_json(_sanitize_proxy_value(value), status)

    def _proxy_generation_reference_body(
        self,
        body: bytes,
        content_type: str,
        response_metadata: dict[str, Any] | None = None,
    ) -> None:
        """Forward one server-resolved image through the existing asset API."""

        request = urllib_request.Request(
            f"{self._generation_backend_url()}/api/generation/references",
            data=body,
            headers={"Accept": "application/json", "Content-Type": content_type},
            method="POST",
        )
        try:
            with urllib_request.urlopen(request, timeout=GENERATION_PROXY_TIMEOUT_SECONDS) as response:
                status = int(response.status)
                raw = response.read(128 * 1024)
        except urllib_error.HTTPError as error:
            try:
                raw = error.read(128 * 1024)
                value = json.loads(raw.decode("utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError, ValueError):
                value = {"ok": False, "error": "Generation Backendがエラーを返しました。"}
            status = int(getattr(error, "code", HTTPStatus.BAD_GATEWAY))
            return self._send_json(_sanitize_proxy_value(value), status if 400 <= status <= 599 else HTTPStatus.BAD_GATEWAY)
        except (urllib_error.URLError, TimeoutError, OSError):
            return self._send_error_json("Generation Backendに接続できません。", HTTPStatus.BAD_GATEWAY)
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError):
            return self._send_error_json("Generation Backendの応答を読み取れません。", HTTPStatus.BAD_GATEWAY)
        if not isinstance(value, dict):
            return self._send_error_json("Generation Backendの応答が不正です。", HTTPStatus.BAD_GATEWAY)
        if response_metadata:
            value = {**value, **response_metadata}
        return self._send_json(_sanitize_proxy_value(value), status)

    def _proxy_generation_reference_upload(self) -> None:
        """Forward one multipart image without interpreting or storing paths."""

        raw_length = self.headers.get("Content-Length")
        try:
            length = int(raw_length or "0")
        except ValueError as error:
            raise GalleryError("Content-Lengthが不正です。") from error
        if length < 1 or length > self.generation_reference_max_body_bytes:
            raise RequestTooLargeError("参考画像が大きすぎます。")
        content_type = self.headers.get("Content-Type", "")
        if not content_type.casefold().startswith("multipart/form-data"):
            return self._send_error_json("multipart/form-dataが必要です。", HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
        body = self.rfile.read(length)
        return self._proxy_generation_reference_body(body, content_type)

    def _proxy_gallery_image_as_reference(self) -> None:
        """Resolve a Gallery image ID server-side and reuse reference upload."""

        payload = self._request_json(max_body_bytes=GENERATION_PROXY_MAX_BODY_BYTES)
        if set(payload) != {"gallery_image_id"}:
            raise GalleryError("gallery_image_idだけを指定してください。")
        image_id = payload.get("gallery_image_id")
        if not isinstance(image_id, str) or not _GALLERY_IMAGE_ID_RE.fullmatch(image_id):
            return self._send_error_json("Gallery画像IDが不正です。", HTTPStatus.BAD_REQUEST)
        resolved = self.store.resolve_image(image_id)
        if resolved is None:
            return self._send_error_json("Gallery画像が見つかりません。", HTTPStatus.NOT_FOUND)
        image_path, image_content_type = resolved
        suffixes = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}
        suffix = suffixes.get(image_content_type.casefold())
        if suffix is None:
            return self._send_error_json("Gallery画像の形式に対応していません。", HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
        try:
            if image_path.stat().st_size > GENERATION_REFERENCE_MAX_BODY_BYTES:
                return self._send_error_json("参考画像が大きすぎます。", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            image_bytes = image_path.read_bytes()
        except OSError:
            return self._send_error_json("Gallery画像を読み込めません。", HTTPStatus.NOT_FOUND)
        boundary = f"----gallery-reference-{secrets.token_hex(16)}"
        multipart_type = f"multipart/form-data; boundary={boundary}"
        safe_filename = f"gallery-{image_id}{suffix}"
        body = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="{safe_filename}"\r\n'
            f"Content-Type: {image_content_type}\r\n\r\n"
        ).encode("ascii") + image_bytes + f"\r\n--{boundary}--\r\n".encode("ascii")
        # The backend intentionally returns only opaque asset metadata. Add the
        # Gallery filename for UI display without exposing the source path.
        return self._proxy_generation_reference_body(
            body,
            multipart_type,
            response_metadata={"filename": image_path.name, "source": "gallery"},
        )

    def _generation_job_path(self, path: str) -> str | None:
        prefix = "/api/generation/jobs/"
        if not path.startswith(prefix):
            return None
        job_id = unquote(path.removeprefix(prefix))
        if not _GENERATION_JOB_ID_RE.fullmatch(job_id):
            return None
        return f"{prefix}{job_id}"

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        parsed = urlsplit(self.path)
        path = parsed.path
        try:
            if path == "/api/generation/health":
                return self._proxy_generation_json("GET", path)
            if path == "/api/generation/options":
                return self._proxy_generation_json("GET", path)
            if path == "/api/generation/tags/search":
                query = parse_qs(parsed.query, keep_blank_values=True)
                unknown = set(query) - {"q", "limit", "category"}
                if unknown:
                    return self._send_error_json("タグ検索の指定が不正です。", HTTPStatus.BAD_REQUEST)
                raw_query = query.get("q", [""])[-1]
                raw_limit = query.get("limit", ["20"])[-1]
                raw_category = query.get("category", ["general"])[-1].strip().casefold()
                try:
                    limit = int(raw_limit or "20")
                except ValueError:
                    return self._send_error_json("タグ検索のlimitが不正です。", HTTPStatus.BAD_REQUEST)
                if limit < 1 or limit > 50:
                    return self._send_error_json("タグ検索のlimitが不正です。", HTTPStatus.BAD_REQUEST)
                if raw_category not in {"all", "general", "character", "copyright"}:
                    return self._send_error_json("タグ検索のcategoryが不正です。", HTTPStatus.BAD_REQUEST)
                if len(raw_query) > 200:
                    return self._send_error_json("検索語が長すぎます。", HTTPStatus.BAD_REQUEST)
                safe_query = urlencode({"q": raw_query, "limit": str(limit), "category": raw_category})
                return self._proxy_generation_json("GET", f"{path}?{safe_query}")
            if path == "/api/generation/auth/status":
                return self._send_json(self._generation_auth_status())
            generation_job_path = self._generation_job_path(path)
            if generation_job_path is not None:
                if not self._require_generation_access():
                    return None
                return self._proxy_generation_json("GET", generation_job_path)
            if path == "/" or path == "/index.html":
                return self._serve_index()
            if path.startswith("/static/"):
                relative = unquote(path.removeprefix("/static/"))
                content_type = "text/css; charset=utf-8" if relative.endswith(".css") else "text/javascript; charset=utf-8"
                return self._serve_static(relative, content_type)
            if path == "/api/config":
                return self._send_json(
                    {
                        "ok": True,
                        "images_root": str(self.store.images_root),
                        "statuses": [
                            {"value": value, "label": STATUS_LABELS[value]}
                            for value in REVIEW_STATUSES
                        ],
                        "ai": {"available": True, "job": _read_ai_job()},
                    }
                )
            if path == "/api/ai/status":
                job = _read_ai_job()
                if job.get("status") == "running" and not _ai_job_running(job):
                    job = {**job, "status": "failed", "stage": "失敗", "error": "AI評価ワーカーが終了しました。"}
                    _write_ai_job(job)
                return self._send_json({"ok": True, "job": job})
            if path == "/api/ai/references":
                return self._send_json({"ok": True, "references": self.store.list_character_references()})
            if path == "/api/refresh":
                count = self.store.sync(force=True)
                return self._send_json({"ok": True, "count": count})
            if path == "/api/images/summary":
                # Return the last committed index immediately. A filesystem
                # scan may take tens of seconds on a large ComfyUI output
                # root, so it must not hold the Batch client's request open.
                self.store.request_background_sync()
                query = self._query()
                return self._send_json(
                    {"ok": True, "summary": self.store.job_summary(query.get("job_id", ""))}
                )
            if path == "/api/dispersion":
                self.store.sync()
                query = self._query()
                summary = self.store.dispersion_summary(
                    status=query["status"] if "status" in query else "adopted",
                    character=query.get("character", ""),
                    dataset=query.get("dataset", ""),
                    job_id=query.get("job_id", ""),
                    query=query.get("q", ""),
                    date_from=query.get("from", ""),
                    date_to=query.get("to", ""),
                    exclude_similar=query.get("exclude_similar", "") in {"1", "true", "yes"},
                    lora_candidate=query.get("lora_candidate", "") in {"1", "true", "yes"},
                )
                return self._send_json({"ok": True, "summary": summary})
            if path == "/api/images":
                self.store.sync()
                query = self._query()
                page, page_size = self._page_options(query)
                result = self.store.list_images_page(
                    page=page,
                    page_size=page_size,
                    status=query.get("status", ""),
                    lora_candidate=query.get("lora_candidate", "") in {"1", "true", "yes"},
                    character=query.get("character", ""),
                    dataset=query.get("dataset", ""),
                    job_id=query.get("job_id", ""),
                    query=query.get("q", ""),
                    date_from=query.get("from", ""),
                    date_to=query.get("to", ""),
                    sort=query.get("sort", "recent"),
                    exclude_similar=query.get("exclude_similar", "") in {"1", "true", "yes"},
                    dispersion_dimension=query.get("dispersion_dimension", ""),
                    dispersion_value=query.get("dispersion_value", ""),
                )
                return self._send_json(
                    {
                        "ok": True,
                        **result,
                        "count": len(result["images"]),
                        "images_root": str(self.store.images_root),
                    }
                )
            if path == "/api/images/ids":
                self.store.sync()
                query = self._query()
                selected = self.store.selection_ids(
                    status=query.get("status", ""),
                    lora_candidate=query.get("lora_candidate", "") in {"1", "true", "yes"},
                    character=query.get("character", ""),
                    dataset=query.get("dataset", ""),
                    job_id=query.get("job_id", ""),
                    query=query.get("q", ""),
                    date_from=query.get("from", ""),
                    date_to=query.get("to", ""),
                    sort=query.get("sort", "recent"),
                    exclude_similar=query.get("exclude_similar", "") in {"1", "true", "yes"},
                    dispersion_dimension=query.get("dispersion_dimension", ""),
                    dispersion_value=query.get("dispersion_value", ""),
                    match=query.get("match", ""),
                    image_id=query.get("image_id", ""),
                    range_start=query.get("range_start", ""),
                    range_end=query.get("range_end", ""),
                )
                return self._send_json({"ok": True, **selected})
            settings_suffix = "/generation-settings"
            if path.startswith("/api/images/") and path.endswith(settings_suffix):
                image_id = unquote(path.removeprefix("/api/images/").removesuffix(settings_suffix))
                image = self.store.get(image_id)
                if image is None:
                    return self._send_error_json("画像が見つかりません。", HTTPStatus.NOT_FOUND)
                count_fallback = 1
                job_id = str(image.get("job_id") or "").strip()
                if job_id:
                    try:
                        count_fallback = max(1, int(self.store.job_summary(job_id).get("total") or 1))
                    except (AttributeError, GalleryError, TypeError, ValueError):
                        count_fallback = 1
                return self._send_json(_safe_generation_settings(image, count_fallback=count_fallback))
            if path.startswith("/api/images/"):
                image_id = unquote(path.removeprefix("/api/images/"))
                image = self.store.get(image_id)
                if image is None:
                    return self._send_error_json("画像が見つかりません。", HTTPStatus.NOT_FOUND)
                return self._send_json({"ok": True, "image": image})
            if path.startswith("/media/"):
                image_id = unquote(path.removeprefix("/media/"))
                resolved = self.store.resolve_image(image_id)
                if resolved is None:
                    return self._send_error_json("画像が見つかりません。", HTTPStatus.NOT_FOUND)
                image_path, content_type = resolved
                try:
                    body = image_path.read_bytes()
                except OSError:
                    return self._send_error_json("画像を読み込めません。", HTTPStatus.NOT_FOUND)
                return self._send_bytes(body, content_type)
            if path.startswith("/thumb/"):
                image_id = unquote(path.removeprefix("/thumb/"))
                query = self._query()
                try:
                    size = int(query.get("size", "320") or "320")
                except ValueError as error:
                    raise GalleryError("thumbnail sizeは整数で指定してください。") from error
                resolved = self.store.resolve_thumbnail(image_id, size)
                if resolved is None:
                    return self._send_error_json("画像が見つかりません。", HTTPStatus.NOT_FOUND)
                thumbnail_path, content_type = resolved
                try:
                    body = thumbnail_path.read_bytes()
                except OSError:
                    return self._send_error_json("サムネイルを読み込めません。", HTTPStatus.NOT_FOUND)
                return self._send_bytes(body, content_type)
            return self._send_error_json("ページが見つかりません。", HTTPStatus.NOT_FOUND)
        except (GalleryError, OSError, ValueError) as error:
            self._send_error_json(str(error), HTTPStatus.INTERNAL_SERVER_ERROR)

    def _serve_static(self, relative: str, content_type: str) -> None:
        candidate = (self.web_root / relative).resolve()
        try:
            candidate.relative_to(self.web_root.resolve())
        except ValueError:
            return self._send_error_json("不正なパスです。", HTTPStatus.NOT_FOUND)
        if not candidate.is_file():
            return self._send_error_json("静的ファイルが見つかりません。", HTTPStatus.NOT_FOUND)
        try:
            body = candidate.read_bytes()
        except OSError as error:
            return self._send_error_json(str(error), HTTPStatus.INTERNAL_SERVER_ERROR)
        self._send_bytes(body, content_type)

    def _serve_index(self) -> None:
        """Serve index.html with file-mtime cache-busters for JS and CSS."""
        candidate = (self.web_root / "index.html").resolve()
        try:
            candidate.relative_to(self.web_root.resolve())
            html = candidate.read_text(encoding="utf-8")
            style_path = (self.web_root / "style.css").resolve()
            script_path = (self.web_root / "app.js").resolve()
            style_version = style_path.stat().st_mtime_ns
            script_version = script_path.stat().st_mtime_ns
        except (OSError, UnicodeError, ValueError) as error:
            return self._send_error_json(str(error), HTTPStatus.INTERNAL_SERVER_ERROR)
        html = html.replace(
            "/static/style.css",
            f"/static/style.css?v={style_version}",
            1,
        )
        html = html.replace(
            "/static/app.js",
            f"/static/app.js?v={script_version}",
            1,
        )
        self._send_bytes(html.encode("utf-8"), "text/html; charset=utf-8")

    def _request_json(self, *, max_body_bytes: int | None = None) -> dict[str, Any]:
        body_limit = self.max_body_bytes if max_body_bytes is None else max_body_bytes
        raw_length = self.headers.get("Content-Length")
        try:
            length = int(raw_length or "0")
        except ValueError as error:
            raise GalleryError("Content-Lengthが不正です。") from error
        if length < 0 or length > body_limit:
            raise RequestTooLargeError("リクエストが大きすぎます。")
        try:
            value = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as error:
            raise GalleryError("JSONを読み取れません。") from error
        if not isinstance(value, dict):
            raise GalleryError("JSONオブジェクトを指定してください。")
        return value

    def _same_origin(self) -> bool:
        origin = self.headers.get("Origin", "").strip()
        host = self.headers.get("Host", "").strip()
        if not origin or not host:
            return False
        parsed = urlsplit(origin)
        return (
            parsed.scheme in {"http", "https"}
            and not parsed.username
            and not parsed.password
            and parsed.netloc.casefold() == host.casefold()
        )

    def _generation_auth_status(self) -> dict[str, Any]:
        network = _client_network(self.client_address[0])
        if network == "loopback":
            return {
                "ok": True,
                "network": network,
                "requires_auth": False,
                "authenticated": True,
                "csrf_token": None,
                "remembered": False,
            }
        session = _generation_session_from_request(self)
        authenticated = network == "tailscale" and session is not None
        return {
            "ok": True,
            "network": network,
            "requires_auth": True,
            "authenticated": authenticated,
            "csrf_token": session.get("csrf_token") if authenticated and session else None,
            "remembered": bool(authenticated and session and session.get("persistent")),
        }

    def _require_generation_access(
        self,
        *,
        mutation: bool = False,
        denied_message: str = "この端末からは生成を実行できません。",
    ) -> bool:
        network = _client_network(self.client_address[0])
        if network == "loopback":
            return True
        if network != "tailscale":
            self._send_error_json(denied_message, HTTPStatus.FORBIDDEN)
            return False
        session = _generation_session_from_request(self)
        if session is None:
            self._send_error_json("生成の認証が必要です。", HTTPStatus.UNAUTHORIZED)
            return False
        if mutation:
            if not self._same_origin():
                self._send_error_json("生成リクエストの送信元を確認できません。", HTTPStatus.FORBIDDEN)
                return False
            csrf = self.headers.get(GENERATION_CSRF_HEADER, "")
            if not csrf or not hmac.compare_digest(csrf, str(session.get("csrf_token", ""))):
                self._send_error_json("生成リクエストの検証に失敗しました。", HTTPStatus.FORBIDDEN)
                return False
        return True

    def _authenticate_generation_session(self) -> None:
        network = _client_network(self.client_address[0])
        if network == "other":
            return self._send_error_json("Tailscale経由の端末だけ認証できます。", HTTPStatus.FORBIDDEN)
        if network != "loopback" and not self._same_origin():
            return self._send_error_json("認証リクエストの送信元を確認できません。", HTTPStatus.FORBIDDEN)
        configured = _generation_auth_token()
        if not configured:
            return self._send_error_json("リモート生成認証が設定されていません。", HTTPStatus.SERVICE_UNAVAILABLE)
        content_type = self.headers.get("Content-Type", "").casefold()
        if not content_type.startswith("application/json"):
            return self._send_error_json("Content-Type: application/json が必要です。", HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
        payload = self._request_json(max_body_bytes=8 * 1024)
        remember_device = payload.get("remember_device", False)
        if not isinstance(remember_device, bool) or set(payload) - {"token", "remember_device"}:
            return self._send_error_json("認証リクエストの形式が不正です。", HTTPStatus.BAD_REQUEST)
        if not isinstance(payload.get("token"), str):
            return self._send_error_json("認証tokenを指定してください。", HTTPStatus.BAD_REQUEST)
        if not hmac.compare_digest(payload["token"], configured):
            return self._send_error_json("認証に失敗しました。", HTTPStatus.UNAUTHORIZED)
        if remember_device and not _generation_session_secret():
            return self._send_error_json("端末記憶用の署名secretが設定されていません。", HTTPStatus.SERVICE_UNAVAILABLE)
        session_id, csrf_token = _new_generation_session(self.client_address[0])
        session_cookie = (
            f"{GENERATION_SESSION_COOKIE}={session_id}; Path=/api/generation; "
            f"Max-Age={GENERATION_SESSION_MAX_AGE_SECONDS}; HttpOnly; SameSite=Strict"
        )
        cookies: list[str] = [session_cookie]
        if remember_device:
            persistent_value = _encode_signed_persistent_session(self.client_address[0])
            if persistent_value is None:
                return self._send_error_json("端末記憶用の署名secretが設定されていません。", HTTPStatus.SERVICE_UNAVAILABLE)
            cookies.append(
                f"{GENERATION_PERSISTENT_COOKIE}={persistent_value}; Path=/api/generation; "
                f"Max-Age={GENERATION_PERSISTENT_MAX_AGE_SECONDS}; HttpOnly; SameSite=Strict"
            )
        else:
            cookies.append(
                f"{GENERATION_PERSISTENT_COOKIE}=; Path=/api/generation; Max-Age=0; HttpOnly; SameSite=Strict"
            )
        return self._send_json(
            {"ok": True, "authenticated": True, "csrf_token": csrf_token, "remembered": remember_device},
            HTTPStatus.OK,
            {"Set-Cookie": cookies},
        )

    def _logout_generation_session(self) -> None:
        if not self._require_generation_access(mutation=True, denied_message="認証済み端末だけ解除できます。"):
            return None
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except (CookieError, ValueError):
            cookie = SimpleCookie()
        session_cookie = cookie.get(GENERATION_SESSION_COOKIE)
        if session_cookie is not None:
            with _GENERATION_SESSIONS_LOCK:
                _GENERATION_SESSIONS.pop(session_cookie.value, None)
        clear_cookies = [
            f"{GENERATION_SESSION_COOKIE}=; Path=/api/generation; Max-Age=0; HttpOnly; SameSite=Strict",
            f"{GENERATION_PERSISTENT_COOKIE}=; Path=/api/generation; Max-Age=0; HttpOnly; SameSite=Strict",
        ]
        return self._send_json(
            {"ok": True, "authenticated": False, "remembered": False, "csrf_token": None},
            HTTPStatus.OK,
            {"Set-Cookie": clear_cookies},
        )

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        path = urlsplit(self.path).path
        try:
            if path == "/api/generation/auth/session":
                return self._authenticate_generation_session()
            if path == "/api/generation/auth/logout":
                return self._logout_generation_session()
            if path == "/api/generation/jobs":
                if not self._require_generation_access(mutation=True):
                    return None
                content_type = self.headers.get("Content-Type", "").casefold()
                if not content_type.startswith("application/json"):
                    return self._send_error_json("Content-Type: application/json が必要です。", HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
                payload = self._request_json(max_body_bytes=self.generation_max_body_bytes)
                return self._proxy_generation_json("POST", path, payload)
            if path == "/api/generation/references":
                if not self._require_generation_access(
                    mutation=True,
                    denied_message="この端末からは生成用画像を登録できません。",
                ):
                    return None
                return self._proxy_generation_reference_upload()
            if path == "/api/generation/references/from-gallery":
                if not self._require_generation_access(
                    mutation=True,
                    denied_message="この端末からGallery画像を参照登録できません。",
                ):
                    return None
                return self._proxy_gallery_image_as_reference()
            if path == "/api/ai/review":
                payload = self._request_json()
                self.store.sync()
                job = _start_ai_review(self.store, payload)
                return self._send_json({"ok": True, "job": job})
            if path == "/api/ai/references":
                payload = self._request_json()
                name = payload.get("name")
                image_ids = payload.get("image_ids")
                if not isinstance(name, str) or not isinstance(image_ids, list):
                    raise GalleryError("参照名とimage_ids配列を指定してください。")
                reference = self.store.register_character_reference(name, image_ids)
                return self._send_json({"ok": True, "reference": reference})
            if path == "/api/commit":
                payload = self._request_json()
                raw_updates = payload.get("updates")
                if not isinstance(raw_updates, list):
                    raise GalleryError("updates配列を指定してください。")
                if len(raw_updates) > 5_000:
                    raise GalleryError("一度に確定できる画像が多すぎます。")
                updates: dict[str, Any] = {}
                for item in raw_updates:
                    if not isinstance(item, dict):
                        raise GalleryError("updatesの要素が不正です。")
                    image_id = item.get("id")
                    status = item.get("status")
                    if not isinstance(image_id, str) or not isinstance(status, str):
                        raise GalleryError("updatesのid/statusが不正です。")
                    update: dict[str, Any] = {"status": status}
                    if "lora_candidate" in item:
                        if not isinstance(item["lora_candidate"], bool):
                            raise GalleryError("updatesのLoRA候補フラグが不正です。")
                        update["lora_candidate"] = item["lora_candidate"]
                    updates[image_id] = update
                result = self.store.commit(updates)
                return self._send_json({"ok": True, **result})
            if path == "/api/refresh":
                self.store.sync(force=True)
                return self._send_json({"ok": True})
            return self._send_error_json("エンドポイントが見つかりません。", HTTPStatus.NOT_FOUND)
        except RequestTooLargeError as error:
            self._send_error_json(str(error), HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
        except GalleryError as error:
            self._send_error_json(str(error))
        except (OSError, ValueError) as error:
            self._send_error_json(str(error), HTTPStatus.INTERNAL_SERVER_ERROR)

    def log_message(self, format: str, *args: Any) -> None:
        # 起動中のアクセスログは残すが、画像metadataの内容は出力しない。
        super().log_message(format, *args)


def _local_network_address() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("192.0.2.1", 80))
            return sock.getsockname()[0]
    except OSError:
        try:
            return socket.gethostbyname(socket.gethostname())
        except OSError:
            return "<PCのLAN IP>"


def _tailscale_ipv4_addresses() -> list[str]:
    """Return local Tailscale IPv4 addresses without requiring the CLI on PATH."""
    pattern = re.compile(r"\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b")
    addresses: list[str] = []

    for command in (("tailscale.exe", "ip", "-4"), ("tailscale", "ip", "-4")):
        try:
            result = subprocess.run(command, capture_output=True, timeout=3, check=False)
        except (OSError, subprocess.SubprocessError):
            continue
        text = result.stdout.decode("utf-8", errors="ignore")
        for address in pattern.findall(text):
            if address not in addresses:
                addresses.append(address)

    try:
        result = subprocess.run(
            ["ipconfig", "/all"],
            capture_output=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        result = None
    if result is not None:
        text = result.stdout.decode("utf-8", errors="ignore")
        for address in pattern.findall(text):
            if address not in addresses:
                addresses.append(address)
    return addresses


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="LAN内だけで使う画像ギャラリー")
    parser.add_argument(
        "--images-root",
        type=Path,
        default=DEFAULT_IMAGES_ROOT,
        help="画像フォルダ。dataset_info.jsonを含む親ならsourceを自動選択します。",
    )
    parser.add_argument(
        "--db-path",
        type=Path,
        default=DEFAULT_DB_PATH,
        help="レビュー状態を保存するSQLiteファイル",
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("GALLERY_HOST", "0.0.0.0"),
        help="待受アドレス（127.0.0.1ならこのPCだけ、既定はLANアクセス用）",
    )
    parser.add_argument("--port", type=int, default=8765)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not 1 <= args.port <= 65_535:
        raise SystemExit("portは1～65535で指定してください。")
    store = GalleryStore(args.images_root, args.db_path)
    try:
        handler = type(
            "ConfiguredGalleryRequestHandler",
            (GalleryRequestHandler,),
            {"store": store, "web_root": WEB_ROOT},
        )
        server = ThreadingHTTPServer((args.host, args.port), handler)
        try:
            sync_status = store.request_background_sync()
        except Exception as error:
            # Binding the HTTP server is the readiness boundary. A failure to
            # schedule the initial scan must not make /api/config unavailable.
            print(f"初回同期の開始に失敗しました: {error}", file=sys.stderr)
            sync_status = store.sync_status()
        print(
            "画像ギャラリーを起動しました（"
            f"現在の索引{sync_status['indexed_count']}枚、初回同期をバックグラウンド実行中）"
        )
        print(f"このPC: http://127.0.0.1:{args.port}/")
        if args.host == "0.0.0.0":
            print(f"同じLANのスマホ: http://{_local_network_address()}:{args.port}/")
            tailscale_addresses = _tailscale_ipv4_addresses()
            if tailscale_addresses:
                for address in tailscale_addresses:
                    print(f"Tailscale: http://{address}:{args.port}/")
            else:
                print("Tailscale IPv4: 未検出（ローカルアクセスは利用可能）")
        print("終了するには Ctrl+C。外部公開やポート転送は行わないでください。")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nギャラリーを終了します。")
        finally:
            server.server_close()
    finally:
        store.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
