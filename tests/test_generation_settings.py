from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class GenerationSettingsIntegrationTests(unittest.TestCase):
    def test_versioned_storage_and_reset_are_wired(self) -> None:
        html = (ROOT / "gallery_web" / "index.html").read_text(encoding="utf-8")
        app = (ROOT / "gallery_web" / "app.js").read_text(encoding="utf-8")
        helper = (ROOT / "gallery_web" / "generation_settings.js").read_text(encoding="utf-8")

        self.assertIn('src="/static/generation_settings.js"', html)
        self.assertIn('id="generation-reset"', html)
        self.assertIn("前回の入力設定を自動保存します", html)
        self.assertIn('"gallery.generate.settings.v1"', helper)
        self.assertIn("GenerationSettings.write", app)
        self.assertIn("GenerationSettings.read", app)
        self.assertIn("GenerationSettings.clear", app)
        self.assertIn("restoreSavedGenerationSettings", app)
        self.assertIn('$("#generation-reset").addEventListener', app)

    def test_only_allowed_form_fields_are_persisted(self) -> None:
        app = (ROOT / "gallery_web" / "app.js").read_text(encoding="utf-8")
        helper = (ROOT / "gallery_web" / "generation_settings.js").read_text(encoding="utf-8")

        for field_id in (
            "generation-character-preset",
            "generation-freeform-character",
            "generation-explicit-tags",
            "generation-appearance",
            "generation-request",
            "generation-model",
            "generation-rating",
            "generation-size",
            "generation-seed",
            "generation-character-lora",
            "generation-character-strength",
            "generation-style-lora",
            "generation-style-strength",
            "generation-additional-lora",
            "generation-additional-strength",
            "generation-count",
            "generation-variation",
        ):
            self.assertIn(f'"#{field_id}"', app)
        self.assertNotIn("reference_image_id", helper)
        self.assertNotIn("generation-auth-token", app[app.index("const generationSettingSelectors"):app.index("function generationSettingsStorage")])

    def test_explicit_reference_and_gallery_restore_remain_session_actions(self) -> None:
        app = (ROOT / "gallery_web" / "app.js").read_text(encoding="utf-8")
        helper = (ROOT / "gallery_web" / "generation_settings.js").read_text(encoding="utf-8")
        self.assertIn('$("#generation-reference-mode").value = "none";', app)
        self.assertIn('state.generation.reference = { imageId: "", fileName: "", previewUrl: "", source: "" }', app)
        self.assertIn("saveGenerationSettings();", app)
        self.assertNotIn("auth_token", helper)
        self.assertNotIn("session_secret", helper)


if __name__ == "__main__":
    unittest.main()
