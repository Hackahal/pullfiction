use futures_lite::future::block_on;

// Analytical expectations are independent of the extracted production WGSL. Diffuse is
// [.8,.6,.4,.7], first texel [.9,.7,.5,.6], second [.8,.6,.4,.1]. No readback is clamped.
const CASES: [(&str, [f32; 4]); 45] = [
    ("Mod_Mod2x", [1.152, 0.504, 0.16, 0.084]),
    (
        "Mod_Mod2xNA_ignores_second_alpha",
        [1.152, 0.504, 0.16, 0.42],
    ),
    ("Mod_Mod", [0.576, 0.252, 0.08, 0.042]),
    ("Mod_Add_diffuse", [0.72, 0.42, 0.2, 0.49]),
    ("Mod_AddNA_diffuse", [0.72, 0.42, 0.2, 0.42]),
    ("Opaque_Opaque", [0.576, 0.252, 0.08, 0.7]),
    ("Opaque_AddAlpha_diffuse", [0.72, 0.42, 0.2, 0.7]),
    ("Opaque_Mod2x", [1.152, 0.504, 0.16, 0.14]),
    ("Opaque_Mod2xNA", [1.152, 0.504, 0.16, 0.7]),
    ("Opaque_Mod", [0.576, 0.252, 0.08, 0.07]),
    (
        "independent_UV0_UV1_translation_and_scale",
        [0.35, 0.55, 0.86, 0.36],
    ),
    (
        "HDR_before_attenuation_not_early_clamped",
        [0.36, 0.36, 0.36, 0.06],
    ),
    ("UV_quarter_turn", [0.5, 1.0, 0.0, 1.0]),
    (
        "unused_third_binding_does_not_enter_two_sample_helper",
        [0.0; 4],
    ),
    (
        "unused_third_bindings_are_different_dynamic_inputs",
        [-1.0; 4],
    ),
    (
        "Mod_Add_emission_after_attenuation",
        [0.98, 0.705, 0.45, 0.49],
    ),
    (
        "Opaque_AddAlpha_emission_after_attenuation",
        [0.26, 0.165, 0.09, 0.7],
    ),
    (
        "Lucifron_alpha_weighted_reflection_preserves_skin_opacity",
        [0.8, 0.7, 0.1, 0.8],
    ),
    (
        "transparent_reflection_does_not_darken_the_lit_skin",
        [0.4, 0.35, 0.05, 0.8],
    ),
    (
        "WMO_raw_reflection_has_no_M2_half_bias",
        [0.6, 0.0, 0.0, 1.0],
    ),
    (
        "WMO_Env_base_alpha_weights_emissive_reflection",
        [0.4, 0.45, 0.5, 1.0],
    ),
    (
        "WMO_specular_directional_highlight",
        [0.5, 0.25, 0.125, 0.5],
    ),
    ("WMO_backfacing_specular_is_zero", [0.0, 0.0, 0.0, 1.0]),
    (
        "WMO_Diffuse_Opaque_LOD_Specular_alpha",
        [0.2, 1.0, 0.2, 0.2],
    ),
    (
        "WMO_Env_zero_reflection_preserves_base_and_fade",
        [0.2, 0.3, 0.4, 0.25],
    ),
    (
        "terrain_MCCV_diffuse_tint_in_shadow",
        [0.56, 0.1045882353, 0.0, 1.0],
    ),
    (
        "terrain_MCCV_black_removes_diffuse_only",
        [0.0, 0.0, 0.0, 1.0],
    ),
    (
        "terrain_absent_MCCV_keeps_legacy_white",
        [0.4, 0.15, 0.4, 1.0],
    ),
    (
        "static_OpaqueMod2xNAAlpha_masks_reflection_by_base_alpha",
        [0.8928, 0.4536, 0.184, 0.7],
    ),
    (
        "static_OpaqueAddAlphaAlpha_masks_emission_after_lighting",
        [0.212, 0.129, 0.066, 0.7],
    ),
    (
        "static_ModAddAlpha_uses_base_opacity_and_emissive_second",
        [0.26, 0.165, 0.09, 0.42],
    ),
    (
        "static_OpaqueAddAlphaWgt_uses_independent_authored_weight",
        [0.204, 0.123, 0.062, 0.7],
    ),
    ("static_OpaqueModNAAlpha", [0.6624, 0.3528, 0.152, 0.7]),
    ("static_OpaqueAlpha", [0.712, 0.414, 0.196, 0.7]),
    (
        "static_base_alpha_zero_retains_doubled_modulation",
        [1.152, 0.504, 0.16, 0.7],
    ),
    (
        "static_base_alpha_one_restores_base_texture",
        [0.72, 0.42, 0.2, 0.7],
    ),
    (
        "static_base_alpha_one_removes_additive_reflection",
        [0.18, 0.105, 0.05, 0.7],
    ),
    (
        "static_base_alpha_zero_keeps_additive_reflection",
        [0.26, 0.165, 0.09, 0.7],
    ),
    (
        "static_zero_texture_weight_removes_reflection_without_hiding_base",
        [0.18, 0.105, 0.05, 0.7],
    ),
    (
        "static_full_texture_weight_keeps_reflection",
        [0.26, 0.165, 0.09, 0.7],
    ),
    (
        "static_second_alpha_zero_restores_base",
        [0.72, 0.42, 0.2, 0.7],
    ),
    (
        "static_second_alpha_one_selects_second_texture",
        [0.64, 0.36, 0.16, 0.7],
    ),
    (
        "static_ModAddAlphaWgt_preserves_base_opacity",
        [0.204, 0.123, 0.062, 0.42],
    ),
    (
        "static_ModAddAlphaWgt_zero_weight_keeps_base",
        [0.18, 0.105, 0.05, 0.42],
    ),
    (
        "static_ModAddAlphaWgt_full_weight_keeps_emission",
        [0.26, 0.165, 0.09, 0.42],
    ),
];

