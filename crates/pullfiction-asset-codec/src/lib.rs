//! The existing renderer's binary decoders, independent of a legacy game installation.
use wasm_bindgen::prelude::*;

const MAX_MODEL_BYTES: usize = 128 * 1024 * 1024;

fn model_summary(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > MAX_MODEL_BYTES {
        return Err("Model exceeds the replay resource limit".into());
    }
    let meshes = benilla_formats::parse_m2_render_submeshes(bytes, "", &[])
        .map_err(|error| error.to_string())?;
    let skeleton = benilla_formats::parse_m2_skeleton(bytes).map_err(|error| error.to_string())?;
    let clips = benilla_formats::parse_m2_animations(bytes);
    let particles =
        benilla_formats::parse_m2_particle_emitters(bytes).map_err(|error| error.to_string())?;
    let attachments =
        benilla_formats::parse_m2_attachments(bytes).map_err(|error| error.to_string())?;
    let textures: std::collections::BTreeSet<_> = meshes
        .iter()
        .flat_map(|mesh| {
            [
                mesh.texture.as_deref(),
                mesh.stage1
                    .as_ref()
                    .and_then(|stage| stage.texture.as_deref()),
            ]
            .into_iter()
            .flatten()
        })
        .collect();
    Ok(serde_json::json!({
        "batches": meshes.len(),
        "vertices": meshes.iter().map(|mesh| mesh.positions.len()).sum::<usize>(),
        "triangles": meshes.iter().map(|mesh| mesh.indices.len() / 3).sum::<usize>(),
        "bones": skeleton.bones.len(),
        "clips": clips.len(),
        "particles": particles.len(),
        "attachments": attachments.len(),
        "textures": textures,
    })
    .to_string())
}

#[wasm_bindgen]
pub fn inspect_model(bytes: &[u8]) -> Result<String, JsValue> {
    model_summary(bytes).map_err(|error| JsValue::from_str(&error))
}

#[wasm_bindgen]
pub struct Texture {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

#[wasm_bindgen]
impl Texture {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }
    pub fn pixels(&self) -> Vec<u8> {
        self.pixels.clone()
    }

    pub fn blend(
        &mut self,
        source: &Texture,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        mode: u8,
    ) -> Result<(), JsValue> {
        blend_texture(self, source, [x, y, width, height], mode)
            .map_err(|error| JsValue::from_str(&error))
    }
}

fn empty_atlas(width: u32, height: u32) -> Result<Texture, String> {
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 4096 * 4096 {
        return Err("Invalid character atlas dimensions".into());
    }
    // CharMaterialRenderer.clearCanvas clears to opaque black before applying
    // authored texture targets. Preserve straight rather than premultiplied RGB.
    let pixels = [0, 0, 0, 255].repeat((width * height) as usize);
    Ok(Texture {
        width,
        height,
        pixels,
    })
}

#[wasm_bindgen]
pub fn character_atlas(width: u32, height: u32) -> Result<Texture, JsValue> {
    empty_atlas(width, height).map_err(|error| JsValue::from_str(&error))
}

