"""ローカル画像ギャラリーを起動する。

標準ライブラリだけで動作するため、既存のLoRA管理CLIやDiscord bridgeの
依存関係・起動方法を変更しない。既定では lora_datasets/source を対象にするが、
ComfyUIのoutputフォルダなどを --images-root で指定できる。
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import socket
import subprocess
import sys
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import parse_qs, unquote, urlsplit

from gallery_db import GalleryError, GalleryStore, REVIEW_STATUSES, STATUS_LABELS, now_iso


PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_IMAGES_ROOT = PROJECT_ROOT / "lora_datasets"
DEFAULT_DB_PATH = PROJECT_ROOT / ".gallery" / "gallery.sqlite3"
WEB_ROOT = PROJECT_ROOT / "gallery_web"
AI_JOB_FILE = PROJECT_ROOT / ".gallery" / "ai_review_job.json"
DEFAULT_GENERATION_BACKEND_URL = "http://127.0.0.1:8787"
GENERATION_PROXY_MAX_BODY_BYTES = 64 * 1024
GENERATION_PROXY_TIMEOUT_SECONDS = 15
_ABSOLUTE_PATH_RE = re.compile(r"(?:(?:[A-Za-z]:)?[\\/])(?:[^\s,;]+[\\/])+[^\s,;]+")
_GENERATION_JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


class RequestTooLargeError(GalleryError):
    """A request exceeded the endpoint's explicit body limit."""


def _is_loopback_client(address: str) -> bool:
    try:
        return ipaddress.ip_address(address).is_loopback
    except ValueError:
        return False


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

    server_version = "LocalImageGallery/1.0"

    def _send_bytes(self, body: bytes, content_type: str, status: int = HTTPStatus.OK) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, value: Any, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self._send_bytes(body, "application/json; charset=utf-8", status)

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
            generation_job_path = self._generation_job_path(path)
            if generation_job_path is not None:
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

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        path = urlsplit(self.path).path
        try:
            if path == "/api/generation/jobs":
                if not _is_loopback_client(self.client_address[0]):
                    return self._send_error_json("この端末からは生成を実行できません。", HTTPStatus.FORBIDDEN)
                content_type = self.headers.get("Content-Type", "").casefold()
                if not content_type.startswith("application/json"):
                    return self._send_error_json("Content-Type: application/json が必要です。", HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
                payload = self._request_json(max_body_bytes=self.generation_max_body_bytes)
                return self._proxy_generation_json("POST", path, payload)
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
