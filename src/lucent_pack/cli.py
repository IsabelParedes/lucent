"""Command-line entry point for the ``lucent`` console script."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="lucent",
        description="Pack a Shiny app and wasm R prefix into a static Lucent site.",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {_package_version()}",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    build = subparsers.add_parser(
        "build",
        help="Pack an existing wasm prefix and Shiny app into a static site",
    )
    build.add_argument(
        "--prefix-dir",
        type=Path,
        required=True,
        help="Existing emscripten-wasm32 conda/micromamba prefix",
    )
    build.add_argument(
        "--app",
        type=Path,
        required=True,
        help="Shiny app directory (mounted at /webApp in the VFS)",
    )
    build.add_argument(
        "--outdir",
        type=Path,
        default=Path("_site"),
        help="Output directory for the static site (default: _site)",
    )
    build.add_argument(
        "--title",
        default="Shiny App",
        help='HTML <title> for the app shell (default: "Shiny App")',
    )
    build.set_defaults(func=_cmd_build)

    serve = subparsers.add_parser(
        "serve",
        help="Serve a built static site directory over HTTP",
    )
    serve.add_argument(
        "directory",
        type=Path,
        help="Output directory from `lucent build` (e.g. _site/)",
    )
    serve.add_argument(
        "--port",
        type=int,
        default=8000,
        help="Port to listen on (default: 8000)",
    )
    serve.set_defaults(func=_cmd_serve)

    return parser


def _package_version() -> str:
    from lucent_pack import __version__

    return __version__


def _cmd_build(args: argparse.Namespace) -> int:
    from lucent_pack.build import BuildError, build

    try:
        build(
            prefix_dir=args.prefix_dir,
            app_dir=args.app,
            out_dir=args.outdir,
            title=args.title,
        )
    except BuildError as exc:
        print(f"lucent: error: {exc}", file=sys.stderr)
        return 1
    return 0


def _cmd_serve(args: argparse.Namespace) -> int:
    from lucent_pack.serve import ServeError, serve

    try:
        serve(directory=args.directory, port=args.port)
    except ServeError as exc:
        print(f"lucent: error: {exc}", file=sys.stderr)
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except NotImplementedError as exc:
        print(f"lucent: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 — top-level CLI boundary
        print(f"lucent: error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