fn blend_texture(
    target: &mut Texture,
    source: &Texture,
    rect: [u32; 4],
    mode: u8,
) -> Result<(), String> {
    let [x, y, width, height] = rect;
    if width == 0
        || height == 0
        || u64::from(x) + u64::from(width) > u64::from(target.width)
        || u64::from(y) + u64::from(height) > u64::from(target.height)
        || source.width == 0
        || source.height == 0
    {
        return Err("Character texture layer exceeds its atlas".into());
    }
    if ![0, 1, 4, 6, 7, 9, 15].contains(&mode) {
        return Err(format!("Unsupported character texture blend mode {mode}"));
    }
    let linear = source.width <= width && source.height <= height;
    for row in 0..height {
        for column in 0..width {
            let sx = (column as f32 + 0.5) * source.width as f32 / width as f32 - 0.5;
            let sy = (row as f32 + 0.5) * source.height as f32 / height as f32 - 0.5;
            let mut sample = [0.; 4];
            for (channel, value) in sample.iter_mut().enumerate() {
                let pixel = |px: f32, py: f32| {
                    let px = px.clamp(0., (source.width - 1) as f32) as usize;
                    let py = py.clamp(0., (source.height - 1) as f32) as usize;
                    f32::from(source.pixels[(py * source.width as usize + px) * 4 + channel]) / 255.
                };
                *value = if linear {
                    let (x0, y0) = (sx.floor(), sy.floor());
                    let (a, b) = (sx - x0, sy - y0);
                    pixel(x0, y0) * (1. - a) * (1. - b)
                        + pixel(x0 + 1., y0) * a * (1. - b)
                        + pixel(x0, y0 + 1.) * (1. - a) * b
                        + pixel(x0 + 1., y0 + 1.) * a * b
                } else {
                    pixel(sx.round(), sy.round())
                };
            }
            let at = (((y + row) * target.width + x + column) * 4) as usize;
            let base: [f32; 4] = std::array::from_fn(|i| f32::from(target.pixels[at + i]) / 255.);
            let mut fragment = sample;
            for i in 0..3 {
                fragment[i] = match mode {
                    4 => base[i] * sample[i],
                    6 if sample[i] < 0.5 => 2. * base[i] * sample[i],
                    6 => 1. - 2. * (1. - base[i]) * (1. - sample[i]),
                    7 => 1. - (1. - base[i]) * (1. - sample[i]),
                    _ => sample[i],
                };
            }
            if mode == 4 {
                fragment[3] = base[3] * sample[3];
            }
            for i in 0..4 {
                let value = if mode <= 1 {
                    fragment[i]
                } else if i == 3 && mode == 9 {
                    fragment[3] + base[3] * (1. - fragment[3])
                } else {
                    fragment[i] * fragment[3] + base[i] * (1. - fragment[3])
                };
                target.pixels[at + i] = (value.clamp(0., 1.) * 255.).round() as u8;
            }
        }
    }
    Ok(())
}

#[wasm_bindgen]
pub fn decode_texture(bytes: &[u8]) -> Result<Texture, JsValue> {
    let dimensions = bytes.get(12..20).and_then(|value| {
        let width = u32::from_le_bytes(value[..4].try_into().ok()?);
        let height = u32::from_le_bytes(value[4..].try_into().ok()?);
        Some((width, height))
    });
    if !bytes.starts_with(b"BLP2")
        || bytes.len() > MAX_MODEL_BYTES
        || !dimensions.is_some_and(|(width, height)| {
            width > 0 && height > 0 && u64::from(width) * u64::from(height) <= 4096 * 4096
        })
    {
        return Err(JsValue::from_str("Invalid or oversized modern BLP texture"));
    }
    benilla_formats::blp_to_rgba(bytes)
        .map(|(width, height, pixels)| Texture {
            width,
            height,
            pixels,
        })
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

#[cfg(test)]
mod tests {
    #[test]
    fn rejects_an_unconverted_or_truncated_model() {
        assert!(super::model_summary(b"MD21").is_err());
        assert!(super::model_summary(b"MD20").is_err());
    }

    #[test]
    fn atlas_blit_preserves_straight_color_and_alpha() {
        let mut atlas = super::empty_atlas(2, 1).unwrap();
        let source = super::Texture {
            width: 1,
            height: 1,
            pixels: vec![200, 100, 50, 128],
        };
        super::blend_texture(&mut atlas, &source, [1, 0, 1, 1], 1).unwrap();
        assert_eq!(atlas.pixels, [0, 0, 0, 255, 200, 100, 50, 128]);
        assert!(super::blend_texture(&mut atlas, &source, [2, 0, 1, 1], 1).is_err());
    }

    #[test]
    fn authored_alpha_modes_keep_their_distinct_alpha_equations() {
        let source = super::Texture {
            width: 1,
            height: 1,
            pixels: vec![255, 0, 0, 128],
        };
        let mut infer = super::empty_atlas(1, 1).unwrap();
        let mut straight = super::empty_atlas(1, 1).unwrap();
        super::blend_texture(&mut infer, &source, [0, 0, 1, 1], 15).unwrap();
        super::blend_texture(&mut straight, &source, [0, 0, 1, 1], 9).unwrap();
        assert_eq!(&infer.pixels[..3], &straight.pixels[..3]);
        assert_eq!(infer.pixels[3], 191);
        assert_eq!(straight.pixels[3], 255);
    }
}
