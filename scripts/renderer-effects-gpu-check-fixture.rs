// Synthetic offscreen fixture body, composed with current production shader/blend code by
// renderer-effects-gpu-check.py. Contains no installed-client assets or data.
fn main() {
    let instance = wgpu::Instance::default();
    let adapter = block_on(instance.request_adapter(&Default::default())).unwrap();
    println!("Adapter: {:?}", adapter.get_info());
    let (device, queue) =
        block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).unwrap();
    let dir = std::path::PathBuf::from(std::env::args().nth(1).unwrap());
    let tests = [
        (
            "modern-mod",
            EffectBlend::ModernParticle(ParticleBlend::Mod),
            0,
            1.,
            [128, 128, 128, 255],
        ),
        (
            "legacy-mod",
            EffectBlend::ParticleMod,
            0,
            1.,
            [16, 12, 10, 255],
        ),
        (
            "modern-mod",
            EffectBlend::ModernParticle(ParticleBlend::Mod),
            255,
            0.,
            [128, 128, 128, 255],
        ),
        (
            "modern-mod",
            EffectBlend::ModernParticle(ParticleBlend::Mod),
            2,
            0.25,
            [128, 128, 128, 255],
        ),
        (
            "modern-mod",
            EffectBlend::ModernParticle(ParticleBlend::Mod),
            1,
            1.,
            [16, 12, 10, 255],
        ),
        (
            "modern-mod",
            EffectBlend::ModernParticle(ParticleBlend::Mod),
            255,
            1.,
            [16, 12, 10, 255],
        ),
        (
            "modern-mod2x",
            EffectBlend::ModernParticle(ParticleBlend::Mod2x),
            0,
            1.,
            [128, 128, 128, 255],
        ),
        ("legacy-mod2x", EffectBlend::Mod2x, 0, 1., [32, 24, 20, 255]),
        (
            "modern-key",
            EffectBlend::ModernParticle(ParticleBlend::AlphaKey),
            160,
            1.,
            [32, 24, 20, 255],
        ),
        (
            "legacy-key",
            EffectBlend::AlphaKey,
            160,
            1.,
            [128, 128, 128, 255],
        ),
        (
            "modern-key",
            EffectBlend::ModernParticle(ParticleBlend::AlphaKey),
            127,
            1.,
            [128, 128, 128, 255],
        ),
        (
            "modern-key",
            EffectBlend::ModernParticle(ParticleBlend::AlphaKey),
            128,
            1.,
            [32, 24, 20, 255],
        ),
        (
            "modern-alpha",
            EffectBlend::ModernParticle(ParticleBlend::Alpha),
            255,
            0.,
            [128, 128, 128, 255],
        ),
        (
            "modern-blendadd",
            EffectBlend::ModernParticle(ParticleBlend::BlendAdd),
            0,
            1.,
            [128, 128, 128, 255],
        ),
    ];
    struct Case {
        name: &'static str,
        blend: EffectBlend,
        alpha: u8,
        track_alpha: f32,
        expected: [u8; 4],
        mode: f32,
        cutoff: f32,
        uv_layers: [f32; 4],
        stage1: [[u8; 4]; 2],
        stage2: [[u8; 4]; 2],
    }
    let mut cases: Vec<Case> = tests
        .into_iter()
        .map(|(name, blend, alpha, track_alpha, expected)| Case {
            name,
            blend,
            alpha,
            track_alpha,
            expected,
            mode: 0.,
            cutoff: 0.,
            uv_layers: [0.25; 4],
            stage1: [[255; 4]; 2],
            stage2: [[255; 4]; 2],
        })
        .collect();
    // Fixed analytical byte expectations for independent 2/3-color and Mod2/Mod4 alpha paths.
    // These exercise the complete current production fragment, not a second shader copy.
    for (mode, expected) in [
        (1., [104, 102, 101, 255]),
        (3., [100, 102, 103, 255]),
        (5., [80, 76, 74, 255]),
        (7., [72, 76, 79, 255]),
    ] {
        cases.push(Case {
            name: "modern-alpha",
            blend: EffectBlend::ModernParticle(ParticleBlend::Alpha),
            alpha: 255,
            track_alpha: 1.,
            expected,
            mode,
            cutoff: 0.,
            uv_layers: [0.25; 4],
            stage1: [[128, 128, 128, 128]; 2],
            stage2: [[64, 128, 192, 64]; 2],
        });
    }
    for (u, expected) in [(0.25, [112, 96, 96, 255]), (0.75, [96, 108, 96, 255])] {
        cases.push(Case {
            name: "modern-alpha",
            blend: EffectBlend::ModernParticle(ParticleBlend::Alpha),
            alpha: 255,
            track_alpha: 1.,
            expected,
            mode: 1.,
            cutoff: 0.,
            uv_layers: [u, 0.25, 0.25, 0.25],
            stage1: [[255, 0, 0, 128], [0, 255, 0, 128]],
            stage2: [[255, 255, 255, 64]; 2],
        });
    }
    for (u, expected) in [(0.25, [112, 96, 96, 255]), (0.75, [96, 96, 106, 255])] {
        cases.push(Case {
            name: "modern-alpha",
            blend: EffectBlend::ModernParticle(ParticleBlend::Alpha),
            alpha: 255,
            track_alpha: 1.,
            expected,
            mode: 3.,
            cutoff: 0.,
            uv_layers: [0.25, 0.25, u, 0.25],
            stage1: [[128, 128, 128, 128]; 2],
            stage2: [[255, 0, 0, 64], [0, 0, 255, 64]],
        });
    }
    for (cutoff, expected) in [(0.2, [104, 102, 101, 255]), (0.3, [128, 128, 128, 255])] {
        cases.push(Case {
            name: "modern-alpha",
            blend: EffectBlend::ModernParticle(ParticleBlend::Alpha),
            alpha: 255,
            track_alpha: 1.,
            expected,
            mode: 1.,
            cutoff,
            uv_layers: [0.25; 4],
            stage1: [[128, 128, 128, 128]; 2],
            stage2: [[64, 128, 192, 64]; 2],
        });
    }
    for (number, case) in cases.iter().enumerate() {
        let Case {
            name,
            blend,
            alpha,
            track_alpha,
            expected,
            ..
        } = case;
        let code = std::fs::read_to_string(dir.join(format!("modern-alpha-{name}.wgsl"))).unwrap();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some(name),
            source: wgpu::ShaderSource::Wgsl(code.into()),
        });
        let targets = [Some(wgpu::ColorTargetState {
            format: wgpu::TextureFormat::Rgba8Unorm,
            blend: effect_blend_state(*blend).0,
            write_mask: wgpu::ColorWrites::ALL,
        })];
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(name),
            layout: None,
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("test_vertex"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fragment"),
                compilation_options: Default::default(),
                targets: &targets,
            }),
            multiview: None,
            cache: None,
        });
        let extent = wgpu::Extent3d {
            width: 1,
            height: 1,
            depth_or_array_layers: 1,
        };
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: extent,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: Default::default(),
                aspect: wgpu::TextureAspect::All,
            },
            &[64, 96, 160, *alpha],
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4),
                rows_per_image: Some(1),
            },
            extent,
        );
        let mut stage_views = Vec::new();
        for pixels in [&case.stage1, &case.stage2] {
            let stage_extent = wgpu::Extent3d {
                width: 2,
                height: 1,
                depth_or_array_layers: 1,
            };
            let stage = device.create_texture(&wgpu::TextureDescriptor {
                label: None,
                size: stage_extent,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &stage,
                    mip_level: 0,
                    origin: Default::default(),
                    aspect: wgpu::TextureAspect::All,
                },
                &pixels.iter().flatten().copied().collect::<Vec<u8>>(),
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(8),
                    rows_per_image: Some(1),
                },
                stage_extent,
            );
            stage_views.push(stage.create_view(&Default::default()));
        }
        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: extent,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        let target_view = target.create_view(&Default::default());
        let sampler = device.create_sampler(&Default::default());
        let camera = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: 256,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let light = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: 1024,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        let params = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: 32,
            usage: wgpu::BufferUsages::UNIFORM,
            mapped_at_creation: false,
        });
        let color = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: 48,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut color_bytes = Vec::new();
        for value in [0.5f32, 0.25, 0.125, *track_alpha] {
            color_bytes.extend(value.to_le_bytes());
        }
        for value in case
            .uv_layers
            .into_iter()
            .chain([case.cutoff, case.mode, 0., 0.])
        {
            color_bytes.extend(value.to_le_bytes());
        }
        queue.write_buffer(&color, 0, &color_bytes);
        let group0 = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: camera.as_entire_binding(),
            }],
        });
        let group1 = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &pipeline.get_bind_group_layout(1),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: light.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: params.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::TextureView(&stage_views[0]),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: wgpu::BindingResource::TextureView(&stage_views[1]),
                },
            ],
        });
        let group2 = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &pipeline.get_bind_group_layout(2),
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: color.as_entire_binding(),
            }],
        });
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: 256,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &target_view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: 0.5,
                            g: 0.5,
                            b: 0.5,
                            a: 1.,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &group0, &[]);
            pass.set_bind_group(1, &group1, &[]);
            pass.set_bind_group(2, &group2, &[]);
            pass.draw(0..3, 0..1);
        }
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &target,
                mip_level: 0,
                origin: Default::default(),
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(256),
                    rows_per_image: Some(1),
                },
            },
            extent,
        );
        queue.submit(Some(encoder.finish()));
        let (send, recv) = std::sync::mpsc::channel();
        readback
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |r| send.send(r).unwrap());
        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        recv.recv().unwrap().unwrap();
        let actual = readback.slice(..).get_mapped_range();
        let pixel = &actual[..4];
        for (a, e) in pixel.iter().zip(expected) {
            assert!(
                (*a as i32 - *e as i32).abs() <= 1,
                "case {number} {name}: {pixel:?} vs {expected:?}"
            );
        }
        println!("PASS {number} {name} mode={} cutoff={} uv={:?} tex_alpha={alpha} track_alpha={track_alpha}: {pixel:?}",case.mode,case.cutoff,case.uv_layers);
    }
    println!("All24 exact-production-fragment texture-sampling/blend tests passed");
}
