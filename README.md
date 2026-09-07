# Pack a Shiny app and a WebAssembly R environment into a static [Lucent](js/) site.

```bash
pip install -e .
lucent build --prefix-dir ./_prefix-wasm --app ./app --out ./_site
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

```bash
# Python package
pip install -e .

# Browser runtime (TypeScript)
cd js && npm ci && npm run build
# copy js/dist → src/lucent_pack/static/lucent/ (release step; not automated yet)
```

## CLI

| Command | Purpose |
|---------|---------|
| `lucent build` | Pack an existing `--prefix-dir` + `--app` into `--out` |
| `lucent serve` | Serve a built site directory (`python -m http.server` style) |