fn main() {
    let instance = wgpu::Instance::default();
    let adapter = block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
        .expect("native GPU adapter required");
    println!("Adapter: {:?}", adapter.get_info());
    let (device, queue) =
        block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).unwrap();
    let code =
        std::fs::read_to_string(std::env::args().nth(1).expect("WGSL path required")).unwrap();
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("exact production packed M2 helpers"),
        source: wgpu::ShaderSource::Wgsl(code.into()),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: None,
        layout: None,
        module: &module,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });
    let size = (CASES.len() * 16) as u64;
    let output = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let values: [[f32; 4]; 6] = [
        [0.9, 0.7, 0.5, 0.6],
        [0.8, 0.6, 0.4, 0.1],
        [0.0; 4],
        [0.9, 0.7, 0.5, 0.6],
        [0.8, 0.6, 0.4, 0.1],
        [1.0; 4],
    ];
    let input = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("two authored triples with different unused third bindings"),
        size: 96,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let data: Vec<u8> = values
        .iter()
        .flatten()
        .flat_map(|v| v.to_le_bytes())
        .collect();
    queue.write_buffer(&input, 0, &data);
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: output.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: input.as_entire_binding(),
            },
        ],
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(1, 1, 1);
    }
    encoder.copy_buffer_to_buffer(&output, 0, &readback, 0, size);
    queue.submit(Some(encoder.finish()));
    let (send, recv) = std::sync::mpsc::channel();
    readback
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |r| send.send(r).unwrap());
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    recv.recv().unwrap().unwrap();
    let bytes = readback.slice(..).get_mapped_range();
    let actual: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    for ((name, expected), actual) in CASES.iter().zip(actual.chunks_exact(4)) {
        for (want, got) in expected.iter().zip(actual) {
            assert!(
                (want - got).abs() < 1e-6,
                "{name}: expected {expected:?}, got {actual:?}"
            );
        }
        println!("PASS {name}: expected={expected:?} actual={actual:?}");
    }
}
