from __future__ import annotations

import sys
import unittest
from types import SimpleNamespace


class HeadlessImportTests(unittest.TestCase):
    def test_engine_import_does_not_load_tk_gui(self) -> None:
        sys.modules.pop("gui", None)
        sys.modules.pop("tkinter", None)
        sys.modules.pop("PIL", None)
        __import__("twitch")
        self.assertNotIn("gui", sys.modules)
        self.assertNotIn("tkinter", sys.modules)
        self.assertNotIn("PIL", sys.modules)

    def test_web_snapshot_starts_empty(self) -> None:
        from utils import AwaitableValue
        from webui import WebUI

        settings = SimpleNamespace(
            priority=[],
            exclude=set(),
            priority_mode=SimpleNamespace(name="PRIORITY_ONLY"),
            connection_quality=1,
            tray_notifications=True,
            enable_badges_emotes=False,
            available_drops_check=False,
            proxy="",
        )
        twitch = SimpleNamespace(
            watching_channel=AwaitableValue(),
            inventory=[],
            channels={},
            settings=settings,
        )
        ui = WebUI(twitch)
        snapshot = ui.snapshot()
        self.assertEqual(snapshot["campaigns"], [])
        self.assertEqual(snapshot["channels"], [])
        self.assertEqual(snapshot["summary"]["activeCampaigns"], 0)

    def test_remote_bind_gets_an_access_token(self) -> None:
        from webui import WebUI

        ui = WebUI(SimpleNamespace(), host="0.0.0.0", open_browser=False)
        self.assertGreaterEqual(len(ui.access_token or ""), 24)


if __name__ == "__main__":
    unittest.main()
