"""Build a static Lucent site from an existing wasm prefix and Shiny app."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

# VFS mount used by Lucent's startApp(appDir = "webApp", ...).
WEB_APP_MOUNT = "/webApp"
WEB_APP_ARCHIVE = "webApp.tar.gz"
EMPACK_META_NAME = "empack_env_meta.json"

RUNTIME_BIN_FILES = ("Rmain.js", "Rmain.wasm")
RUNTIME_LIB_FILES = ("libR.so", "libRblas.so", "libRlapack.so")


class BuildError(Exception):
    """User-facing build failure."""


def build(
    *,
    prefix_dir: Path,
    app_dir: Path,
    out_dir: Path,
    title: str = "Shiny App",
) -> None:
    """Pack ``prefix_dir`` + ``app_dir`` into ``out_dir``.

    Steps:
    1. Validate the prefix (Rmain / libR*) and app directory
    2. Run empack pack env / pack dir / pack append into ``out_dir/packages/``
    3. Copy Rmain binaries and libR*.so into ``out_dir/runtime/``
    4. Assemble Lucent JS, shell templates, SW alias, and app sources (separate task)
    """
    prefix_dir = prefix_dir.expanduser().resolve()
    app_dir = app_dir.expanduser().resolve()
    out_dir = out_dir.expanduser().resolve()

    validate_prefix(prefix_dir)
    validate_app(app_dir)

    packages_dir = out_dir / "packages"
    runtime_dir = out_dir / "runtime"

    _log(f"preparing output directory {out_dir}")
    if out_dir.exists():
        shutil.rmtree(out_dir)
    packages_dir.mkdir(parents=True)
    (runtime_dir / "bin").mkdir(parents=True)
    (runtime_dir / "lib" / "R" / "lib").mkdir(parents=True)

    pack_env(prefix_dir, packages_dir)
    pack_app(app_dir, packages_dir)
    append_app(packages_dir)
    copy_runtime(prefix_dir, runtime_dir)

    _log(f"packed packages → {packages_dir}")
    _log(f"copied runtime  → {runtime_dir}")

    # Site shell / Lucent JS / SW alias — implemented in the assemble task.
    assemble_site(out_dir=out_dir, app_dir=app_dir, title=title)


def validate_prefix(prefix_dir: Path) -> None:
    if not prefix_dir.is_dir():
        raise BuildError(f"prefix directory does not exist: {prefix_dir}")

    missing: list[str] = []
    for name in RUNTIME_BIN_FILES:
        if not (prefix_dir / "bin" / name).is_file():
            missing.append(f"bin/{name}")
    for name in RUNTIME_LIB_FILES:
        if not (prefix_dir / "lib" / "R" / "lib" / name).is_file():
            missing.append(f"lib/R/lib/{name}")
    if missing:
        raise BuildError(
            "prefix looks incomplete (not an emscripten-wasm32 R env with r-main?). "
            f"Missing under {prefix_dir}: {', '.join(missing)}"
        )


def validate_app(app_dir: Path) -> None:
    if not app_dir.is_dir():
        raise BuildError(f"app directory does not exist: {app_dir}")


def pack_env(prefix_dir: Path, packages_dir: Path) -> None:
    _log(f"empack pack env --env-prefix {prefix_dir}")
    _run_empack(
        [
            "pack",
            "env",
            "--env-prefix",
            str(prefix_dir),
            "--outdir",
            str(packages_dir),
        ]
    )
    meta = packages_dir / EMPACK_META_NAME
    if not meta.is_file():
        raise BuildError(f"empack pack env did not write {meta}")


def pack_app(app_dir: Path, packages_dir: Path) -> None:
    _log(f"empack pack dir {app_dir} → {WEB_APP_MOUNT}")
    _run_empack(
        [
            "pack",
            "dir",
            "--host-dir",
            str(app_dir),
            "--mount-dir",
            WEB_APP_MOUNT,
            "--outname",
            WEB_APP_ARCHIVE,
            "--outdir",
            str(packages_dir),
        ]
    )
    archive = packages_dir / WEB_APP_ARCHIVE
    if not archive.is_file():
        raise BuildError(f"empack pack dir did not write {archive}")


def append_app(packages_dir: Path) -> None:
    meta = packages_dir / EMPACK_META_NAME
    archive = packages_dir / WEB_APP_ARCHIVE
    _log(f"empack pack append {archive.name} → {meta.name}")
    _run_empack(
        [
            "pack",
            "append",
            "--env-meta",
            str(meta),
            "--tarfile",
            str(archive),
        ]
    )


def copy_runtime(prefix_dir: Path, runtime_dir: Path) -> None:
    """Copy Rmain bootstrap assets needed before VFS populate."""
    _log("copying Rmain.js / Rmain.wasm / libR*.so into runtime/")
    bin_dst = runtime_dir / "bin"
    lib_dst = runtime_dir / "lib" / "R" / "lib"
    bin_dst.mkdir(parents=True, exist_ok=True)
    lib_dst.mkdir(parents=True, exist_ok=True)

    for name in RUNTIME_BIN_FILES:
        shutil.copy2(prefix_dir / "bin" / name, bin_dst / name)
    for name in RUNTIME_LIB_FILES:
        shutil.copy2(prefix_dir / "lib" / "R" / "lib" / name, lib_dst / name)


def assemble_site(*, out_dir: Path, app_dir: Path, title: str) -> None:
    """Copy Lucent assets, shell templates, SW alias, and app sources into ``out_dir``."""
    raise NotImplementedError(
        "site assembly is not implemented yet "
        f"(out_dir={out_dir}, app_dir={app_dir}, title={title!r})"
    )


def _empack_executable() -> str:
    exe = shutil.which("empack")
    if exe is None:
        raise BuildError(
            "empack not found on PATH. Install lucent-pack (pulls in empack) "
            "and ensure its environment is active."
        )
    return exe


def _run_empack(args: list[str]) -> None:
    cmd = [_empack_executable(), *args]
    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError as exc:
        raise BuildError(
            f"empack failed with exit code {exc.returncode}: {' '.join(cmd)}"
        ) from exc


def _log(message: str) -> None:
    print(f"[lucent] {message}", flush=True)
