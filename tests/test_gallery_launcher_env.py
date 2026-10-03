from __future__ import annotations

import unittest
from pathlib import Path


SECRET_NAMES = (
    "GALLERY_GENERATION_AUTH_TOKEN",
    "GALLERY_GENERATION_SESSION_SECRET",
)


def resolve_secret_environment(
    process_env: dict[str, str], user_env: dict[str, str]
) -> dict[str, str]:
    """Model the launcher contract without ever handling real secret values."""
    result = dict(process_env)
    for name in SECRET_NAMES:
        if result.get(name, "").strip():
            continue
        user_value = user_env.get(name, "")
        if user_value.strip():
            result[name] = user_value
    return result


class GalleryLauncherEnvironmentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.launcher = (
            Path(__file__).resolve().parents[1] / "launch_gallery.ps1"
        ).read_text(encoding="utf-8")

    def test_process_environment_wins(self) -> None:
        value = resolve_secret_environment(
            {SECRET_NAMES[0]: "process-auth", SECRET_NAMES[1]: "process-session"},
            {SECRET_NAMES[0]: "user-auth", SECRET_NAMES[1]: "user-session"},
        )
        self.assertEqual(value[SECRET_NAMES[0]], "process-auth")
        self.assertEqual(value[SECRET_NAMES[1]], "process-session")

    def test_user_environment_fills_missing_process_values(self) -> None:
        value = resolve_secret_environment(
            {}, {SECRET_NAMES[0]: "user-auth", SECRET_NAMES[1]: "user-session"}
        )
        self.assertEqual(value[SECRET_NAMES[0]], "user-auth")
        self.assertEqual(value[SECRET_NAMES[1]], "user-session")

    def test_missing_both_sources_stays_unset(self) -> None:
        value = resolve_secret_environment({}, {})
        self.assertNotIn(SECRET_NAMES[0], value)
        self.assertNotIn(SECRET_NAMES[1], value)

    def test_launcher_implements_safe_precedence_without_logging_values(self) -> None:
        self.assertIn("Import-GallerySecretEnvironment", self.launcher)
        self.assertIn('[Environment]::GetEnvironmentVariable($name, "Process")', self.launcher)
        self.assertIn('[Environment]::GetEnvironmentVariable($name, "User")', self.launcher)
        self.assertIn('[Environment]::SetEnvironmentVariable($name, $userValue, "Process")', self.launcher)
        self.assertNotIn("Write-Host $userValue", self.launcher)
        self.assertNotIn("Write-Output $userValue", self.launcher)
        self.assertNotIn("-ArgumentList $userValue", self.launcher)


if __name__ == "__main__":
    unittest.main()
