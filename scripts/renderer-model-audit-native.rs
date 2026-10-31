//! Framed stdin probe for renderer-model-audit.py; links the production format readers.
//! No assets are written, rendered or uploaded. Parent build supplies matching rlibs.
use std::io::{self, Read, Write};

#[cfg(not(texture_audit))]
fn inspect_model(bytes: &[u8]) -> Result<serde_json::Value, String> {
    let meshes = benilla_formats::parse_m2_render_submeshes(bytes, "", &[])
        .map_err(|e| format!("mesh: {e:#}"))?;
    let skeleton =
        benilla_formats::parse_m2_skeleton(bytes).map_err(|e| format!("skeleton: {e:#}"))?;
    let particles = benilla_formats::parse_m2_particle_emitters(bytes)
        .map_err(|e| format!("particles: {e:#}"))?;
    let ribbons =
        benilla_formats::parse_m2_ribbon_emitters(bytes).map_err(|e| format!("ribbons: {e:#}"))?;
    let attachments =
        benilla_formats::parse_m2_attachments(bytes).map_err(|e| format!("attachments: {e:#}"))?;
    let animations = benilla_formats::parse_m2_animations(bytes);
    let stage_combiners: Vec<_> = meshes
        .iter()
        .filter_map(|s| s.stage1.as_ref().map(|s| s.combine))
        .collect();
    let stage_weights: Vec<_> = meshes.iter().filter_map(|s| s.stage1.as_ref()?.uv.as_ref()?.weight.as_ref())
        .map(|a| serde_json::json!({"samples":[a.sample(None,0.0,0.0),a.sample(None,0.5,0.5),a.sample(None,1.0,1.0)],
            "keys":a.seq(None).weight.as_ref().map(|w| &w.keys)})).collect();
    let mut texture_paths = std::collections::BTreeSet::new();
    for mesh in &meshes {
        if let Some(path) = &mesh.texture {
            texture_paths.insert(path.clone());
        }
        if let Some(stage) = &mesh.stage1 {
            if let Some(path) = &stage.texture {
                texture_paths.insert(path.clone());
            }
            if let Some(path) = stage
                .third_texture
                .as_ref()
                .and_then(|s| s.texture.as_ref())
            {
                texture_paths.insert(path.clone());
            }
        }
    }
    Ok(
        serde_json::json!({"status":"decoded", "batches":meshes.len(),
        "bones":skeleton.bones.len(), "particles":particles.len(), "ribbons":ribbons.len(),
        "attachments":attachments.len(), "animations":animations.len(),
        "stageCombiners":stage_combiners, "stageWeights":stage_weights,
        "texturePaths":texture_paths,
        "proofBoundary":"Production native decoding only; GPU/lifecycle/visual state unverified"}),
    )
}

fn inspect_texture(bytes: &[u8]) -> Result<serde_json::Value, String> {
    // Exercise both production paths: authored native blocks for upload and
    // actual RGBA expansion used by compositing. Never retain or emit pixels.
    let native = benilla_blp::decode_native(bytes).map_err(|e| format!("native BLP: {e}"))?;
    let rgba = benilla_blp::decode(bytes).map_err(|e| format!("RGBA BLP: {e}"))?;
    if native.width == 0
        || native.height == 0
        || native.mips.is_empty()
        || native.width != rgba.width
        || native.height != rgba.height
        || native.mips.len() != rgba.mips.len()
    {
        return Err("BLP decoder dimensions or mip counts disagree".into());
    }
    let mut rgba_bytes = 0usize;
    let mut native_bytes = 0usize;
    for (index, (blocks, pixels)) in native.mips.iter().zip(&rgba.mips).enumerate() {
        if blocks.width != pixels.width
            || blocks.height != pixels.height
            || blocks.bytes.len() != native.texels.level_bytes(blocks.width, blocks.height)
            || pixels.rgba.len() != pixels.width as usize * pixels.height as usize * 4
        {
            return Err(format!(
                "BLP decoder mip {index} has inconsistent dimensions or bytes"
            ));
        }
        rgba_bytes += pixels.rgba.len();
        native_bytes += blocks.bytes.len();
    }
    Ok(
        serde_json::json!({"status":"decoded", "assetType":"texture",
        "width":rgba.width, "height":rgba.height, "mips":rgba.mips.len(),
        "nativeTexels":format!("{:?}", native.texels),
        "nativeBytes":native_bytes, "rgbaBytes":rgba_bytes,
        "firstPixel":&rgba.mips[0].rgba[..4],
        "proofBoundary":"Production native-block parsing and CPU RGBA decoding; GPU sampling and visual state unverified"}),
    )
}

fn inspect(bytes: &[u8]) -> Result<serde_json::Value, String> {
    if bytes.starts_with(b"BLP2") {
        return inspect_texture(bytes);
    }
    #[cfg(not(texture_audit))]
    {
        inspect_model(bytes)
    }
    #[cfg(texture_audit)]
    {
        Err("not a BLP2 texture".into())
    }
}

fn main() -> io::Result<()> {
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    loop {
        let mut size = [0u8; 4];
        match input.read_exact(&mut size) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(e),
        }
        let size = u32::from_le_bytes(size) as usize;
        if size > 256 * 1024 * 1024 {
            return Err(io::Error::other("asset exceeds probe limit"));
        }
        let mut bytes = vec![0u8; size];
        input.read_exact(&mut bytes)?;
        let result = std::panic::catch_unwind(|| inspect(&bytes));
        let report = match result {
            Ok(Ok(report)) => report,
            Ok(Err(error)) => serde_json::json!({"status":"decode-error","error":error}),
            Err(_) => {
                serde_json::json!({"status":"panic","error":"production asset reader panicked"})
            }
        };
        writeln!(output, "{report}")?;
        output.flush()?;
    }
    Ok(())
}
