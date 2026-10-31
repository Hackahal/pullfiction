//! Quad expansion: one pool of live particles into camera-facing (or XY-plane) quads, the
//! reference's quad writer (`0x7b2a50` head, `0x7b3041` tail), shared by child emitters
//! (`0x7b5dd0`).

use benilla_assets::coords::wow_to_bevy;
use benilla_formats::ParticleEmitterDef;
use bevy::prelude::*;

use super::buffer::{EffectQuads, EffectVertex, ParticleVertexData};
use super::{rand01, Particle};

/// The 128-entry twinkle noise table, uniform in [0, 1) like the reference's `0xcf58f0` (filled at
/// startup by `0x706790`); a fixed seed, so the distribution matches but not the stream.
static TWINKLE_LUT: std::sync::LazyLock<[f32; 128]> = std::sync::LazyLock::new(|| {
    let mut s = 0xC0FF_EE11u32;
    let mut t = [0.0f32; 128];
    for v in &mut t {
        *v = rand01(&mut s);
    }
    t
});

/// Index `(floor(clamp(twinkleSpeed · age, 0, 255)) + phase) & 0x7f` (`0x7b2a86`); the reference's
/// phase is a pointer hash, ours a spawn-time random ([`Particle::phase`]).
fn twinkle_noise(twinkle_speed: f32, age: f32, phase: u32) -> f32 {
    let idx = ((twinkle_speed * age).clamp(0.0, 255.0) as u32).wrapping_add(phase) as usize & 0x7f;
    TWINKLE_LUT[idx]
}

/// `spin·age`, negated when negative on a particle whose 0x20-byte pool slot has address bit 5 set
/// (`0x7b2dda`), so a negative-spin emitter counter-rotates half its cloud. Our bit 5 is
/// [`Particle::phase`]'s, stable per particle where a pool index would not be.
pub(super) fn spin_angle(spin: f32, age: f32, phase: u32) -> f32 {
    let angle = spin * age;
    if angle < 0.0 && phase & 0x20 != 0 {
        -angle
    } else {
        angle
    }
}

/// The camera basis one frame of expansion billboards against.
pub(super) struct CamBasis {
    pub(crate) right: Vec3,
    pub(crate) up: Vec3,
}

/// How a cloud's stored coordinates reach the world (the two modes on [`super::Particle`]).
pub(super) struct DrawFrame {
    pub(crate) anchored: bool,
    /// World mode's ride frame `A`, the reference's `[ebp+8]` at `0x7b3d20`, folded on the
    /// `0x7b3f4f` leg; the identity off a transport. Model mode never reads it (`0x7b3efb`).
    pub(crate) ride: crate::ride_frame::StoredFrame,
    /// The owning model's render alpha, folded into every particle's alpha (`emitter+0x1a8`).
    pub(crate) alpha: f32,
    /// One model unit of half-extent in the stored frame: 1.0 in the world, a UI tile's pixels per
    /// unit (the reference's `768·√(a²+1)` FrameXML units, instance scale excluded, `0x7b2ba6`).
    pub(crate) size_scale: f32,
}

/// One particle's world-space quad centre, shared by [`expand_quads`] and the depth dump.
pub(super) fn particle_center(frame: &DrawFrame, placement: &Transform, p: &Particle) -> Vec3 {
    if frame.anchored {
        // World mode (`0x10` clear): no `rt+0x1fc` fold (`0x7b3f48`), only the ride frame,
        // `A · T · S` (`0x7b3f4f`); off a transport `A` is null, the store world (`0x7b3f95`).
        frame.ride.to_world(p.pos)
    } else {
        // Model mode (`0x10` set): the live emitter matrix, re-applied every frame (`0x7b3efb`).
        placement.transform_point(wow_to_bevy([p.pos.x, p.pos.y, p.pos.z]))
    }
}

/// The twinklePercent draw gate; must match [`expand_quads`]'s `0x7b2adc` skip.
pub(super) fn draw_gated(def: &ParticleEmitterDef, p: &Particle) -> bool {
    let noise = twinkle_noise(def.twinkle_speed, p.age, p.phase);
    def.twinkle_percent < 1.0 && noise > def.twinkle_percent
}

