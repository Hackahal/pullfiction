# Modern client asset adapters

The application reads modern client files in the browser. Use [the editor guide](EDITOR.md) to build and preview it, and [browser assets](BROWSER-ASSETS.md) for the production loading boundary. No local game-data server or original 1.12 installation is required.

## Adapter code

`scripts/classic_*.py` contains pure format adapters shared by the browser conversion worker and developer checks. `classic_db2.py` reads build-specific tables through the pinned community definitions. Character, equipment, creature and spell adapters produce browser-local metadata. World and terrain adapters preserve instance geometry and tactical-map floors. The Rust engine consumes the adapted resources through its existing native rendering and UI systems.

The format name `classic` does not limit planning to raids. Maps come from the selected client's catalog. Available Classic Era and SoD resources are supported within the implemented format coverage. Forever discovery and inaccessible/encrypted resources remain explicit compatibility boundaries. See [Forever client support](FOREVER-CLIENT.md).

Successful table decoding or model conversion does not establish correct pixels, full spell behavior or every boss scale. Use the [renderer workbench](../web/editor/src/renderer-lab/README.md) and its separate evidence checks.

## Inspect an asset outside the browser

These optional developer tools read installed archives without changing them:

```sh
bash scripts/classic-setup.sh
python3 scripts/classic-assets.py prepare
```

Use the reader's `--help` for `--install`, `--library` and `--output`. Keep generated caches outside the game installation and Git. `classic-model-check.py` checks prepared model/geometry resources; `classic-adapt.py` creates an inspection overlay. Neither is an application launcher or proof of visual correctness.

The pinned archive reader is [CascLib revision 6b889ec](https://github.com/ladislav-zezula/CascLib/tree/6b889ec8f421cbc9baccec296c582362ab917887). Native archive inspection is optional; end users select their files in the browser.

## Test conversion

`bash scripts/check.sh` runs synthetic converter fixtures and the production renderer compile check. These fixtures contain authored bytes and no game assets.

For optional real-client appearance tests, explicitly set `PULLFICTION_CLIENT_VIEW` to the client metadata view and `PULLFICTION_CASC_LIBRARY` to the built CascLib binary, then run `python3 scripts/classic-characters-test.py`. The test does not open or automate the official client. It reports a skip unless both paths are supplied; a configured read failure remains a failure.

For broader installed-data checks, use the renderer coverage, model audit and world audit tools described by the renderer workbench. Keep their captures and reports local.
