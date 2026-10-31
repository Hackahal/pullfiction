# Browser-local modern assets

Pull Fiction's browser asset modules read an official Classic 1.15.9 installation
without a native helper or game-data server. The static editor connects these
modules to the Rust/Bevy replay renderer. The clean release is prepared with
`scripts/browser-static-build.sh`; see [STATIC-HOSTING.md](STATIC-HOSTING.md).
No deployment has been performed. Browser checks cover the restored native UI,
an MC replay, the complete 37:56 SoD AQ40 replay, and local 3D and tactical-map loading. They do not
establish exhaustive item, effect or encounter fidelity.

## Data boundary

The user selects their World of Warcraft folder through a standard directory
file input. The browser receives read-only `File` objects. Only `.build.info`,
CASC configuration files, indexes and archive files reach the reader worker.
Executables, account settings, screenshots and combat logs are excluded.

CascLib 6b889ec runs as WebAssembly inside a worker and reads file ranges through
Emscripten WORKERFS. It opens offline storage with download flags disabled.
The resource API accepts replay model, texture, effect, icon, DB2 and selected
raid environment references. Terrain, WMO buildings, placed models and tactical
minimap data are read locally. The four native fonts, class and raid-marker atlases,
tooltip textures, and authored sky and liquid textures are local inputs too.
Illustrated world-map artwork and the unused stock login and avatar HUD programs
are excluded. The original native planner UI runs on an owned root and tooltip
bootstrap through the existing Lua loader.

Client bytes and converted assets remain in browser memory or the origin-private
filesystem. Each converted-cache generation includes the client build key and
the converter revision. Cache entries include a content hash. Incomplete or
damaged entries are misses; unavailable storage does not prevent conversion.
Callers can abort selection preparation, directory enumeration, archive opening
and subsequent reads through an `AbortSignal`.

Chrome can refuse a persistent `showDirectoryPicker` grant for an installation
under `/Applications`. The standard directory file input was verified with that
installation. Chrome calls its confirmation an upload, but this implementation
passes the files to a local worker and does not send them to an HTTP server.

## Converter and renderer boundary

The worker loads Pyodide only when a model or catalog needs conversion. It reuses
the existing pure Python adapters for models, creature metadata, items and spell
visual graphs. It prepares the first model skin profile and does not prepare
unused LOD profiles. All client resource reads remain offline CASC reads.

`pullfiction-asset-codec` exposes the existing Rust renderer parsers independently
of the game bootstrap. It can validate converted model batches, animation clips,
bones, particles and attachments, and decode BLP2 textures. It starts no game,
stock UI, terrain streaming or network connection.

The static build runs the original planner application: `viewer.rs`, `WorldPlugins`,
`GamePlugins`, the camera, replay systems, native raid frames, and native nameplates.
React continues to own the editor panels and timelines. Hosting changes the asset
reader and startup preparation, rather than selecting a replacement scene or UI.

The editor installs one process-wide local file provider before startup. Original
synchronous `Chain` reads use prepared bytes. The asynchronous `MpqAssetReader`
streams through the same provider. Unprepared files, missing files, and conversion
failures remain distinct; a partial cache is never advertised as a complete archive
index. The local provider has no game-data HTTP fallback.

Modern DB2 adapters construct the original map, area, creature, item, spell, lighting,
and character catalog types. The original renderers and samplers consume them.
NPC object scale includes the client's model and display scales once, as required
by the original renderer's `OBJECT_FIELD_SCALE_X` contract. An explicit final
object scale in an imported replay remains unchanged.
The owned UI bootstrap skips the hidden stock login and HUD startup while retaining
the original world-entry lifecycle, text and quad passes, input, saved bindings,
raid and nameplate scripts, and tooltip builder.

The world converter reuses the modern file-ID and split-terrain adapters.
Geometry, textures, buildings and placed models are requested as needed for the
selected raid. The tactical view uses local minimap tiles when available and
actual floor geometry otherwise. Its coordinates and floor heights remain in
the same yard-based world space as the 3D view. Illustrated world-map artwork
is not required for either view. None of these client resources enter the
published package.

Modern WMO minimaps resolve their group/grid coordinates through
`WMOMinimapTexture.db2`. This retains the original map layout when the client
omits the old filename translation table. MC's 58 tiles match every original
area/cell key and corner coordinate. Modern `MPY2` triangle metadata and extended
batch material fields are converted only when the original format can represent
their meaning; invalid or conflicting records fail explicitly.

Animated M2 batches use separate material instances, sampling authored alpha,
texture translation/rotation/scale and tint tracks on the rig's replay clock.
Paused playback keeps that clock fixed. Removing an instance releases its
material-animation table slots. This shares the renderer's existing track
samplers and material table rather than introducing a separate effects format.

Successful parsing establishes the conversion boundary. It does not establish
rendered character appearance, gear or spell fidelity; those require browser
acceptance of the combined application.

## Installed products and replay versions

Era and SoD are replay rulesets. The selected client build is an independent
asset source, and both the build key and converter revision separate its cache.
The supported asset adapter currently targets Classic 1.15.9.

Installing WoW Forever can leave both application directories and the shared
Classic archive data present while replacing the root `.build.info` product row
with `wowf`. If no active Classic row exists, the reader checks the selected
local CASC configs for a retained Classic 1.15.9 build. It opens that real build
through an in-memory metadata view. It never rewrites the installation or
downloads missing archives, and rejects ambiguous build selection.

This path was checked against retained Classic build 1.15.9.70576 after Forever
1.60.1.70634 was installed. Reading a retained Classic build does not establish
support for Forever's 1.60 model and table formats.

