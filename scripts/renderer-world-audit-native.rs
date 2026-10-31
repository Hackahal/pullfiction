//! Framed stdin probe for renderer-world-audit.py using production format consumers.
//! No assets are written or rendered. Compile against the parent's fresh matching rlibs.
use std::io::{self, Read, Write};

fn inspect(bytes: &[u8]) -> Result<serde_json::Value, String> {
    let (&kind, data) = bytes.split_first().ok_or("empty world probe frame")?;
    match kind {
        b'A' => {
            let tile =
                benilla_formats::adt_to_tile_mesh(data).map_err(|e| format!("terrain: {e:#}"))?;
            let mut colored = 0;
            let mut holes = 0;
            let mut indices = 0;
            for chunk in &tile.chunks {
                if chunk.positions.len() != 145
                    || chunk
                        .indices
                        .iter()
                        .any(|&i| i as usize >= chunk.positions.len())
                    || chunk.positions.iter().flatten().any(|v| !v.is_finite())
                    || chunk.normals.iter().flatten().any(|v| !v.is_finite())
                    || chunk.vertex_colors.iter().flatten().any(|v| !v.is_finite())
                    || (!chunk.vertex_colors.is_empty() && chunk.vertex_colors.len() != 145)
                    || chunk.indices.len() != (64 - chunk.holes.count_ones() as usize) * 12
                {
                    return Err("terrain mesh/attribute/index/hole invariant failed".into());
                }
                for row in 0..8 {
                    for col in 0..8 {
                        let center = chunk.positions[row * 17 + 9 + col];
                        let height = chunk.height_at(center);
                        if chunk.holes & (1u64 << (row * 8 + col)) != 0 {
                            if height.is_some() {
                                return Err("holed terrain retained height-query surface".into());
                            }
                        } else if height
                            .is_none_or(|v| !v.is_finite() || (v - center[2]).abs() > 0.05)
                        {
                            return Err(
                                "terrain center height differs from drawn center vertex".into()
                            );
                        }
                    }
                }
                colored += usize::from(!chunk.vertex_colors.is_empty());
                holes += chunk.holes.count_ones();
                indices += chunk.indices.len();
            }
            Ok(
                serde_json::json!({"status":"decoded", "kind":"terrain", "chunks":tile.chunks.len(),
                "indices":indices,"coloredChunks":colored,"holedCells":holes,
                "proofBoundary":"Production native terrain mesh/height consumer only; GPU/runtime/visual unverified"}),
            )
        }
        b'R' => {
            let root = benilla_formats::parse_wmo_root(data).map_err(|e| format!("root: {e:#}"))?;
            Ok(
                serde_json::json!({"status":"decoded","kind":"wmo-root","groups":root.group_count(),
                "proofBoundary":"Production native root decoding only; GPU/runtime/visual unverified"}),
            )
        }
        b'G' => {
            let prefix: [u8; 4] = data
                .get(..4)
                .ok_or("missing group root size")?
                .try_into()
                .unwrap();
            let size = u32::from_le_bytes(prefix) as usize;
            let root_data = data.get(4..4 + size).ok_or("group root exceeds frame")?;
            let group_data = data.get(4 + size..).ok_or("group data exceeds frame")?;
            let root = benilla_formats::parse_wmo_root(root_data)
                .map_err(|e| format!("group root: {e:#}"))?;
            let meshes = benilla_formats::wmo_group_submeshes(group_data, &root)
                .map_err(|e| format!("group: {e:#}"))?;
            for mesh in &meshes {
                if mesh
                    .indices
                    .iter()
                    .any(|&i| i as usize >= mesh.positions.len())
                    || mesh.positions.iter().flatten().any(|v| !v.is_finite())
                    || mesh.uvs.len() != mesh.positions.len()
                    || mesh.uvs.iter().flatten().any(|v| !v.is_finite())
                    || (!mesh.normals.is_empty() && mesh.normals.len() != mesh.positions.len())
                {
                    return Err("WMO render-submesh invariant failed".into());
                }
            }
            let liquid = benilla_formats::wmo_group_liquid_mesh(group_data);
            Ok(
                serde_json::json!({"status":"decoded","kind":"wmo-group","batches":meshes.len(),
                "vertices":meshes.iter().map(|m|m.positions.len()).sum::<usize>(),
                "indices":meshes.iter().map(|m|m.indices.len()).sum::<usize>(),
                "emptyDraw":meshes.is_empty(),"liquid":liquid.is_some(),
                "proofBoundary":"Production native RenderSubmesh consumer only; GPU/material binding/PVS/visual unverified"}),
            )
        }
        _ => Err("unknown world probe frame kind".into()),
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
            return Err(io::Error::other("world probe frame exceeds limit"));
        }
        let mut bytes = vec![0u8; size];
        input.read_exact(&mut bytes)?;
        let report = match std::panic::catch_unwind(|| inspect(&bytes)) {
            Ok(Ok(report)) => report,
            Ok(Err(error)) => serde_json::json!({"status":"decode-error","error":error}),
            Err(_) => {
                serde_json::json!({"status":"panic","error":"production world reader panicked"})
            }
        };
        writeln!(output, "{report}")?;
        output.flush()?;
    }
    Ok(())
}
