from __future__ import annotations

from multiprocessing import freeze_support


if __name__ == "__main__":
    freeze_support()

    import argparse
    import asyncio
    import logging
    import os
    import signal
    import sys
    import traceback
    import warnings
    from functools import partial

    import truststore

    truststore.inject_into_ssl()

    from constants import FILE_FORMATTER, LOCK_PATH, LOGGING_LEVELS, LOG_PATH, SELF_PATH
    from exceptions import CaptchaRequired
    from settings import Settings
    from translate import _
    from twitch import Twitch
    from utils import lock_file
    from fork_version import __version__
    from version import __version__ as upstream_version
    from webui import WebUI

    warnings.simplefilter("default", ResourceWarning)

    if sys.version_info < (3, 10):
        raise RuntimeError("Python 3.10 or higher is required")

    class ParsedArgs(argparse.Namespace):
        _verbose: int
        _debug_ws: bool
        _debug_gql: bool
        log: bool
        tray: bool
        dump: bool
        legacy_ui: bool
        host: str
        port: int
        no_browser: bool

        @property
        def logging_level(self) -> int:
            return LOGGING_LEVELS[min(self._verbose, 4)]

        @property
        def debug_ws(self) -> int:
            if self._debug_ws:
                return logging.DEBUG
            if self._verbose >= 4:
                return logging.INFO
            return logging.NOTSET

        @property
        def debug_gql(self) -> int:
            if self._debug_gql:
                return logging.DEBUG
            if self._verbose >= 4:
                return logging.INFO
            return logging.NOTSET

    parser = argparse.ArgumentParser(
        SELF_PATH.name,
        description="Mine timed Twitch drops from a local or hosted dashboard.",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"Twitch Drops Miner Next {__version__} (upstream engine {upstream_version})",
    )
    parser.add_argument("-v", dest="_verbose", action="count", default=0)
    parser.add_argument(
        "--log", action="store_true",
        default=os.environ.get("TDM_LOG", "").lower() in {"1", "true", "yes"},
        help="write logs to the data directory",
    )
    parser.add_argument("--dump", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--tray", action="store_true", help="start minimized with a tray icon")
    parser.add_argument(
        "--legacy-ui",
        action="store_true",
        help="use the original Tkinter interface",
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("TDM_HOST", "127.0.0.1"),
        help="dashboard bind address (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("TDM_PORT", "8080")),
        help="dashboard port (default: 8080)",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        default=os.environ.get("TDM_NO_BROWSER", "").lower() in {"1", "true", "yes"},
        help="do not open the dashboard in a browser",
    )
    parser.add_argument("--debug-ws", dest="_debug_ws", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--debug-gql", dest="_debug_gql", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(namespace=ParsedArgs())

    try:
        settings = Settings(args)
    except Exception:
        parser.error(f"Unable to load settings:\n{traceback.format_exc()}")

    async def run() -> int:
        try:
            _.set_language(settings.language)
        except ValueError:
            pass

        if settings.logging_level > logging.DEBUG:
            logging.getLogger().addHandler(logging.NullHandler())
        logger = logging.getLogger("TwitchDrops")
        logger.setLevel(settings.logging_level)
        if settings.log:
            handler = logging.FileHandler(LOG_PATH)
            handler.setFormatter(FILE_FORMATTER)
            logger.addHandler(handler)
        else:
            handler = logging.StreamHandler()
            handler.setFormatter(logging.Formatter("%(levelname)s: %(message)s"))
            logger.addHandler(handler)
        logging.getLogger("TwitchDrops.gql").setLevel(settings.debug_gql)
        logging.getLogger("TwitchDrops.websocket").setLevel(settings.debug_ws)

        ui_factory = None
        if not args.legacy_ui:
            ui_factory = partial(
                WebUI,
                host=args.host,
                port=args.port,
                open_browser=not args.no_browser and not args.tray,
                tray=args.tray,
            )
        client = Twitch(settings, ui_factory=ui_factory)

        loop = asyncio.get_running_loop()
        installed_signals: list[signal.Signals] = []
        if sys.platform != "win32":
            for sig in (signal.SIGINT, signal.SIGTERM):
                loop.add_signal_handler(sig, client.gui.close)
                installed_signals.append(sig)

        exit_status = 0

        async def run_until_closed() -> None:
            miner_task = asyncio.create_task(client.run())
            close_task = asyncio.create_task(client.gui.wait_until_closed())
            done, _pending = await asyncio.wait(
                (miner_task, close_task), return_when=asyncio.FIRST_COMPLETED
            )
            if close_task in done and not miner_task.done():
                client.close()
                miner_task.cancel()
                try:
                    await miner_task
                except asyncio.CancelledError:
                    if fatal_error := getattr(client.gui, "fatal_error", None):
                        raise fatal_error from None
                    return
            close_task.cancel()
            await miner_task

        try:
            await run_until_closed()
        except CaptchaRequired:
            exit_status = 1
            client.prevent_close()
            client.print(_("error", "captcha"))
        except Exception:
            exit_status = 1
            if sys.platform == "win32":
                from platform_qol import show_startup_error
                show_startup_error(str(getattr(client.gui, "fatal_error", None) or "Fatal miner error. See log.txt for details."))
            if getattr(client.gui, "fatal_error", None):
                logger.critical("Dashboard failed:\n%s", traceback.format_exc())
                client.gui.close()
            else:
                client.prevent_close()
                client.print("Fatal error encountered:\n")
                client.print(traceback.format_exc())
        finally:
            for sig in installed_signals:
                loop.remove_signal_handler(sig)
            client.print(_("gui", "status", "exiting"))
            await client.shutdown()

        if not client.gui.close_requested:
            client.gui.tray.change_icon("error")
            client.print(_("status", "terminated"))
            client.gui.status.update(_("gui", "status", "terminated"))
            client.gui.grab_attention(sound=True)
        await client.gui.wait_until_closed()
        client.save(force=True)
        client.gui.stop()
        client.gui.close_window()
        return exit_status

    locked, lock_handle = lock_file(LOCK_PATH)
    if not locked:
        if sys.platform == "win32":
            from platform_qol import show_startup_error
            show_startup_error("Twitch Drops Miner is already running for this data directory.")
        parser.error("Twitch Drops Miner is already running for this data directory.")
    try:
        raise SystemExit(asyncio.run(run()))
    finally:
        lock_handle.close()
