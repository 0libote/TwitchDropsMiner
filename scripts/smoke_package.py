from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path


def available_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit(f"Usage: {Path(sys.argv[0]).name} EXECUTABLE")

    executable = Path(sys.argv[1]).resolve()
    if not executable.is_file():
        raise SystemExit(f"Packaged executable not found: {executable}")

    port = available_port()
    with tempfile.TemporaryDirectory(prefix="tdm-smoke-") as data_dir:
        environment = os.environ.copy()
        environment["TDM_DATA_DIR"] = data_dir
        process = subprocess.Popen(
            [
                str(executable),
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                "--no-browser",
            ],
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError(f"Packaged app exited with status {process.returncode}")
                try:
                    with urllib.request.urlopen(
                        f"http://127.0.0.1:{port}/healthz", timeout=1
                    ) as response:
                        if json.load(response) == {"status": "ok"}:
                            print(f"Packaged dashboard is healthy on port {port}")
                            return 0
                except OSError:
                    time.sleep(0.25)
            raise RuntimeError("Packaged dashboard did not become healthy within 30 seconds")
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


if __name__ == "__main__":
    raise SystemExit(main())
