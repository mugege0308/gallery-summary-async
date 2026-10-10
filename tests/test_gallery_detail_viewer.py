from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class GalleryDetailViewerIntegrationTests(unittest.TestCase):
    def test_detail_viewer_controls_and_sequences_are_wired(self) -> None:
        html = (ROOT / "gallery_web" / "index.html").read_text(encoding="utf-8")
        app = (ROOT / "gallery_web" / "app.js").read_text(encoding="utf-8")
        css = (ROOT / "gallery_web" / "style.css").read_text(encoding="utf-8")

        for element_id in ("detail-previous", "detail-position", "detail-next", "detail-toggle-adoption", "detail-adoption-status"):
            self.assertIn(f'id="{element_id}"', html)
        self.assertIn('src="/static/detail_viewer.js"', html)
        self.assertIn("state.detailSequence", app)
        self.assertIn("openDetail(image, state.recentImages)", app)
        self.assertIn("openDetail(image, state.images)", app)
        self.assertIn('$("#detail-previous").addEventListener', app)
        self.assertIn('$("#detail-next").addEventListener', app)
        self.assertIn('$("#detail-toggle-adoption").addEventListener', app)
        self.assertIn('fetch("/api/commit"', app)
        self.assertIn("updateDetailAdoptionUi", app)
        self.assertIn("updateAdoptionInMemory", app)
        self.assertIn('採用済み ✓', app)
        self.assertIn("object-fit: contain", css)
        self.assertIn("max-height: min(56vh, 560px)", css)
        self.assertIn("min-height: 44px", css)
        self.assertIn("detail-adoption-tools", css)


if __name__ == "__main__":
    unittest.main()
