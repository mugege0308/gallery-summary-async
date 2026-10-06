from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class GalleryLauncherBackendContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.launcher = (ROOT / "launch_gallery.ps1").read_text(encoding="utf-8")

    def test_gallery_checks_backend_before_starting_or_reusing_gallery(self) -> None:
        self.assertIn("Test-BackendReady", self.launcher)
        self.assertIn("Ensure-BackendReady", self.launcher)
        self.assertIn("$response.service_ready -eq $true", self.launcher)
        self.assertIn("$response.lm_studio_configured -eq $true", self.launcher)
        self.assertIn("$response.comfyui_url_configured -eq $true", self.launcher)

        backend_call = self.launcher.index("Ensure-BackendReady")
        gallery_ready = self.launcher.index("if (Test-GalleryReady)")
        self.assertLess(backend_call, gallery_ready)

    def test_backend_launcher_is_independent_and_discoverable(self) -> None:
        self.assertIn("GENERATION_BACKEND_LAUNCHER", self.launcher)
        self.assertIn("discord-bot-rebuild\\launch_generation_backend.ps1", self.launcher)
        self.assertIn("for ($level = 0; $level -lt 4; $level++)", self.launcher)
        self.assertIn("-File $launcherPath", self.launcher)
        self.assertNotIn("generation_backend_server.py", self.launcher)

    def test_gallery_does_not_pass_secrets_to_backend_launcher(self) -> None:
        self.assertNotIn("GALLERY_GENERATION_AUTH_TOKEN", self.launcher.split("Ensure-BackendReady", 1)[1])
        self.assertNotIn("GALLERY_GENERATION_SESSION_SECRET", self.launcher.split("Ensure-BackendReady", 1)[1])

    def test_no_browser_mode_is_available_for_headless_diagnostics(self) -> None:
        self.assertIn("[switch]$NoBrowser", self.launcher)
        self.assertIn("Open-GalleryIfRequested", self.launcher)


if __name__ == "__main__":
    unittest.main()
