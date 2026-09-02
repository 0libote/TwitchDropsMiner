from __future__ import annotations

import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from aiohttp import web
from yarl import URL


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
            can_watch=Mock(),
        )
        ui = WebUI(twitch)
        snapshot = ui.snapshot()
        self.assertEqual(snapshot["campaigns"], [])
        self.assertEqual(snapshot["channels"], [])
        self.assertEqual(snapshot["networkIssues"], [])
        self.assertEqual(snapshot["summary"]["activeCampaigns"], 0)

        ui.report_network_issue("https://spade.twitch.tv/track")
        self.assertEqual(ui.snapshot()["networkIssues"], [])
        ui.report_network_issue("https://spade.twitch.tv/track")
        self.assertEqual(ui.snapshot()["networkIssues"], ["spade.twitch.tv"])
        ui.report_network_recovery("https://spade.twitch.tv/track")
        self.assertEqual(ui.snapshot()["networkIssues"], [])

    def test_remote_bind_gets_an_access_token(self) -> None:
        from webui import WebUI

        ui = WebUI(SimpleNamespace(), host="0.0.0.0", open_browser=False)
        self.assertGreaterEqual(len(ui.access_token or ""), 24)

    def test_web_notifications_respect_the_setting(self) -> None:
        from webui import WebUI

        twitch = SimpleNamespace(settings=SimpleNamespace(tray_notifications=False))
        ui = WebUI(twitch)
        ui.tray.notify("Claimed", "Drop")
        self.assertEqual(list(ui.notifications), [])
        twitch.settings.tray_notifications = True
        ui.tray.notify("Claimed", "Drop")
        self.assertEqual(list(ui.notifications), [{"title": "Drop", "message": "Claimed"}])

    def test_web_activity_is_written_to_the_process_log(self) -> None:
        from webui import WebUI

        ui = WebUI(SimpleNamespace())
        with self.assertLogs("TwitchDrops", level="INFO") as captured:
            ui.print("Watching ExampleChannel")
        self.assertEqual(captured.output, ["INFO:TwitchDrops:Watching ExampleChannel"])


class WebSettingsTests(unittest.IsolatedAsyncioTestCase):
    async def test_dashboard_login_sets_session_cookie(self) -> None:
        from webui import WebUI

        ui = WebUI(SimpleNamespace(), access_token="correct-token")

        class Request:
            secure = False

            def __init__(self, token: str) -> None:
                self.token = token

            async def post(self) -> dict[str, str]:
                return {"token": self.token}

        rejected = await ui._dashboard_login(Request("wrong-token"))  # type: ignore[arg-type]
        self.assertEqual(rejected.status, 401)
        self.assertIn("That token is not valid", rejected.text)

        accepted = await ui._dashboard_login(Request("correct-token"))  # type: ignore[arg-type]
        self.assertEqual(accepted.status, 302)
        self.assertEqual(accepted.cookies["tdm_session"].value, "correct-token")
        self.assertTrue(accepted.cookies["tdm_session"]["httponly"])

    async def test_channel_switch_rejects_ineligible_channel(self) -> None:
        from webui import WebUI

        channel = SimpleNamespace(id=7)
        twitch = SimpleNamespace(
            channels={7: channel},
            can_watch=Mock(return_value=False),
            change_state=Mock(),
        )
        ui = WebUI(twitch)
        request = SimpleNamespace(match_info={"channel_id": "7"})

        with self.assertRaises(web.HTTPConflict):
            await ui._switch_channel(request)
        twitch.change_state.assert_not_called()

        twitch.can_watch.return_value = True
        response = await ui._switch_channel(request)
        self.assertEqual(response.status, 200)
        twitch.change_state.assert_called_once()

    async def test_proxy_requires_a_host_and_port(self) -> None:
        from webui import WebUI

        settings = SimpleNamespace(proxy=URL(), save=Mock())
        twitch = SimpleNamespace(settings=settings, change_state=Mock())
        ui = WebUI(twitch)

        class Request:
            def __init__(self, proxy: str) -> None:
                self.proxy = proxy

            async def json(self) -> dict[str, str]:
                return {"proxy": self.proxy}

        await ui._update_settings(Request("http://localhost:3128"))  # type: ignore[arg-type]
        self.assertEqual(settings.proxy, URL("http://localhost:3128"))
        with self.assertRaises(web.HTTPBadRequest):
            await ui._update_settings(Request("missing-port"))  # type: ignore[arg-type]
        with self.assertRaises(web.HTTPBadRequest):
            await ui._update_settings(Request("http://localhost"))  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
