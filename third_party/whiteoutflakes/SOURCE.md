# WhiteoutFlakes particle references

Derived portions of the modern multi-texture particle adapter, UV expansion and fragment combiner use WhiteoutFlakes by Fernando Sahmkow, under BSD-3-Clause. The full license is retained in LICENSE.

Source: https://github.com/FernandoS27/WhiteoutFlakes/tree/d2756ce11e0bbb5dac43b97ea5cf1627d53a402b

Pinned implementation references:

- `src/io/m2/m2_model_adapter.cpp`: unsigned 3.5 UV scales and sign-magnitude 6.9 scroll values.
- `src/io/m2/m2_animation.cpp`: compressed gravity direction, signed magnitude and decoding before interpolation.
- `src/renderer/particle/base/particle2_emitter.cpp`: independent layer origins and correlated U/V scroll variation.
- `src/renderer/particle/base/particle2_emitter.cpp`, `Emitter2::ApplyAnimated`: world-stored force scaling and model-stored acceleration units.
- `src/renderer/particle/output/particle_geometry.cpp`: extra-layer UV construction.
- `src/renderer/shaders/particle_multitex.slang`: separate color-stage and alpha Mod2/Mod4 products.

The upstream AI-derived works notice confirms that derived code retains the BSD copyright, conditions and disclaimer. Original game files and downloaded research snapshots are not distributed here.
