"""ローカル画像ギャラリーの索引・metadata・レビュー状態を管理する。

このモジュールは既存の dataset_manager / Discord bridge から独立している。
画像ファイルは読み取り専用で扱い、レビュー結果だけを SQLite に保存する。
データセット画像については、確定時に dataset_info.json へもミラーする。
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import sqlite3
import struct
import tempfile
import threading
import time
import zlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from dataset_dispersion import (
    extract_explicit_classification,
    load_warning_config,
    matches_classification,
    serialise_explicit_classification,
    summarise,
)


SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
THUMBNAIL_SIZES = (160, 240, 320, 480)
REVIEW_STATUSES = ("unreviewed", "adopted", "hold", "rejected")
# Kept only for backwards compatibility with older clients and dataset_info
# records.  New data stores the review status and the LoRA flag separately.
LEGACY_LORA_STATUS = "lora_candidate"
STATUS_LABELS = {
    "unreviewed": "未選別",
    "adopted": "採用",
    "hold": "保留",
    "rejected": "没",
}
AI_CANDIDATE_LABELS = {
    "adopt_candidate": "採用候補",
    "hold_candidate": "保留候補",
    "reject_candidate": "没候補",
}
PREFERENCE_SIGNALS = {
    "adopted": 1.0,
    "hold": 0.0,
    "rejected": -1.0,
    "unreviewed": 0.0,
}


class GalleryError(Exception):
    """ギャラリー画面へ表示できるエラー。"""


def _serial_sync(method):
    """Serialize filesystem syncs triggered by ThreadingHTTPServer requests."""

    def wrapped(self, *args, **kwargs):
        with self._sync_lock:
            return method(self, *args, **kwargs)

    return wrapped


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _normalise_relative(value: str) -> str:
    return value.replace("\\", "/").lstrip("./")


def _prompt_key(value: str) -> str:
    """Return a stable key for prompt matching while ignoring whitespace/case."""

    normalised = " ".join(str(value or "").split()).casefold()
    return hashlib.sha256(normalised.encode("utf-8")).hexdigest()[:32] if normalised else ""


def _safe_child(path: Path, parent: Path) -> Path | None:
    """path が parent 配下なら resolve 済みパスを返す。"""

    try:
        resolved = path.resolve()
        resolved.relative_to(parent.resolve())
    except (OSError, ValueError):
        return None
    return resolved


def _json_object(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _clip_value(value: Any, limit: int = 100_000) -> Any:
    """巨大なComfyUI workflowをDBへ無制限に保存しない。"""

    if isinstance(value, str):
        return value if len(value) <= limit else value[:limit] + "…"
    if isinstance(value, list):
        return [_clip_value(item, limit) for item in value[:500]]
    if isinstance(value, dict):
        return {str(key): _clip_value(item, limit) for key, item in list(value.items())[:500]}
    return value


def read_png_text(path: Path) -> dict[str, str]:
    """PNGの tEXt / zTXt / iTXt チャンクを標準ライブラリだけで読む。"""

    try:
        data = path.read_bytes()
    except OSError:
        return {}
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        return {}

    result: dict[str, str] = {}
    position = 8
    while position + 12 <= len(data):
        length = struct.unpack(">I", data[position : position + 4])[0]
        chunk_type = data[position + 4 : position + 8]
        start = position + 8
        end = start + length
        if end + 4 > len(data) or length > 16 * 1024 * 1024:
            break
        chunk = data[start:end]
        position = end + 4
        try:
            if chunk_type == b"tEXt":
                keyword, value = chunk.split(b"\x00", 1)
                result[keyword.decode("latin-1")] = value.decode("latin-1")
            elif chunk_type == b"zTXt":
                keyword, compressed = chunk.split(b"\x00", 1)
                if compressed[:1] == b"\x00":
                    value = zlib.decompress(compressed[1:]).decode("latin-1")
                    result[keyword.decode("latin-1")] = value
            elif chunk_type == b"iTXt":
                keyword, rest = chunk.split(b"\x00", 1)
                if len(rest) < 2:
                    continue
                compression_flag = rest[0]
                rest = rest[2:]
                _language, rest = rest.split(b"\x00", 1)
                _translated, value = rest.split(b"\x00", 1)
                if compression_flag:
                    value = zlib.decompress(value)
                result[keyword.decode("utf-8", "replace")] = value.decode(
                    "utf-8", "replace"
                )
        except (UnicodeError, ValueError, zlib.error):
            continue
    return result


def _first_value(sources: Iterable[Any], keys: set[str]) -> Any:
    """複数のmetadataオブジェクトから指定キーを深さ優先で探す。"""

    wanted = {key.casefold() for key in keys}

    def visit(value: Any) -> Any:
        if isinstance(value, dict):
            for key, child in value.items():
                if str(key).casefold() in wanted and child not in (None, "", []):
                    if isinstance(child, (str, int, float)) and not isinstance(child, bool):
                        return child
            for child in value.values():
                found = visit(child)
                if found not in (None, ""):
                    return found
        elif isinstance(value, list):
            for child in value:
                found = visit(child)
                if found not in (None, ""):
                    return found
        return None

    for source in sources:
        found = visit(source)
        if found not in (None, ""):
            return found
    return None


def parse_stable_diffusion_parameters(value: str) -> dict[str, Any]:
    """A1111/SD系PNGの parameters 文字列を表示用に分解する。"""

    lines = value.splitlines()
    negative_index = next(
        (index for index, line in enumerate(lines) if line.startswith("Negative prompt:")),
        None,
    )
    steps_index = next(
        (index for index, line in enumerate(lines) if re.match(r"^Steps:", line)), None
    )
    if negative_index is None:
        prompt_lines = lines[: steps_index if steps_index is not None else len(lines)]
        negative_lines: list[str] = []
    else:
        prompt_lines = lines[:negative_index]
        negative_end = steps_index if steps_index is not None else len(lines)
        negative_lines = [
            line.removeprefix("Negative prompt:").strip()
            for line in lines[negative_index:negative_end]
        ]

    result: dict[str, Any] = {
        "prompt": "\n".join(line.strip() for line in prompt_lines).strip(),
        "negative_prompt": "\n".join(line for line in negative_lines if line).strip(),
    }
    tail = " ".join(lines[steps_index:]) if steps_index is not None else ""
    for label, key in (
        ("Steps", "steps"),
        ("Sampler", "sampler"),
        ("CFG scale", "cfg_scale"),
        ("Seed", "seed"),
        ("Size", "size"),
        ("Model hash", "model_hash"),
        ("Model", "model"),
        ("VAE", "vae"),
        ("Clip skip", "clip_skip"),
    ):
        match = re.search(rf"(?:^|, )?{re.escape(label)}:\s*([^,]+)", tail)
        if match:
            raw = match.group(1).strip()
            if key in {"steps", "seed", "clip_skip"} and raw.isdigit():
                result[key] = int(raw)
            elif key == "cfg_scale":
                try:
                    result[key] = float(raw)
                except ValueError:
                    result[key] = raw
            else:
                result[key] = raw
    return {key: value for key, value in result.items() if value not in (None, "")}


def _parse_comfy_prompt(value: Any) -> dict[str, Any]:
    """ComfyUI prompt JSONからよく使う表示項目だけを取り出す。"""

    if not isinstance(value, dict):
        return {}
    texts: list[str] = []
    texts_by_node: dict[str, str] = {}
    positive_node_ids: set[str] = set()
    negative_node_ids: set[str] = set()
    loras: list[dict[str, Any]] = []
    result: dict[str, Any] = {}
    for node_id, node in value.items():
        if not isinstance(node, dict):
            continue
        class_type = str(node.get("class_type", "")).casefold()
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        text_value = inputs.get("text")
        if isinstance(text_value, str) and ("cliptext" in class_type or "text" in inputs):
            texts.append(text_value)
            texts_by_node[str(node_id)] = text_value
        for input_name, target_ids in (("positive", positive_node_ids), ("negative", negative_node_ids)):
            linked = inputs.get(input_name)
            if isinstance(linked, (list, tuple)) and linked and isinstance(linked[0], (str, int)):
                target_ids.add(str(linked[0]))
        if "ksampler" in class_type or "sampler" in class_type:
            for key in ("seed", "noise_seed"):
                if key in inputs and isinstance(inputs[key], (int, float)):
                    result.setdefault("seed", inputs[key])
        if "checkpointloader" in class_type:
            checkpoint = inputs.get("ckpt_name")
            if isinstance(checkpoint, str):
                result.setdefault("checkpoint", checkpoint)
        if "lora" in class_type:
            name = inputs.get("lora_name") or inputs.get("lora")
            if isinstance(name, str):
                item: dict[str, Any] = {"name": name}
                for key in ("strength_model", "strength_clip", "strength"):
                    if isinstance(inputs.get(key), (int, float)):
                        item[key] = inputs[key]
                loras.append(item)
    if texts:
        positive_texts = [texts_by_node[node_id] for node_id in positive_node_ids if node_id in texts_by_node]
        negative_texts = [texts_by_node[node_id] for node_id in negative_node_ids if node_id in texts_by_node]
        result["prompt"] = "\n\n".join(dict.fromkeys(positive_texts or texts))
        if negative_texts:
            result["negative_prompt"] = "\n\n".join(dict.fromkeys(negative_texts))
    if loras:
        result["loras"] = loras
    return result


def _embedded_metadata(path: Path) -> tuple[dict[str, Any], dict[str, str]]:
    texts = read_png_text(path)
    parsed: dict[str, Any] = {}
    parameters = texts.get("parameters")
    if parameters:
        parsed.update(parse_stable_diffusion_parameters(parameters))
    for key in ("prompt", "comfy_prompt"):
        raw = texts.get(key)
        if not raw:
            continue
        try:
            comfy = _parse_comfy_prompt(json.loads(raw))
        except json.JSONDecodeError:
            comfy = {"prompt": raw}
        for field, value in comfy.items():
            if field == "loras" and isinstance(value, list):
                parsed.setdefault(field, value)
            else:
                parsed.setdefault(field, value)
    # Future generators may embed the explicit diversity contract directly in
    # PNG metadata. Keep it as structured data so the normal metadata merge
    # and classifier can apply it before prompt inference.
    for key in ("dataset_dispersion", "dispersion_classification", "classification"):
        raw = texts.get(key)
        if not raw:
            continue
        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            parsed.setdefault("dataset_dispersion", value)
    return parsed, texts


def _sidecar_metadata(path: Path) -> dict[str, Any]:
    candidates = [
        path.with_name(path.name + ".metadata.json"),
        path.with_suffix(".json"),
    ]
    for candidate in candidates:
        if candidate.is_file():
            value = _json_object(candidate)
            if value is not None:
                return value
    return {}


def _image_dimensions(path: Path) -> tuple[int | None, int | None]:
    try:
        with path.open("rb") as file:
            header = file.read(32)
    except OSError:
        return None, None
    if header.startswith(b"\x89PNG\r\n\x1a\n") and len(header) >= 24:
        return struct.unpack(">II", header[16:24])
    # JPEG dimensions are optional; Pillow is not required for the gallery.
    return None, None


def _iso_from_mtime(path: Path) -> str:
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).astimezone().isoformat(
            timespec="seconds"
        )
    except OSError:
        return now_iso()


def _extract_loras(sources: Iterable[Any]) -> list[Any]:
    def find_named_lora(value: Any) -> Any:
        if isinstance(value, dict):
            for key in ("lora_name", "lora_model", "lora_file"):
                name = value.get(key)
                if isinstance(name, str) and name.strip():
                    item: dict[str, Any] = {"name": name}
                    for strength_key in ("strength_model", "strength_clip", "lora_strength", "strength", "weight"):
                        if isinstance(value.get(strength_key), (int, float)):
                            item[strength_key] = value[strength_key]
                    return [item]
            for child in value.values():
                found = find_named_lora(child)
                if found:
                    return found
        elif isinstance(value, list):
            for child in value:
                found = find_named_lora(child)
                if found:
                    return found
        return []

    for source in sources:
        if isinstance(source, dict):
            for key in ("loras", "lora", "used_loras", "loras_used"):
                value = source.get(key)
                if isinstance(value, list) and value:
                    return value
            named = find_named_lora(source)
            if named:
                return named
        if isinstance(source, list) and source:
            return source
    return []


def build_metadata(
    image_path: Path,
    *,
    dataset_name: str = "",
    dataset_dir: Path | None = None,
    record: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], str]:
    """画像・sidecar・dataset_infoを統合し、UI用metadataを返す。"""

    record = record or {}
    sidecar = _sidecar_metadata(image_path)
    embedded, embedded_text = _embedded_metadata(image_path)
    sources = [embedded, sidecar, record]
    explicit_dispersion = serialise_explicit_classification(
        extract_explicit_classification(sources)
    )

    caption = ""
    caption_file = record.get("caption_file")
    if dataset_dir and isinstance(caption_file, str):
        caption_path = _safe_child(dataset_dir / "train" / caption_file, dataset_dir / "train")
        if caption_path and caption_path.is_file():
            try:
                caption = caption_path.read_text(encoding="utf-8-sig").strip()
            except (OSError, UnicodeError):
                caption = ""

    prompt = _first_value(sources, {"prompt", "positive_prompt", "positive"})
    negative_prompt = _first_value(sources, {"negative_prompt", "negative"})
    if not prompt and caption:
        prompt = caption
    generated_at = _first_value(
        sources,
        {"generated_at", "generation_time", "created_at", "timestamp", "imported_at"},
    ) or _iso_from_mtime(image_path)
    character_name = _first_value(
        sources, {"character_name", "character", "charactername"}
    ) or dataset_name
    original_image = _first_value(
        sources,
        {"original_image", "source_image", "input_image", "init_image", "reference_image"},
    )
    batch_id = _first_value(sources, {"batch_id", "batch", "batchid"})
    job_id = _first_value(sources, {"job_id", "jobid", "prompt_id", "workflow_id"})
    if not original_image and record.get("source_file"):
        original_image = str(record["source_file"])

    metadata: dict[str, Any] = {
        "prompt": str(prompt) if prompt is not None else "",
        "prompt_key": _prompt_key(str(prompt) if prompt is not None else ""),
        "negative_prompt": str(negative_prompt) if negative_prompt is not None else "",
        "seed": _first_value(sources, {"seed", "random_seed"}),
        "model": _first_value(sources, {"model", "model_name", "checkpoint", "ckpt_name"}),
        "checkpoint": _first_value(sources, {"checkpoint", "ckpt_name", "model"}),
        "loras": _extract_loras(sources),
        "lora_strength": _first_value(
            sources, {"lora_strength", "strength_model", "strength", "weight"}
        ),
        "generated_at": str(generated_at),
        # Keep the batch sidecar's original field names available alongside
        # the gallery's normalized names. Existing clients use generated_at
        # and character_name; batch links and detail views can also consume
        # the explicit metadata contract without re-reading the sidecar.
        "created_at": str(
            _first_value(sources, {"created_at", "generated_at", "timestamp"})
            or generated_at
        ),
        "character": str(character_name) if character_name else "",
        "character_name": str(character_name) if character_name else "",
        "original_image": str(original_image) if original_image else "",
        "batch_id": str(batch_id) if batch_id is not None else "",
        "job_id": str(job_id) if job_id is not None else "",
        "caption": caption,
        # This is an additive, flexible metadata contract. Existing rows do
        # not have to be migrated; absent fields continue through inference.
        "source_metadata": {
            "sidecar": _clip_value(sidecar),
            "embedded_keys": sorted(embedded_text),
            "parameters": _clip_value(embedded_text.get("parameters", "")),
            "record": _clip_value(record),
        },
    }
    if explicit_dispersion:
        metadata["dataset_dispersion"] = {
            "schema_version": 1,
            **explicit_dispersion,
        }
    return metadata, str(character_name or "")


def _status_from_record(record: dict[str, Any]) -> str:
    value = record.get("gallery_status") or record.get("review_status")
    if value == LEGACY_LORA_STATUS:
        return "adopted"
    if isinstance(value, str) and value in REVIEW_STATUSES:
        return value
    return "rejected" if record.get("excluded") is True else "unreviewed"


def _lora_candidate_from_record(record: dict[str, Any]) -> bool:
    """Read the additive LoRA flag while accepting old status-style data."""

    value = record.get("lora_candidate", record.get("gallery_lora_candidate", False))
    if isinstance(value, str):
        return value.strip().casefold() in {"1", "true", "yes", "on", LEGACY_LORA_STATUS}
    return bool(value) or record.get("gallery_status") == LEGACY_LORA_STATUS


def _row_metadata(row: sqlite3.Row) -> dict[str, Any]:
    try:
        value = json.loads(row["metadata_json"] or "{}")
    except (TypeError, json.JSONDecodeError):
        value = {}
    return value if isinstance(value, dict) else {}


def _row_prompt_key(row: sqlite3.Row) -> str:
    metadata = _row_metadata(row)
    return str(metadata.get("prompt_key") or _prompt_key(str(metadata.get("prompt") or "")))


def _row_time(row: sqlite3.Row) -> datetime | None:
    try:
        return datetime.fromisoformat(str(row["generated_at"] or row["modified_at"]))
    except (TypeError, ValueError):
        return None


def _generation_group_map(rows: list[sqlite3.Row]) -> tuple[dict[str, str], dict[str, str]]:
    """Map image IDs to explicit or conservative inferred generation groups.

    Existing ComfyUI exports often have no batch/job identifier. In that case,
    images with the same normalized prompt are split when the timestamp gap
    exceeds two minutes, which gives a useful mobile-friendly bulk-selection
    fallback without pretending it is an authoritative job boundary.
    """

    groups: dict[str, str] = {}
    labels: dict[str, str] = {}
    by_prompt: dict[str, list[sqlite3.Row]] = {}
    for row in rows:
        batch_id = str(row["batch_id"] or "")
        job_id = str(row["job_id"] or "")
        # A batch is the narrowest explicit generation group.  A job filter
        # remains available for selecting the whole job, while this detail
        # action should select only the batch represented by the card.
        if batch_id:
            key = f"batch:{batch_id}"
            groups[row["id"]] = key
            labels[key] = f"batch_id: {batch_id}"
        elif job_id:
            key = f"job:{job_id}"
            groups[row["id"]] = key
            labels[key] = f"job_id: {job_id}"
        else:
            by_prompt.setdefault(_row_prompt_key(row), []).append(row)

    for prompt_key, prompt_rows in by_prompt.items():
        ordered = sorted(
            prompt_rows,
            key=lambda row: (
                _row_time(row) or datetime.min.replace(tzinfo=timezone.utc),
                row["relative_path"].casefold(),
            ),
        )
        group_number = 0
        previous_time: datetime | None = None
        for row in ordered:
            current_time = _row_time(row)
            if previous_time is not None and current_time is not None:
                if (current_time - previous_time).total_seconds() > 120:
                    group_number += 1
            elif previous_time is None and current_time is None and group_number:
                group_number += 1
            key = f"inferred:{prompt_key or 'no-prompt'}:{group_number}"
            groups[row["id"]] = key
            labels[key] = "同一promptの連続生成（推定）"
            previous_time = current_time
    return groups, labels


class GalleryStore:
    """画像rootを一つ担当するSQLiteベースのギャラリー索引。"""

    def __init__(self, images_root: Path, db_path: Path) -> None:
        self.images_root = images_root.expanduser().resolve()
        self.db_path = db_path.expanduser().resolve()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.thumbnail_root = self.db_path.parent / "thumbs"
        self._lock = threading.RLock()
        self._sync_lock = threading.Lock()
        self._filesystem_signature_value: str | None = None
        self._known_file_state: dict[str, tuple[int, int, int]] = {}
        self._last_scan_count = 0
        self._last_signature_check_at = 0.0
        self._signature_check_interval = 5.0
        self._sync_thread: threading.Thread | None = None
        self._sync_stop_event = threading.Event()
        self._last_sync_error: str | None = None
        self._last_sync_completed_at: str | None = None
        self.connection = sqlite3.connect(
            self.db_path, timeout=30, check_same_thread=False
        )
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA foreign_keys=ON")
        self._create_schema()

    def close(self) -> None:
        with self._lock:
            self._sync_stop_event.set()
            sync_thread = self._sync_thread
        if sync_thread is not None and sync_thread is not threading.current_thread():
            # Do not close the SQLite connection while a background scan can
            # still be using it.  Waiting gives shutdown a deterministic
            # task-cleanup boundary.
            sync_thread.join()
        with self._lock:
            self.connection.close()

    def _run_background_sync(self) -> None:
        try:
            if self._sync_stop_event.is_set():
                return
            self.sync()
        except Exception as error:  # keep an index-backed response available
            with self._lock:
                self._last_sync_error = f"{type(error).__name__}: {error}"
        else:
            with self._lock:
                self._last_sync_error = None
                self._last_sync_completed_at = now_iso()
        finally:
            with self._lock:
                if self._sync_thread is threading.current_thread():
                    self._sync_thread = None

    def request_background_sync(self) -> dict[str, Any]:
        """Start at most one non-blocking filesystem sync and return its state.

        Callers can continue reading the last committed SQLite index while the
        scan is in progress. A failed refresh is retained as diagnostic state
        and does not invalidate the existing index.
        """

        with self._lock:
            if self._sync_stop_event.is_set():
                return self._sync_status_locked()
            if self._sync_thread is None or not self._sync_thread.is_alive():
                self._sync_thread = threading.Thread(
                    target=self._run_background_sync,
                    name="gallery-index-sync",
                    daemon=True,
                )
                self._sync_thread.start()
            return self._sync_status_locked()

    def _sync_status_locked(self) -> dict[str, Any]:
        return {
            "running": self._sync_thread is not None and self._sync_thread.is_alive(),
            "last_error": self._last_sync_error,
            "last_completed_at": self._last_sync_completed_at,
            "indexed_count": self._last_scan_count,
        }

    def sync_status(self) -> dict[str, Any]:
        """Return background sync state without touching the filesystem."""

        with self._lock:
            return self._sync_status_locked()

    def _create_schema(self) -> None:
        with self.connection:
            self.connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS images (
                    id TEXT PRIMARY KEY,
                    path TEXT NOT NULL UNIQUE,
                    relative_path TEXT NOT NULL,
                    dataset_name TEXT NOT NULL DEFAULT '',
                    character_name TEXT NOT NULL DEFAULT '',
                    filename TEXT NOT NULL,
                    extension TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL DEFAULT 0,
                    modified_at TEXT NOT NULL DEFAULT '',
                    generated_at TEXT NOT NULL DEFAULT '',
                    batch_id TEXT NOT NULL DEFAULT '',
                    job_id TEXT NOT NULL DEFAULT '',
                    width INTEGER,
                    height INTEGER,
                    status TEXT NOT NULL DEFAULT 'unreviewed',
                    lora_candidate INTEGER NOT NULL DEFAULT 0,
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    dataset_info_path TEXT NOT NULL DEFAULT '',
                    dataset_record_id TEXT NOT NULL DEFAULT '',
                    first_seen_at TEXT NOT NULL,
                    last_seen_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_gallery_status ON images(status);
                CREATE INDEX IF NOT EXISTS idx_gallery_dataset ON images(dataset_name);
                CREATE INDEX IF NOT EXISTS idx_gallery_generated ON images(generated_at);

                CREATE TABLE IF NOT EXISTS ai_scores (
                    image_id TEXT PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
                    quality_score REAL,
                    character_score REAL,
                    duplicate_penalty REAL,
                    preference_score REAL,
                    final_score REAL,
                    ai_candidate TEXT NOT NULL DEFAULT '',
                    details_json TEXT NOT NULL DEFAULT '{}',
                    model_name TEXT NOT NULL DEFAULT '',
                    embedding_model TEXT NOT NULL DEFAULT '',
                    phash TEXT NOT NULL DEFAULT '',
                    embedding BLOB,
                    source_mtime_ns INTEGER,
                    reference_name TEXT NOT NULL DEFAULT '',
                    evaluated_at TEXT NOT NULL DEFAULT '',
                    FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_ai_final_score ON ai_scores(final_score);
                CREATE INDEX IF NOT EXISTS idx_ai_quality_score ON ai_scores(quality_score);
                CREATE INDEX IF NOT EXISTS idx_ai_character_score ON ai_scores(character_score);
                CREATE INDEX IF NOT EXISTS idx_ai_duplicate_penalty ON ai_scores(duplicate_penalty);

                CREATE TABLE IF NOT EXISTS character_references (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE,
                    image_ids_json TEXT NOT NULL DEFAULT '[]',
                    embedding BLOB,
                    embedding_dim INTEGER,
                    embedding_model TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS preference_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
                    previous_status TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL,
                    signal REAL NOT NULL,
                    source TEXT NOT NULL DEFAULT 'manual_commit',
                    created_at TEXT NOT NULL,
                    embedding_model TEXT NOT NULL DEFAULT ''
                );
                CREATE INDEX IF NOT EXISTS idx_preference_events_image ON preference_events(image_id);
                CREATE INDEX IF NOT EXISTS idx_preference_events_created ON preference_events(created_at);
                """
            )
            columns = {
                row[1]
                for row in self.connection.execute("PRAGMA table_info(images)").fetchall()
            }
            for column in ("batch_id", "job_id", "lora_candidate"):
                if column not in columns:
                    column_type = "INTEGER NOT NULL DEFAULT 0" if column == "lora_candidate" else "TEXT NOT NULL DEFAULT ''"
                    self.connection.execute(f"ALTER TABLE images ADD COLUMN {column} {column_type}")
            # Older versions represented LoRA candidates as an exclusive
            # review status.  Preserve those records as adopted images with
            # the new additive flag, without touching image files.
            self.connection.execute(
                "UPDATE images SET status = 'adopted', lora_candidate = 1 WHERE status = ?",
                (LEGACY_LORA_STATUS,),
            )
            self.connection.execute(
                "UPDATE preference_events SET status = 'adopted', signal = 1.0 WHERE status = ?",
                (LEGACY_LORA_STATUS,),
            )
            self.connection.execute(
                "UPDATE preference_events SET previous_status = 'adopted' WHERE previous_status = ?",
                (LEGACY_LORA_STATUS,),
            )
            self.connection.execute("CREATE INDEX IF NOT EXISTS idx_gallery_batch ON images(batch_id)")
            self.connection.execute("CREATE INDEX IF NOT EXISTS idx_gallery_job ON images(job_id)")
            self.connection.execute("CREATE INDEX IF NOT EXISTS idx_gallery_lora_candidate ON images(lora_candidate)")

    def _image_id(self, relative_path: str) -> str:
        return hashlib.sha256(relative_path.casefold().encode("utf-8")).hexdigest()[:32]

    def _dataset_contexts(self) -> list[tuple[str, Path, Path, dict[str, Any]]]:
        if not self.images_root.is_dir():
            return []
        contexts: list[tuple[str, Path, Path, dict[str, Any]]] = []
        root_info = self.images_root / "dataset_info.json"
        if root_info.is_file():
            info = _json_object(root_info)
            if info is not None:
                contexts.append((self.images_root.name, self.images_root, root_info, info))
            return contexts
        try:
            children = sorted(self.images_root.iterdir(), key=lambda item: item.name.casefold())
        except OSError:
            return []
        for child in children:
            if not child.is_dir() or child.is_symlink():
                continue
            info_path = child / "dataset_info.json"
            if not info_path.is_file():
                continue
            info = _json_object(info_path)
            if info is not None:
                contexts.append((str(info.get("dataset_name") or child.name), child, info_path, info))
        return contexts

    def _scan(self) -> list[dict[str, Any]]:
        """現在存在する画像をギャラリー行へ変換する。"""

        if not self.images_root.is_dir():
            return []
        scanned: list[dict[str, Any]] = []
        contexts = self._dataset_contexts()
        for dataset_name, dataset_dir, info_path, info in contexts:
            source_dir = dataset_dir / "source"
            if not source_dir.is_dir():
                continue
            records: dict[str, dict[str, Any]] = {}
            for record in info.get("images", []):
                if isinstance(record, dict) and isinstance(record.get("source_file"), str):
                    records[_normalise_relative(record["source_file"]).casefold()] = record
            try:
                paths = sorted(source_dir.rglob("*"), key=lambda item: item.as_posix().casefold())
            except OSError:
                paths = []
            for image_path in paths:
                if (
                    not image_path.is_file()
                    or image_path.is_symlink()
                    or image_path.suffix.casefold() not in SUPPORTED_EXTENSIONS
                ):
                    continue
                relative = image_path.relative_to(self.images_root).as_posix()
                source_relative = image_path.relative_to(source_dir).as_posix()
                record = records.get(source_relative.casefold(), {})
                scanned.append(
                    self._build_row(
                        image_path,
                        relative,
                        dataset_name=dataset_name,
                        dataset_info_path=info_path,
                        record=record,
                        dataset_dir=dataset_dir,
                    )
                )

        # A ComfyUI output directory normally has no dataset_info.json. In that
        # case every image below the supplied root is indexed as a generic image.
        if not contexts:
            try:
                paths = sorted(self.images_root.rglob("*"), key=lambda item: item.as_posix().casefold())
            except OSError:
                paths = []
            for image_path in paths:
                if (
                    not image_path.is_file()
                    or image_path.is_symlink()
                    or image_path.suffix.casefold() not in SUPPORTED_EXTENSIONS
                ):
                    continue
                relative = image_path.relative_to(self.images_root).as_posix()
                scanned.append(self._build_row(image_path, relative))
        return scanned

    def _build_row(
        self,
        image_path: Path,
        relative: str,
        *,
        dataset_name: str = "",
        dataset_info_path: Path | None = None,
        record: dict[str, Any] | None = None,
        dataset_dir: Path | None = None,
    ) -> dict[str, Any]:
        record = record or {}
        metadata, character_name = build_metadata(
            image_path,
            dataset_name=dataset_name,
            dataset_dir=dataset_dir,
            record=record,
        )
        try:
            stat = image_path.stat()
            size_bytes = stat.st_size
            modified_at = datetime.fromtimestamp(
                stat.st_mtime, tz=timezone.utc
            ).astimezone().isoformat(timespec="seconds")
        except OSError:
            size_bytes = 0
            modified_at = now_iso()
        width, height = _image_dimensions(image_path)
        return {
            "id": self._image_id(relative),
            "path": str(image_path.resolve()),
            "relative_path": relative,
            "dataset_name": dataset_name,
            "character_name": character_name,
            "filename": image_path.name,
            "extension": image_path.suffix.casefold(),
            "size_bytes": size_bytes,
            "modified_at": modified_at,
            "generated_at": str(metadata.get("generated_at") or modified_at),
            "batch_id": str(metadata.get("batch_id") or ""),
            "job_id": str(metadata.get("job_id") or ""),
            "width": width,
            "height": height,
            "initial_status": _status_from_record(record),
            "initial_lora_candidate": _lora_candidate_from_record(record),
            "metadata_json": json.dumps(metadata, ensure_ascii=False, separators=(",", ":")),
            "dataset_info_path": str(dataset_info_path.resolve()) if dataset_info_path else "",
            "dataset_record_id": str(record.get("id", "")) if record else "",
        }

    def _filesystem_signature(self) -> str:
        """画像と関連metadataの変更検知用署名を作る。

        ページ移動時はPNG本体を再解析せず、この軽いstat走査だけで済ませる。
        """

        if not self.images_root.is_dir():
            return "missing"
        entries: list[str] = []
        try:
            for path in self.images_root.rglob("*"):
                if path.is_symlink() or not path.is_file():
                    continue
                suffix = path.suffix.casefold()
                if suffix not in SUPPORTED_EXTENSIONS and suffix not in {".json", ".txt"}:
                    continue
                stat = path.stat()
                relative = path.relative_to(self.images_root).as_posix()
                entries.append(f"{relative}\0{stat.st_size}\0{stat.st_mtime_ns}")
        except (OSError, ValueError):
            return f"error:{now_iso()}"
        entries.sort(key=str.casefold)
        digest = hashlib.sha256()
        for entry in entries:
            digest.update(entry.encode("utf-8", "surrogatepass"))
            digest.update(b"\n")
        return digest.hexdigest()

    @staticmethod
    def _sidecar_mtime_ns(image_path: Path) -> int:
        latest = 0
        for candidate in (
            image_path.with_name(image_path.name + ".metadata.json"),
            image_path.with_suffix(".json"),
        ):
            try:
                if candidate.is_file():
                    latest = max(latest, candidate.stat().st_mtime_ns)
            except OSError:
                continue
        return latest

    @classmethod
    def _file_state(cls, image_path: Path) -> tuple[int, int, int]:
        try:
            stat = image_path.stat()
            return stat.st_size, stat.st_mtime_ns, cls._sidecar_mtime_ns(image_path)
        except OSError:
            return 0, 0, cls._sidecar_mtime_ns(image_path)

    def _scan_incremental(self) -> tuple[list[dict[str, Any]], set[str], dict[str, tuple[int, int, int]]] | None:
        """Scan only changed/new generic output files after the first index.

        ComfyUI output roots do not contain dataset_info.json, so the common
        case can avoid reopening thousands of existing PNGs whenever a new
        batch arrives.  Dataset roots keep the conservative full-scan path.
        """

        if self._dataset_contexts():
            return None
        try:
            with self._lock:
                existing_paths = {
                    str(row["relative_path"])
                    for row in self.connection.execute("SELECT relative_path FROM images").fetchall()
                }
        except sqlite3.Error:
            existing_paths = set()
        changed: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        current_state: dict[str, tuple[int, int, int]] = {}
        try:
            paths = self.images_root.rglob("*")
            for image_path in paths:
                if (
                    not image_path.is_file()
                    or image_path.is_symlink()
                    or image_path.suffix.casefold() not in SUPPORTED_EXTENSIONS
                ):
                    continue
                relative = image_path.relative_to(self.images_root).as_posix()
                state = self._file_state(image_path)
                current_state[relative] = state
                image_id = self._image_id(relative)
                seen_ids.add(image_id)
                if (
                    relative not in existing_paths
                    or self._known_file_state.get(relative) != state
                ):
                    changed.append(self._build_row(image_path, relative))
        except (OSError, ValueError):
            return None
        return changed, seen_ids, current_state

    @_serial_sync
    def sync(self, *, force: bool = False) -> int:
        """ファイルを再走査する。変更がなければ既存索引をそのまま使う。"""

        now = time.monotonic()
        if (
            not force
            and self._filesystem_signature_value is not None
            and now - self._last_signature_check_at < self._signature_check_interval
        ):
            return self._last_scan_count
        signature = self._filesystem_signature()
        self._last_signature_check_at = now
        if not force and signature == self._filesystem_signature_value:
            return self._last_scan_count

        incremental = None if force or self._filesystem_signature_value is None else self._scan_incremental()
        current_state: dict[str, tuple[int, int, int]]
        if incremental is None:
            scanned = self._scan()
            seen_ids = {row["id"] for row in scanned}
            current_state = {
                str(row["relative_path"]): self._file_state(Path(row["path"]))
                for row in scanned
            }
        else:
            scanned, seen_ids, current_state = incremental
        timestamp = now_iso()
        with self._lock, self.connection:
            for row in scanned:
                self.connection.execute(
                    """
                    INSERT INTO images (
                        id, path, relative_path, dataset_name, character_name,
                        filename, extension, size_bytes, modified_at, generated_at,
                        batch_id, job_id,
                        width, height, status, lora_candidate, metadata_json, dataset_info_path,
                        dataset_record_id, first_seen_at, last_seen_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        path=excluded.path,
                        relative_path=excluded.relative_path,
                        dataset_name=excluded.dataset_name,
                        character_name=excluded.character_name,
                        filename=excluded.filename,
                        extension=excluded.extension,
                        size_bytes=excluded.size_bytes,
                        modified_at=excluded.modified_at,
                        generated_at=excluded.generated_at,
                        batch_id=excluded.batch_id,
                        job_id=excluded.job_id,
                        width=excluded.width,
                        height=excluded.height,
                        metadata_json=excluded.metadata_json,
                        dataset_info_path=excluded.dataset_info_path,
                        dataset_record_id=excluded.dataset_record_id,
                        last_seen_at=excluded.last_seen_at
                    """,
                    (
                        row["id"],
                        row["path"],
                        row["relative_path"],
                        row["dataset_name"],
                        row["character_name"],
                        row["filename"],
                        row["extension"],
                        row["size_bytes"],
                        row["modified_at"],
                        row["generated_at"],
                        row["batch_id"],
                        row["job_id"],
                        row["width"],
                        row["height"],
                        row["initial_status"],
                        int(row["initial_lora_candidate"]),
                        row["metadata_json"],
                        row["dataset_info_path"],
                        row["dataset_record_id"],
                        timestamp,
                        timestamp,
                    ),
                )
            if seen_ids:
                self.connection.execute(
                    "CREATE TEMP TABLE IF NOT EXISTS _gallery_seen_ids (id TEXT PRIMARY KEY)"
                )
                self.connection.execute("DELETE FROM _gallery_seen_ids")
                self.connection.executemany(
                    "INSERT INTO _gallery_seen_ids (id) VALUES (?)",
                    ((image_id,) for image_id in seen_ids),
                )
                self.connection.execute(
                    "DELETE FROM images WHERE id NOT IN (SELECT id FROM _gallery_seen_ids)"
                )
                self.connection.execute("DELETE FROM _gallery_seen_ids")
            else:
                self.connection.execute("DELETE FROM images")
        self._filesystem_signature_value = signature
        self._known_file_state = current_state
        self._last_scan_count = len(seen_ids)
        return len(seen_ids)

    def _row_payload(self, row: sqlite3.Row) -> dict[str, Any]:
        try:
            metadata = json.loads(row["metadata_json"])
        except (TypeError, json.JSONDecodeError):
            metadata = {}
        if not isinstance(metadata, dict):
            metadata = {}
        ai_values = {
            "quality_score": row["ai_quality_score"] if "ai_quality_score" in row.keys() else None,
            "character_score": row["ai_character_score"] if "ai_character_score" in row.keys() else None,
            "duplicate_penalty": row["ai_duplicate_penalty"] if "ai_duplicate_penalty" in row.keys() else None,
            "preference_score": row["ai_preference_score"] if "ai_preference_score" in row.keys() else None,
            "final_score": row["ai_final_score"] if "ai_final_score" in row.keys() else None,
            "candidate": row["ai_candidate"] if "ai_candidate" in row.keys() else "",
            "model_name": row["ai_model_name"] if "ai_model_name" in row.keys() else "",
            "reference_name": row["ai_reference_name"] if "ai_reference_name" in row.keys() else "",
            "evaluated_at": row["ai_evaluated_at"] if "ai_evaluated_at" in row.keys() else "",
        }
        try:
            ai_values["details"] = json.loads(row["ai_details_json"] or "{}") if "ai_details_json" in row.keys() else {}
        except (TypeError, json.JSONDecodeError):
            ai_values["details"] = {}
        has_ai = any(value not in (None, "", {}) for value in ai_values.values())
        return {
            "id": row["id"],
            "filename": row["filename"],
            "relative_path": row["relative_path"],
            "dataset_name": row["dataset_name"],
            "character_name": row["character_name"],
            "extension": row["extension"],
            "size_bytes": row["size_bytes"],
            "modified_at": row["modified_at"],
            "generated_at": row["generated_at"],
            "batch_id": row["batch_id"] if "batch_id" in row.keys() else "",
            "job_id": row["job_id"] if "job_id" in row.keys() else "",
            "width": row["width"],
            "height": row["height"],
            "status": row["status"],
            "status_label": STATUS_LABELS.get(row["status"], row["status"]),
            "lora_candidate": bool(row["lora_candidate"]) if "lora_candidate" in row.keys() else False,
            "url": f"/media/{row['id']}",
            "thumbnail_url": f"/thumb/{row['id']}?size=320",
            "metadata": metadata,
            "ai": ai_values if has_ai else None,
        }

    def _matching_rows(
        self,
        *,
        status: str = "",
        character: str = "",
        dataset: str = "",
        job_id: str = "",
        query: str = "",
        date_from: str = "",
        date_to: str = "",
        sort: str = "recent",
        exclude_similar: bool = False,
        lora_candidate: bool = False,
        dispersion_dimension: str = "",
        dispersion_value: str = "",
    ) -> list[sqlite3.Row]:
        with self._lock:
            rows = self.connection.execute(
                """
                SELECT images.*,
                       ai_scores.quality_score AS ai_quality_score,
                       ai_scores.character_score AS ai_character_score,
                       ai_scores.duplicate_penalty AS ai_duplicate_penalty,
                       ai_scores.preference_score AS ai_preference_score,
                       ai_scores.final_score AS ai_final_score,
                       ai_scores.ai_candidate AS ai_candidate,
                       ai_scores.details_json AS ai_details_json,
                       ai_scores.model_name AS ai_model_name,
                       ai_scores.reference_name AS ai_reference_name,
                       ai_scores.evaluated_at AS ai_evaluated_at
                FROM images
                LEFT JOIN ai_scores ON ai_scores.image_id = images.id
                """
            ).fetchall()
        character_key = character.strip().casefold()
        dataset_key = dataset.strip().casefold()
        job_key = job_id.strip().casefold()
        query_key = query.strip().casefold()
        result: list[sqlite3.Row] = []
        for row in rows:
            if status == LEGACY_LORA_STATUS:
                if not bool(row["lora_candidate"]):
                    continue
            elif status and status in REVIEW_STATUSES and row["status"] != status:
                continue
            if lora_candidate and not bool(row["lora_candidate"]):
                continue
            row_job_id = str(row["job_id"] or "").strip().casefold()
            if job_key and row_job_id != job_key:
                continue
            if dataset_key and dataset_key not in str(row["dataset_name"] or "").casefold():
                continue
            text = " ".join(
                (row["character_name"], row["dataset_name"], row["filename"], row["relative_path"])
            ).casefold()
            if character_key and character_key not in text:
                continue
            if query_key and query_key not in (text + " " + str(row["metadata_json"])).casefold():
                continue
            generated_date = str(row["generated_at"] or row["modified_at"])[:10]
            if date_from and generated_date < date_from:
                continue
            if date_to and generated_date > date_to:
                continue
            ai_penalty = row["ai_duplicate_penalty"]
            if exclude_similar and ai_penalty is not None and float(ai_penalty) >= 0.75:
                continue
            if dispersion_dimension and not matches_classification(
                {"metadata": _row_metadata(row)}, dispersion_dimension, dispersion_value
            ):
                continue
            result.append(row)
        if sort == "ai":
            result.sort(key=lambda row: (row["ai_final_score"] is None, -(row["ai_final_score"] or -1.0), row["relative_path"].casefold()))
        elif sort == "quality":
            result.sort(key=lambda row: (row["ai_quality_score"] is None, -(row["ai_quality_score"] or -1.0), row["relative_path"].casefold()))
        elif sort == "character":
            result.sort(key=lambda row: (row["ai_character_score"] is None, -(row["ai_character_score"] or -1.0), row["relative_path"].casefold()))
        elif sort == "duplicate":
            result.sort(key=lambda row: (row["ai_duplicate_penalty"] is None, row["ai_duplicate_penalty"] or 0.0, row["relative_path"].casefold()))
        else:
            result.sort(key=lambda row: (row["generated_at"] or "", row["relative_path"].casefold()), reverse=True)
        return result

    def list_images(
        self,
        *,
        status: str = "",
        character: str = "",
        dataset: str = "",
        job_id: str = "",
        query: str = "",
        date_from: str = "",
        date_to: str = "",
        sort: str = "recent",
        exclude_similar: bool = False,
        lora_candidate: bool = False,
        dispersion_dimension: str = "",
        dispersion_value: str = "",
    ) -> list[dict[str, Any]]:
        return [
            self._row_payload(row)
            for row in self._matching_rows(
                status=status,
                character=character,
                dataset=dataset,
                job_id=job_id,
                query=query,
                date_from=date_from,
                date_to=date_to,
                sort=sort,
                exclude_similar=exclude_similar,
                lora_candidate=lora_candidate,
                dispersion_dimension=dispersion_dimension,
                dispersion_value=dispersion_value,
            )
        ]

    def list_images_page(
        self,
        *,
        page: int = 1,
        page_size: int = 50,
        status: str = "",
        character: str = "",
        dataset: str = "",
        job_id: str = "",
        query: str = "",
        date_from: str = "",
        date_to: str = "",
        sort: str = "recent",
        exclude_similar: bool = False,
        lora_candidate: bool = False,
        dispersion_dimension: str = "",
        dispersion_value: str = "",
    ) -> dict[str, Any]:
        if page < 1:
            raise GalleryError("pageは1以上で指定してください。")
        if page_size not in range(1, 101):
            raise GalleryError("page_sizeは1～100で指定してください。")
        rows = self._matching_rows(
            status=status,
            character=character,
            dataset=dataset,
            job_id=job_id,
            query=query,
            date_from=date_from,
            date_to=date_to,
            sort=sort,
            exclude_similar=exclude_similar,
            lora_candidate=lora_candidate,
            dispersion_dimension=dispersion_dimension,
            dispersion_value=dispersion_value,
        )
        total = len(rows)
        total_pages = max(1, (total + page_size - 1) // page_size)
        actual_page = min(page, total_pages)
        start = (actual_page - 1) * page_size
        return {
            "images": [self._row_payload(row) for row in rows[start : start + page_size]],
            "total": total,
            "page": actual_page,
            "page_size": page_size,
            "total_pages": total_pages,
        }

    def job_summary(self, job_id: str) -> dict[str, Any]:
        """Return fresh image/AI candidate counts for a single generation job."""

        key = job_id.strip()
        if not key:
            raise GalleryError("job_idを指定してください。")
        rows = self._matching_rows(job_id=key)
        candidate_counts = {
            "adopt_candidate": 0,
            "hold_candidate": 0,
            "reject_candidate": 0,
        }
        ai_scored = 0
        batch_ids: set[str] = set()
        for row in rows:
            if row["batch_id"]:
                batch_ids.add(str(row["batch_id"]))
            if row["ai_final_score"] is not None:
                ai_scored += 1
            candidate = str(row["ai_candidate"] or "")
            if candidate in candidate_counts:
                candidate_counts[candidate] += 1
        return {
            "job_id": key,
            "total": len(rows),
            "batch_count": len(batch_ids),
            "ai_scored": ai_scored,
            "adopt_candidate": candidate_counts["adopt_candidate"],
            "hold_candidate": candidate_counts["hold_candidate"],
            "reject_candidate": candidate_counts["reject_candidate"],
        }

    def dispersion_summary(
        self,
        *,
        status: str = "adopted",
        character: str = "",
        dataset: str = "",
        job_id: str = "",
        query: str = "",
        date_from: str = "",
        date_to: str = "",
        exclude_similar: bool = False,
        lora_candidate: bool = False,
    ) -> dict[str, Any]:
        """Summarise derived prompt/caption labels without changing the DB."""

        rows = self._matching_rows(
            status=status,
            character=character,
            dataset=dataset,
            job_id=job_id,
            query=query,
            date_from=date_from,
            date_to=date_to,
            sort="recent",
            exclude_similar=exclude_similar,
            lora_candidate=lora_candidate,
        )
        images = [
            {"id": row["id"], "metadata": _row_metadata(row)}
            for row in rows
        ]
        config_path = self.db_path.parent / "dispersion_config.json"
        if not config_path.is_file():
            config_path = Path(__file__).resolve().with_name("dispersion_config.json")
        return {
            **summarise(images, load_warning_config(config_path)),
            "scope": {
                "status": status or "all",
                "character": character,
                "dataset": dataset,
                "job_id": job_id,
                "total": len(images),
            },
        }

    def selection_ids(
        self,
        *,
        status: str = "",
        character: str = "",
        dataset: str = "",
        job_id: str = "",
        query: str = "",
        date_from: str = "",
        date_to: str = "",
        sort: str = "recent",
        exclude_similar: bool = False,
        lora_candidate: bool = False,
        dispersion_dimension: str = "",
        dispersion_value: str = "",
        match: str = "",
        image_id: str = "",
        range_start: str = "",
        range_end: str = "",
    ) -> dict[str, Any]:
        """Return IDs for a non-mutating bulk-selection operation."""

        if match not in {"", "prompt", "group"}:
            raise GalleryError("matchはpromptまたはgroupで指定してください。")
        if match and not image_id:
            raise GalleryError("match指定時はimage_idが必要です。")
        if (range_start and not range_end) or (range_end and not range_start):
            raise GalleryError("範囲選択にはrange_startとrange_endの両方が必要です。")

        if match:
            rows = self._matching_rows()
            target = next((row for row in rows if row["id"] == image_id), None)
            if target is None:
                raise GalleryError("基準画像が見つかりません。画面を更新してください。")
            if match == "prompt":
                target_key = _row_prompt_key(target)
                if not target_key:
                    raise GalleryError("この画像にはpromptが保存されていません。")
                selected = [row for row in rows if _row_prompt_key(row) == target_key]
                label = "同じprompt"
            else:
                group_map, group_labels = _generation_group_map(rows)
                target_group = group_map.get(image_id)
                if not target_group:
                    raise GalleryError("生成グループを推定できませんでした。")
                selected = [row for row in rows if group_map.get(row["id"]) == target_group]
                label = group_labels.get(target_group, "同じ生成グループ")
            return {
                "ids": [row["id"] for row in selected],
                "items": [
                    {"id": row["id"], "status": row["status"], "lora_candidate": bool(row["lora_candidate"])}
                    for row in selected
                ],
                "total": len(selected),
                "label": label,
            }

        rows = self._matching_rows(
            status=status,
            character=character,
            dataset=dataset,
            job_id=job_id,
            query=query,
            date_from=date_from,
            date_to=date_to,
            sort=sort,
            exclude_similar=exclude_similar,
            lora_candidate=lora_candidate,
            dispersion_dimension=dispersion_dimension,
            dispersion_value=dispersion_value,
        )
        if range_start and range_end:
            start_index = next((index for index, row in enumerate(rows) if row["id"] == range_start), None)
            end_index = next((index for index, row in enumerate(rows) if row["id"] == range_end), None)
            if start_index is None or end_index is None:
                raise GalleryError("範囲内の画像が現在の絞り込み結果にありません。")
            lower, upper = sorted((start_index, end_index))
            rows = rows[lower : upper + 1]
        return {
            "ids": [row["id"] for row in rows],
            "items": [
                {"id": row["id"], "status": row["status"], "lora_candidate": bool(row["lora_candidate"])}
                for row in rows
            ],
            "total": len(rows),
            "label": "現在の検索結果",
        }

    def selection_match_info(self, image_id: str) -> dict[str, Any]:
        """Return counts shown before prompt/group bulk selection is applied."""

        rows = self._matching_rows()
        target = next((row for row in rows if row["id"] == image_id), None)
        if target is None:
            raise GalleryError("画像が見つかりません。画面を更新してください。")
        group_map, group_labels = _generation_group_map(rows)
        prompt_key = _row_prompt_key(target)
        group_key = group_map.get(image_id, "")
        prompt_count = sum(1 for row in rows if _row_prompt_key(row) == prompt_key)
        group_count = sum(1 for row in rows if group_map.get(row["id"]) == group_key)
        return {
            "image_id": image_id,
            "prompt_count": prompt_count,
            "group_count": group_count,
            "group_label": group_labels.get(group_key, "同じ生成グループ"),
            "batch_id": target["batch_id"] if "batch_id" in target.keys() else "",
            "job_id": target["job_id"] if "job_id" in target.keys() else "",
        }

    def get(self, image_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self.connection.execute(
                """
                SELECT images.*,
                       ai_scores.quality_score AS ai_quality_score,
                       ai_scores.character_score AS ai_character_score,
                       ai_scores.duplicate_penalty AS ai_duplicate_penalty,
                       ai_scores.preference_score AS ai_preference_score,
                       ai_scores.final_score AS ai_final_score,
                       ai_scores.ai_candidate AS ai_candidate,
                       ai_scores.details_json AS ai_details_json,
                       ai_scores.model_name AS ai_model_name,
                       ai_scores.reference_name AS ai_reference_name,
                       ai_scores.evaluated_at AS ai_evaluated_at
                FROM images LEFT JOIN ai_scores ON ai_scores.image_id = images.id
                WHERE images.id = ?
                """,
                (image_id,),
            ).fetchone()
        return self._row_payload(row) if row else None

    def resolve_image(self, image_id: str) -> tuple[Path, str] | None:
        with self._lock:
            row = self.connection.execute("SELECT path, extension FROM images WHERE id = ?", (image_id,)).fetchone()
        if row is None:
            return None
        path = _safe_child(Path(row["path"]), self.images_root)
        if path is None or not path.is_file() or path.suffix.casefold() not in SUPPORTED_EXTENSIONS:
            return None
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        return path, content_type

    def resolve_thumbnail(self, image_id: str, size: int = 320) -> tuple[Path, str] | None:
        if size not in THUMBNAIL_SIZES:
            raise GalleryError(f"thumbnail sizeは{THUMBNAIL_SIZES}のいずれかです。")
        resolved = self.resolve_image(image_id)
        if resolved is None:
            return None
        image_path, original_content_type = resolved
        cache_path = self.thumbnail_root / f"{image_id}_{size}.jpg"
        try:
            original_mtime = image_path.stat().st_mtime_ns
            if cache_path.is_file() and cache_path.stat().st_mtime_ns >= original_mtime:
                return cache_path, "image/jpeg"
        except OSError:
            pass

        try:
            from PIL import Image, ImageOps
        except ImportError:
            # 依存がない環境でもギャラリー自体は使えるようにする。
            return image_path, original_content_type

        self.thumbnail_root.mkdir(parents=True, exist_ok=True)
        temporary_name: str | None = None
        try:
            with Image.open(image_path) as opened:
                image = ImageOps.exif_transpose(opened)
                if image.mode in {"RGBA", "LA"} or "transparency" in image.info:
                    rgba = image.convert("RGBA")
                    background = Image.new("RGB", rgba.size, "white")
                    background.paste(rgba, mask=rgba.getchannel("A"))
                    image = background
                else:
                    image = image.convert("RGB")
                image.thumbnail((size, size), Image.Resampling.LANCZOS)
                with tempfile.NamedTemporaryFile(
                    suffix=".jpg", dir=self.thumbnail_root, delete=False
                ) as temporary:
                    temporary_name = temporary.name
                image.save(temporary_name, format="JPEG", quality=84, optimize=True)
            os.replace(temporary_name, cache_path)
            temporary_name = None
        except Exception as error:
            if temporary_name:
                Path(temporary_name).unlink(missing_ok=True)
            raise GalleryError(f"サムネイルを生成できません: {error}") from error
        return cache_path, "image/jpeg"

    def _write_json_atomic(self, path: Path, value: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary_name: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", newline="\n", dir=path.parent,
                prefix=f".{path.name}.", suffix=".tmp", delete=False
            ) as file:
                json.dump(value, file, ensure_ascii=False, indent=2)
                file.write("\n")
                temporary_name = file.name
            os.replace(temporary_name, path)
        except Exception:
            if temporary_name:
                Path(temporary_name).unlink(missing_ok=True)
            raise

    def _updated_dataset_infos(
        self, rows: list[sqlite3.Row], updates: dict[str, dict[str, Any]]
    ) -> tuple[list[tuple[Path, bytes, dict[str, Any]]], list[Path]]:
        grouped: dict[Path, list[sqlite3.Row]] = {}
        for row in rows:
            if row["dataset_info_path"]:
                grouped.setdefault(Path(row["dataset_info_path"]), []).append(row)
        changes: list[tuple[Path, bytes, dict[str, Any]]] = []
        written_paths: list[Path] = []
        for info_path, info_rows in grouped.items():
            safe_info = _safe_child(info_path, self.images_root.parent)
            if safe_info is None or not safe_info.is_file():
                continue
            info = _json_object(safe_info)
            if info is None or not isinstance(info.get("images"), list):
                continue
            original = safe_info.read_bytes()
            changed = False
            for row in info_rows:
                target = updates[row["id"]]
                target_status = target["status"]
                target_id = str(row["dataset_record_id"])
                try:
                    dataset_dir = Path(info_path).parent.resolve()
                    target_source = Path(row["path"]).resolve().relative_to(
                        (dataset_dir / "source").resolve()
                    ).as_posix()
                except (OSError, ValueError):
                    target_source = ""
                for record in info["images"]:
                    if not isinstance(record, dict):
                        continue
                    record_source = _normalise_relative(str(record.get("source_file", "")))
                    if str(record.get("id", "")) != target_id and record_source != target_source:
                        continue
                    record["gallery_status"] = target_status
                    record["lora_candidate"] = bool(target["lora_candidate"])
                    record["reviewed_at"] = now_iso()
                    record["excluded"] = target_status == "rejected"
                    changed = True
                    break
            if changed:
                changes.append((safe_info, original, info))
                written_paths.append(safe_info)
        return changes, written_paths

    def register_character_reference(self, name: str, image_ids: list[str]) -> dict[str, Any]:
        """Register gallery images as a named character reference set."""

        cleaned_name = " ".join(str(name).split())
        if not cleaned_name or len(cleaned_name) > 120:
            raise GalleryError("参照キャラクター名を1～120文字で指定してください。")
        cleaned_ids = list(dict.fromkeys(str(image_id) for image_id in image_ids if image_id))
        if not cleaned_ids or len(cleaned_ids) > 100:
            raise GalleryError("参照画像は1～100枚指定してください。")
        with self._lock, self.connection:
            placeholders = ",".join("?" for _ in cleaned_ids)
            found = {
                row["id"]
                for row in self.connection.execute(
                    f"SELECT id FROM images WHERE id IN ({placeholders})", tuple(cleaned_ids)
                ).fetchall()
            }
            if found != set(cleaned_ids):
                raise GalleryError("参照画像に存在しない画像が含まれています。")
            now = now_iso()
            reference_id = hashlib.sha256(cleaned_name.casefold().encode("utf-8")).hexdigest()[:24]
            self.connection.execute(
                """
                INSERT INTO character_references
                    (id, name, image_ids_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    image_ids_json = excluded.image_ids_json,
                    updated_at = excluded.updated_at
                """,
                (reference_id, cleaned_name, json.dumps(cleaned_ids), now, now),
            )
        return {"id": reference_id, "name": cleaned_name, "image_ids": cleaned_ids}

    def list_character_references(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self.connection.execute(
                "SELECT id, name, image_ids_json, embedding_model, created_at, updated_at FROM character_references ORDER BY name COLLATE NOCASE"
            ).fetchall()
        result: list[dict[str, Any]] = []
        for row in rows:
            try:
                image_ids = json.loads(row["image_ids_json"] or "[]")
            except json.JSONDecodeError:
                image_ids = []
            result.append(
                {
                    "id": row["id"],
                    "name": row["name"],
                    "image_count": len(image_ids) if isinstance(image_ids, list) else 0,
                    "embedding_model": row["embedding_model"],
                    "created_at": row["created_at"],
                    "updated_at": row["updated_at"],
                }
            )
        return result

    def get_character_reference(self, name: str) -> sqlite3.Row | None:
        with self._lock:
            return self.connection.execute(
                "SELECT * FROM character_references WHERE name = ? COLLATE NOCASE",
                (name.strip(),),
            ).fetchone()

    def commit(self, updates: dict[str, Any]) -> dict[str, Any]:
        """レビュー結果とLoRA候補フラグを一括確定する。

        The old ``{image_id: "lora_candidate"}`` form is accepted and
        migrated to ``adopted + lora_candidate=true`` for older clients.
        """

        if not updates:
            return {"updated": [], "metadata_files": []}
        cleaned: dict[str, dict[str, Any]] = {}
        for image_id, raw_update in updates.items():
            if not isinstance(image_id, str):
                raise GalleryError("画像IDと状態の形式が正しくありません。")
            if isinstance(raw_update, str):
                status = "adopted" if raw_update == LEGACY_LORA_STATUS else raw_update
                lora_candidate = raw_update == LEGACY_LORA_STATUS
            elif isinstance(raw_update, dict):
                status = raw_update.get("status")
                lora_candidate = raw_update.get("lora_candidate")
                if lora_candidate is not None and not isinstance(lora_candidate, bool):
                    raise GalleryError("LoRA候補フラグの形式が正しくありません。")
            else:
                raise GalleryError("レビュー更新の形式が正しくありません。")
            if not isinstance(status, str) or status not in REVIEW_STATUSES:
                raise GalleryError(f"未対応のレビュー状態です: {status}")
            cleaned[image_id] = {"status": status, "lora_candidate": lora_candidate}

        with self._lock:
            placeholders = ",".join("?" for _ in cleaned)
            rows = self.connection.execute(
                f"SELECT * FROM images WHERE id IN ({placeholders})", tuple(cleaned)
            ).fetchall()
            found = {row["id"] for row in rows}
            missing = set(cleaned) - found
            if missing:
                raise GalleryError("存在しない画像が含まれています。画面を更新してください。")

            previous_statuses = {row["id"]: row["status"] for row in rows}
            previous_lora_candidates = {row["id"]: bool(row["lora_candidate"]) for row in rows}
            normalised: dict[str, dict[str, Any]] = {}
            for row in rows:
                update = cleaned[row["id"]]
                flag = update["lora_candidate"]
                if flag is None:
                    flag = bool(row["lora_candidate"])
                if update["status"] != "adopted":
                    flag = False
                normalised[row["id"]] = {
                    "status": update["status"],
                    "lora_candidate": bool(flag),
                }
            changes, metadata_files = self._updated_dataset_infos(rows, normalised)
            written: list[Path] = []
            try:
                for path, _original, info in changes:
                    self._write_json_atomic(path, info)
                    written.append(path)
                with self.connection:
                    for image_id, update in normalised.items():
                        self.connection.execute(
                            "UPDATE images SET status = ?, lora_candidate = ?, last_seen_at = ? WHERE id = ?",
                            (update["status"], int(update["lora_candidate"]), now_iso(), image_id),
                        )
                        status = update["status"]
                        previous = previous_statuses.get(image_id, "")
                        if previous != status:
                            self.connection.execute(
                                """
                                INSERT INTO preference_events
                                    (image_id, previous_status, status, signal, source, created_at)
                                VALUES (?, ?, ?, ?, 'manual_commit', ?)
                                """,
                                (
                                    image_id,
                                    previous,
                                    status,
                                    PREFERENCE_SIGNALS.get(status, 0.0),
                                    now_iso(),
                                ),
                            )
            except Exception as error:
                for path, original, _info in changes:
                    if path in written:
                        try:
                            path.write_bytes(original)
                        except OSError:
                            pass
                raise GalleryError(f"レビュー結果を確定できませんでした: {error}") from error
        return {
            "updated": list(normalised),
            "lora_candidate_updated": [
                image_id for image_id, update in normalised.items()
                if update["lora_candidate"] != previous_lora_candidates.get(image_id, False)
            ],
            "metadata_files": [str(path) for path in metadata_files],
        }
