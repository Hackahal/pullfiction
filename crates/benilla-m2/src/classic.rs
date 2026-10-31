//! Classic Era 1.15.9 MD21 models, kept separate from the original MD20 reader.
//!
//! Modern tracks contain one array per sequence, use compressed bone quaternions,
//! and reference external SKIN files. The caller supplies the selected skin bytes.
//! This reader does not pretend modern effects or external skeletons are vanilla data.

use benilla_bytes::ByteExt;

#[derive(Debug)]
pub struct ClassicError(pub &'static str);
impl std::fmt::Display for ClassicError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for ClassicError {}
type Result<T> = std::result::Result<T, ClassicError>;

fn u32_at(b: &[u8], p: usize) -> Result<u32> {
    b.u32_at(p).ok_or(ClassicError("truncated Classic model"))
}
fn slice(b: &[u8], offset: usize, size: usize) -> Result<&[u8]> {
    b.bytes_at(offset, size)
        .ok_or(ClassicError("Classic model array exceeds file"))
}
fn array(b: &[u8], p: usize, stride: usize) -> Result<&[u8]> {
    let count = u32_at(b, p)? as usize;
    let offset = u32_at(b, p + 4)? as usize;
    let size = count
        .checked_mul(stride)
        .ok_or(ClassicError("Classic array overflow"))?;
    slice(b, offset, size)
}
fn vec3(b: &[u8], p: usize) -> Result<[f32; 3]> {
    let value = [b.f32_at(p), b.f32_at(p + 4), b.f32_at(p + 8)];
    match value {
        [Some(x), Some(y), Some(z)] if x.is_finite() && y.is_finite() && z.is_finite() => {
            Ok([x, y, z])
        }
        _ => Err(ClassicError("invalid Classic vector")),
    }
}
fn file_ids(b: &[u8]) -> Result<Vec<u32>> {
    if !b.len().is_multiple_of(4) {
        return Err(ClassicError("invalid Classic file ID array"));
    }
    Ok(b.chunks_exact(4)
        .map(|v| u32::from_le_bytes(v.try_into().unwrap()))
        .collect())
}

/// Per-sequence keys use local milliseconds. Global-sequence tracks use their own clock.
#[derive(Debug)]
pub struct ClassicTrack<T> {
    pub interpolation: u16,
    pub global_sequence: i16,
    pub sequences: Vec<Vec<(u32, T)>>,
}
fn track<T>(
    b: &[u8],
    p: usize,
    stride: usize,
    read: impl Fn(&[u8], usize) -> Result<T>,
) -> Result<ClassicTrack<T>> {
    let interpolation = b.u16_at(p).ok_or(ClassicError("truncated Classic track"))?;
    let global_sequence = b
        .u16_at(p + 2)
        .ok_or(ClassicError("truncated Classic track"))? as i16;
    // Cubic tracks have triple-wide values; reject rather than misreading their stride.
    if interpolation > 1 {
        return Err(ClassicError(
            "cubic Classic bone tracks require a spline reader",
        ));
    }
    let timestamps = array(b, p + 4, 8)?;
    let values = array(b, p + 12, 8)?;
    if timestamps.len() != values.len() {
        return Err(ClassicError("Classic track sequence count mismatch"));
    }
    let mut sequences = Vec::with_capacity(timestamps.len() / 8);
    for (times, keys) in timestamps.chunks_exact(8).zip(values.chunks_exact(8)) {
        let count = u32_at(times, 0)? as usize;
        if count != u32_at(keys, 0)? as usize {
            return Err(ClassicError("Classic track key count mismatch"));
        }
        let times = slice(
            b,
            u32_at(times, 4)? as usize,
            count
                .checked_mul(4)
                .ok_or(ClassicError("key count overflow"))?,
        )?;
        let key_offset = u32_at(keys, 4)? as usize;
        slice(
            b,
            key_offset,
            count
                .checked_mul(stride)
                .ok_or(ClassicError("key count overflow"))?,
        )?;
        let mut sequence = Vec::with_capacity(count);
        for (i, time) in times.chunks_exact(4).enumerate() {
            let time = u32_at(time, 0)?;
            if sequence
                .last()
                .is_some_and(|(previous, _)| *previous > time)
            {
                return Err(ClassicError("Classic timestamps are not ordered"));
            }
            sequence.push((time, read(b, key_offset + i * stride)?));
        }
        sequences.push(sequence);
    }
    Ok(ClassicTrack {
        interpolation,
        global_sequence,
        sequences,
    })
}
fn quaternion(b: &[u8], p: usize) -> Result<[f32; 4]> {
    let mut q = [0.0; 4];
    for (i, out) in q.iter_mut().enumerate() {
        let v = b
            .u16_at(p + i * 2)
            .ok_or(ClassicError("truncated compressed quaternion"))? as i16;
        *out = if v < 0 {
            f32::from(v) + 32768.0
        } else {
            f32::from(v) - 32767.0
        } / 32767.0;
    }
    Ok(q)
}

pub struct ClassicBone {
    pub key_bone: i32,
    pub flags: u32,
    pub parent: i16,
    pub pivot: [f32; 3],
    pub translation: ClassicTrack<[f32; 3]>,
    pub rotation: ClassicTrack<[f32; 4]>,
    pub scale: ClassicTrack<[f32; 3]>,
}
#[derive(Debug)]
pub struct ClassicSequence {
    pub id: u16,
    pub variation: u16,
    pub duration_ms: u32,
    pub flags: u32,
    pub alias: u16,
}
pub struct ClassicSkin {
    pub indices: Vec<u16>,
    pub triangles: Vec<u16>,
    pub sections: Vec<crate::SkinSection>,
    pub batches: Vec<crate::SkinBatch>,
}
/// Geometry and bone animation data. Effects/material animation integration is a separate gate.
pub struct ClassicModel {
    pub vertices: Vec<crate::M2Vertex>,
    pub bones: Vec<ClassicBone>,
    pub sequences: Vec<ClassicSequence>,
    pub skin_file_ids: Vec<u32>,
    pub texture_file_ids: Vec<u32>,
    pub texture_types: Vec<u32>,
    pub skin: ClassicSkin,
    pub particle_emitters: u32,
    pub ribbon_emitters: u32,
}

fn parse_skin(b: &[u8], vertex_count: usize) -> Result<ClassicSkin> {
    if b.get(..4) != Some(b"SKIN") {
        return Err(ClassicError("not an external SKIN file"));
    }
    let indices: Vec<u16> = array(b, 4, 2)?
        .chunks_exact(2)
        .map(|v| v.u16_at(0).unwrap())
        .collect();
    let triangles: Vec<u16> = array(b, 12, 2)?
        .chunks_exact(2)
        .map(|v| v.u16_at(0).unwrap())
        .collect();
    if !triangles.len().is_multiple_of(3)
        || indices.iter().any(|&v| usize::from(v) >= vertex_count)
        || triangles.iter().any(|&v| usize::from(v) >= indices.len())
    {
        return Err(ClassicError("SKIN indices exceed geometry"));
    }
    let mut sections = Vec::new();
    for s in array(b, 28, 48)?.chunks_exact(48) {
        // Elements remain u16; `level` extends the section's offset into that array.
        let start = u32::from(s.u16_at(8).unwrap()) | (u32::from(s.u16_at(2).unwrap()) << 16);
        let count = s.u16_at(10).unwrap();
        if u64::from(start) + u64::from(count) > triangles.len() as u64 {
            return Err(ClassicError("SKIN section exceeds triangle array"));
        }
        sections.push(crate::SkinSection {
            id: s.u16_at(0).unwrap(),
            triangle_start: start,
            triangle_count: count,
        });
    }
    let mut batches = Vec::new();
    for s in array(b, 36, 24)?.chunks_exact(24) {
        if usize::from(s.u16_at(4).unwrap()) >= sections.len() {
            return Err(ClassicError("SKIN batch refers to absent section"));
        }
        batches.push(crate::SkinBatch {
            flags: s.u16_at(0).unwrap(),
            shader_id: s.u16_at(2).unwrap(),
            skin_section_index: s.u16_at(4).unwrap(),
            color_index: s.u16_at(8).unwrap(),
            material_index: s.u16_at(10).unwrap(),
            texture_count: s.u16_at(14).unwrap(),
            texture_combo_index: s.u16_at(16).unwrap(),
            texture_coord_combo_index: s.u16_at(18).unwrap(),
            weight_combo_index: s.u16_at(20).unwrap(),
            texture_transform_combo_index: s.u16_at(22).unwrap(),
        });
    }
    Ok(ClassicSkin {
        indices,
        triangles,
        sections,
        batches,
    })
}

/// Decode version 274 with inline bones/animation and a caller-selected external skin.
/// External skeleton/animation files are explicitly rejected until that data path is wired.
pub fn parse_classic_model(data: &[u8], skin: &[u8]) -> Result<ClassicModel> {
    let mut parts = std::collections::HashMap::new();
    let mut p = 0usize;
    while p < data.len() {
        let tag: [u8; 4] = slice(data, p, 4)?.try_into().unwrap();
        let size = u32_at(data, p + 4)? as usize;
        let value = slice(data, p + 8, size)?;
        if parts.insert(tag, value).is_some() {
            return Err(ClassicError("duplicate Classic model chunk"));
        }
        p += 8 + size;
    }
    let b = *parts
        .get(b"MD21")
        .ok_or(ClassicError("not a chunked MD21 model"))?;
    if b.get(..4) != Some(b"MD20") || u32_at(b, 4)? != 274 {
        return Err(ClassicError("expected Classic model version 274"));
    }
    let skeleton_ids = file_ids(parts.get(b"SKID").copied().unwrap_or_default())?;
    let animation_ids = parts.get(b"AFID").copied().unwrap_or_default();
    if !animation_ids.len().is_multiple_of(8) {
        return Err(ClassicError("invalid external animation ID table"));
    }
    if skeleton_ids.iter().any(|&id| id != 0)
        || animation_ids
            .chunks_exact(8)
            .any(|record| record.u32_at(4).is_some_and(|id| id != 0))
    {
        return Err(ClassicError(
            "external Classic skeleton/animations are not wired yet",
        ));
    }
    let skin_file_ids = file_ids(parts.get(b"SFID").copied().unwrap_or_default())?;
    if skin_file_ids.len() < u32_at(b, 0x44)? as usize {
        return Err(ClassicError("missing external Classic skins"));
    }
    let texture_file_ids = file_ids(parts.get(b"TXID").copied().unwrap_or_default())?;
    let texture_types = array(b, 0x50, 16)?
        .chunks_exact(16)
        .map(|v| u32_at(v, 0))
        .collect::<Result<Vec<_>>>()?;
    if texture_file_ids.len() != texture_types.len() {
        return Err(ClassicError("Classic texture ID count mismatch"));
    }
    let mut vertices = Vec::new();
    for v in array(b, 0x3c, 48)?.chunks_exact(48) {
        let xyz = vec3(v, 0)?;
        let normal = vec3(v, 20)?;
        vertices.push(crate::M2Vertex {
            position: crate::C3 {
                x: xyz[0],
                y: xyz[1],
                z: xyz[2],
            },
            normal: crate::C3 {
                x: normal[0],
                y: normal[1],
                z: normal[2],
            },
            bone_weights: v[12..16].try_into().unwrap(),
            bone_indices: v[16..20].try_into().unwrap(),
            tex_coords: crate::C2 {
                x: v.f32_at(32).unwrap(),
                y: v.f32_at(36).unwrap(),
            },
        });
    }
    let mut sequences = Vec::new();
    for s in array(b, 0x1c, 64)?.chunks_exact(64) {
        sequences.push(ClassicSequence {
            id: s.u16_at(0).unwrap(),
            variation: s.u16_at(2).unwrap(),
            duration_ms: u32_at(s, 4)?,
            flags: u32_at(s, 12)?,
            alias: s.u16_at(62).unwrap(),
        });
    }
    let bone_records = array(b, 0x2c, 88)?;
    let mut bones = Vec::new();
    let offset = u32_at(b, 0x30)? as usize;
    for (i, record) in bone_records.chunks_exact(88).enumerate() {
        let base = offset + i * 88;
        let parent = record.u16_at(8).unwrap() as i16;
        if parent < -1 || parent >= (bone_records.len() / 88) as i16 || parent == i as i16 {
            return Err(ClassicError("invalid Classic bone parent"));
        }
        bones.push(ClassicBone {
            key_bone: u32_at(record, 0)? as i32,
            flags: u32_at(record, 4)?,
            parent,
            pivot: vec3(record, 76)?,
            translation: track(b, base + 16, 12, vec3)?,
            rotation: track(b, base + 36, 8, quaternion)?,
            scale: track(b, base + 56, 12, vec3)?,
        });
    }
    // Consumers walk parent chains. Reject cycles before handing them a rig.
    for start in 0..bones.len() {
        let mut current = start;
        let mut terminated = false;
        for _ in 0..=bones.len() {
            let parent = bones[current].parent;
            if parent < 0 {
                terminated = true;
                break;
            }
            current = parent as usize;
        }
        if !terminated {
            return Err(ClassicError("cyclic Classic bone hierarchy"));
        }
    }
    for start in 0..sequences.len() {
        let mut current = start;
        let mut terminated = false;
        for _ in 0..=sequences.len() {
            let sequence = sequences
                .get(current)
                .ok_or(ClassicError("invalid Classic animation alias"))?;
            if sequence.flags & 0x40 == 0 {
                terminated = true;
                break;
            }
            current = usize::from(sequence.alias);
        }
        if !terminated {
            return Err(ClassicError("cyclic Classic animation alias"));
        }
    }
    for v in &vertices {
        if v.bone_weights
            .iter()
            .zip(v.bone_indices)
            .any(|(&weight, index)| weight != 0 && usize::from(index) >= bones.len())
        {
            return Err(ClassicError("Classic vertex refers to absent bone"));
        }
    }
    Ok(ClassicModel {
        skin: parse_skin(skin, vertices.len())?,
        vertices,
        bones,
        sequences,
        skin_file_ids,
        texture_file_ids,
        texture_types,
        ribbon_emitters: u32_at(b, 0x120)?,
        particle_emitters: u32_at(b, 0x128)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn put(b: &mut [u8], p: usize, n: u32) {
        b[p..p + 4].copy_from_slice(&n.to_le_bytes());
    }
    #[test]
    fn track_keeps_sequence_times_separate_and_decodes_compressed_rotation() {
        let mut b = vec![0u8; 112];
        b[2..4].copy_from_slice(&0xffffu16.to_le_bytes());
        put(&mut b, 4, 2);
        put(&mut b, 8, 20);
        put(&mut b, 12, 2);
        put(&mut b, 16, 36);
        put(&mut b, 20, 1);
        put(&mut b, 24, 52);
        put(&mut b, 28, 1);
        put(&mut b, 32, 56);
        put(&mut b, 36, 1);
        put(&mut b, 40, 60);
        put(&mut b, 44, 1);
        put(&mut b, 48, 68);
        put(&mut b, 52, 10);
        put(&mut b, 56, 20);
        for p in [60, 68] {
            for i in 0..3 {
                b[p + i * 2..p + i * 2 + 2].copy_from_slice(&32767u16.to_le_bytes());
            }
            b[p + 6..p + 8].copy_from_slice(&65535u16.to_le_bytes());
        }
        let t = track(&b, 0, 8, quaternion).unwrap();
        assert_eq!(t.global_sequence, -1);
        assert_eq!(t.sequences[0], vec![(10, [0., 0., 0., 1.])]);
        assert_eq!(t.sequences[1][0].0, 20);
        put(&mut b, 48, 110);
        assert!(track(&b, 0, 8, quaternion).is_err());
    }
    #[test]
    fn truncated_models_and_wrong_skins_fail() {
        assert!(parse_classic_model(b"MD21", b"").is_err());
        assert!(parse_skin(b"SKIN", 0).is_err());
        assert!(parse_skin(&[0; 48], 0).is_err());
    }
    fn fixture() -> (Vec<u8>, Vec<u8>) {
        let mut b = vec![0u8; 600];
        b[..4].copy_from_slice(b"MD20");
        put(&mut b, 4, 274);
        put(&mut b, 0x3c, 3);
        put(&mut b, 0x40, 304);
        put(&mut b, 0x2c, 1);
        put(&mut b, 0x30, 448);
        put(&mut b, 0x1c, 1);
        put(&mut b, 0x20, 536);
        put(&mut b, 0x44, 1);
        b[456..458].copy_from_slice(&0xffffu16.to_le_bytes());
        put(&mut b, 540, 1000);
        put(&mut b, 548, 0x20);
        for i in 0..3 {
            b[304 + i * 48 + 12] = 255;
            put(&mut b, 304 + i * 48, (i as f32).to_bits());
        }
        let mut outer = Vec::new();
        outer.extend_from_slice(b"MD21");
        outer.extend_from_slice(&(b.len() as u32).to_le_bytes());
        outer.extend_from_slice(&b);
        outer.extend_from_slice(b"SFID");
        outer.extend_from_slice(&4u32.to_le_bytes());
        outer.extend_from_slice(&77u32.to_le_bytes());
        let mut skin = vec![0u8; 132];
        skin[..4].copy_from_slice(b"SKIN");
        put(&mut skin, 4, 3);
        put(&mut skin, 8, 48);
        put(&mut skin, 12, 3);
        put(&mut skin, 16, 54);
        put(&mut skin, 28, 1);
        put(&mut skin, 32, 60);
        put(&mut skin, 36, 1);
        put(&mut skin, 40, 108);
        for p in [48, 54] {
            skin[p + 2..p + 4].copy_from_slice(&1u16.to_le_bytes());
            skin[p + 4..p + 6].copy_from_slice(&2u16.to_le_bytes());
        }
        skin[70..72].copy_from_slice(&3u16.to_le_bytes());
        (outer, skin)
    }
    #[test]
    fn full_model_preserves_geometry_skin_and_sequence_identity() {
        let (b, skin) = fixture();
        let model = parse_classic_model(&b, &skin).unwrap();
        assert_eq!(model.vertices[2].position.x, 2.0);
        assert_eq!(model.vertices[0].bone_weights, [255, 0, 0, 0]);
        assert_eq!(model.bones[0].parent, -1);
        assert_eq!(model.sequences[0].duration_ms, 1000);
        assert_eq!(model.skin.indices, [0, 1, 2]);
        assert_eq!(model.skin.triangles, [0, 1, 2]);
        assert_eq!(model.skin.sections[0].triangle_count, 3);
        assert_eq!(model.skin_file_ids, [77]);
    }
    #[test]
    fn modern_skin_extends_section_range_start_with_u16_elements() {
        let (_, mut skin) = fixture();
        let triangles = skin.len();
        skin.resize(triangles + 65_541 * 2, 0);
        skin[triangles + 65_538 * 2..triangles + 65_541 * 2].copy_from_slice(&[0, 0, 1, 0, 2, 0]);
        put(&mut skin, 12, 65_541);
        put(&mut skin, 16, triangles as u32);
        skin[62..64].copy_from_slice(&1u16.to_le_bytes()); // level
        skin[68..70].copy_from_slice(&2u16.to_le_bytes()); // low start
        let decoded = parse_skin(&skin, 3).unwrap();
        assert_eq!(decoded.sections[0].triangle_start, 65_538);
        assert_eq!(decoded.triangles.len(), 65_541);
        assert_eq!(decoded.indices, [0u16, 1, 2]);
        assert_eq!(&decoded.triangles[65_538..], &[0u16, 1, 2]);
        skin[68..70].copy_from_slice(&3u16.to_le_bytes());
        assert!(parse_skin(&skin, 3).is_err());
    }
    #[test]
    fn full_model_rejects_invalid_joints_aliases_and_skin_indices() {
        let (mut b, mut skin) = fixture();
        b[8 + 304 + 16] = 1;
        assert!(parse_classic_model(&b, &skin).is_err());
        b[8 + 304 + 16] = 0;
        put(&mut b, 8 + 548, 0x40);
        b[8 + 598..8 + 600].copy_from_slice(&99u16.to_le_bytes());
        assert!(parse_classic_model(&b, &skin).is_err());
        put(&mut b, 8 + 548, 0x20);
        skin[54..56].copy_from_slice(&3u16.to_le_bytes());
        assert!(parse_classic_model(&b, &skin).is_err());
    }
}
