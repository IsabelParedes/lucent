"""Serve a built static Lucent site directory over HTTP."""

from __future__ import annotations

import mimetypes
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class ServeError(Exception):
    """User-facing serve failure."""


def serve(*, directory: Path, port: int = 8000) -> None:
    """Serve ``directory`` with a stdlib HTTP server."""
    directory = directory.expanduser().resolve()
    if not directory.is_dir():
        raise ServeError(f"directory does not exist: {directory}")
    if not (1 <= port <= 65535):
        raise ServeError(f"invalid port: {port}")

    # Ensure Rmain.wasm is served with the correct type (may be missing in older MIME DBs).
    mimetypes.add_type("application/wasm", ".wasm")

    handler = partial(SimpleHTTPRequestHandler, directory=str(directory))
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    except OSError as exc:
        raise ServeError(f"could not bind to port {port}: {exc}") from exc

    url = f"http://127.0.0.1:{port}/"
    print(f"[lucent] serving {directory}", flush=True)
    print(f"[lucent] {url}", flush=True)
    print("[lucent] press Ctrl+C to stop", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[lucent] stopped", flush=True)
    finally:
        server.server_close()
