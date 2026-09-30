from __future__ import annotations

import json
import gc
import sqlite3
import struct
import tempfile
import unittest
import zlib
from pathlib import Path

from gallery_db import GalleryStore, _parse_comfy_prompt


def png_with_text(keyword: str, value: str) -> bytes:
    signature = b"\x89PNG\r\n\x1a\n"

    def chunk(name: bytes, body: bytes) -> bytes:
        return (
            struct.pack(">I", len(body))
            + name
            + body
            + struct.pack(">I", zlib.crc32(name + body) & 0xFFFFFFFF)
        )

    # A valid 1x1 RGB PNG with an additional tEXt chunk.
    raw = b"\x00\xff\xff\xff"
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    return signature + chunk(b"IHDR", ihdr) + chunk(b"tEXt", keyword.encode() + b"\0" + value.encode()) + chunk(
        b"IDAT", zlib.compress(raw)
    ) + chunk(b"IEND", b"")


class GalleryStoreTests(unittest.TestCase):
    def test_comfy_prompt_separates_positive_and_negative_text(self) -> None:
        parsed = _parse_comfy_prompt(
            {
                "1": {"class_type": "CLIPTextEncode", "inputs": {"text": "full body, smiling", "clip": ["4", 0]}},
                "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "bad anatomy, blurry", "clip": ["4", 0]}},
                "3": {"class_type": "KSampler", "inputs": {"positive": ["1", 0], "negative": ["2", 0]}},
            }
        )
        self.assertEqual(parsed["prompt"], "full body, smiling")
        self.assertEqual(parsed["negative_prompt"], "bad anatomy, blurry")

    def test_sync_persists_explicit_dispersion_metadata_from_sidecar(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "output"
            root.mkdir()
            image = root / "explicit.png"
            image.write_bytes(png_with_text("parameters", "full body, front"))
            (root / "explicit.png.metadata.json").write_text(
                json.dumps(
                    {
                        "prompt": "full body, front",
                        "dataset_dispersion": {
                            "schema_version": 1,
                            "shot_distance": "upper_body",
                            "view_angle": "three_quarter",
                            "expression": "unknown",
                            "outfit_type": "original_default",
                            "pose_type": "standing",
                        },
                    }
                ),
                encoding="utf-8",
            )
            store = GalleryStore(root, Path(temporary) / "gallery.sqlite3")
            try:
                store.sync()
                item = store.list_images()[0]
                explicit = item["metadata"]["dataset_dispersion"]
                self.assertEqual(explicit["shot_distance"], "upper_body")
                self.assertEqual(explicit["view_angle"], "three_quarter")
                summary = store.dispersion_summary(status="")
                self.assertEqual(
                    summary["dimensions"]["camera_distance"]["source_counts"]["explicit"],
                    1,
                )
            finally:
                store.close()

    def test_sync_reads_explicit_dispersion_from_png_text(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "output"
            root.mkdir()
            image = root / "embedded.png"
            image.write_bytes(
                png_with_text(
                    "dataset_dispersion",
                    json.dumps(
                        {
                            "shot_distance": "full_body",
                            "view_angle": "front",
                            "expression": "happy",
                            "outfit_type": "casual_simple",
                            "pose_type": "moving_action",
                        }
                    ),
                )
            )
            store = GalleryStore(root, Path(temporary) / "gallery.sqlite3")
            try:
                store.sync()
                item = store.list_images()[0]
                self.assertEqual(item["metadata"]["dataset_dispersion"]["shot_distance"], "full_body")
                self.assertEqual(item["metadata"]["dataset_dispersion"]["outfit_type"], "casual_simple")
            finally:
                store.close()

    def test_sync_reads_dataset_and_commit_mirrors_without_deleting_image(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "lora_datasets"
            dataset = root / "キャラA"
            source = dataset / "source"
            train = dataset / "train"
            source.mkdir(parents=True)
            train.mkdir()
            (source / "one.png").write_bytes(
                png_with_text(
                    "parameters",
                    "a character, blue eyes\nNegative prompt: low quality\nSteps: 20, Seed: 123, Model: test.safetensors",
                )
            )
            (train / "0001.txt").write_text("caption fallback", encoding="utf-8")
            info_path = dataset / "dataset_info.json"
            info_path.write_text(
                json.dumps(
                    {
                        "dataset_name": "キャラA",
                        "images": [
                            {"id": 1, "source_file": "one.png", "caption_file": "0001.txt", "excluded": False}
                        ],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            db_path = Path(temporary) / "gallery.sqlite3"
            store = GalleryStore(root, db_path)
            try:
                self.assertEqual(store.sync(), 1)
                page = store.list_images_page(page=1, page_size=1)
                self.assertEqual(page["total"], 1)
                self.assertEqual(page["page_size"], 1)
                self.assertEqual(page["total_pages"], 1)
                images = page["images"]
                self.assertEqual(len(images), 1)
                image = images[0]
                self.assertEqual(image["status"], "unreviewed")
                self.assertIn("thumbnail_url", image)
                self.assertEqual(image["metadata"]["seed"], 123)
                self.assertEqual(image["metadata"]["negative_prompt"], "low quality")
                self.assertIn("a character", image["metadata"]["prompt"])
                thumbnail = store.resolve_thumbnail(image["id"], size=160)
                self.assertIsNotNone(thumbnail)
                self.assertEqual(thumbnail[1], "image/jpeg")
                self.assertTrue(thumbnail[0].is_file())

                store.commit({image["id"]: "rejected"})
                self.assertTrue((source / "one.png").is_file())
                self.assertEqual(store.get(image["id"])["status"], "rejected")
                updated_info = json.loads(info_path.read_text(encoding="utf-8"))
                self.assertTrue(updated_info["images"][0]["excluded"])
                self.assertEqual(updated_info["images"][0]["gallery_status"], "rejected")
            finally:
                store.close()

    def test_generic_root_supports_sidecar_metadata_and_status_filter(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "output"
            root.mkdir()
            image_path = root / "render.png"
            image_path.write_bytes(png_with_text("prompt", json.dumps({"1": {"class_type": "KSampler", "inputs": {"seed": 77}}})))
            image_path.with_name(image_path.name + ".metadata.json").write_text(
                json.dumps({"character_name": "sidecar-char", "lora_name": "style.safetensors", "lora_strength": 0.8}),
                encoding="utf-8",
            )
            store = GalleryStore(root, Path(temporary) / "gallery.sqlite3")
            try:
                store.sync()
                image = store.list_images(character="sidecar-char")[0]
                self.assertEqual(image["metadata"]["character_name"], "sidecar-char")
                self.assertEqual(image["metadata"]["loras"][0]["name"], "style.safetensors")
                store.commit({image["id"]: "lora_candidate"})
                stored = store.get(image["id"])
                self.assertEqual(stored["status"], "adopted")
                self.assertTrue(stored["lora_candidate"])
                self.assertEqual(len(store.list_images(status="lora_candidate")), 1)
                self.assertEqual(len(store.list_images(lora_candidate=True)), 1)
                self.assertEqual(len(store.list_images(status="unreviewed")), 0)

                store.commit({image["id"]: {"status": "hold"}})
                stored = store.get(image["id"])
                self.assertEqual(stored["status"], "hold")
                self.assertFalse(stored["lora_candidate"])
                self.assertEqual(len(store.list_images(lora_candidate=True)), 0)
            finally:
                store.close()
                del store
                gc.collect()

    def test_lora_candidate_is_additive_and_legacy_status_is_compatible(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "output"
            root.mkdir()
            image_path = root / "adopted.png"
            image_path.write_bytes(png_with_text("prompt", "test"))
            store = GalleryStore(root, Path(temporary) / "gallery.sqlite3")
            try:
                store.sync()
                image = store.list_images()[0]
                store.commit({image["id"]: {"status": "adopted", "lora_candidate": True}})
                self.assertEqual(store.get(image["id"])["status"], "adopted")
                self.assertTrue(store.get(image["id"])["lora_candidate"])
                events = store.connection.execute("SELECT status FROM preference_events").fetchall()
                self.assertEqual([row[0] for row in events], ["adopted"])
            finally:
                store.close()

    def test_existing_exclusive_lora_status_is_migrated_without_image_loss(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "output"
            root.mkdir()
            db_path = Path(temporary) / "gallery.sqlite3"
            with sqlite3.connect(db_path) as connection:
                connection.execute(
                    """
                    CREATE TABLE images (
                        id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE,
                        relative_path TEXT NOT NULL, dataset_name TEXT NOT NULL DEFAULT '',
                        character_name TEXT NOT NULL DEFAULT '', filename TEXT NOT NULL,
                        extension TEXT NOT NULL, size_bytes INTEGER NOT NULL DEFAULT 0,
                        modified_at TEXT NOT NULL DEFAULT '', generated_at TEXT NOT NULL DEFAULT '',
                        batch_id TEXT NOT NULL DEFAULT '', job_id TEXT NOT NULL DEFAULT '',
                        width INTEGER, height INTEGER, status TEXT NOT NULL DEFAULT 'unreviewed',
                        metadata_json TEXT NOT NULL DEFAULT '{}', dataset_info_path TEXT NOT NULL DEFAULT '',
                        dataset_record_id TEXT NOT NULL DEFAULT '', first_seen_at TEXT NOT NULL,
                        last_seen_at TEXT NOT NULL
                    )
                    """
                )
                connection.execute(
                    "INSERT INTO images (id,path,relative_path,filename,extension,status,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?)",
                    ("legacy", str(root / "legacy.png"), "legacy.png", "legacy.png", ".png", "lora_candidate", "now", "now"),
                )
            connection.close()
            store = GalleryStore(root, db_path)
            try:
                row = store.connection.execute("SELECT status,lora_candidate FROM images WHERE id='legacy'").fetchone()
                self.assertEqual(row["status"], "adopted")
                self.assertEqual(row["lora_candidate"], 1)
            finally:
                store.close()
                del store
                gc.collect()


if __name__ == "__main__":
    unittest.main()
