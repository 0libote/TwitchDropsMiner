from __future__ import annotations

import asyncio
import json
import logging
import secrets
import webbrowser
from collections import deque
from dataclasses import dataclass
from datetime import datetime
from functools import partial
from pathlib import Path
from time import monotonic
from typing import Any, TYPE_CHECKING

from aiohttp import web
from yarl import URL

from constants import PriorityMode, State

if TYPE_CHECKING:
    from channel import Channel
    from inventory import DropsCampaign, TimedDrop
    from twitch import Twitch
    from utils import Game


logger = logging.getLogger("TwitchDrops")
WEB_ROOT = Path(__file__).with_name("web")
TOKEN_LOGIN_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Dashboard access · Twitch Drops Miner Next</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0d0d0f; color: #f4f3f7; font: 14px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(420px, calc(100% - 40px)); padding: 32px; border: 1px solid #29292f; border-radius: 14px; background: #151518; }
    p { color: #aaa8b0; }
    label, input, button { display: block; width: 100%; box-sizing: border-box; }
    label { margin: 24px 0 8px; font-weight: 650; }
    input, button { padding: 11px 12px; border: 1px solid #35353d; border-radius: 8px; color: inherit; background: #0d0d0f; font: inherit; }
    button { margin-top: 12px; border-color: #7755dd; color: #100c18; background: #9b78ff; font-weight: 750; cursor: pointer; }
    .error { color: #ef9696; }
  </style>
</head>
<body>
  <main>
    <h1>Dashboard access</h1>
    <p>Enter the token configured as <code>TDM_ACCESS_TOKEN</code>. This browser will remember it in an HTTP-only session cookie.</p>
    __ERROR__
    <form action="/session" method="post">
      <label for="token">Access token</label>
      <input id="token" name="token" type="password" required autofocus autocomplete="off">
      <button type="submit">Open dashboard</button>
    </form>
  </main>
</body>
</html>
"""


def _iso(value: datetime) -> str:
    return value.isoformat()


def _drop_json(drop: TimedDrop) -> dict[str, Any]:
    return {
        "id": drop.id,
        "name": drop.name,
        "rewards": drop.rewards_text(),
        "claimed": drop.is_claimed,
        "claimable": drop.can_claim,
        "currentMinutes": drop.current_minutes,
        "requiredMinutes": drop.required_minutes,
        "remainingMinutes": drop.remaining_minutes,
        "progress": round(drop.progress, 4),
        "startsAt": _iso(drop.starts_at),
        "endsAt": _iso(drop.ends_at),
        "benefits": [
            {"name": benefit.name, "type": benefit.type.value, "image": str(benefit.image_url)}
            for benefit in drop.benefits
        ],
    }


def _campaign_json(campaign: DropsCampaign) -> dict[str, Any]:
    if campaign.active:
        status = "active"
    elif campaign.upcoming:
        status = "upcoming"
    elif campaign.expired:
        status = "expired"
    else:
        status = "unavailable"
    return {
        "id": campaign.id,
        "name": campaign.name,
        "game": campaign.game.name,
        "gameId": campaign.game.id,
        "image": str(campaign.image_url),
        "linked": campaign.linked,
        "eligible": campaign.eligible,
        "finished": campaign.finished,
        "status": status,
        "startsAt": _iso(campaign.starts_at),
        "endsAt": _iso(campaign.ends_at),
        "claimedDrops": campaign.claimed_drops,
        "totalDrops": campaign.total_drops,
        "remainingMinutes": campaign.remaining_minutes,
        "progress": round(campaign.progress, 4),
        "drops": [_drop_json(drop) for drop in campaign.drops],
    }


def _channel_json(
    channel: Channel, watching_id: int | None, *, watchable: bool
) -> dict[str, Any]:
    game = channel.game
    stream = getattr(channel, "_stream", None)
    return {
        "id": channel.id,
        "name": channel.name,
        "login": getattr(channel, "_login", channel.name),
        "url": str(channel.url),
        "online": channel.online,
        "pending": channel.pending_online,
        "watching": channel.id == watching_id,
        "watchable": watchable,
        "game": game.name if game is not None else None,
        "viewers": channel.viewers,
        "dropsEnabled": channel.drops_enabled,
        "title": getattr(stream, "title", None),
    }


class _Reactive:
    def __init__(self, manager: WebUI) -> None:
        self.manager = manager

    def changed(self) -> None:
        self.manager.changed()


class StatusView(_Reactive):
    def update(self, text: str) -> None:
        self.manager.status_text = text
        self.changed()

    def clear(self) -> None:
        self.update("")


class WebsocketView(_Reactive):
    def update(self, idx: int, status: str | None = None, topics: int | None = None) -> None:
        item = self.manager.websocket_state.setdefault(idx, {"status": "Disconnected", "topics": 0})
        if status is not None:
            item["status"] = status
        if topics is not None:
            item["topics"] = topics
        self.changed()

    def remove(self, idx: int) -> None:
        self.manager.websocket_state.pop(idx, None)
        self.changed()


@dataclass
class LoginData:
    username: str
    password: str
    token: str


class LoginView(_Reactive):
    def __init__(self, manager: WebUI) -> None:
        super().__init__(manager)
        self._pending: asyncio.Future[LoginData] | None = None

    def update(self, status: str, user_id: int | None) -> None:
        self.manager.login_state.update(status=status, userId=user_id)
        self.changed()

    def clear(self, login: bool = False, password: bool = False, token: bool = False) -> None:
        del login, password, token

    async def ask_enter_code(self, page_url: URL, user_code: str) -> None:
        if page_url.scheme != "https" or page_url.host not in {"twitch.tv", "www.twitch.tv"}:
            raise ValueError("Twitch returned an invalid device activation URL")
        self.manager.status_text = "Waiting for Twitch authorization"
        self.manager.login_state.update(
            status="Authorization required",
            activationUrl=str(page_url),
            activationCode=user_code,
        )
        self.changed()

    async def ask_login(self) -> LoginData:
        self.manager.login_state["status"] = "Sign in required"
        self._pending = asyncio.get_running_loop().create_future()
        self.changed()
        try:
            return await self.manager.coro_unless_closed(self._pending)
        finally:
            self._pending = None

    def submit(self, payload: dict[str, Any]) -> bool:
        if self._pending is None or self._pending.done():
            return False
        self._pending.set_result(
            LoginData(
                str(payload.get("username", "")).strip(),
                str(payload.get("password", "")),
                str(payload.get("token", "")).strip(),
            )
        )
        return True


class _Button:
    def __init__(self, manager: WebUI) -> None:
        self.manager = manager

    def config(self, **values: Any) -> None:
        if "state" in values:
            self.manager.can_logout = values["state"] == "normal"
            self.manager.changed()


class HelpView:
    def __init__(self, manager: WebUI) -> None:
        self._invalidate_button = _Button(manager)


class TrayView(_Reactive):
    def change_icon(self, state: str) -> None:
        self.manager.activity_state = state
        self.changed()

    def update_title(self, drop: TimedDrop | None) -> None:
        del drop
        self.changed()

    def notify(self, message: str, title: str) -> None:
        if not self.manager._twitch.settings.tray_notifications:
            return
        self.manager.notifications.appendleft({"title": title, "message": message})
        self.changed()

    def restore(self) -> None:
        return

    def stop(self) -> None:
        return


class ProgressView(_Reactive):
    ALMOST_DONE_SECONDS = 55

    def __init__(self, manager: WebUI) -> None:
        super().__init__(manager)
        self.drop: TimedDrop | None = None
        self._displayed_at: float | None = None

    def display(
        self,
        drop: TimedDrop | None,
        *,
        countdown: bool = True,
        subone: bool = False,
    ) -> None:
        del subone
        self.drop = drop
        self._displayed_at = monotonic() if drop is not None and countdown else None
        self.changed()

    def stop_timer(self) -> None:
        self._displayed_at = None

    def minute_almost_done(self) -> bool:
        return self._displayed_at is None or monotonic() - self._displayed_at >= self.ALMOST_DONE_SECONDS


class ChannelView(_Reactive):
    def __init__(self, manager: WebUI) -> None:
        super().__init__(manager)
        self.selected_id: int | None = None
        self.watching_id: int | None = None

    def display(self, channel: Channel, *, add: bool = False) -> None:
        del channel, add
        self.changed()

    def remove(self, channel: Channel) -> None:
        if self.selected_id == channel.id:
            self.selected_id = None
        self.changed()

    def clear(self) -> None:
        self.selected_id = None
        self.watching_id = None
        self.changed()

    def get_selection(self) -> Channel | None:
        if self.selected_id is None:
            return None
        return self.manager._twitch.channels.get(self.selected_id)

    def set_watching(self, channel: Channel) -> None:
        self.watching_id = channel.id
        self.selected_id = None
        self.changed()

    def clear_watching(self) -> None:
        self.watching_id = None
        self.changed()

    def clear_selection(self) -> None:
        self.selected_id = None


class InventoryView(_Reactive):
    async def add_campaign(self, campaign: DropsCampaign) -> None:
        del campaign
        self.changed()

    def update_drop(self, drop: TimedDrop) -> None:
        del drop
        self.changed()

    def clear(self) -> None:
        self.changed()


class SettingsView(_Reactive):
    def __init__(self, manager: WebUI) -> None:
        super().__init__(manager)
        self.games: set[str] = set()

    def set_games(self, games: set[Game]) -> None:
        self.games.update(game.name for game in games)
        self.changed()

    def clear_selection(self) -> None:
        return


class WebUI:
    def __init__(
        self,
        twitch: Twitch,
        *,
        host: str = "127.0.0.1",
        port: int = 8080,
        open_browser: bool = True,
        access_token: str | None = None,
    ) -> None:
        self._twitch = twitch
        self.host = host
        self.port = port
        self.open_browser = open_browser
        self.access_token = access_token
        self._generated_access_token = False
        if access_token is None and host not in {"127.0.0.1", "localhost", "::1"}:
            self.access_token = secrets.token_urlsafe(24)
            self._generated_access_token = True
        self._close_requested = asyncio.Event()
        self._server_task: asyncio.Task[None] | None = None
        self._runner: web.AppRunner | None = None
        self.fatal_error: BaseException | None = None
        self._subscribers: set[asyncio.Queue[None]] = set()
        self._revision = 0
        self.status_text = "Starting"
        self.activity_state = "idle"
        self.websocket_state: dict[int, dict[str, Any]] = {}
        self.login_state: dict[str, Any] = {
            "status": "Signed out",
            "userId": None,
            "activationUrl": None,
            "activationCode": None,
        }
        self.can_logout = False
        self.messages: deque[str] = deque(maxlen=250)
        self.notifications: deque[dict[str, str]] = deque(maxlen=20)
        self._network_failures: dict[str, int] = {}
        self.status = StatusView(self)
        self.websockets = WebsocketView(self)
        self.login = LoginView(self)
        self.help = HelpView(self)
        self.tray = TrayView(self)
        self.progress = ProgressView(self)
        self.channels = ChannelView(self)
        self.inv = InventoryView(self)
        self.settings = SettingsView(self)

    @property
    def running(self) -> bool:
        return self._server_task is not None and not self._server_task.done()

    @property
    def close_requested(self) -> bool:
        return self._close_requested.is_set()

    def changed(self) -> None:
        self._revision += 1
        for queue in tuple(self._subscribers):
            if queue.empty():
                queue.put_nowait(None)

    def snapshot(self) -> dict[str, Any]:
        watching = self._twitch.watching_channel.get_with_default(None)
        watching_id = watching.id if watching is not None else None
        settings = self._twitch.settings
        active_drop = self.progress.drop
        campaigns = [_campaign_json(campaign) for campaign in self._twitch.inventory]
        channels = [
            _channel_json(
                channel,
                watching_id,
                watchable=self._twitch.can_watch(channel),
            )
            for channel in self._twitch.channels.values()
        ]
        return {
            "revision": self._revision,
            "status": self.status_text,
            "activity": self.activity_state,
            "login": self.login_state,
            "canLogout": self.can_logout,
            "watchingChannelId": watching_id,
            "activeDrop": _drop_json(active_drop) if active_drop is not None else None,
            "campaigns": campaigns,
            "channels": channels,
            "websockets": [
                {"id": idx + 1, **item}
                for idx, item in sorted(self.websocket_state.items())
            ],
            "messages": list(self.messages),
            "notifications": list(self.notifications),
            "networkIssues": sorted(
                host for host, failures in self._network_failures.items() if failures >= 2
            ),
            "games": sorted(self.settings.games),
            "settings": {
                "priority": list(settings.priority),
                "exclude": sorted(settings.exclude),
                "priorityMode": settings.priority_mode.name,
                "connectionQuality": settings.connection_quality,
                "trayNotifications": settings.tray_notifications,
                "enableBadgesEmotes": settings.enable_badges_emotes,
                "availableDropsCheck": settings.available_drops_check,
                "proxy": str(settings.proxy),
            },
            "summary": {
                "campaigns": len(campaigns),
                "activeCampaigns": sum(item["status"] == "active" for item in campaigns),
                "completedCampaigns": sum(item["finished"] for item in campaigns),
                "onlineChannels": sum(item["online"] for item in channels),
            },
        }

    def start(self) -> None:
        if self._server_task is None:
            self._server_task = asyncio.create_task(self._serve())
            self._server_task.add_done_callback(self._server_stopped)

    def _server_stopped(self, task: asyncio.Task[None]) -> None:
        if task.cancelled() or self.close_requested:
            return
        if exc := task.exception():
            self.fatal_error = exc
            self.print(f"Dashboard server failed: {exc}")
            self.close()

    def stop(self) -> None:
        self.progress.stop_timer()

    async def _serve(self) -> None:
        app = web.Application(middlewares=[self._security_headers, self._authenticate])
        app.router.add_get("/", self._index)
        app.router.add_post("/session", self._dashboard_login)
        app.router.add_get("/healthz", self._health)
        app.router.add_get("/api/state", self._state)
        app.router.add_get("/api/events", self._events)
        app.router.add_post("/api/actions/{action}", self._action)
        app.router.add_post("/api/channels/{channel_id}", self._switch_channel)
        app.router.add_put("/api/settings", self._update_settings)
        app.router.add_post("/api/login", self._login)
        app.router.add_static("/assets", WEB_ROOT, append_version=True)
        self._runner = web.AppRunner(app, access_log=None)
        await self._runner.setup()
        site = web.TCPSite(self._runner, self.host, self.port)
        try:
            await site.start()
            url_host = "127.0.0.1" if self.host in {"0.0.0.0", "::"} else self.host
            url = f"http://{url_host}:{self.port}/"
            if self.access_token is not None and (self.open_browser or self._generated_access_token):
                url = f"{url}?token={self.access_token}"
                logger.warning("Dashboard access URL: %s", url)
            elif self.access_token is not None:
                logger.info("Dashboard: %s (access token required)", url)
            else:
                logger.info("Dashboard: %s", url)
            if self.open_browser:
                asyncio.get_running_loop().run_in_executor(None, partial(webbrowser.open, url))
            await self._close_requested.wait()
        finally:
            await self._runner.cleanup()

    @web.middleware
    async def _security_headers(self, request: web.Request, handler: Any) -> web.StreamResponse:
        response = await handler(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src 'self' https: data:; "
            "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'"
        )
        return response

    @web.middleware
    async def _authenticate(self, request: web.Request, handler: Any) -> web.StreamResponse:
        if request.path in {"/healthz", "/session"} or self.access_token is None:
            return await handler(request)
        query_token = request.query.get("token")
        supplied = query_token or request.cookies.get("tdm_session")
        if supplied is None or not secrets.compare_digest(supplied, self.access_token):
            if request.path == "/":
                return web.Response(
                    text=TOKEN_LOGIN_HTML.replace("__ERROR__", ""),
                    content_type="text/html",
                    status=401,
                )
            raise web.HTTPUnauthorized(text="A valid dashboard access token is required.")
        response: web.StreamResponse
        if query_token == self.access_token and request.path == "/":
            response = web.HTTPFound("/")
        else:
            response = await handler(request)
        if query_token == self.access_token:
            response.set_cookie(
                "tdm_session",
                self.access_token,
                httponly=True,
                samesite="Strict",
                secure=request.secure,
            )
        return response

    async def _dashboard_login(self, request: web.Request) -> web.StreamResponse:
        token = str((await request.post()).get("token", ""))
        if self.access_token is None or not secrets.compare_digest(token, self.access_token):
            return web.Response(
                text=TOKEN_LOGIN_HTML.replace(
                    "__ERROR__", '<p class="error" role="alert">That token is not valid.</p>'
                ),
                content_type="text/html",
                status=401,
            )
        response = web.HTTPFound("/")
        response.set_cookie(
            "tdm_session",
            self.access_token,
            httponly=True,
            samesite="Strict",
            secure=request.secure,
        )
        return response

    async def _index(self, request: web.Request) -> web.FileResponse:
        del request
        return web.FileResponse(WEB_ROOT / "index.html")

    async def _health(self, request: web.Request) -> web.Response:
        del request
        return web.json_response({"status": "ok"})

    async def _state(self, request: web.Request) -> web.Response:
        del request
        return web.json_response(self.snapshot())

    async def _events(self, request: web.Request) -> web.StreamResponse:
        response = web.StreamResponse(
            headers={
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            }
        )
        await response.prepare(request)
        queue: asyncio.Queue[None] = asyncio.Queue(maxsize=1)
        self._subscribers.add(queue)
        try:
            while True:
                payload = json.dumps(self.snapshot(), separators=(",", ":"))
                await response.write(f"data:{payload}\n\n".encode())
                try:
                    await asyncio.wait_for(queue.get(), timeout=20)
                except asyncio.TimeoutError:
                    await response.write(b":keepalive\n\n")
        except (ConnectionResetError, asyncio.CancelledError):
            pass
        finally:
            self._subscribers.discard(queue)
        return response

    async def _action(self, request: web.Request) -> web.Response:
        action = request.match_info["action"]
        if action == "reload":
            self._twitch.change_state(State.INVENTORY_FETCH)
        elif action == "restart":
            self._twitch.change_state(State.RESTART)
        elif action == "pause":
            self._twitch.change_state(State.IDLE)
        elif action == "logout":
            self._twitch._auth_state.invalidate(delete_cookies=True)
            self._twitch.change_state(State.RESTART)
        elif action == "shutdown":
            self.close()
        else:
            raise web.HTTPNotFound(text="Unknown action")
        return web.json_response({"ok": True})

    async def _switch_channel(self, request: web.Request) -> web.Response:
        try:
            channel_id = int(request.match_info["channel_id"])
        except ValueError as exc:
            raise web.HTTPBadRequest(text="Invalid channel ID") from exc
        if channel_id not in self._twitch.channels:
            raise web.HTTPNotFound(text="Channel not found")
        if not self._twitch.can_watch(self._twitch.channels[channel_id]):
            raise web.HTTPConflict(text="Channel is not eligible for an active drop")
        self.channels.selected_id = channel_id
        self._twitch.change_state(State.CHANNEL_SWITCH)
        return web.json_response({"ok": True})

    async def _update_settings(self, request: web.Request) -> web.Response:
        payload = await request.json()
        settings = self._twitch.settings
        if "priority" in payload:
            settings.priority = list(dict.fromkeys(map(str, payload["priority"])))
        if "exclude" in payload:
            settings.exclude = set(map(str, payload["exclude"]))
        if "priorityMode" in payload:
            try:
                settings.priority_mode = PriorityMode[str(payload["priorityMode"])]
            except KeyError as exc:
                raise web.HTTPBadRequest(text="Invalid priority mode") from exc
        if "connectionQuality" in payload:
            quality = int(payload["connectionQuality"])
            if not 1 <= quality <= 6:
                raise web.HTTPBadRequest(text="Connection quality must be between 1 and 6")
            settings.connection_quality = quality
        for json_name, attr_name in {
            "trayNotifications": "tray_notifications",
            "enableBadgesEmotes": "enable_badges_emotes",
            "availableDropsCheck": "available_drops_check",
        }.items():
            if json_name in payload:
                setattr(settings, attr_name, bool(payload[json_name]))
        if "proxy" in payload:
            proxy = URL(str(payload["proxy"]).strip())
            try:
                valid_proxy = not proxy or (
                    proxy.host is not None and proxy.explicit_port is not None
                )
            except ValueError:
                valid_proxy = False
            if not valid_proxy:
                raise web.HTTPBadRequest(text="Proxy must include a host and port")
            settings.proxy = proxy
        settings.save()
        self._twitch.change_state(State.GAMES_UPDATE)
        self.changed()
        return web.json_response({"ok": True})

    async def _login(self, request: web.Request) -> web.Response:
        if not self.login.submit(await request.json()):
            raise web.HTTPConflict(text="The miner is not waiting for credentials")
        return web.json_response({"ok": True})

    async def wait_until_closed(self) -> None:
        await self._close_requested.wait()

    async def coro_unless_closed(self, coro: Any) -> Any:
        tasks = [asyncio.ensure_future(coro), asyncio.create_task(self._close_requested.wait())]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        if self.close_requested:
            from exceptions import ExitRequest

            raise ExitRequest()
        return await next(iter(done))

    def prevent_close(self) -> None:
        self._close_requested.clear()

    def close(self, *args: Any) -> int:
        del args
        self._close_requested.set()
        self._twitch.close()
        return 0

    def close_window(self) -> None:
        return

    def save(self, *, force: bool = False) -> None:
        del force

    def grab_attention(self, *, sound: bool = True) -> None:
        del sound

    def set_games(self, games: set[Game]) -> None:
        self.settings.set_games(games)

    def display_drop(
        self,
        drop: TimedDrop,
        *,
        countdown: bool = True,
        subone: bool = False,
    ) -> None:
        self.progress.display(drop, countdown=countdown, subone=subone)
        self.tray.update_title(drop)

    def clear_drop(self) -> None:
        self.progress.display(None)
        self.tray.update_title(None)

    def print(self, message: str) -> None:
        logger.info("%s", message)
        self.messages.append(message)
        self.changed()

    def report_network_issue(self, url: str) -> None:
        if host := URL(url).host:
            failures = self._network_failures.get(host, 0) + 1
            self._network_failures[host] = failures
            if failures == 2:
                self.changed()

    def report_network_recovery(self, url: str) -> None:
        if (host := URL(url).host) and self._network_failures.pop(host, 0) >= 2:
            self.changed()
