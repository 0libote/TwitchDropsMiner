from __future__ import annotations

import os
import asyncio
import subprocess
import sys
import webbrowser
from pathlib import Path
from typing import Callable

from constants import IS_PACKAGED, SELF_PATH


AUTOSTART_NAME = "TwitchDropsMinerNext"


def set_windows_autostart(enabled: bool, *, tray: bool = True) -> None:
    if sys.platform != "win32":
        return
    import winreg

    command = (
        f'"{SELF_PATH}"' if IS_PACKAGED
        else f'"{sys.executable}" "{SELF_PATH}"'
    ) + (" --tray" if tray else "")
    with winreg.OpenKey(
        winreg.HKEY_CURRENT_USER,
        r"Software\Microsoft\Windows\CurrentVersion\Run",
        0,
        winreg.KEY_SET_VALUE,
    ) as key:
        if enabled:
            winreg.SetValueEx(key, AUTOSTART_NAME, 0, winreg.REG_SZ, command)
        else:
            try:
                winreg.DeleteValue(key, AUTOSTART_NAME)
            except FileNotFoundError:
                pass


def set_keep_awake(enabled: bool) -> None:
    if sys.platform != "win32":
        return
    import ctypes

    ctypes.windll.kernel32.SetThreadExecutionState(
        0x80000000 | (0x00000001 if enabled else 0)
    )


def open_path(path: Path) -> None:
    if sys.platform == "win32":
        os.startfile(path)  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


def show_startup_error(message: str) -> None:
    if sys.platform == "win32":
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, message, "Twitch Drops Miner Next", 0x10)


class NativeTray:
    def __init__(self, url: str, close: Callable[[], None]) -> None:
        self.url = url
        self.close = close
        self.icon = None
        self.images: dict[str, object] = {}

    def start(self) -> None:
        if sys.platform != "win32" or self.icon is not None:
            return
        import pystray
        from PIL import Image
        from constants import _resource_path

        loop = asyncio.get_running_loop()
        menu = pystray.Menu(
            pystray.MenuItem("Open dashboard", lambda *_: webbrowser.open(self.url), default=True),
            pystray.MenuItem("Exit", lambda *_: loop.call_soon_threadsafe(self.close)),
        )
        self.images["pickaxe"] = Image.open(_resource_path("icons/pickaxe.ico"))
        self.icon = pystray.Icon(
            "twitch_drops_miner_next", self.images["pickaxe"],
            "Twitch Drops Miner Next", menu,
        )
        self.icon.run_detached()

    def update(self, title: str, icon: str = "pickaxe") -> None:
        if self.icon is None:
            return
        from PIL import Image
        from constants import _resource_path
        self.icon.title = title[:127]
        if icon not in self.images:
            self.images[icon] = Image.open(_resource_path(f"icons/{icon}.ico"))
        self.icon.icon = self.images[icon]

    def notify(self, message: str, title: str) -> None:
        if self.icon is not None:
            self.icon.notify(message, title)

    def stop(self) -> None:
        if self.icon is not None:
            self.icon.stop()
            self.icon = None
        for image in self.images.values():
            image.close()  # type: ignore[attr-defined]
        self.images.clear()
