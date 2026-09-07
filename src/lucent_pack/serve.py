"""Serve a built static Lucent site directory over HTTP."""

from __future__ import annotations

from pathlib import Path


def serve(*, directory: Path, port: int = 8000) -> None:
    """Serve ``directory`` with a stdlib HTTP server (like ``python -m http.server``)."""
    raise NotImplementedError(
        f"lucent serve is not implemented yet (directory={directory}, port={port})"
    )
