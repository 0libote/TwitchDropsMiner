from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from yarl import URL


class HeadlessImportTests(unittest.TestCase):
    def test_stats_are_persisted(self) -> None:
        import stats

        with tempfile.TemporaryDirectory() as directory, patch.object(
            stats, "STATS_PATH", Path(directory) / "stats.json"
        ):
            first = stats.Stats()
            first.progress(3)
            first.claim()
            second = stats.Stats()
            self.assertEqual(second.lifetime["mining_minutes"], 3)
            self.assertEqual(second.lifetime["drops_claimed"], 1)
            self.assertEqual(second.lifetime["started_count"], 2)

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

    def test_web_notifications_respect_the_setting(self) -> None:
        from webui import WebUI

        twitch = SimpleNamespace(settings=SimpleNamespace(tray_notifications=False))
        ui = WebUI(twitch)
        ui.tray.notify("Claimed", "Drop")
        self.assertEqual(list(ui.notifications), [])
        twitch.settings.tray_notifications = True
        ui.tray.notify("Claimed", "Drop")
        notification = list(ui.notifications)[0]
        self.assertEqual(notification["title"], "Drop")
        self.assertEqual(notification["message"], "Claimed")
        self.assertIn("time", notification)

    def test_web_activity_is_written_to_the_process_log(self) -> None:
        from webui import WebUI

        ui = WebUI(SimpleNamespace())
        with self.assertLogs("TwitchDrops", level="INFO") as captured:
            ui.print("Watching ExampleChannel")
        self.assertEqual(captured.output, ["INFO:TwitchDrops:Watching ExampleChannel"])

    def test_only_authenticated_cookie_jars_are_saved(self) -> None:
        from twitch import _save_authenticated_cookies

        cookie_jar = Mock()
        cookie_jar.filter_cookies.return_value = {}
        _save_authenticated_cookies(cookie_jar, URL("https://www.twitch.tv"))
        cookie_jar.save.assert_not_called()

        cookie_jar.filter_cookies.return_value = {"auth-token": "token"}
        _save_authenticated_cookies(cookie_jar, URL("https://www.twitch.tv"))
        cookie_jar.save.assert_called_once()


class WebRoutingTests(unittest.IsolatedAsyncioTestCase):
    async def test_optional_dashboard_authentication(self) -> None:
        from utils import AwaitableValue
        from webui import WebUI

        twitch = SimpleNamespace(
            watching_channel=AwaitableValue(), inventory=[], channels={},
            settings=SimpleNamespace(
                priority=[], exclude=set(), priority_mode=SimpleNamespace(name="PRIORITY_ONLY"),
                connection_quality=1, tray_notifications=True, enable_badges_emotes=False,
                available_drops_check=False, proxy="",
            ),
            can_watch=Mock(),
        )
        with patch.dict("os.environ", {"TDM_WEB_TOKEN": "secret"}):
            client = TestClient(TestServer(WebUI(twitch)._build_app()))
        await client.start_server()
        try:
            self.assertEqual((await client.get("/healthz")).status, 200)
            self.assertEqual((await client.get("/")).status, 401)
            self.assertEqual(
                (await client.get("/", headers={"Authorization": "Basic dGRtOnNlY3JldA=="})).status,
                200,
            )
        finally:
            await client.close()

    async def test_dashboard_routes_support_direct_navigation(self) -> None:
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
        client = TestClient(TestServer(WebUI(twitch)._build_app()))
        await client.start_server()
        try:
            for path in (
                "/",
                "/campaigns",
                "/campaigns/example",
                "/mining",
                "/settings",
                "/diagnostics",
            ):
                response = await client.get(path)
                self.assertEqual(response.status, 200, path)
                self.assertEqual(response.headers["Cache-Control"], "no-cache")
                self.assertIn('id="app-shell"', await response.text())
            response = await client.get("/assets/app.js?v=test")
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers["Cache-Control"], "no-cache")
            script = await response.text()
            self.assertIn("function renderRoute", script)
            self.assertIn('role="combobox"', script)
            self.assertIn('event.key === "ArrowDown"', script)
            self.assertNotIn("<datalist", script)
        finally:
            await client.close()

    async def test_operational_endpoints(self) -> None:
        from utils import AwaitableValue
        from webui import WebUI

        settings = SimpleNamespace(
            priority=[], exclude=set(), priority_mode=SimpleNamespace(name="PRIORITY_ONLY"),
            connection_quality=1, tray_notifications=True, enable_badges_emotes=False,
            available_drops_check=False, autostart_tray=False, keep_awake=False, proxy="",
        )
        stats = Mock()
        stats.snapshot.return_value = {
            "startedAt": "2026-01-01T00:00:00+00:00", "uptimeSeconds": 60,
            "session": {}, "lifetime": {"drops_claimed": 2, "mining_minutes": 10,
            "channel_switches": 1, "watch_failures": 0, "watch_heartbeats": 10},
            "lastInventoryAt": None, "lastRecoveryAt": None,
        }
        twitch = SimpleNamespace(
            watching_channel=AwaitableValue(), inventory=[], channels={}, settings=settings,
            stats=stats, can_watch=Mock(),
        )
        client = TestClient(TestServer(WebUI(twitch)._build_app()))
        await client.start_server()
        try:
            self.assertEqual((await client.get("/healthz")).status, 200)
            self.assertEqual((await client.get("/readyz")).status, 503)
            metrics = await (await client.get("/metrics")).text()
            self.assertIn("tdm_drops_claimed_total 2", metrics)
            exported = await (await client.get("/api/export?stats=1")).json()
            self.assertEqual(exported["settings"]["proxy"], "")
            self.assertIn("stats", exported)
        finally:
            await client.close()

    def test_web_preview_fixture_has_current_snapshot_shape(self) -> None:
        import json

        fixture = json.loads(
            (Path(__file__).parent / "fixtures" / "web_state.json").read_text()
        )
        self.assertEqual(
            {"activeDrop", "campaigns", "channels", "settings", "summary"},
            {
                key
                for key in fixture
                if key in {"activeDrop", "campaigns", "channels", "settings", "summary"}
            },
        )
        self.assertTrue(fixture["campaigns"][0]["drops"])


class WebSettingsTests(unittest.IsolatedAsyncioTestCase):
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
