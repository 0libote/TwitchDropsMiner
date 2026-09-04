from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import platform
import secrets
import sys
import webbrowser
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from functools import partial
from ipaddress import ip_address
from pathlib import Path
from time import monotonic
from typing import TYPE_CHECKING, Any

import aiohttp
from aiohttp import web
from yarl import URL

from constants import DATA_DIR, LOG_PATH, PriorityMode, State
from fork_version import __version__
from platform_qol import NativeTray, open_path, set_keep_awake, set_windows_autostart
from version import __version__ as upstream_version

if TYPE_CHECKING:
    from channel import Channel
    from inventory import DropsCampaign, TimedDrop
    from twitch import Twitch
    from utils import Game


logger = logging.getLogger("TwitchDrops")
WEB_ROOT = Path(__file__).with_name("web")


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
        "totalRemainingMinutes": drop.total_remaining_minutes,
        "prerequisites": [
            {"id": prerequisite.id, "name": prerequisite.name, "claimed": prerequisite.is_claimed}
            for pid in drop.precondition_drops
            if (prerequisite := drop.campaign.timed_drops.get(pid)) is not None
        ],
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
        "linkUrl": str(campaign.link_url),
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
            if not self.manager.can_logout:
                self.manager.login_state["userId"] = None
            self.manager.changed()


class HelpView:
    def __init__(self, manager: WebUI) -> None:
        self._invalidate_button = _Button(manager)


