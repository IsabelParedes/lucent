/**
 * Map Shiny addResourcePath URL prefixes to paths under the wasm R tree.
 *
 * Shiny serves deps at /shiny/{name}-{version}/{file} while files live under
 * package trees like library/shiny/www/shared/. This table matches stock Shiny
 * 1.14.x / bslib 0.11.x layout so the SW can serve assets without calling R.
 */
import { WASM_R_HOME } from "./constants";

/** HTTP path for a file relative to R_HOME, under the host prefix directory.
 * Returned without a leading slash so callers can resolve it against the site
 * root (SW registration scope), which may be `/` or a project Pages base.
 */
export function rHomeAssetHttpPath(hostPrefixDir: string, rHomeRelative: string): string {
  const hostPrefix = hostPrefixDir.replace(/^\/+|\/+$/g, "");
  const rel = rHomeRelative.replace(/^\/+/, "");
  return `${hostPrefix}${WASM_R_HOME}/${rel}`.replace(/\/+/g, "/").replace(/^\//, "");
}

const WASM_R_HOME_PREFIX = `${WASM_R_HOME}/`;

interface StaticBaseRule {
  match: (prefix: string) => boolean;
  base: string;
}

const SHINY_STATIC_BASES: StaticBaseRule[] = [
  { match: (p) => p.startsWith("jquery-"), base: "library/shiny/www/shared" },
  { match: (p) => p.startsWith("shiny-css-"), base: "library/shiny/www/shared" },
  { match: (p) => p.startsWith("shiny-javascript-"), base: "library/shiny/www/shared" },
  {
    match: (p) => p.startsWith("shiny-busy-indicators-"),
    base: "library/shiny/www/shared/busy-indicators",
  },
  { match: (p) => p.startsWith("htmltools-fill-"), base: "library/htmltools/fill" },
  { match: (p) => p.startsWith("strftime-"), base: "library/shiny/www/shared/strftime" },
  {
    match: (p) => p.startsWith("ionrangeslider-javascript-"),
    base: "library/shiny/www/shared/ionrangeslider",
  },
];

/**
 * Prefix/suffix pairs that do not follow the generic `{base}/{suffix}` layout.
 * Returns a path relative to R_HOME/ (no leading slash), or null.
 */
function resolveKnownAsset(prefix: string, suffix: string): string | null {
  if (prefix.startsWith("bootstrap-5")) {
    if (suffix.endsWith(".js")) {
      return `library/bslib/lib/bs5/dist/js/${basename(suffix)}`;
    }
    if (suffix === "bootstrap.min.css") {
      return "library/bslib/css-precompiled/5/bootstrap.min.css";
    }
    return null;
  }

  if (prefix.startsWith("bslib-component-js-")) {
    return `library/bslib/components/dist/${suffix}`;
  }

  if (prefix.startsWith("bslib-component-css-")) {
    return `library/bslib/components/dist/${suffix}`;
  }

  if (prefix.startsWith("bslib-tag-require-")) {
    return "library/bslib/components/tag-require.js";
  }

  if (prefix.startsWith("bs3compat-")) {
    return `library/bslib/bs3compat/js/${suffix}`;
  }

  if (prefix.startsWith("shiny-javascript-")) {
    return "library/shiny/www/shared/shiny.min.js";
  }

  if (prefix.startsWith("jquery-")) {
    return `library/shiny/www/shared/${suffix}`;
  }

  // Sass-compiled or cache-only deps (selectize, ionRangeSlider CSS, shiny-sass).
  if (
    prefix.startsWith("selectize-") ||
    prefix.startsWith("ionRangeSlider-") ||
    prefix.startsWith("shiny-sass-")
  ) {
    return null;
  }

  return null;
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/**
 * @param prefix e.g. jquery-3.7.1
 * @param suffix e.g. jquery.min.js
 * @returns path relative to R_HOME/ (no leading slash)
 */
export function resolveShinyStaticRHomePath(prefix: string, suffix: string): string | null {
  if (!prefix || !suffix || suffix.includes("..")) {
    return null;
  }

  const known = resolveKnownAsset(prefix, suffix);
  if (known) {
    return known;
  }

  for (const rule of SHINY_STATIC_BASES) {
    if (rule.match(prefix)) {
      return `${rule.base}/${suffix}`.replace(/\/+/g, "/");
    }
  }

  return null;
}

/**
 * @param vfsDir absolute VFS path from shiny::resourcePaths()
 * @param suffix file path under the resource prefix
 */
export function rHomePathFromVfsDir(vfsDir: string, suffix: string): string | null {
  if (!vfsDir || !suffix || suffix.includes("..")) {
    return null;
  }
  const normalized = vfsDir.replace(/\/$/, "");
  if (!normalized.startsWith(WASM_R_HOME_PREFIX)) {
    return null;
  }
  const fetchPath = normalized.slice(WASM_R_HOME_PREFIX.length);
  return `${fetchPath}/${suffix}`.replace(/\/+/g, "/");
}
