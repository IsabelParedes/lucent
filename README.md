# Pack a Shiny app and a WebAssembly R environment into a static [Lucent](js/) site.

```bash
pip install -e .
lucent build --prefix-dir ./_prefix-wasm --app ./app --outdir ./_site
lucent serve _site
```

Create a wasm environment with your favorite package manager:

```bash
micromamba create -p ./_prefix-wasm -f environment.yaml --platform=emscripten-wasm32
```

```yaml
# Sample environment.yaml
name: shinyapp-env
channels:
- https://repo.prefix.dev/emscripten-forge-4x
- conda-forge
dependencies:
# Minimum requirements
- r-main
- r-shiny
# Any additional packages required for the app
- r-bslib
- r-plotly
```

## Development

Requirements:
- python
- pip
- nodejs

```bash
pip install -e .

# Browser runtime — required before `python -m build` (wheel)
cd js && npm ci && npm run build
mkdir -p ../src/lucent_pack/static/lucent/dist
cp -a dist/. ../src/lucent_pack/static/lucent/dist/
```

The hatch wheel hook fails the build if the bundles (`src/lucent_pack/static/lucent/dist/`) are missing.

## CLI

| Command | Purpose |
|---------|---------|
| `lucent build` | Pack an existing `--prefix-dir` + `--app` into `--outdir` |
| `lucent serve` | Serve a built site directory (`python -m http.server` style) |
