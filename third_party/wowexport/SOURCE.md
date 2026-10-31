# Character appearance reference

The modern appearance relationship traversal and atlas blending follow
[wow.export](https://github.com/Kruithne/wow.export/tree/c2fd7bde36a712be78a5da896c995b84fbfa2545),
revision `c2fd7bde36a712be78a5da896c995b84fbfa2545`.

The relevant MIT-licensed source files are `src/js/db/caches/DBCharacterCustomization.js`,
`src/js/ui/character-appearance.js`, `src/js/3D/renderers/CharMaterialRenderer.js`
and `src/shaders/char.fragment.shader`. Equipment relationships, geoset mappings,
texture priorities, and replaceable texture slots also use `src/js/wow/EquipmentSlots.js`,
`src/js/db/caches/DBItemGeosets.js`, `DBItemModels.js`, `DBItemCharTextures.js`,
`DBComponentModelFileData.js`, and `src/js/3D/renderers/M2RendererGL.js` at the same revision.
Pull Fiction implements its own local DB2 adapter and Rust/WASM atlas compositor
around the existing asset decoders.

Attribution and license are retained in `LICENSE`. No extracted client assets
or reference application assets are included.
