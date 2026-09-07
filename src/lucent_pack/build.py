"""Build a static Lucent site from an existing wasm prefix and Shiny app."""

from __future__ import annotations

from pathlib import Path


def build(
    *,
    prefix_dir: Path,
    app_dir: Path,
    out_dir: Path,
    title: str = "Shiny App",
) -> None:
    """Pack ``prefix_dir`` + ``app_dir`` into ``out_dir``.

    Expected steps (not yet implemented):
    1. Validate the prefix (Rmain.js / Rmain.wasm) and app directory
    2. Run empack pack env / pack dir / pack append
    3. Copy Rmain binaries and libR*.so into ``out_dir/runtime/``
    4. Copy bundled Lucent JS, shell templates, SW alias, and app sources
    """
    raise NotImplementedError(
        "lucent build is not implemented yet "
        f"(prefix_dir={prefix_dir}, app_dir={app_dir}, out_dir={out_dir}, title={title!r})"
    )
