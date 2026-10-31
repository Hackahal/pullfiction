# Modern model and terrain material references

Packed M2 shader selection, sample arity, and material equations follow the MIT-licensed
[noclip.website](https://github.com/magcius/noclip.website/tree/e47a8cc8a9fe16e83adc0bf19153ff04c666ceca)
revision `e47a8cc8a9fe16e83adc0bf19153ff04c666ceca`, specifically
`rust/src/wow/skin.rs` and `src/WorldOfWarcraft/program.ts`.

Static M2 shader selection also uses `STATIC_SHADERS` at that revision. The selected
OpaqueMod2xNAAlpha, OpaqueAddAlphaAlpha, ModAddAlpha, OpaqueAddAlphaWgt,
ModAddAlphaWgt, OpaqueModNAAlpha and OpaqueAlpha equations retain their authored alpha masks and
reflection weights. The second transparency lookup has its own animation curve;
a zero reflection weight does not hide the base model.

The modern WMO shader table and Diffuse, Specular, Env, Opaque and LOD equations also
follow `rust/src/wow/wmo.rs` and `src/WorldOfWarcraft/program.ts` at that revision.
Terrain MCCV uses `rust/src/wow/adt.rs` and `TerrainProgram` in `program.ts`: source
BGRA bytes become RGB/255, then multiply diffuse color by two. Absent MCCV keeps
Pull Fiction's original terrain path unchanged. The authored MCCV alpha does not
replace terrain opacity.

Pull Fiction implements its own adapter, typed material channels, sequence clocks and WGSL
integration. The original copyright, MIT permission notice and upstream reverse-engineering
note are retained in `LICENSE`. No extracted client assets are included.
