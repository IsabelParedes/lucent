"""Hatch build hook: require Lucent JS assets in the wheel."""

from __future__ import annotations

from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

# Bundles emitted by `js/` (tsup) and copied to package data at release.
REQUIRED_LUCENT_DIST_FILES = (
    "runApp.js",
    "rWasmWorker.js",
    "httpuv-web.js",
    "httpuv-sw.js",
    "shiny-socket.js",
)


class CustomBuildHook(BuildHookInterface):
    """Fail wheel builds if Lucent browser assets were not built into package data."""

    def initialize(self, version: str, build_data: dict) -> None:
        # sdist ships TypeScript sources under js/; only wheels need the bundles.
        # Editable installs should not require a frontend build either.
        if self.target_name != "wheel" or version == "editable":
            return

        dist_dir = Path(self.root) / "src" / "lucent_pack" / "static" / "lucent" / "dist"
        missing = [name for name in REQUIRED_LUCENT_DIST_FILES if not (dist_dir / name).is_file()]
        if not missing:
            return

        missing_list = ", ".join(missing)
        raise RuntimeError(
            "Lucent browser assets are missing from package data.\n"
            f"  Expected directory: {dist_dir}\n"
            f"  Missing: {missing_list}\n"
            "Build them before creating a wheel:\n"
            "  ( cd js && npm ci && npm run build )\n"
            "  mkdir -p src/lucent_pack/static/lucent/dist\n"
            "  cp -a js/dist/. src/lucent_pack/static/lucent/dist/\n"
        )
