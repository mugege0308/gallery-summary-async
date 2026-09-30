"""Dataset diversity classification and the explicit metadata contract.

The classifier does not run an image model or mutate review/database state. It
derives conservative labels from indexed metadata, while future generators can
persist authoritative labels beside each image with
``write_explicit_classification_sidecar``. Anything not supplied explicitly or
identified from tags remains ``unknown``.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any


DIMENSIONS: tuple[str, ...] = (
    "camera_distance",
    "orientation",
    "expression",
    "outfit",
    "pose",
)

DIMENSION_LABELS: dict[str, str] = {
    "camera_distance": "カメラ距離",
    "orientation": "向き",
    "expression": "表情",
    "outfit": "衣装",
    "pose": "ポーズ",
}

VALUE_LABELS: dict[str, dict[str, str]] = {
    "camera_distance": {
        "close_up": "face / close-up",
        "upper_body": "upper body",
        "waist_up": "waist up",
        "knee_up": "knee up",
        "full_body": "full body",
        "unknown": "unknown",
    },
    "orientation": {
        "front": "front",
        "three_quarter": "three-quarter",
        "side": "side",
        "rear_ish": "looking back / rear-ish",
        "unknown": "unknown",
    },
    "expression": {
        "neutral": "neutral",
        "smile": "smile",
        "happy": "happy",
        "angry": "angry",
        "sad": "sad",
        "surprised": "surprised",
        "eyes_closed": "eyes closed",
        "other": "other",
        "unknown": "unknown",
    },
    "outfit": {
        "original_default": "original/default outfit",
        "alternate_outfit": "alternate outfit",
        "simple_casual": "simple/casual outfit",
        "school_uniform": "school uniform",
        "other_specific": "other specific outfit",
        "unknown": "unknown",
    },
    "pose": {
        "standing": "standing",
        "sitting": "sitting",
        "moving_action": "moving/action",
        "unknown": "unknown",
    },
}

EXPLICIT_FIELDS: tuple[str, ...] = (
    "shot_distance",
    "view_angle",
    "expression",
    "outfit_type",
    "pose_type",
)
FIELD_TO_DIMENSION = {
    "shot_distance": "camera_distance",
    "view_angle": "orientation",
    "expression": "expression",
    "outfit_type": "outfit",
    "pose_type": "pose",
}

_EXPLICIT_ALIASES: dict[str, dict[str, str]] = {
    "shot_distance": {
        "face_close_up": "close_up",
        "face_closeup": "close_up",
        "close_up": "close_up",
        "closeup": "close_up",
        "upper_body": "upper_body",
        "waist_up": "waist_up",
        "knee_up": "knee_up",
        "full_body": "full_body",
        "unknown": "unknown",
    },
    "view_angle": {
        "front": "front",
        "three_quarter": "three_quarter",
        "threequarter": "three_quarter",
        "side": "side",
        "rear_ish": "rear_ish",
        "rear": "rear_ish",
        "unknown": "unknown",
    },
    "expression": {
        "neutral": "neutral",
        "smile": "smile",
        "happy": "happy",
        "angry": "angry",
        "sad": "sad",
        "surprised": "surprised",
        "eyes_closed": "eyes_closed",
        "other": "other",
        "unknown": "unknown",
    },
    "outfit_type": {
        "original_default": "original_default",
        "alternate": "alternate_outfit",
        "alternate_outfit": "alternate_outfit",
        "casual_simple": "simple_casual",
        "simple_casual": "simple_casual",
        "school_uniform": "school_uniform",
        "other_specific": "other_specific",
        "unknown": "unknown",
    },
    "pose_type": {
        "standing": "standing",
        "sitting": "sitting",
        "moving_action": "moving_action",
        "unknown": "unknown",
    },
}
_EXPLICIT_STORAGE_VALUES: dict[str, dict[str, str]] = {
    "shot_distance": {"close_up": "face_close_up"},
    "view_angle": {},
    "expression": {},
    "outfit_type": {
        "alternate_outfit": "alternate",
        "simple_casual": "casual_simple",
    },
    "pose_type": {},
}

# These are defaults only.  The editable JSON file in the project root is
# loaded by GalleryStore and can change them without modifying Python code.
DEFAULT_WARNING_CONFIG: dict[str, Any] = {
    "min_samples_for_warning": 10,
    "low_share": 0.10,
    "dominance_share": 0.80,
    "max_unknown_share": 0.30,
    "min_classified_share_for_bias_warning": 0.50,
    "required_values": {
        "camera_distance": ["full_body", "upper_body", "close_up"],
        "orientation": ["front", "three_quarter", "side"],
        "expression": [],
        "outfit": ["original_default", "alternate_outfit"],
        "pose": [],
    },
    "minimum_known_categories": {
        "expression": 3,
        "pose": 2,
    },
}


def load_warning_config(path: Path | None = None) -> dict[str, Any]:
    """Load editable warning thresholds, falling back safely on bad JSON."""

    config: dict[str, Any] = json.loads(json.dumps(DEFAULT_WARNING_CONFIG))
    if path is None or not path.is_file():
        return config
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return config
    if not isinstance(value, dict):
        return config
    for key in (
        "min_samples_for_warning", "low_share", "dominance_share",
        "max_unknown_share", "min_classified_share_for_bias_warning",
    ):
        if isinstance(value.get(key), (int, float)):
            config[key] = value[key]
    for key in ("required_values", "minimum_known_categories"):
        if isinstance(value.get(key), dict):
            for dimension, values in value[key].items():
                if dimension not in DIMENSIONS:
                    continue
                if key == "required_values" and isinstance(values, list):
                    config[key][dimension] = [str(item) for item in values]
                elif key == "minimum_known_categories" and isinstance(values, (int, float)):
                    config[key][dimension] = int(values)
    return config


def _normalise_explicit_token(value: Any) -> str:
    return re.sub(r"[^a-z0-9一-龯ぁ-んァ-ヶ]+", "_", str(value).casefold()).strip("_")


def normalise_explicit_classification(value: Any) -> dict[str, str]:
    """Validate the persisted classification contract and return known fields."""

    if not isinstance(value, Mapping):
        return {}
    values = value.get("values") if isinstance(value.get("values"), Mapping) else value
    result: dict[str, str] = {}
    for field in EXPLICIT_FIELDS:
        raw = values.get(field)
        if raw in (None, ""):
            continue
        token = _normalise_explicit_token(raw)
        canonical = _EXPLICIT_ALIASES.get(field, {}).get(token)
        if canonical is not None:
            result[field] = canonical
    return result


def extract_explicit_classification(sources: Sequence[Any]) -> dict[str, str]:
    """Read explicit fields from sidecar/embedded/dataset records in priority order."""

    result: dict[str, str] = {}
    for source in sources:
        if not isinstance(source, Mapping):
            continue
        candidates: list[Any] = []
        for key in ("dataset_dispersion", "dispersion_classification", "classification"):
            if isinstance(source.get(key), Mapping):
                candidates.append(source[key])
        candidates.append(source)
        for candidate in candidates:
            for field, value in normalise_explicit_classification(candidate).items():
                result.setdefault(field, value)
    return result


def serialise_explicit_classification(value: Any) -> dict[str, str]:
    """Return stable public contract names for sidecars and gallery metadata."""

    normalised = normalise_explicit_classification(value)
    return {
        field: _EXPLICIT_STORAGE_VALUES.get(field, {}).get(item, item)
        for field, item in normalised.items()
    }


def explicit_classification(image: Mapping[str, Any] | None) -> dict[str, str]:
    image = image or {}
    metadata = image.get("metadata", image)
    return extract_explicit_classification([metadata])


def write_explicit_classification_sidecar(
    image_path: Path, values: Mapping[str, Any], *, source: str = "generation"
) -> Path:
    """Merge explicit classification into an image sidecar for future generators."""

    sidecar = image_path.with_name(image_path.name + ".metadata.json")
    existing: dict[str, Any] = {}
    if sidecar.is_file():
        try:
            loaded = json.loads(sidecar.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                existing = loaded
        except (OSError, UnicodeError, json.JSONDecodeError):
            existing = {}
    normalised = serialise_explicit_classification(values)
    existing["dataset_dispersion"] = {
        "schema_version": 1,
        "source": str(source or "generation"),
        **{field: normalised.get(field, "unknown") for field in EXPLICIT_FIELDS},
    }
    sidecar.parent.mkdir(parents=True, exist_ok=True)
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", newline="\n", dir=sidecar.parent,
            prefix=f".{sidecar.name}.", suffix=".tmp", delete=False
        ) as file:
            json.dump(existing, file, ensure_ascii=False, indent=2)
            file.write("\n")
            temporary_name = file.name
        os.replace(temporary_name, sidecar)
    except Exception:
        if temporary_name:
            Path(temporary_name).unlink(missing_ok=True)
        raise
    return sidecar


def _normalise_text(value: str) -> str:
    text = value.casefold().replace("_", " ").replace("-", " ").replace("/", " ")
    return re.sub(r"\s+", " ", text).strip()


def _collect_prompt_text(value: Any, key: str = "") -> list[str]:
    """Collect only prompt/caption-like metadata, not arbitrary filenames."""

    allowed_keys = {
        "prompt", "positive", "positive_prompt", "prompt_text", "caption",
        "tags", "text", "parameters", "description",
    }
    if isinstance(value, str):
        return [value] if not key or key.casefold() in allowed_keys else []
    if isinstance(value, Mapping):
        collected: list[str] = []
        for child_key, child in value.items():
            collected.extend(_collect_prompt_text(child, str(child_key)))
        return collected
    if isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        collected = []
        for child in value:
            collected.extend(_collect_prompt_text(child, key))
        return collected
    return []


def metadata_text(image: Mapping[str, Any] | None) -> str:
    """Return the searchable prompt/caption text for one gallery image."""

    image = image or {}
    metadata = image.get("metadata", image)
    values = _collect_prompt_text(metadata)
    # Dataset captions and sidecars are already in metadata, but support a
    # direct caption/prompt field for callers outside GalleryStore as well.
    for key in ("caption", "prompt", "positive_prompt"):
        value = image.get(key)
        if isinstance(value, str):
            values.append(value)
    return _normalise_text(" ".join(dict.fromkeys(item for item in values if item.strip())))


def _match(text: str, *phrases: str) -> list[str]:
    found: list[str] = []
    for phrase in phrases:
        candidate = _normalise_text(phrase)
        if candidate and re.search(rf"(?<!\w){re.escape(candidate)}(?!\w)", text):
            found.append(phrase)
    return found


def _result(dimension: str, value: str, matched: list[str]) -> dict[str, Any]:
    return {
        "dimension": dimension,
        "value": value,
        "label": VALUE_LABELS[dimension].get(value, value),
        "matched": matched,
        "known": value != "unknown",
        "source": "inferred" if value != "unknown" else "unknown",
    }


def classify_text(text: str) -> dict[str, dict[str, Any]]:
    """Classify explicit English tags in a prompt/caption conservatively."""

    text = _normalise_text(text)
    results: dict[str, dict[str, Any]] = {}

    distance_rules = (
        ("close_up", ("close up", "closeup", "close-up", "face focus", "headshot", "face shot", "portrait", "顔アップ", "顔のアップ")),
        ("upper_body", ("upper body", "bust shot", "bust", "chest up", "chest-up", "head and shoulders", "upper torso", "上半身", "バストアップ")),
        ("waist_up", ("waist up", "waistup", "waist-up", "from waist up", "waist shot", "mid shot", "腰上", "腰から上")),
        ("knee_up", ("knee up", "knees up", "knee-up", "cowboy shot", "thigh up", "thigh-up", "3 4 body", "膝上")),
        ("full_body", ("full body", "fullbody", "full-length", "full length", "whole body", "head to toe", "long shot", "全身")),
    )
    for value, phrases in distance_rules:
        matched = _match(text, *phrases)
        if matched:
            results["camera_distance"] = _result("camera_distance", value, matched)
            break
    results.setdefault("camera_distance", _result("camera_distance", "unknown", []))

    orientation_rules = (
        ("rear_ish", ("looking back", "rear view", "rearish", "from behind", "back view", "facing away", "back-facing", "後ろ姿", "背中", "後ろ向き")),
        ("three_quarter", ("three quarter", "three-quarter", "3 4 view", "3/4 view", "three quarter view", "three quarters", "斜め向き", "三分の一")),
        ("side", ("side view", "from side", "side profile", "profile view", "profile", "sideways", "side", "横顔", "横向き")),
        ("front", ("front view", "from front", "facing viewer", "facing front", "facing forward", "front-facing", "looking at viewer", "facing camera", "front", "正面", "正面向き", "前向き")),
    )
    for value, phrases in orientation_rules:
        matched = _match(text, *phrases)
        if matched:
            results["orientation"] = _result("orientation", value, matched)
            break
    results.setdefault("orientation", _result("orientation", "unknown", []))

    expression_rules = (
        ("eyes_closed", ("eyes closed", "closed eyes", "eyes shut", "目を閉じ", "目をつぶる", "閉じた目")),
        ("surprised", ("surprised", "shocked", "astonished", "open mouth", "surprise", "驚き", "驚いた", "びっくり")),
        ("angry", ("angry", "furious", "scowl", "怒り", "怒った")),
        ("sad", ("sad", "crying", "tears", "teary", "sad face", "悲しい", "泣き顔", "涙")),
        ("happy", ("happy", "joyful", "laughing", "cheerful", "excited", "delighted", "幸せ", "嬉しい", "喜び")),
        ("smile", ("smile", "smiling", "grin", "gentle smile", "soft smile", "bright smile", "笑顔", "微笑み", "にっこり")),
        ("neutral", ("neutral expression", "expressionless", "blank expression", "calm expression", "relaxed expression", "soft expression", "neutral", "serious", "無表情", "真顔", "穏やかな表情")),
    )
    for value, phrases in expression_rules:
        matched = _match(text, *phrases)
        if matched:
            results["expression"] = _result("expression", value, matched)
            break
    results.setdefault("expression", _result("expression", "unknown", []))

    outfit_rules = (
        ("school_uniform", ("school uniform", "school clothes", "uniform", "制服")),
        ("alternate_outfit", ("alternate outfit", "alternate costume", "different outfit", "change of clothes", "outfit change", "costume change", "別衣装", "衣装違い")),
        ("simple_casual", ("casual outfit", "casual clothes", "casual clothing", "simple outfit", "casual wear", "everyday clothes", "cardigan", "hoodie", "sweater", "t-shirt", "私服", "カジュアル", "普段着")),
        ("other_specific", ("traditional japanese attire", "kimono", "yukata", "maid outfit", "maid costume", "dress", "swimsuit", "bikini", "armor", "伝統衣装", "着物", "浴衣", "ドレス")),
        ("original_default", ("original outfit", "original costume", "default outfit", "signature outfit", "usual outfit", "character outfit", "通常衣装", "元衣装")),
    )
    for value, phrases in outfit_rules:
        matched = _match(text, *phrases)
        if matched:
            results["outfit"] = _result("outfit", value, matched)
            break
    results.setdefault("outfit", _result("outfit", "unknown", []))

    pose_rules = (
        ("moving_action", ("action pose", "dynamic pose", "running", "walking", "walk", "jumping", "jump", "dancing", "fighting", "motion", "moving", "leg up", "kneeling", "crouching", "lying", "走る", "歩く", "動き", "アクション")),
        ("sitting", ("sitting", "seated", "sitting on", "sit", "座る", "座り")),
        ("standing", ("standing", "stand", "立つ", "立ち")),
    )
    for value, phrases in pose_rules:
        matched = _match(text, *phrases)
        if matched:
            results["pose"] = _result("pose", value, matched)
            break
    results.setdefault("pose", _result("pose", "unknown", []))
    return results


def classify_image(image: Mapping[str, Any] | None) -> dict[str, dict[str, Any]]:
    result = classify_text(metadata_text(image))
    for field, value in explicit_classification(image).items():
        dimension = FIELD_TO_DIMENSION[field]
        result[dimension] = _result(dimension, value, [])
        result[dimension]["source"] = "explicit"
    return result


def matches_classification(image: Mapping[str, Any] | None, dimension: str, value: str) -> bool:
    if dimension not in DIMENSIONS or value not in VALUE_LABELS[dimension]:
        return False
    return classify_image(image).get(dimension, {}).get("value") == value


def summarise(images: Sequence[Mapping[str, Any]], config: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return counts, ratios and configurable diversity warnings."""

    config = config or DEFAULT_WARNING_CONFIG
    total = len(images)
    dimensions: dict[str, Any] = {}
    for dimension in DIMENSIONS:
        values = list(VALUE_LABELS[dimension])
        counts = {value: 0 for value in values}
        matched_by_value: dict[str, list[str]] = {value: [] for value in values}
        for image in images:
            result = classify_image(image).get(dimension) or _result(dimension, "unknown", [])
            value = result["value"] if result["value"] in counts else "unknown"
            counts[value] += 1
            if image.get("id"):
                matched_by_value[value].append(str(image["id"]))
        categories = [
            {
                "value": value,
                "label": VALUE_LABELS[dimension][value],
                "count": counts[value],
                "ratio": (counts[value] / total) if total else 0.0,
                "image_ids": matched_by_value[value],
                "clickable": True,
            }
            for value in values
        ]
        known_counts = {value: count for value, count in counts.items() if value != "unknown"}
        source_counts = {"explicit": 0, "inferred": 0, "unknown": 0}
        for image in images:
            source = (classify_image(image).get(dimension) or {}).get("source", "unknown")
            source_counts[source if source in source_counts else "unknown"] += 1
        dimensions[dimension] = {
            "label": DIMENSION_LABELS[dimension],
            "total": total,
            "categories": categories,
            "known_count": sum(known_counts.values()),
            "unknown_count": counts.get("unknown", 0),
            "source_counts": source_counts,
            "warnings": [],
        }

        if total < int(config.get("min_samples_for_warning", 10)):
            continue
        unknown_ratio = dimensions[dimension]["unknown_count"] / total
        if unknown_ratio >= float(config.get("max_unknown_share", 0.30)):
            dimensions[dimension]["warnings"].append(
                f"{DIMENSION_LABELS[dimension]}はmetadataだけでは分類できない画像が多いです。"
            )
        classified_ratio = dimensions[dimension]["known_count"] / total if total else 0.0
        if classified_ratio < float(config.get("min_classified_share_for_bias_warning", 0.50)):
            continue
        for required in config.get("required_values", {}).get(dimension, []):
            if required not in counts:
                continue
            if counts[required] == 0:
                dimensions[dimension]["warnings"].append(
                    f"{VALUE_LABELS[dimension][required]}がありません。"
                )
            elif counts[required] / total < float(config.get("low_share", 0.10)):
                dimensions[dimension]["warnings"].append(
                    f"{VALUE_LABELS[dimension][required]}が少ないです。"
                )
        minimum_known = int(config.get("minimum_known_categories", {}).get(dimension, 0))
        if minimum_known and len([count for count in known_counts.values() if count]) < minimum_known:
            dimensions[dimension]["warnings"].append(
                f"{DIMENSION_LABELS[dimension]}の種類が少ないです。"
            )
        known_total = sum(known_counts.values())
        if known_total:
            dominant_value, dominant_count = max(known_counts.items(), key=lambda item: item[1])
            if dominant_count / known_total >= float(config.get("dominance_share", 0.80)) and len(known_counts) > 1:
                dimensions[dimension]["warnings"].append(
                    f"{VALUE_LABELS[dimension][dominant_value]}に偏っています。"
                )

    warnings = [
        {"dimension": dimension, "label": dimensions[dimension]["label"], "message": message}
        for dimension in DIMENSIONS
        for message in dimensions[dimension]["warnings"]
    ]
    return {"total": total, "dimensions": dimensions, "warnings": warnings}
