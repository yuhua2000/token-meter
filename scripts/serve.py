#!/usr/bin/env python3
"""Serve the token-meter dashboard from local files.

Endpoints:
    /            web/index.html
    /api/data    ~/.claude/token-meter/dashboard.json
    /health      ok

Standard library only.  The plugin starts this on demand with `$.process.spawn`
and stops it when the session ends.
"""

import argparse
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "web" / "index.html"


class Handler(BaseHTTPRequestHandler):
    server_version = "token-meter/1"

    def do_GET(self):  # noqa: N802 (stdlib naming)
        path = self.path.split("?", 1)[0]

        if path in ("/", "/index.html"):
            try:
                body = INDEX.read_bytes()
            except OSError as error:
                self._send(
                    500,
                    f"web/index.html not found: {error}\n".encode(),
                    "text/plain; charset=utf-8",
                )
                return
            self._send(200, body, "text/html; charset=utf-8")
            return

        if path == "/api/data":
            try:
                body = self.server.data_path.read_bytes()
            except OSError:
                body = b'{"error":"no data yet"}'
            self._send(200, body, "application/json; charset=utf-8")
            return

        if path == "/health":
            self._send(200, b"ok\n", "text/plain; charset=utf-8")
            return

        if path == "/favicon.ico":
            self._send(204, b"", "image/x-icon")
            return

        self._send(404, b"not found\n", "text/plain; charset=utf-8")

    def do_HEAD(self):  # noqa: N802
        self.do_GET()

    def _send(self, code, body, content_type):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("token-meter: " + (fmt % args) + "\n")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Serve the token-meter dashboard.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument(
        "--data",
        default=str(Path.home() / ".claude" / "token-meter" / "dashboard.json"),
        help="dashboard.json written by the plugin",
    )
    args = parser.parse_args(argv)

    if not (1024 <= args.port <= 65535):
        print("port must be between 1024 and 65535", file=sys.stderr)
        return 2

    data_path = Path(os.path.expanduser(args.data))
    try:
        server = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError as error:
        print(f"cannot listen on {args.host}:{args.port}: {error}", file=sys.stderr)
        return 1

    server.daemon_threads = True
    server.data_path = data_path
    print(f"token-meter dashboard: http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())