An isolated browser POC opens the actual `wowf` 1.60.1.70634 and 1.60.1.70658 archives through
File/Blob and WORKERFS. Readable table bytes match independent native archive
reads. The shared adapter also converts verified version-272 embedded camera
layouts, with actual BogBeast, Centaur, and Qiraji Prophet models accepted by the
original WASM model decoder. Unvalidated version-272 particle layouts and external
skeleton or animation files still fail explicitly.

The shared reader now accepts an explicit `wowf` profile and keeps its cache
separate from Classic. It reads available WDC5 sections by exact offline ranges.
Coverage includes omitted section counts; encrypted holes never become zeroes
or invented rows. Partial table inspection is uncached and retried on each request.
Whole-file encryption errors do not imply that every record is unavailable.

In build 1.60.1.70658, the browser resolves 73 maps, including all four new leveling
dungeons, 14,204 creature displays, 31,948 spell names, and 31,850 items. Counts
include copy rows except where the table has none. The same converter resolves
WDT files through actual Map FileDataIDs rather than a dungeon-name allowlist.
See [Forever client readiness](FOREVER-CLIENT.md) for the API, measured coverage,
and remaining integration work. The main application still selects Classic by
default. These data-path checks do not establish full Forever scene support.

## Modern character appearance

`classic_characters.py` resolves race/body models, customization choices, geoset
visibility, atlas sizes and texture FileDataIDs through the installed modern DB2
tables. It requires no `CharSections` data or older client. The graph traversal
and blending reference is pinned wow.export source with its MIT attribution.

The browser worker decodes the selected BLP textures through the existing Rust
codec and composes the body and extra-skin atlases with their authored dimensions,
placement and blend modes. Hair uses its source texture directly. The worker
reads only the model's selected skin profile and the selected appearance's texture
dependencies. Geometry, texture decoding and composition stay on the user's device.

The client's `ChrCustomizationConversion` table maps recorded skin, face, hair style,
hair colour, and facial-feature bytes to modern choice IDs. Unrecorded choices use
valid client defaults. The adapter does not recover information absent from the log.

The original character geoset selector reads modern hair, facial-hair, and helmet
metadata through its existing catalog interfaces. The planner does not substitute
the standalone recipe's visibility heuristic for that selector. A prepared body
atlas enters the original compositor as a base-only plan at its authored dimensions.
Hair and extra-skin aliases follow actual material usage; bald hair keeps the
original variation-1 fallback. Derived BLP2 textures include a full mip ladder.

Recorded body equipment is resolved by its display IDs. NPC bake material references
resolve to local texture FileDataIDs, which the original baked-NPC texture loader
reads through aliases. NPC equipment attachments and additional modern-only visual
features remain separate compatibility work. Requirement-gated choices and advanced
customization types remain explicit unsupported cases.

The native integration checks resolve models and texture dependencies for all
16 playable race/body combinations. An isolated browser check on client
1.15.9.70576 generated the female gnome's 512px body atlas and hair texture in
about 1.27 seconds, including converter startup. This establishes browser-local
appearance preparation, not complete rendered character or equipment fidelity.

Replay preparation fills the required body, hair, extra-skin, creature skin, and
NPC bake bytes before installing actors. This avoids the original compositor's
permanent missing-atlas cache. Helm, shoulder, and weapon attachment rendering
continues through the original client code. Native checks cover the data boundary;
complete equipment and effects fidelity still requires browser comparison.

Modern lighting retains the original interpolation and sampling algorithms.
The modern tables omit the old separate underwater profile links. An explicit
adapter policy uses the corresponding surface profile in those slots; this is
a fallback, not recovered underwater data. Sounds and unsupported procedural
effect primitives are not established by the visual catalog adapter.

`SpellName.db2` supplies actual client names, including spells without a visual
record. Native cast and aura icons use the selected client's spell icon
FileDataIDs. WCL icon filenames remain in the untouched raw replay export;
prepared replay metadata supplies local aliases to the existing UI consumers.

The [browser log adapter](BROWSER-LOGS.md) is connected to the editor's import
flow. Local replay JSON works without OAuth configuration. Browser authorization
requires a registered public client and remains unverified with the live service.

Combat logs identify NPC entries rather than model displays. The permitted
prefetched Wowhead index contains names and numeric display references only.
Each candidate must also exist in the selected local creature catalog. Missing
entries remain unresolved; they do not trigger scraping or remote art downloads.
See [the source and coverage record](../third_party/wowhead-npcs/SOURCE.md).

## Cloudflare packaging constraints

The browser modules use relative, same-origin URLs for application code.
Their generated output contains no game resources. The converter build copies
an explicit set of runtime files, application adapter sources and community
format definitions with their license notices.

Keep the final static release output separate from `web/dist`, which currently
contains extracted game resources and old bundles. The isolated proof directory
also contains developer checks and reference hashes; do not publish it as the
application. Cloudflare's current single-file limit is 25 MiB. The new archive
reader, codec, interpreter and standard-library files each fit below that limit.

## Verify the foundation locally

Developer tools are required to build these modules. End users do not install
them. Use the existing pinned CascLib checkout from `scripts/classic-setup.sh`.
Install and activate Emscripten 6.0.13 in `.agent/tools/emsdk`, then prepare the
browser converter runtime:

```sh
npm install --prefix .agent/tools/browser-converter --ignore-scripts --no-audit --no-fund pyodide@314.0.7
bash scripts/browser-assets-build.sh
bash scripts/browser-codec-build.sh
node --test web/archive/*.test.mjs
python3 scripts/classic-characters-test.py
```

Both build scripts default to `.agent/work/browser-assets/dist`. They do not
modify `web/dist`, start the editor or deploy anything. The isolated browser
proof is `web/archive/proof.html`. Its `expected.json` and
`expected-models.json` inputs contain reference hashes generated from the
developer's own installation and are not shipped with the application.
