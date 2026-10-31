//! Synthetic MOMT -> parsed material -> render-submesh sampler contract.
use std::io::Cursor;

use super::super::test_bytes::{chunk, f3};
use crate::{parse_wmo_root, wmo_group_submeshes};

fn root_bytes(flags: &[u32]) -> Vec<u8> {
    let mut header = vec![0; 64];
    header[..4].copy_from_slice(&(flags.len() as u32).to_le_bytes());
    header[4..8].copy_from_slice(&1u32.to_le_bytes());
    let mut materials = vec![0; flags.len() * 64];
    for (index, flag) in flags.iter().enumerate() {
        materials[index * 64..index * 64 + 4].copy_from_slice(&flag.to_le_bytes());
    }
    [
        chunk(b"REVM", &17u32.to_le_bytes()),
        chunk(b"DHOM", &header),
        chunk(b"XTOM", b"World\\shared.blp\0"),
        chunk(b"TMOM", &materials),
    ]
    .concat()
}

fn group_bytes(materials: u8) -> Vec<u8> {
    let mut header = vec![0; 68];
    header[8..12].copy_from_slice(&8u32.to_le_bytes());
    let vertices = [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]]
        .into_iter()
        .flat_map(f3)
        .collect::<Vec<_>>();
    let uvs = [-0.25f32, -0.25, 1.25, -0.25, -0.25, 1.25]
        .into_iter()
        .flat_map(f32::to_le_bytes)
        .collect::<Vec<_>>();
    let mut batches = Vec::new();
    for material in 0..materials {
        let mut batch = vec![0; 24];
        batch[16..18].copy_from_slice(&3u16.to_le_bytes());
        batch[20..22].copy_from_slice(&2u16.to_le_bytes());
        batch[23] = material;
        batches.extend(batch);
    }
    let body = [
        header,
        chunk(b"TVOM", &vertices),
        chunk(b"IVOM", &[0, 0, 1, 0, 2, 0]),
        chunk(b"VTOM", &uvs),
        chunk(b"YPOM", &[0x20, 0]),
        chunk(b"ABOM", &batches),
    ]
    .concat();
    [chunk(b"REVM", &17u32.to_le_bytes()), chunk(b"PGOM", &body)].concat()
}

#[test]
fn parsed_material_flags_keep_four_independent_sampler_modes_on_one_texture() {
    let flags = [0, 0x40, 0x80, 0xc0];
    let bytes = root_bytes(&flags);
    let benilla_wmo::ParsedWmo::Root(parsed) =
        benilla_wmo::parse_wmo(&mut Cursor::new(&bytes)).unwrap()
    else {
        panic!("expected a root");
    };
    assert_eq!(
        parsed.materials.iter().map(|m| m.flags).collect::<Vec<_>>(),
        flags
    );
    let root = parse_wmo_root(&bytes).unwrap();
    let meshes = wmo_group_submeshes(&group_bytes(4), &root).unwrap();
    assert_eq!(meshes.len(), 4);
    let expected = [(true, true), (false, true), (true, false), (false, false)];
    for (mesh, mode) in meshes.iter().zip(expected) {
        assert_eq!((mesh.wrap_x, mesh.wrap_y), mode);
        assert_eq!(mesh.texture.as_deref(), Some("World\\shared.blp"));
        assert_eq!(mesh.positions, meshes[0].positions);
        assert_eq!(
            mesh.uvs, meshes[0].uvs,
            "sampler policy must preserve authored UVs"
        );
        assert_eq!(mesh.indices, meshes[0].indices);
    }
}

#[test]
fn lighting_and_culling_bits_preserve_the_default_repeat_control() {
    let root = parse_wmo_root(&root_bytes(&[0x01 | 0x04 | 0x10 | 0x20])).unwrap();
    let meshes = wmo_group_submeshes(&group_bytes(1), &root).unwrap();
    assert_eq!((meshes[0].wrap_x, meshes[0].wrap_y), (true, true));
    assert!(meshes[0].two_sided);
    assert!(meshes[0].emissive);
    assert!(meshes[0].window);
}

#[test]
fn modern_wmo_material_modes_keep_shader_and_reflection_bindings_with_a_legacy_control() {
    let shaders = [0u32, 1, 3, 4, 21];
    let mut header = vec![0; 64];
    header[..4].copy_from_slice(&(shaders.len() as u32).to_le_bytes());
    header[4..8].copy_from_slice(&1u32.to_le_bytes());
    let base = b"World\\base.blp\0";
    let mut materials = vec![0; shaders.len() * 64];
    for (index, shader) in shaders.into_iter().enumerate() {
        let at = index * 64;
        materials[at..at + 4].copy_from_slice(&0xc0u32.to_le_bytes());
        materials[at + 4..at + 8].copy_from_slice(&shader.to_le_bytes());
        materials[at + 24..at + 28].copy_from_slice(&(base.len() as u32).to_le_bytes());
    }
    let textures = [base.as_slice(), b"World\\reflection.blp\0"].concat();
    let mut bytes = [
        chunk(b"REVM", &17u32.to_le_bytes()),
        chunk(b"DHOM", &header),
        chunk(b"XTOM", &textures),
        chunk(b"TMOM", &materials),
    ]
    .concat();
    let legacy = parse_wmo_root(&bytes).unwrap();
    let legacy_meshes = wmo_group_submeshes(&group_bytes(5), &legacy).unwrap();
    // The original WMO remapper inherits RenderSubmesh's historical combine=1; its asset
    // loader publishes no M2 combine stage. Nonzero modern descriptors must not change it.
    assert!(legacy_meshes
        .iter()
        .all(|m| m.combine == 1 && m.stage1.is_none()));
    let mut original_descriptors = bytes.clone();
    let material_start = bytes.windows(4).position(|v| v == b"TMOM").unwrap() + 8;
    for i in 0..shaders.len() {
        let at = material_start + i * 64;
        original_descriptors[at + 4..at + 8].copy_from_slice(&0u32.to_le_bytes());
        original_descriptors[at + 24..at + 28].copy_from_slice(&0u32.to_le_bytes());
    }
    let original_root = parse_wmo_root(&original_descriptors).unwrap();
    let original_meshes = wmo_group_submeshes(&group_bytes(5), &original_root).unwrap();
    for (legacy, original) in legacy_meshes.iter().zip(&original_meshes) {
        assert_eq!(legacy.combine, original.combine);
        assert!(original.stage1.is_none());
        assert_eq!(legacy.texture, original.texture);
        assert_eq!(legacy.blend, original.blend);
        assert_eq!(legacy.positions, original.positions);
        assert_eq!(legacy.uvs, original.uvs);
        assert_eq!(legacy.indices, original.indices);
    }
    bytes.extend(chunk(b"1WFP", &1u32.to_le_bytes()));
    let modern = parse_wmo_root(&bytes).unwrap();
    let meshes = wmo_group_submeshes(&group_bytes(5), &modern).unwrap();
    assert_eq!(
        meshes.iter().map(|m| m.combine).collect::<Vec<_>>(),
        [32, 33, 35, 36, 53]
    );
    let reflection = meshes[2].stage1.as_ref().unwrap();
    assert_eq!(reflection.texture.as_deref(), Some("World\\reflection.blp"));
    assert!(reflection.env_map);
    assert_eq!(reflection.combine, 18);
    assert_eq!((reflection.wrap_x, reflection.wrap_y), (false, false));
    for (mesh, control) in meshes.iter().zip(&legacy_meshes) {
        assert_eq!(mesh.positions, control.positions);
        assert_eq!(mesh.uvs, control.uvs);
        assert_eq!(mesh.indices, control.indices);
    }
}
