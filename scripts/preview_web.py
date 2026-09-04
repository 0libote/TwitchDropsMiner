"""Preview the shared dashboard with sample data, without connecting to Twitch.

Run: python scripts/preview_web.py --port 8095
The preview is read-only and only listens on localhost.
"""
from __future__ import annotations

import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent


class PreviewHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/api/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                payload = (ROOT / "tests/fixtures/web_state.json").read_text()
                self.wfile.write(f"data: {json.dumps(json.loads(payload))}\n\n".encode())
                self.wfile.flush()
                while True:
                    time.sleep(15)
                    self.wfile.write(b": preview keepalive\n\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        assets = {"/assets/app.js": "text/javascript", "/assets/theme.js": "text/javascript", "/assets/app.css": "text/css"}
        if path in assets:
            file = ROOT / "web" / path.rsplit("/", 1)[-1]
            content_type = assets[path]
        elif path in ("/", "/campaigns", "/mining", "/settings", "/diagnostics") or path.startswith("/campaigns/"):
            file = ROOT / "web/index.html"
            content_type = "text/html"
        else:
            self.send_error(404)
            return
        data = file.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:
        message = b"This is a read-only preview. Run the miner to use this action."
        self.send_response(409)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(message)))
        self.end_headers()
        self.wfile.write(message)

    do_PUT = do_POST


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8095)
    args = parser.parse_args()
    print(f"Read-only dashboard preview: http://127.0.0.1:{args.port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), PreviewHandler).serve_forever()
