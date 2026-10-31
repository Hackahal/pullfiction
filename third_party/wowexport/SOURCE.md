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

Modern packed M2 combiners additionally reference `src/js/3D/ShaderMapper.js`,
`src/shaders/m2.fragment.shader` and `src/shaders/m2.vertex.shader` at that revision.
The native renderer keeps the selected shader's sample arity, independent texture transforms,
and pre-light diffuse versus post-light additive terms.

Attribution and license are retained in `LICENSE`. No extracted client assets
or reference application assets are included.
