#!/usr/bin/env python3
"""Local server for health dashboard with refresh endpoint."""

from __future__ import annotations

import json
import subprocess
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PROJECT_DIR = Path("/Users/saajan/AI_Projects")
SYNC_SCRIPT = PROJECT_DIR / "sync_apple_health_desktop.py"
HOST = "127.0.0.1"
PORT = 8000


class Handler(SimpleHTTPRequestHandler):
    def do_POST(self) -> None:
        if self.path == "/api/refresh":
            self._post_refresh()
            return
        self.send_json(404, {"ok": False, "error": "Unknown endpoint"})

    def _post_refresh(self) -> None:
        try:
            proc = subprocess.run(
                ["python3", str(SYNC_SCRIPT)],
                cwd=PROJECT_DIR,
                capture_output=True,
                text=True,
                check=False,
            )
            if proc.returncode != 0:
                self.send_json(500, {"ok": False, "error": proc.stderr.strip() or proc.stdout.strip()})
                return
            self.send_json(200, {"ok": True, "message": proc.stdout.strip()})
        except Exception as exc:
            self.send_json(500, {"ok": False, "error": str(exc)})

    def send_json(self, status: int, payload: dict) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Server running at http://{HOST}:{PORT}/health_dashboard_replica.html")
    server.serve_forever()


if __name__ == "__main__":
    main()