/// One particle's rendered half-extent; must match the `half` term in [`expand_quads`].
pub(super) fn particle_half(
    def: &ParticleEmitterDef,
    placement: &Transform,
    p: &Particle,
    size_scale: f32,
) -> f32 {
    let noise = twinkle_noise(def.twinkle_speed, p.age, p.phase);
    let u_age = (p.age / p.life).clamp(0.0, 1.0);
    let scale = if def.scale_size_by_instance() {
        placement.scale.x.max(1e-4)
    } else {
        size_scale
    };
    def.sample_life(u_age).size * def.twinkle(noise) * scale
}

/// Expand one pool into the shared stream: world-space quads, corners in perimeter order for the
/// lane's `[0,1,2, 0,2,3]` indices.
pub(super) fn expand_quads(
    def: &ParticleEmitterDef,
    particles: &[Particle],
    frame: &DrawFrame,
    placement: &Transform,
    cam: &CamBasis,
    out: &mut Vec<EffectVertex>,
) {
    expand_quads_inner(def, particles, frame, placement, cam, out, None);
}

pub(super) fn expand_particle_quads(
    def: &ParticleEmitterDef,
    particles: &[Particle],
    frame: &DrawFrame,
    placement: &Transform,
    cam: &CamBasis,
    stream: &mut EffectQuads,
) {
    stream
        .particle_data
        .resize(stream.verts.len(), ParticleVertexData::default());
    expand_quads_inner(
        def,
        particles,
        frame,
        placement,
        cam,
        &mut stream.verts,
        Some(&mut stream.particle_data),
    );
}