class TrayView(_Reactive):
    def change_icon(self, state: str) -> None:
        self.manager.activity_state = state
        set_keep_awake(state == "active" and self.manager._twitch.settings.keep_awake)
        self.manager.native_tray.update(self.manager._tray_title(), state)
        self.changed()

    def update_title(self, drop: TimedDrop | None) -> None:
        self.manager.native_tray.update(self.manager._tray_title(drop), self.manager.activity_state)
        self.changed()

    def notify(self, message: str, title: str) -> None:
        self.manager.send_webhook("claim", title, message)
        if not self.manager._twitch.settings.tray_notifications:
            return
        self.manager.notifications.appendleft(
            {"time": datetime.now(timezone.utc).isoformat(), "title": title, "message": message}
        )
        self.manager.native_tray.notify(message, title)
        self.changed()

    def restore(self) -> None:
        return

    def stop(self) -> None:
        self.manager.native_tray.stop()
        set_keep_awake(False)


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
        self.manager._twitch.stats.last_inventory_at = datetime.now(timezone.utc).isoformat()
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
        tray: bool = False,
    ) -> None:
        self._twitch = twitch
        self.host = host
        self.port = port
        self.open_browser = open_browser
        self.auth_token = os.environ.get("TDM_WEB_TOKEN", "")
        self.csrf_token = secrets.token_urlsafe(32)
        self._webhook_tasks: set[asyncio.Task] = set()
        self.last_watchdog = 0.0
        self.recovery_reason: str | None = None
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
        self.messages: deque[dict[str, str]] = deque(maxlen=250)
        self.notifications: deque[dict[str, str]] = deque(maxlen=20)
        self._network_failures: dict[str, int] = {}
        url_host = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
        self.dashboard_url = f"http://{url_host}:{port}/"
        self.native_tray = NativeTray(self.dashboard_url, self.close)
        self._tray_enabled = tray
        self._clock_task: asyncio.Task[None] | None = None
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
    def webhook_url(self) -> str:
        return os.environ.get("TDM_WEBHOOK_URL") or getattr(self._twitch.settings, "webhook_url", "")

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
        stats = getattr(self._twitch, "stats", None)
        stats_snapshot = stats.snapshot() if stats is not None else {
            "startedAt": None, "uptimeSeconds": 0, "session": {}, "lifetime": {},
            "lastInventoryAt": None, "lastRecoveryAt": None,
        }
        return {
            "revision": self._revision,
            "paused": getattr(self._twitch, "paused", False),
            "miningPlan": self._mining_plan(),
            "progressHealth": self._progress_health(),
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
            "stats": stats_snapshot,
            "system": {
                "version": __version__,
                "upstreamVersion": upstream_version,
                "python": platform.python_version(),
                "platform": platform.platform(),
                "packaged": bool(getattr(sys, "frozen", False)),
                "dataDirectory": str(DATA_DIR),
                "authenticationEnabled": bool(self.auth_token),
                "webhookManagedByEnvironment": bool(os.environ.get("TDM_WEBHOOK_URL")),
            },
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
                "autostart": getattr(settings, "autostart_tray", False),
                "keepAwake": getattr(settings, "keep_awake", False),
                "proxy": str(settings.proxy),
                "webhookUrl": "" if os.environ.get("TDM_WEBHOOK_URL") else getattr(settings, "webhook_url", ""),
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
            self._clock_task = asyncio.create_task(self._clock_monitor())

    def _progress_health(self) -> dict[str, Any]:
        elapsed = self._twitch.seconds_without_progress() if hasattr(self._twitch, "seconds_without_progress") else None
        stamp = getattr(self._twitch, "last_confirmed_progress_at", None)
        return {
            "lastConfirmedAt": (datetime.now(timezone.utc) - timedelta(seconds=max(0, monotonic() - stamp))).isoformat() if stamp is not None else None,
            "secondsWithoutProgress": int(elapsed) if elapsed is not None else None,
            "nextRecoveryInSeconds": int(max(0, 900 - elapsed, 900 - (monotonic() - self.last_watchdog))) if elapsed is not None else None,
            "recoveryReason": self.recovery_reason,
        }

    def _mining_plan(self) -> list[dict[str, Any]]:
        miner = self._twitch
        games = getattr(miner, "wanted_games", [])
        watching = miner.watching_channel.get_with_default(None)
        current = miner.get_active_campaign(watching) if watching is not None else None
        paused = getattr(miner, "paused", False)
        now = datetime.now(timezone.utc)
        planned = []
        for game in games:
            campaigns = [c for c in miner.inventory if c.game == game and not c.finished and c.eligible and not c.expired]
            if not campaigns:
                continue
            active = current is not None and current in campaigns
            live_campaigns = [c for c in campaigns if any(
                miner.can_watch(ch) and c.can_earn(ch) for ch in miner.channels.values()
            )]
            campaign = current if active else min(live_campaigns or campaigns, key=lambda c: c.remaining_minutes)
            live = active or campaign in live_campaigns
            planned.append((game, campaign, active, live, len(campaigns) == 1))
        # Live fallback mining can precede a preferred game with no eligible channel.
        planned.sort(key=lambda item: 0 if item[2] else 1 if item[3] else 2)
        elapsed = 0
        predictable = not paused
        result = []
        for game, campaign, active, live, unambiguous in planned:
            priority = game.name in miner.settings.priority
            reason_code = "paused" if paused else "mining" if active else "queued" if live else "waiting"
            reason = {"paused": "Mining paused", "mining": "Currently mining", "queued": "Priority game" if priority else "Selected by fallback rule", "waiting": "No eligible live channel discovered yet"}[reason_code]
            # A current campaign has a useful estimate even when other campaigns in
            # that game make the subsequent game-level schedule unknowable.
            estimate = None
            if predictable and live and (active or unambiguous):
                elapsed += campaign.remaining_minutes
                estimate = (now + timedelta(minutes=elapsed)).isoformat()
                if now + timedelta(minutes=elapsed) > campaign.ends_at:
                    estimate = None
                    predictable = False
            else:
                predictable = False
            if not unambiguous:
                predictable = False
            result.append({"game": game.name, "gameId": game.id, "campaignId": campaign.id,
                "name": campaign.name, "image": str(campaign.image_url), "reason": reason,
                "reasonCode": reason_code, "remainingMinutes": campaign.remaining_minutes,
                "estimatedCompletionAt": estimate,
                "endsAt": campaign.ends_at.isoformat(), "watching": active, "priority": priority})
        # Keep blocked explicit preferences visible, without presenting them as scheduled work.
        for game in miner.settings.priority:
            if any(item["game"] == game for item in result):
                continue
            campaigns = [c for c in miner.inventory if c.game.name == game]
            campaign = campaigns[0] if campaigns else None
            reason = "Excluded by your mining plan" if game in miner.settings.exclude else "Account connection required" if any(not c.linked for c in campaigns) else "No eligible campaign selected"
            result.append({"game": game, "gameId": campaign.game.id if campaign else None,
                "campaignId": campaign.id if campaign else None, "image": str(campaign.image_url) if campaign else None,
                "reason": reason, "reasonCode": "waiting", "remainingMinutes": None,
                "estimatedCompletionAt": None, "endsAt": None, "watching": False, "priority": True})
        return result

    def _server_stopped(self, task: asyncio.Task[None]) -> None:
        if task.cancelled() or self.close_requested:
            return
        if exc := task.exception():
            self.fatal_error = exc
            self.print(f"Dashboard server failed: {exc}")
            self.close()

    def stop(self) -> None:
        self.progress.stop_timer()
        if self._clock_task is not None:
            self._clock_task.cancel()
        self.native_tray.stop()
        for task in self._webhook_tasks:
            task.cancel()
        set_keep_awake(False)

    def _build_app(self) -> web.Application:
        app = web.Application(middlewares=[self._authentication, self._csrf_protection, self._security_headers])
        for path in ("/", "/campaigns", "/mining", "/settings", "/diagnostics", "/history"):
            app.router.add_get(path, self._index)
        app.router.add_get("/campaigns/{campaign_id}", self._index)
        app.router.add_get("/healthz", self._health)
        app.router.add_get("/readyz", self._ready)
        app.router.add_get("/metrics", self._metrics)
        app.router.add_get("/api/diagnostics", self._diagnostics)
        app.router.add_get("/api/export", self._export)
        app.router.add_post("/api/import", self._import)
        app.router.add_get("/api/state", self._state)
        app.router.add_get("/api/csrf", self._csrf)
        app.router.add_get("/api/history", self._history)
        app.router.add_get("/api/events", self._events)
        app.router.add_post("/api/actions/{action}", self._action)
        app.router.add_post("/api/channels/{channel_id}", self._switch_channel)
        app.router.add_put("/api/settings", self._update_settings)
        app.router.add_post("/api/login", self._login)
        app.router.add_static("/assets", WEB_ROOT, append_version=True)
        return app

    async def _serve(self) -> None:
        app = self._build_app()
        self._runner = web.AppRunner(app, access_log=None)
        await self._runner.setup()
        site = web.TCPSite(self._runner, self.host, self.port)
        try:
            await site.start()
            logger.info("Dashboard: %s", self.dashboard_url)
            if self._tray_enabled:
                self.native_tray.start()
            if self.open_browser:
                asyncio.get_running_loop().run_in_executor(
                    None, partial(webbrowser.open, self.dashboard_url)
                )
            await self._close_requested.wait()
        finally:
            await self._runner.cleanup()

    @web.middleware
    async def _authentication(self, request: web.Request, handler: Any) -> web.StreamResponse:
        hostname = request.url.host
        public_host = URL(os.environ.get("TDM_PUBLIC_URL", "")).host
        allowed = hostname in {"127.0.0.1", "localhost", "::1", public_host}
        if not allowed and self.host not in {"127.0.0.1", "localhost", "::1"}:
            try:
                ip_address(hostname)
                allowed = True
            except ValueError:
                pass
        if not allowed:
            raise web.HTTPForbidden(text="Unrecognised local dashboard host")
        if not self.auth_token or request.path == "/healthz":
            return await handler(request)
        expected = "Basic " + base64.b64encode(f"tdm:{self.auth_token}".encode()).decode()
        if not secrets.compare_digest(request.headers.get("Authorization", ""), expected):
            raise web.HTTPUnauthorized(headers={"WWW-Authenticate": 'Basic realm="TDM dashboard"'})
        return await handler(request)

    @web.middleware
    async def _csrf_protection(self, request: web.Request, handler: Any) -> web.StreamResponse:
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            origin = request.headers.get("Origin")
            expected_origin = os.environ.get("TDM_PUBLIC_URL", "").rstrip("/") or f"{request.scheme}://{request.host}"
            if origin and origin != expected_origin:
                raise web.HTTPForbidden(text="Cross-origin actions are not allowed")
            if not secrets.compare_digest(request.headers.get("X-CSRF-Token", ""), self.csrf_token):
                raise web.HTTPForbidden(text="Invalid request token; reload the dashboard and try again")
        return await handler(request)

    async def _csrf(self, request: web.Request) -> web.Response:
        return web.json_response({"token": self.csrf_token}, headers={"Cache-Control": "no-store"})

    async def _history(self, request: web.Request) -> web.Response:
        history = getattr(self._twitch, "history", None)
        account = getattr(getattr(self._twitch, "_auth_state", None), "user_id", None)
        if not account:
            raise web.HTTPConflict(text="Connect Twitch to view this account's saved history")
        if history is None:
            raise web.HTTPServiceUnavailable(text="Reward history is unavailable; check the process log")
        try:
            offset = max(0, int(request.query.get("offset", "0")))
        except ValueError as exc:
            raise web.HTTPBadRequest(text="Invalid history offset") from exc
        result = history.query(str(account), game_id=request.query.get("game") or None,
            search=request.query.get("q", "")[:200], offset=offset, limit=50)
        result["summary"] = history.summary(str(account))
        return web.json_response(result, headers={"Cache-Control": "no-store"})

    @web.middleware
    async def _security_headers(self, request: web.Request, handler: Any) -> web.StreamResponse:
        response = await handler(request)
        response.headers["Cache-Control"] = "no-store" if request.path.startswith("/api/") else "no-cache"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src 'self' https: data:; "
            "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'"
        )
        return response

    async def _index(self, request: web.Request) -> web.FileResponse:
        del request
        return web.FileResponse(WEB_ROOT / "index.html")

    async def _health(self, request: web.Request) -> web.Response:
        del request
        return web.json_response({"status": "ok"})

    async def _ready(self, request: web.Request) -> web.Response:
        del request
        pool = getattr(getattr(self._twitch, "websocket", None), "websockets", ())
        sockets_ready = bool(pool) and all(socket.connected for socket in pool)
        ready = bool(self.login_state.get("userId")) and sockets_ready
        return web.json_response({"status": "ready" if ready else "starting"}, status=200 if ready else 503)

    async def _metrics(self, request: web.Request) -> web.Response:
        del request
        stats = self._twitch.stats.snapshot()
        lifetime = stats["lifetime"]
        lines = [
            f'tdm_uptime_seconds {stats["uptimeSeconds"]}',
            f'tdm_drops_claimed_total {lifetime["drops_claimed"]}',
            f'tdm_mining_minutes_total {lifetime["mining_minutes"]}',
            f'tdm_channel_switches_total {lifetime["channel_switches"]}',
            f'tdm_watch_failures_total {lifetime["watch_failures"]}',
        ]
        return web.Response(text="\n".join(lines) + "\n", content_type="text/plain")

    async def _diagnostics(self, request: web.Request) -> web.Response:
        del request
        snapshot = self.snapshot()
        return web.json_response({key: snapshot[key] for key in (
            "status", "activity", "websockets", "networkIssues", "stats", "system"
        )})

    async def _export(self, request: web.Request) -> web.Response:
        settings = self.snapshot()["settings"]
        settings["proxy"] = ""  # Proxy URLs may contain credentials; never export them.
        settings["webhookUrl"] = ""  # Webhook paths often contain service credentials.
        payload: dict[str, Any] = {"settings": settings}
        if request.query.get("stats") == "1":
            payload["stats"] = self._twitch.stats.snapshot()["lifetime"]
        return web.json_response(payload, headers={
            "Content-Disposition": 'attachment; filename="tdm-export.json"'
        })

    async def _import(self, request: web.Request) -> web.Response:
        try:
            payload = await request.json()
        except ValueError as exc:
            raise web.HTTPBadRequest(text="Import must be valid JSON") from exc
        return self._apply_settings(payload.get("settings", payload) if isinstance(payload, dict) else payload)

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
            self._twitch.pause()
        elif action == "resume":
            self._twitch.resume()
        elif action == "test-webhook":
            if not self.webhook_url:
                raise web.HTTPBadRequest(text="Save a webhook URL first")
            if not await self._deliver_webhook("test", "Test notification", "Twitch Drops Miner notification test"):
                raise web.HTTPBadGateway(text="Webhook delivery failed; check the URL and process log")
        elif action == "logout":
            self._twitch._auth_state.invalidate(delete_cookies=True)
            self.login_state.update(userId=None, activationCode=None, activationUrl=None, status="Signed out")
            self.can_logout = False
            self.changed()
            self._twitch.change_state(State.RESTART)
        elif action == "shutdown":
            self.close()
        elif action == "open-data":
            open_path(DATA_DIR)
        elif action == "open-log":
            open_path(LOG_PATH if LOG_PATH.exists() else DATA_DIR)
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
        try:
            payload = await request.json()
        except (ValueError, TypeError) as exc:
            raise web.HTTPBadRequest(text="Settings must be valid JSON") from exc
        return self._apply_settings(payload)

    def _apply_settings(self, payload: Any) -> web.Response:
        if not isinstance(payload, dict):
            raise web.HTTPBadRequest(text="Settings must be an object")
        candidate: dict[str, Any] = {}
        for name in ("priority", "exclude"):
            if name in payload:
                values = payload[name]
                if not isinstance(values, list) or len(values) > 1000 or any(not isinstance(v, str) or not v.strip() or len(v) > 200 for v in values):
                    raise web.HTTPBadRequest(text=f"{name} must be a list of game names")
                candidate[name] = list(dict.fromkeys(values)) if name == "priority" else set(values)
        if "priorityMode" in payload:
            try:
                candidate["priority_mode"] = PriorityMode[payload["priorityMode"]]
            except (KeyError, TypeError) as exc:
                raise web.HTTPBadRequest(text="Invalid priority mode") from exc
        if "connectionQuality" in payload:
            value = payload["connectionQuality"]
            if type(value) is not int or not 1 <= value <= 6:
                raise web.HTTPBadRequest(text="Connection quality must be an integer between 1 and 6")
            candidate["connection_quality"] = value
        for name, attribute in {
            "trayNotifications": "tray_notifications", "enableBadgesEmotes": "enable_badges_emotes",
            "availableDropsCheck": "available_drops_check", "keepAwake": "keep_awake", "autostart": "autostart_tray",
        }.items():
            if name in payload:
                if type(payload[name]) is not bool:
                    raise web.HTTPBadRequest(text=f"{name} must be a boolean")
                candidate[attribute] = payload[name]
        for name, attribute in {"proxy": "proxy", "webhookUrl": "webhook_url"}.items():
            if name not in payload:
                continue
            value = payload[name]
            if not isinstance(value, str) or len(value) > 4096:
                raise web.HTTPBadRequest(text=f"{name} must be a URL string")
            try:
                url = URL(value.strip())
                if url and (url.scheme not in {"http", "https"} or not url.host or (name == "proxy" and url.explicit_port is None)):
                    raise ValueError()
            except ValueError as exc:
                raise web.HTTPBadRequest(text="Proxy must include an HTTP(S) host and port" if name == "proxy" else "Webhook must be an HTTP(S) URL") from exc
            if name == "webhookUrl" and os.environ.get("TDM_WEBHOOK_URL"):
                continue
            candidate[attribute] = url if name == "proxy" else str(url)
        settings = self._twitch.settings
        previous = {name: getattr(settings, name, None) for name in candidate}
        try:
            for name, value in candidate.items():
                setattr(settings, name, value)
            if "autostart_tray" in candidate and candidate["autostart_tray"] != previous["autostart_tray"]:
                set_windows_autostart(candidate["autostart_tray"])
            settings.save()
        except Exception as exc:
            for name, value in previous.items():
                setattr(settings, name, value)
            if "autostart_tray" in candidate:
                try:
                    set_windows_autostart(bool(previous["autostart_tray"]))
                except OSError:
                    logger.exception("Unable to restore autostart after a failed save")
            logger.exception("Settings save failed")
            raise web.HTTPInternalServerError(text="Settings could not be saved") from exc
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
        self.messages.append({
            "time": datetime.now(timezone.utc).isoformat(), "level": "info", "message": message
        })
        self.changed()

    def report_network_issue(self, url: str) -> None:
        if host := URL(url).host:
            failures = self._network_failures.get(host, 0) + 1
            self._network_failures[host] = failures
            if failures == 2:
                self.send_webhook("network_failure", "Twitch network problem", f"Requests to {host} are failing")
                self.changed()

    def report_network_recovery(self, url: str) -> None:
        if (host := URL(url).host) and self._network_failures.pop(host, 0) >= 2:
            if stats := getattr(self._twitch, "stats", None):
                stats.last_recovery_at = datetime.now(timezone.utc).isoformat()
            self.send_webhook("network_recovery", "Twitch network recovered", f"Requests to {host} recovered")
            self.changed()

    def _tray_title(self, drop: TimedDrop | None = None) -> str:
        drop = drop or self.progress.drop
        if drop is None:
            return f"Twitch Drops Miner Next — {self.status_text}"
        return f"Twitch Drops Miner Next — {drop.rewards_text()} {drop.progress:.0%}"

    async def _deliver_webhook(self, event: str, title: str, message: str) -> bool:
        try:
            async with (
                aiohttp.ClientSession() as session,
                session.post(self.webhook_url,
                    json={"event": event, "title": title, "message": message},
                    timeout=aiohttp.ClientTimeout(total=10), allow_redirects=False) as response,
            ):
                if 200 <= response.status < 300:
                    return True
                logger.warning("Webhook returned HTTP %s", response.status)
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError, OSError):
            # URLs can contain credentials: do not include exception text.
            logger.warning("Webhook delivery failed")
        return False

    def send_webhook(self, event: str, title: str, message: str) -> None:
        if not self.webhook_url:
            return
        task = asyncio.create_task(self._deliver_webhook(event, title, message))
        self._webhook_tasks.add(task)
        task.add_done_callback(self._webhook_tasks.discard)

    async def _clock_monitor(self) -> None:
        """Refresh after suspend/resume and recover once when mining appears stalled."""
        previous = monotonic()
        while True:
            await asyncio.sleep(60)
            now = monotonic()
            if now - previous > 180:
                self.print("System resumed; refreshing Twitch state")
                self._twitch.change_state(State.INVENTORY_FETCH)
            previous = now
            elapsed = self._twitch.seconds_without_progress()
            if elapsed is not None and elapsed >= 900 and now - self.last_watchdog >= 900:
                self.last_watchdog = now
                self.recovery_reason = "No confirmed progress for 15 minutes; inventory refresh requested"
                self.print("Mining progress appears stalled; refreshing inventory")
                self.send_webhook(
                    "mining_stalled", "Mining progress stalled",
                    "No confirmed progress for 15 minutes; an automatic refresh was requested.",
                )
                self._twitch.change_state(State.INVENTORY_FETCH)