fn expand_quads_inner(
    def: &ParticleEmitterDef,
    particles: &[Particle],
    frame: &DrawFrame,
    placement: &Transform,
    cam: &CamBasis,
    out: &mut Vec<EffectVertex>,
    mut material_out: Option<&mut Vec<ParticleVertexData>>,
) {
    let anchored = frame.anchored;
    let (cam_right, cam_up) = (cam.right, cam.up);
    // Size takes the instance scale only when flagged (`0x7b2a50`), else the lane's size unit.
    let scale = if def.scale_size_by_instance() {
        placement.scale.x.max(1e-4)
    } else {
        frame.size_scale
    };
    // XY quads (file flag 0x1000, `0x7b41a3`) lie flat in the emitter's XY plane under the live
    // model matrix, its scale included, in both modes. The basis carries the emitter frame's
    // R(+Z, 90°) (`0x719114`) itself, since births take it at emission: X̂ to Ŷ, Ŷ to −X̂.
    let plane_basis = def.xy_quad().then(|| {
        let s = placement.scale.x.max(1e-4);
        (
            placement.rotation * (wow_to_bevy([0.0, 1.0, 0.0]) * s),
            placement.rotation * (wow_to_bevy([-1.0, 0.0, 0.0]) * s),
        )
    });
    // Atlas cell (`0x7b2bd5` head, `0x7b304e` tail): `col = idx & (cols − 1)`, `row = idx >>
    // log2(cols)`, cols a power of two. The row is never clamped: past the last cell V ≥ 1 and
    // the repeat sampler wraps to row 0, which 553 emitters reach at a flipbook's tail.
    let (cols, rows) = (def.tile_cols, def.tile_rows);
    let (inv_cols, inv_rows) = (1.0 / cols as f32, 1.0 / rows as f32);
    let cell_uv = |idx: u16| {
        let cx = f32::from(idx & (cols - 1));
        let cy = f32::from(idx >> cols.trailing_zeros());
        (
            (cx * inv_cols, (cx + 1.0) * inv_cols),
            (cy * inv_rows, (cy + 1.0) * inv_rows),
        )
    };
    for p in particles {
        let noise = twinkle_noise(def.twinkle_speed, p.age, p.phase);
        // The twinklePercent gate (`0x7b2adc`): below 1, a sample above it draws no quad.
        if def.twinkle_percent < 1.0 && noise > def.twinkle_percent {
            continue;
        }
        let u_age = (p.age / p.life).clamp(0.0, 1.0);
        let ol = def.sample_life(u_age);
        let (mut rgba, size) = (ol.color, ol.size);
        // The model's render alpha scales alpha alone, never RGB (`0x7b9b10`, the `0x7b9b42` fmul).
        rgba[3] *= frame.alpha;
        // Raw authored gamma RGB: additive stacks sum in gamma like the reference's bytes, and
        // the FFX chain's scene reads apply their 255 saturation (`ffx_glow.wgsl`), not this.
        let center = particle_center(frame, placement, p);
        // `size` is the half-extent (corners ±1.0, `0x7b2d0c`), times the gated twinkle and the
        // flagged instance scale; a twinkle range with min == max burns steady.
        let (mut half, mut half_y) = (
            size * def.twinkle(noise) * scale,
            ol.size_y * def.twinkle(noise) * scale,
        );
        let mut modern_angle = None;
        if let Some(v) = def.modern_variation {
            // Stable birth samples derived from the particle's existing random seed.
            let sample = |salt: u32| {
                let mut n = p.phase.wrapping_add(salt);
                n ^= n >> 16;
                n = n.wrapping_mul(0x7feb352d);
                n ^= n >> 15;
                ((n as f64 / u32::MAX as f64) * 2. - 1.) as f32
            };
            let x = sample(1);
            let y = if v[6] != 0. { sample(2) } else { x };
            half *= (1. + x * v[0]).max(0.);
            half_y *= (1. + y * v[1]).max(0.);
            modern_angle = Some(v[2] + sample(3) * v[3] + p.age * (v[4] + sample(4) * v[5]));
        }
        // Deviation: quads keep pool order within a cloud, without the reference's back-to-front
        // sort (`0x7b3a10`), because only an alpha-blended cloud can show the order; between
        // clouds, each draw record's anchor sorts it.
        let mut push_quad = |corners: [Vec3; 4], quv: [[f32; 2]; 4]| {
            let lo: [f32; 2] =
                std::array::from_fn(|i| quv.iter().map(|uv| uv[i]).fold(f32::INFINITY, f32::min));
            let hi: [f32; 2] = std::array::from_fn(|i| {
                quv.iter().map(|uv| uv[i]).fold(f32::NEG_INFINITY, f32::max)
            });
            for (c, t) in corners.iter().zip(quv) {
                out.push(EffectVertex {
                    pos: c.to_array(),
                    uv: t,
                    color: rgba,
                });
                if let Some(extra) = material_out.as_deref_mut() {
                    let mut data = ParticleVertexData::default();
                    if let Some(material) = &def.modern_material {
                        data.material = [material.cutoff(u_age), material.shader_mode()];
                        if material.multi_texture() {
                            // Adapted from WhiteoutFlakes particle2_emitter.cpp and
                            // particle_geometry.cpp, BSD-3-Clause. Each layer shares one
                            // symmetric velocity sample across U/V; origins are independent.
                            let sample = |salt: u32| {
                                let mut seed =
                                    p.phase.wrapping_add(salt).wrapping_mul(0x9e3779b9) | 1;
                                rand01(&mut seed)
                            };
                            for layer in 0..2 {
                                let variation = sample(10 + layer as u32 * 3) * 2. - 1.;
                                for axis in 0..2 {
                                    let origin = sample(11 + layer as u32 * 3 + axis as u32);
                                    let speed = material.uv_velocity[layer][axis]
                                        + variation * material.uv_velocity_variation[layer][axis];
                                    let at = (origin + p.age * speed).rem_euclid(1.);
                                    let corner = if hi[axis] > lo[axis] {
                                        (t[axis] - lo[axis]) / (hi[axis] - lo[axis])
                                    } else {
                                        0.
                                    };
                                    data.uv_layers[layer * 2 + axis] =
                                        at + corner * material.uv_scale[layer];
                                }
                            }
                        }
                    }
                    extra.push(data);
                }
            }
        };
        // Head quad (particleType 0 or 2), drawn first (`0x7b2bc9`): a billboard, or the XY plane.
        if def.head_tail != 1 {
            let ((u0, u1), (v0, v1)) = cell_uv(ol.head_cell);
            let (base_r, base_u) = plane_basis.unwrap_or((cam_right, cam_up));
            // Spin (file +0x198): in-plane by [`spin_angle`] (`0x7b2ddc`); on an XY quad this
            // is the reference's Rodrigues about the plane normal, as `normal × base_r = base_u`.
            let angle = modern_angle.unwrap_or_else(|| spin_angle(def.spin, p.age, p.phase));
            let (r, u) = if angle != 0.0 {
                let (sa, ca) = angle.sin_cos();
                (
                    (base_r * ca + base_u * sa) * half,
                    (base_u * ca - base_r * sa) * half_y,
                )
            } else {
                (base_r * half, base_u * half_y)
            };
            push_quad(
                [
                    center - r - u,
                    center + r - u,
                    center + r + u,
                    center - r + u,
                ],
                [[u0, v1], [u1, v1], [u1, v0], [u0, v0]],
            );
        }
        // Tail quad (particleType 1 or 2, `0x7b3041`): |velocity|·tailTime back along the motion,
        // 2·half wide in screen space, U from 0 at the particle to 1 at the tip, a billboard when
        // the velocity is view-parallel; its own flipbook cell (file +0x174..+0x17b, `0x7b3054`).
        if def.head_tail >= 1 {
            let ((u0, u1), (v0, v1)) = cell_uv(ol.tail_cell);
            let vel_world = if anchored {
                frame.ride.dir_to_world(p.vel)
            } else {
                placement.rotation * (placement.scale * wow_to_bevy(p.vel.to_array()))
            };
            let t_eff = if def.tail_clamps_to_age() {
                def.tail_time.min(p.age)
            } else {
                def.tail_time
            };
            let tail = -vel_world * t_eff;
            let (tr, tu) = (tail.dot(cam_right), tail.dot(cam_up));
            let l2 = tr * tr + tu * tu;
            if l2 < 7.7e-4 {
                // Degenerate: the reference's plain-billboard fallback (`0x7b33fa`).
                let (r, u) = (cam_right * half, cam_up * half);
                push_quad(
                    [
                        center - r - u,
                        center + r - u,
                        center + r + u,
                        center - r + u,
                    ],
                    [[u0, v1], [u1, v1], [u1, v0], [u0, v0]],
                );
            } else {
                let inv_l = half / l2.sqrt();
                let perp = (cam_up * tr - cam_right * tu) * inv_l;
                push_quad(
                    [
                        center - perp,
                        center + perp,
                        center + tail + perp,
                        center + tail - perp,
                    ],
                    [[u0, v1], [u0, v0], [u1, v0], [u1, v1]],
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{expand_quads, spin_angle, CamBasis, DrawFrame, Particle};
    use bevy::prelude::{Quat, Transform, Vec3};

    #[test]
    fn modern_particle_uv_layers_scroll_independently_and_frozen_redraw_is_stable() {
        use super::expand_particle_quads;
        use crate::particles::buffer::{EffectQuads, EffectVertex};
        let mut def = crate::particles::tests::plain_def();
        def.modern_material = Some(benilla_formats::ModernParticleMaterial {
            color_index: 0,
            particle_colors: None,
            flags: 0x70000000,
            textures: [
                Some("base.blp".into()),
                Some("detail.blp".into()),
                Some("alpha.blp".into()),
            ],
            uv_scale: [1., 0.5],
            uv_velocity: [[-25. / 512., 0.], [0.75, 0.75]],
            uv_velocity_variation: [[0.; 2]; 2],
            color_multiplier: 1.5,
            alpha_multiplier: 0.75,
            alpha_cutoff: vec![[0., 0.1], [1., 0.3]],
            z_source: None,
        });
        let mut particle = Particle {
            pos: Vec3::ZERO,
            vel: Vec3::ZERO,
            age: 0.,
            life: 1.,
            phase: 7,
            fresh: false,
            quat: Quat::IDENTITY,
            angvel: Vec3::ZERO,
        };
        let frame = DrawFrame {
            anchored: false,
            ride: Default::default(),
            alpha: 1.,
            size_scale: 1.,
        };
        let camera = CamBasis {
            right: Vec3::X,
            up: Vec3::Y,
        };
        let draw = |p: &Particle| {
            let mut stream = EffectQuads::default();
            stream.verts.push(EffectVertex {
                pos: [0.; 3],
                uv: [0.; 2],
                color: [1.; 4],
            });
            expand_particle_quads(
                &def,
                std::slice::from_ref(p),
                &frame,
                &Transform::IDENTITY,
                &camera,
                &mut stream,
            );
            stream
        };
        let first = draw(&particle);
        assert_eq!(
            first.particle_data.len(),
            5,
            "single-texture predecessors receive neutral supplemental data"
        );
        assert_eq!(first.particle_data[0].material, [0.; 2]);
        let a = first.particle_data[1].uv_layers;
        let opposite = first.particle_data[3].uv_layers;
        assert!((opposite[0] - a[0] - 1.).abs() < 1e-6);
        assert!((opposite[2] - a[2] - 0.5).abs() < 1e-6);
        particle.age = 0.25;
        let later = draw(&particle);
        let frozen = draw(&particle);
        for (a, b) in later.particle_data.iter().zip(&frozen.particle_data) {
            assert_eq!(a.uv_layers, b.uv_layers);
            assert_eq!(a.material, b.material);
        }
        let b = later.particle_data[1].uv_layers;
        assert!(
            ((b[0] - a[0]).rem_euclid(1.) - (-25f32 / 512. * 0.25).rem_euclid(1.)).abs() < 1e-6
        );
        assert!(((b[2] - a[2]).rem_euclid(1.) - 0.75 * 0.25).abs() < 1e-6);
        assert!((later.particle_data[1].material[0] - 0.15).abs() < 1e-6);
        assert_eq!(later.particle_data[1].material[1], 7.);
    }

    /// The `0x7b2dda` negate: only a negative angle on a bit-5 particle flips.
    #[test]
    fn negative_spin_counter_rotates_the_bit5_half() {
        assert_eq!(spin_angle(-3.0, 0.5, 0x20), 1.5, "bit 5 set: negated");
        assert_eq!(spin_angle(-3.0, 0.5, 0x1f), -1.5, "bit 5 clear: kept");
        assert_eq!(
            spin_angle(3.0, 0.5, 0x20),
            1.5,
            "positive spin: never negated"
        );
        assert_eq!(spin_angle(3.0, 0.5, 0x1f), 1.5);
        assert_eq!(spin_angle(0.0, 0.5, 0xff), 0.0);
    }

    /// The reference folds `emitter+0x1a8`, the model's `CM2Model+0x19c`, into the alpha byte alone
    /// (`0x7b9b10`, the `0x7b9b42` fmul).
    #[test]
    fn the_models_render_alpha_scales_particle_alpha_and_nothing_else() {
        let mut def = crate::particles::tests::plain_def();
        def.over_life.color = [[0.8, 0.4, 0.2, 0.5]; 3];
        let pool = [Particle {
            pos: Vec3::ZERO,
            vel: Vec3::ZERO,
            age: 0.0,
            life: 1.0,
            phase: 0,
            fresh: false,
            quat: Quat::IDENTITY,
            angvel: Vec3::ZERO,
        }];
        let cam = CamBasis {
            right: Vec3::X,
            up: Vec3::Y,
        };
        let shoot = |alpha| {
            let frame = DrawFrame {
                anchored: true,
                ride: crate::ride_frame::StoredFrame::default(),
                alpha,
                size_scale: 1.0,
            };
            let mut out = Vec::new();
            expand_quads(&def, &pool, &frame, &Transform::IDENTITY, &cam, &mut out);
            out[0].color
        };

        let opaque = shoot(1.0);
        assert_eq!(opaque, [0.8, 0.4, 0.2, 0.5], "no fade: the authored ramp");
        let half = shoot(0.5);
        assert_eq!(
            [half[0], half[1], half[2]],
            [0.8, 0.4, 0.2],
            "RGB is untouched by the model alpha"
        );
        assert!((half[3] - 0.25).abs() < 1e-6, "alpha halves: {half:?}");
        assert_eq!(shoot(0.0)[3], 0.0, "an invisible model draws nothing");
    }
}
