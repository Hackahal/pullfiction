//! Vanilla (MD20 v256) M2 particle emitters, read from raw bytes because `benilla-m2` skips them:
//! fixed 0x1f8-byte records (array at MD20+0x13c/+0x140) at the reference loader's offsets
//! (`0x70ebd0`). Rate and enabled bake one loop per sequence into [`EmitTiming`], since the
//! reference samples both in the playing sequence's key window (`0x713d50`).

use std::io::Cursor;

use anyhow::Result;
use benilla_m2::{parse_m2, M2ScalarTrack};

use crate::emit_timing::{EmitParams, EmitTiming};
use crate::models::SeqSlot;

/// Emitter spawn shape, file `emitterType` (+0x2a): 1 plane, 2 sphere, 3 spline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParticleShape {
    Plane,
    Sphere,
    Spline,
}

/// Particle blend, file `blendingType` (+0x28), the M2 blend enum. Mod (5) and mod2x (6) have no
/// modulate path yet and draw as `Alpha`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ParticleBlend {
    /// Modern adapter only: destination multiplied by source RGB.
    Mod,
    /// Modern adapter only: twice destination multiplied by source RGB.
    Mod2x,
    /// Modern adapter only: source RGB plus destination attenuated by source alpha.
    BlendAdd,
    /// `4` Add, `(SRC_ALPHA, ONE)`, and `3` NoAlphaAdd, which the reference draws `(ONE, ONE)`
    /// (EGxBlend 10): no depth write or sort. Flames and glows.
    Add,
    /// `2` Alpha: `(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)`. Smoke.
    Alpha,
    /// `1` AlphaKey, for chips and debris: alpha test `GEQUAL round(instanceAlpha × 224)` from the
    /// raw mode (`0x70c256`, 224.0 at `[0x812034]`). Mode ≤ 1 at alpha ≥ 0.99999 joins the opaque
    /// list (`0x7085db`), whose promotion row `0x811fe0` keeps it EGxBlend 1, blending off
    /// (`0x59d563`); z-write goes off only above mode 1 (`0x70d8f1`).
    AlphaKey,
    /// `0` Opaque: blending off, depth write on, no alpha test (the mode-0 arm of `0x70c237` sets
    /// ref 0, which `0x59d5b9` turns into `glDisable(GL_ALPHA_TEST)`). Also any unknown byte.
    Opaque,
}

/// One segment's flipbook cell ramp: the authored `(begin, end)` and the `(base, span)` the
/// reference derives at load (`0x7b9da0` head, `0x7b9de0` tail), `|end − begin| + 1` cells in the
/// authored direction. A decreasing pair is shipped and plays backwards; nothing swaps or clamps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CellRamp {
    /// The authored pair, stored at `rec+0x3c/+0x40` and never read back by the reference.
    pub begin: u16,
    pub end: u16,
    base: i32,
    span: i32,
}

impl CellRamp {
    /// From an authored pair, by `0x7b9da0`'s two arms.
    pub fn new(begin: u16, end: u16) -> Self {
        let (b, e) = (i32::from(begin), i32::from(end));
        let (base, span) = if e >= b {
            (b, e - b + 1)
        } else {
            (b + 1, e - b - 1)
        };
        Self {
            begin,
            end,
            base,
            span,
        }
    }

    /// The cell at segment fraction `t` (inset and repeat already applied, [`OverLife::sample`]):
    /// `floor(base + span·t) & 0xFF`, the reference's mod-256 wrap, not a clamp.
    pub fn sample(&self, t: f32) -> u16 {
        // Deviation: NaN floors to 0 where the reference reads the raw mantissa, because we do not
        // reproduce its divide by zero on a `mid` of 0 or 1; no shipped emitter authors one.
        let v = self.base as f32 + self.span as f32 * t;
        ((v.floor() as i32) & 0xFF) as u16
    }
}

/// The over-life ramps (+0x14c..) at normalized age `u = age / lifespan`: colour and size are
/// 3-key ramps split at [`Self::mid`] into two linear segments, with a [`CellRamp`] per segment
/// for the head and the tail (built at `0x70ebd0`, evaluated at `0x7b9b10`).
#[derive(Debug, Clone, Copy)]
pub struct OverLife {
    /// Normalized age (+0x14c) splitting the segments; only `age > lifespan·mid` enters B.
    pub mid: f32,
    /// RGBA keys (+0x150/+0x154/+0x158, packed BGRA); A is the over-life opacity.
    pub color: [[f32; 4]; 3],
    /// Size keys (+0x15c/+0x160/+0x164), yards.
    pub scale: [f32; 3],
    /// The head quad's ramp per segment: A (+0x168/+0x16a), B (+0x16e/+0x170).
    pub head_cells: [CellRamp; 2],
    /// The tail streak's own ramp: A (+0x174/+0x176), B (+0x178/+0x17a), read at `0x7b304e`.
    pub tail_cells: [CellRamp; 2],
    /// Flipbook repeats per segment (+0x16c/+0x172): unless 1.0, the cells cycle `fract(t·repeat)`.
    pub repeat: [f32; 2],
}

/// One evaluation of the over-life ramps: the four outputs of the reference's `0x7b9b10`.
#[derive(Debug, Clone, Copy)]
pub struct OverLifeSample {
    /// Linear RGBA; A is the over-life opacity.
    pub color: [f32; 4],
    /// Half-extent in yards.
    pub size: f32,
    pub size_y: f32,
    pub head_cell: u16,
    pub tail_cell: u16,
}

impl OverLife {
    /// Sample every ramp at normalized age `u` (0..1).
    pub fn sample(&self, u: f32) -> OverLifeSample {
        let u = u.clamp(0.0, 1.0);
        // Deviation: `mid` is clamped to [1e-3, 1] because a 0 divides by zero in the reference
        // (`0x7b9cf0`, walking NaN into the sampler); no shipped emitter authors one.
        let mid = self.mid.clamp(1e-3, 1.0);
        let (k0, k1, t, seg) = if u <= mid {
            (0, 1, u / mid, 0)
        } else {
            (1, 2, (u - mid) / (1.0 - mid).max(1e-3), 1)
        };
        // The reference's only normalized time: `0x7b9b10` computes `t·0.99 + 0.005` once for every
        // ramp. With the cell ramp's ±1 it gives `cell(0) == begin` and `cell(1) == end` either
        // way (exact below 200 cells; the largest shipped atlas is 8×8).
        let t = t.clamp(0.0, 1.0) * 0.99 + 0.005;
        let mut color = [0.0; 4];
        for (c, slot) in color.iter_mut().enumerate() {
            *slot = self.color[k0][c] + (self.color[k1][c] - self.color[k0][c]) * t;
        }
        let size = self.scale[k0] + (self.scale[k1] - self.scale[k0]) * t;
        // The repeat cycles the cells only: colour and size are stored before the `rec+0x50 != 1.0`
        // branch (`0x7b9bcc`).
        let ct = if self.repeat[seg] != 1.0 {
            (t * self.repeat[seg]).fract()
        } else {
            t
        };
        OverLifeSample {
            color,
            size,
            size_y: size,
            head_cell: self.head_cells[seg].sample(ct),
            tail_cell: self.tail_cells[seg].sample(ct),
        }
    }
}

/// A spline (type 3) emitter's curve: a cubic Bézier chain (`3K+1` points: P, out, in, P, …)
/// walked by normalized arc length, whose knots the reference computes at load (`0x7b9a80` →
/// `0x4532e0`) for the spawn kernel `0x7b9500`. A segment's length here is a 16-chord sum; the
/// reference's method (`0x453e50`) is untraced.
#[derive(Debug, Clone)]
pub struct SplineData {
    /// Control points, model-local WoW axes (`3K+1`, from file+0x1d4/+0x1d8).
    pub points: Vec<[f32; 3]>,
    /// Cumulative normalized arc length at each segment boundary (`K+1` entries, 0 to 1).
    knots: Vec<f32>,
}

impl SplineData {
    /// From `3K+1` raw control points.
    pub fn new(points: Vec<[f32; 3]>) -> Option<Self> {
        let k = points.len().checked_sub(1)? / 3;
        if k == 0 || points.len() != 3 * k + 1 {
            return None;
        }
        let mut knots = vec![0.0f32];
        for seg in 0..k {
            let mut len = 0.0;
            let mut prev = Self::bezier(&points[3 * seg..3 * seg + 4], 0.0);
            for i in 1..=16 {
                let p = Self::bezier(&points[3 * seg..3 * seg + 4], i as f32 / 16.0);
                len += ((p[0] - prev[0]).powi(2)
                    + (p[1] - prev[1]).powi(2)
                    + (p[2] - prev[2]).powi(2))
                .sqrt();
                prev = p;
            }
            knots.push(knots[seg] + len);
        }
        let total = *knots.last().unwrap();
        if total > 0.0 {
            for kn in &mut knots {
                *kn /= total;
            }
        }
        Some(Self { points, knots })
    }

    fn bezier(p: &[[f32; 3]], u: f32) -> [f32; 3] {
        let w = [
            (1.0 - u).powi(3),
            3.0 * u * (1.0 - u).powi(2),
            3.0 * u * u * (1.0 - u),
            u.powi(3),
        ];
        std::array::from_fn(|c| (0..4).map(|i| w[i] * p[i][c]).sum())
    }

    fn bezier_deriv(p: &[[f32; 3]], u: f32) -> [f32; 3] {
        let w = [
            -3.0 * (1.0 - u).powi(2),
            3.0 * (1.0 - u) * (1.0 - 3.0 * u),
            3.0 * u * (2.0 - 3.0 * u),
            3.0 * u * u,
        ];
        std::array::from_fn(|c| (0..4).map(|i| w[i] * p[i][c]).sum())
    }

    fn locate(&self, t: f32) -> (usize, f32) {
        let k = self.knots.len() - 1;
        let seg = self.knots[1..k]
            .iter()
            .position(|&kn| t < kn)
            .unwrap_or(k - 1);
        let (a, b) = (self.knots[seg], self.knots[seg + 1]);
        (seg, ((t - a) / (b - a).max(1e-6)).clamp(0.0, 1.0))
    }

    /// The point at arc fraction `t`, clamped to the end points outside [0, 1] (`0x453390`).
    pub fn eval(&self, t: f32) -> [f32; 3] {
        if t <= 0.0 {
            return self.points[0];
        }
        if t >= 1.0 {
            return *self.points.last().unwrap();
        }
        let (seg, u) = self.locate(t);
        Self::bezier(&self.points[3 * seg..3 * seg + 4], u)
    }

    /// The unnormalized tangent at arc fraction `t` (`0x453420`; its caller renormalizes).
    pub fn tangent(&self, t: f32) -> [f32; 3] {
        let (seg, u) = self.locate(t.clamp(0.0, 1.0));
        Self::bezier_deriv(&self.points[3 * seg..3 * seg + 4], u)
    }
}

/// Authored modern particle material inputs retained by the browser adapter's PFP5 extension.
#[derive(Debug, Clone)]
pub struct ModernParticleMaterial {
    pub flags: u32,
    pub textures: [Option<String>; 3],
    pub uv_scale: [f32; 2],
    pub uv_velocity: [[f32; 2]; 2],
    pub uv_velocity_variation: [[f32; 2]; 2],
    pub color_multiplier: f32,
    pub alpha_multiplier: f32,
    pub alpha_cutoff: Vec<[f32; 2]>,
    pub z_source: Option<f32>,
}

impl ModernParticleMaterial {
    pub fn multi_texture(&self) -> bool {
        self.flags & 0x10000000 != 0
    }
    /// Bit 0 activates the path; bits 1/2 choose its independent color/alpha products.
    pub fn shader_mode(&self) -> f32 {
        if !self.multi_texture() {
            return 0.;
        }
        (1 + 2 * u32::from(self.flags & 0x40000000 != 0)
            + 4 * u32::from(self.flags & 0x20000000 != 0)) as f32
    }
    pub fn cutoff(&self, age: f32) -> f32 {
        if self.alpha_cutoff.is_empty() {
            return 0.;
        }
        let end = self.alpha_cutoff.partition_point(|k| k[0] <= age);
        let a = self.alpha_cutoff[end.saturating_sub(1)];
        let b = self.alpha_cutoff[end.min(self.alpha_cutoff.len() - 1)];
        let t = if b[0] > a[0] {
            ((age - a[0]) / (b[0] - a[0])).clamp(0., 1.)
        } else {
            0.
        };
        a[1] + (b[1] - a[1]) * t
    }
}

/// One vanilla M2 particle emitter, positions and vectors model-local (WoW axes, Z up).
#[derive(Debug, Clone)]
pub struct ParticleEmitterDef {
    pub modern_material: Option<ModernParticleMaterial>,
    pub modern_variation: Option<[f32; 7]>,
    pub life_color_curve: Vec<[f32; 4]>,
    pub life_alpha_curve: Vec<[f32; 2]>,
    pub life_scale_curve: Vec<[f32; 3]>,
    /// Classic adapter absolute symmetric emission variations; zero for original assets.
    pub head_cell_curve: Vec<[f32; 2]>,
    pub tail_cell_curve: Vec<[f32; 2]>,
    pub lifespan_variation: f32,
    pub emission_rate_variation: f32,
    pub flags: u32,
    pub position: [f32; 3],
    pub bone: u16,
    pub shape: ParticleShape,
    pub blend: ParticleBlend,
    /// Whether the scene light multiplies the quads (`lit_of`, from the raw blend byte).
    pub lit: bool,
    /// Geometry model (+0x18, an `M2Array<char>` path, `0x7b1c80`): spawns models, not quads.
    pub geometry_model: Option<String>,
    /// Recursion model (+0x20, `0x7b5dd0`, `0x7b5b9f`): up to 4 of its emitters run as children,
    /// driven once per live parent particle per frame at that particle's position.
    pub recursion_model: Option<String>,
    /// Particle texture, the `.blp` path from the M2 textures table.
    pub texture: Option<String>,
    /// Atlas rows (and `tile_cols` columns), both non-zero powers of two: on a bad pair the
    /// reference's setter `0x7b4ed0` writes nothing and keeps its 1×1, and so does the parse.
    pub tile_rows: u16,
    pub tile_cols: u16,
    /// 0 head (camera-facing quad), 1 tail (velocity streak), 2 both.
    pub head_tail: u8,
    /// Spawn rate (+0xdc) and the on/off gate (+0x1dc), baked one loop per sequence.
    pub timing: EmitTiming,
    /// The other nine emission tracks (+0x34..+0x130), baked the same way and sampled each frame
    /// on the emitter's clock: they animate, so `value[0]` alone is wrong.
    pub params: EmitParams,
    /// Velocity drag (+0x194, a scalar copied to runtime +0x1e0 at `0x70ffdd`): each frame, after
    /// gravity, `vel −= min(dt·drag, 1)·vel` (`0x7b2680`).
    pub drag: f32,
    /// Tail time (+0x17c, seconds; the quad writer's tail block `0x7b3041`): a tail particle draws
    /// a streak `|velocity| · tail_time` long behind its motion.
    pub tail_time: f32,
    /// Model particles' spin range (+0x19c min, +0x1a8 max, rad/s), rolled per birth at
    /// `0x7b2420`: X takes `min + u·range`; Y and Z a raw [1, 2) mantissa × range, ignoring min.
    pub angular_velocity_min: [f32; 3],
    pub angular_velocity_max: [f32; 3],
    /// Scales a flag-0x40 emitter's inherited velocity (+0x190, runtime +0x1c4 at
    /// `0x70ff71`/`0x70ff77`).
    pub inherit_scale: f32,
    /// Two (emitter speed, follow fraction) samples (+0x1c4..+0x1d0) for [`Self::follow_line`].
    pub follow_speed1: f32,
    pub follow_scale1: f32,
    pub follow_speed2: f32,
    pub follow_scale2: f32,
    /// Twinkle (+0x180..+0x18c; the quad writer `0x7b2a50`): the half-size is the over-life size
    /// times [`Self::twinkle`], a multiplier skipped when `min == max`, so `{0,0}` burns steady at
    /// ramp size. The loader `0x70ebd0` keeps min and the delta `max − min` (`rt+0x1c0`).
    pub twinkle_speed: f32,
    /// Below 1, a frame whose twinkle noise exceeds it draws no quad (`0x7b2adc`).
    pub twinkle_percent: f32,
    pub twinkle_min: f32,
    pub twinkle_max: f32,
    /// Spline curve (+0x1d4 count, +0x1d8 offset, `3·⌊count/3⌋ + 1` points, `0x7b9a80`). A spline
    /// repurposes the tracks' `values[0]`: `area_length`/`area_width` are the spawn window in
    /// [0, 1], `vertical_range` a spin ψ about the tangent (birth velocity +Z turned by S11·ψ),
    /// `horizontal_range` a `U01·scatter` jitter along the velocity, and the rate a load-time arc
    /// scale that the first per-frame rate sample overwrites.
    pub spline: Option<SplineData>,
    /// Quad spin (+0x198, runtime +0x18c): rotation `spin · age` rad (`0x7b2ddc`); a negative spin
    /// reverses on half the particles (a pointer-bit-5 hash, `0x7b2dda`).
    pub spin: f32,
    pub over_life: OverLife,
}

impl ParticleEmitterDef {
    /// Classic flipbook keys keep their authored lifetime clock, including discontinuities.
    pub fn sample_life(&self, age: f32) -> OverLifeSample {
        let mut value = self.over_life.sample(age);
        fn cell(keys: &[[f32; 2]], age: f32) -> Option<u16> {
            if keys.is_empty() {
                return None;
            }
            let end = keys.partition_point(|key| key[0] <= age);
            let a = keys[end.saturating_sub(1)];
            let b = keys[end.min(keys.len() - 1)];
            let t = if b[0] > a[0] {
                ((age - a[0]) / (b[0] - a[0])).clamp(0.0, 1.0)
            } else {
                0.0
            };
            Some((a[1] + (b[1] - a[1]) * t).floor().max(0.0) as u16)
        }
        fn linear<const N: usize>(keys: &[[f32; N]], age: f32, column: usize) -> Option<f32> {
            if keys.is_empty() {
                return None;
            }
            let end = keys.partition_point(|key| key[0] <= age);
            let a = keys[end.saturating_sub(1)];
            let b = keys[end.min(keys.len() - 1)];
            let t = if b[0] > a[0] {
                ((age - a[0]) / (b[0] - a[0])).clamp(0., 1.)
            } else {
                0.
            };
            Some(a[column] + (b[column] - a[column]) * t)
        }
        for i in 0..3 {
            if let Some(c) = linear(&self.life_color_curve, age, i + 1) {
                value.color[i] = c;
            }
        }
        if let Some(a) = linear(&self.life_alpha_curve, age, 1) {
            value.color[3] = a;
        }
        if let Some(size) = linear(&self.life_scale_curve, age, 1) {
            value.size = size;
        }
        value.size_y = linear(&self.life_scale_curve, age, 2).unwrap_or(value.size);
        value.head_cell = cell(&self.head_cell_curve, age).unwrap_or(value.head_cell);
        value.tail_cell = cell(&self.tail_cell_curve, age).unwrap_or(value.tail_cell);
        if let Some(material) = &self.modern_material {
            for color in &mut value.color[..3] {
                *color *= material.color_multiplier;
            }
            value.color[3] *= material.alpha_multiplier;
        }
        value
    }
    /// File flag 0x10 (runtime 0x100; the flag remap `0x70faf8`..`0x70fc44` is not the identity).
    /// Set, particles live emitter-local and the draw re-applies the live emitter matrix, so the
    /// cloud rides the emitter; clear, the spawn bakes them into world space, so a moving host lays
    /// a trail (spawn `0x7b8a9a`, draw `0x7b3ef9`).
    pub fn model_space(&self) -> bool {
        self.flags & 0x10 != 0
    }
    /// File flag 0x4000 (runtime 0x40000, added at `0x7b2744`): live particles move by
    /// [`Self::follow_line`]'s fraction (≤ 1) of the emitter's per-frame motion; a store already
    /// riding the emitter moves by `(fraction − 1)·Δ`.
    pub fn follow_emitter(&self) -> bool {
        self.flags & 0x4000 != 0
    }
    /// `(slope, intercept)` through the two follow samples (`0x7b5d30`): the per-frame fraction is
    /// `clamp(slope·|Δpos|/dt + intercept, 0, 1)`. Equal speeds give no response.
    pub fn follow_line(&self) -> Option<(f32, f32)> {
        ((self.follow_speed2 - self.follow_speed1).abs() >= 1e-6).then(|| {
            let slope = (self.follow_scale2 - self.follow_scale1)
                / (self.follow_speed2 - self.follow_speed1);
            (slope, self.follow_scale1 - slope * self.follow_speed1)
        })
    }
    /// File flag 0x40 (runtime 0x400, `0x7b53ce`): births inherit the emitter's motion. Past each
    /// 1/30 s of accumulated dt the inherit velocity becomes
    /// `oneFrameΔ · ((1/30) / accum) · inherit_scale`, 0 while no particle lives, and each birth
    /// adds `(1 + S11·speed_variation) · inherit` to its velocity.
    pub fn inherits_emitter_motion(&self) -> bool {
        self.flags & 0x40 != 0
    }
    /// File flag 0x20 (runtime 0x200): particle size scales with the emitter transform's scale;
    /// without it an instance-scaled prop scales only its particle positions.
    pub fn scale_size_by_instance(&self) -> bool {
        self.flags & 0x20 != 0
    }
    /// File flag 0x100 on a sphere (runtime 0x4000, mapped only for type 2): birth velocity is
    /// straight +Z instead of radial.
    pub fn sphere_up(&self) -> bool {
        self.flags & 0x100 != 0
    }
    /// File flag 0x80 on a sphere (runtime 0x800, mapped only for type 2): a particle dies the
    /// frame `dot(stepVelocity, updatedPos) > 0` (`0x7b2680`).
    pub fn kill_outbound(&self) -> bool {
        self.shape == ParticleShape::Sphere && self.flags & 0x80 != 0
    }
    /// File flag 0x400 (runtime 0x10000): the tail streak's `tail_time` is clamped to the
    /// particle's age, so the streak grows from zero at birth.
    pub fn tail_clamps_to_age(&self) -> bool {
        self.flags & 0x400 != 0
    }
    /// File flag 0x200 (runtime 0x8000, tested in the spawn `0x7b2420`): each tumble axis's
    /// angular velocity flips sign with probability ½.
    pub fn tumble_random_sign(&self) -> bool {
        self.flags & 0x200 != 0
    }
    /// File flag 0x2000 (runtime 0x20000): once per birth in anchored mode (hook `0x7b2140`), the
    /// client probes 20 yd down for terrain, WMO or doodad geometry (`0x672b60` → `0x6aa160`,
    /// flags 0x100111); on a hit the quad stands on the surface, its height the surface plus its
    /// birth size (`0x7b9e20`).
    pub fn ground_snap(&self) -> bool {
        self.flags & 0x2000 != 0
    }
    /// File flag 0x8000, a one-shot burst (`0x718ec8`): when `enabled && rate > 0` first holds it
    /// spawns `ftol(rate · density · LOD)` particles once (`0x7b5c50` → `0x7b55ae`/`0x7b563d`),
    /// never pours `rate·dt`, and re-arms only when the gate falls.
    pub fn burst(&self) -> bool {
        self.flags & 0x8000 != 0
    }
    /// File flag 0x1000 (runtime 0x2000): the head quad lies flat in the emitter's model XY plane,
    /// the ±1 unit square times the live draw matrix, spinning about its normal (`0x7b2c25`,
    /// corner table `0x7b41a3`).
    pub fn xy_quad(&self) -> bool {
        self.flags & 0x1000 != 0
    }
    /// The gated twinkle size multiplier for a noise sample in [0, 1) from the caller's LUT at
    /// `twinkle_speed · age`: 1 when `min == max`.
    pub fn twinkle(&self, noise: f32) -> f32 {
        if (self.twinkle_max - self.twinkle_min).abs() < 1e-6 {
            1.0
        } else {
            noise * (self.twinkle_max - self.twinkle_min) + self.twinkle_min
        }
    }
}

const STRIDE: usize = 0x1f8;
const HDR_COUNT: usize = 0x13c;
const HDR_PTR: usize = 0x140;

fn le_u16(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
fn le_u32(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}
fn le_f32(b: &[u8], o: usize) -> f32 {
    f32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}
fn le_vec3(b: &[u8], o: usize) -> [f32; 3] {
    [le_f32(b, o), le_f32(b, o + 4), le_f32(b, o + 8)]
}

/// One raw 28-byte vanilla M2Track at `track`: absolute key times and the per-sequence `ranges`;
/// `read` decodes one `elem`-byte value.
fn read_raw_track(
    b: &[u8],
    track: usize,
    elem: usize,
    read: impl Fn(&[u8], usize) -> f32,
) -> M2ScalarTrack {
    let mut out = M2ScalarTrack {
        gseq: 0xffff,
        ..M2ScalarTrack::default()
    };
    if track + 0x1c > b.len() {
        return out;
    }
    out.interp = le_u16(b, track);
    out.gseq = le_u16(b, track + 2);
    let (rn, ro) = (le_u32(b, track + 4) as usize, le_u32(b, track + 8) as usize);
    let (tn, to) = (
        le_u32(b, track + 0x0c) as usize,
        le_u32(b, track + 0x10) as usize,
    );
    let (vn, vo) = (
        le_u32(b, track + 0x14) as usize,
        le_u32(b, track + 0x18) as usize,
    );
    if ro + rn * 8 <= b.len() {
        out.ranges = (0..rn)
            .map(|i| (le_u32(b, ro + i * 8), le_u32(b, ro + i * 8 + 4)))
            .collect();
    }
    let n = tn.min(vn);
    if n > 0 && to + n * 4 <= b.len() && vo + n * elem <= b.len() {
        out.keys = (0..n)
            .map(|i| (le_u32(b, to + i * 4), read(b, vo + i * elem)))
            .collect();
    }
    out
}

fn blend_of(v: u8) -> ParticleBlend {
    match v {
        3 | 4 => ParticleBlend::Add,
        2 | 5 | 6 => ParticleBlend::Alpha, // 5/6 (mod/mod2x): no modulate path yet
        1 => ParticleBlend::AlphaKey,
        _ => ParticleBlend::Opaque,
    }
}

fn adapted_blend_of(v: u8, modern: bool) -> ParticleBlend {
    if modern {
        match v {
            5 => return ParticleBlend::Mod,
            6 => return ParticleBlend::Mod2x,
            7 => return ParticleBlend::BlendAdd,
            _ => {}
        }
    }
    blend_of(v)
}

/// The reference's per-blend lighting table (`0x811fa8`, read at `0x70bb0a`), indexed by the raw
/// blend byte: the mod modes light nothing.
const LIGHTING_BY_BLEND: [bool; 7] = [true, true, true, true, true, false, false];

/// Whether the reference lights this emitter's quads: its synthesized per-draw material
/// (`0x70d8b0`) decides `GL_LIGHTING` as a mesh's does (`0x70baf0`, at `0x70bb00`), lit iff file
/// bit 0x1 is clear and `0x811fa8[blend]` is set. Bit 0x1 is unlit; wowdev has it inverted.
fn lit_of(flags: u32, blend_byte: u8) -> bool {
    flags & 0x1 == 0
        && LIGHTING_BY_BLEND
            .get(usize::from(blend_byte))
            .copied()
            .unwrap_or(true)
}

fn shape_of(v: u16) -> ParticleShape {
    match v {
        2 => ParticleShape::Sphere,
        3 => ParticleShape::Spline,
        _ => ParticleShape::Plane,
    }
}

/// The vanilla M2's particle emitters, textures resolved through `benilla-m2`'s textures table;
/// empty for a model with none or a file that is not MD20.
pub fn parse_m2_particle_emitters(bytes: &[u8]) -> Result<Vec<ParticleEmitterDef>> {
    let textures: Vec<Option<String>> = match parse_m2(&mut Cursor::new(bytes)) {
        Ok(fmt) => fmt
            .model()
            .textures
            .iter()
            .map(|t| {
                let f = t
                    .filename
                    .string
                    .to_string_lossy()
                    .trim_end_matches('\0')
                    .to_string();
                (!f.is_empty()).then_some(f)
            })
            .collect(),
        Err(_) => Vec::new(),
    };

    if bytes.len() < HDR_PTR + 4 || &bytes[..4] != b"MD20" {
        return Ok(Vec::new());
    }
    let count = le_u32(bytes, HDR_COUNT) as usize;
    let base = le_u32(bytes, HDR_PTR) as usize;
    if count == 0 || count > 256 || base + count * STRIDE > bytes.len() {
        return Ok(Vec::new());
    }

    let mut variations = vec![(0.0, 0.0); count];
    let mut cell_curves = vec![(Vec::new(), Vec::new()); count];
    let mut life_curves = vec![(Vec::new(), Vec::new(), Vec::new()); count];
    let mut modern_variations = vec![None; count];
    let mut modern_materials = vec![None; count];
    let mut vector_gravity_tracks: Vec<Option<[M2ScalarTrack; 3]>> = vec![None; count];
    if bytes.len() >= 12 {
        let magic = &bytes[bytes.len() - 12..bytes.len() - 8];
        if matches!(
            magic,
            b"PFPV" | b"PFP2" | b"PFP3" | b"PFP4" | b"PFP5" | b"PFP6"
        ) {
            let offset = le_u32(bytes, bytes.len() - 8) as usize;
            let entries = le_u32(bytes, bytes.len() - 4) as usize;
            let stride = if magic == b"PFP6" {
                248
            } else if magic == b"PFP5" {
                160
            } else if magic == b"PFP4" {
                76
            } else if magic == b"PFP3" {
                48
            } else if magic == b"PFP2" {
                24
            } else {
                8
            };
            anyhow::ensure!(
                entries == count && offset.checked_add(count * stride) == Some(bytes.len() - 12),
                "invalid Classic particle variation table"
            );
            for (i, value) in variations.iter_mut().enumerate() {
                let at = offset + i * stride;
                *value = (le_f32(bytes, at), le_f32(bytes, at + 4));
                anyhow::ensure!(
                    value.0.is_finite() && value.1.is_finite() && value.0 >= 0.0 && value.1 >= 0.0,
                    "invalid Classic particle variation"
                );
                if stride >= 76 {
                    let values: [f32; 7] = std::array::from_fn(|i| le_f32(bytes, at + 48 + i * 4));
                    anyhow::ensure!(
                        values.iter().all(|v| v.is_finite()),
                        "invalid modern particle variation"
                    );
                    modern_variations[i] = Some(values);
                }
                if stride >= 48 {
                    fn curve<const N: usize>(
                        bytes: &[u8],
                        field: usize,
                        limit: usize,
                    ) -> Result<Vec<[f32; N]>> {
                        let n = le_u32(bytes, field) as usize;
                        let p = le_u32(bytes, field + 4) as usize;
                        anyhow::ensure!(
                            n <= 64 && p.checked_add(n * N * 4).is_some_and(|end| end <= limit),
                            "invalid modern lifetime curve bounds"
                        );
                        let mut keys: Vec<[f32; N]> = Vec::new();
                        for j in 0..n {
                            let key = std::array::from_fn(|i| le_f32(bytes, p + (j * N + i) * 4));
                            anyhow::ensure!(
                                key.iter().all(|v| v.is_finite())
                                    && (0.0..=1.0).contains(&key[0])
                                    && keys.last().is_none_or(|prev| prev[0] <= key[0]),
                                "invalid modern lifetime curve key"
                            );
                            keys.push(key);
                        }
                        Ok(keys)
                    }
                    life_curves[i] = (
                        curve(bytes, at + 24, offset)?,
                        curve(bytes, at + 32, offset)?,
                        curve(bytes, at + 40, offset)?,
                    );
                    if stride >= 160 {
                        let flags = le_u32(bytes, at + 76);
                        let material = ModernParticleMaterial {
                            flags,
                            textures: std::array::from_fn(|j| {
                                textures
                                    .get(le_u32(bytes, at + 80 + j * 4) as usize)
                                    .cloned()
                                    .flatten()
                            }),
                            uv_scale: std::array::from_fn(|j| le_f32(bytes, at + 92 + j * 4)),
                            uv_velocity: std::array::from_fn(|j| {
                                std::array::from_fn(|k| le_f32(bytes, at + 100 + j * 8 + k * 4))
                            }),
                            uv_velocity_variation: std::array::from_fn(|j| {
                                std::array::from_fn(|k| le_f32(bytes, at + 116 + j * 8 + k * 4))
                            }),
                            color_multiplier: le_f32(bytes, at + 132),
                            alpha_multiplier: le_f32(bytes, at + 136),
                            alpha_cutoff: curve(bytes, at + 140, offset)?,
                            z_source: (le_u32(bytes, at + 156) != 0)
                                .then(|| le_f32(bytes, at + 148)),
                        };
                        anyhow::ensure!(
                            material
                                .uv_scale
                                .iter()
                                .chain(material.uv_velocity.iter().flatten())
                                .chain(material.uv_velocity_variation.iter().flatten())
                                .chain([&material.color_multiplier, &material.alpha_multiplier])
                                .all(|v| v.is_finite())
                                && material.z_source.is_none_or(f32::is_finite),
                            "invalid modern particle material values"
                        );
                        anyhow::ensure!(
                            !material.multi_texture()
                                || (le_u32(bytes, at + 152) == 0
                                    && material.textures.iter().all(Option::is_some)),
                            "unsupported or unresolved modern particle texture stages"
                        );
                        modern_materials[i] = Some(material);
                    }
                    if stride == 248 {
                        let marker = le_u32(bytes, at + 160);
                        anyhow::ensure!(marker <= 1, "invalid modern vector gravity marker");
                        if marker == 1 {
                            for axis in 0..3 {
                                let track = at + 164 + axis * 28;
                                anyhow::ensure!(
                                    le_u16(bytes, track) <= 1,
                                    "unsupported modern vector gravity interpolation"
                                );
                                for (field, element) in [(4, 8usize), (12, 4), (20, 4)] {
                                    let n = le_u32(bytes, track + field) as usize;
                                    let p = le_u32(bytes, track + field + 4) as usize;
                                    anyhow::ensure!(
                                        p.checked_add(n.saturating_mul(element))
                                            .is_some_and(|end| end <= offset),
                                        "invalid modern vector gravity track bounds"
                                    );
                                }
                                let n = le_u32(bytes, track + 20) as usize;
                                let p = le_u32(bytes, track + 24) as usize;
                                anyhow::ensure!(
                                    le_u32(bytes, track + 12) as usize == n,
                                    "modern vector gravity key counts disagree"
                                );
                                let rn = le_u32(bytes, track + 4) as usize;
                                let ro = le_u32(bytes, track + 8) as usize;
                                anyhow::ensure!(
                                    (0..rn).all(|i| {
                                        let first = le_u32(bytes, ro + i * 8) as usize;
                                        let last = le_u32(bytes, ro + i * 8 + 4) as usize;
                                        first <= last && last < n
                                    }),
                                    "invalid modern vector gravity key window"
                                );
                                anyhow::ensure!(
                                    (0..n).all(|i| le_f32(bytes, p + i * 4).is_finite()),
                                    "invalid modern vector gravity value"
                                );
                            }
                            vector_gravity_tracks[i] = Some(std::array::from_fn(|axis| {
                                read_raw_track(bytes, at + 164 + axis * 28, 4, le_f32)
                            }));
                        }
                    }
                }
                if stride >= 24 {
                    let (head, tail) = &mut cell_curves[i];
                    for (field, output) in [(at + 8, head), (at + 16, tail)] {
                        let n = le_u32(bytes, field) as usize;
                        let p = le_u32(bytes, field + 4) as usize;
                        anyhow::ensure!(
                            n <= 64 && p.checked_add(n * 8).is_some_and(|end| end <= offset),
                            "invalid Classic flipbook array"
                        );
                        for j in 0..n {
                            let key = [le_f32(bytes, p + j * 8), le_f32(bytes, p + j * 8 + 4)];
                            anyhow::ensure!(
                                key.iter().all(|v| v.is_finite())
                                    && (0.0..=1.0).contains(&key[0])
                                    && key[1] >= 0.0,
                                "invalid Classic flipbook key"
                            );
                            anyhow::ensure!(
                                output
                                    .last()
                                    .is_none_or(|previous: &[f32; 2]| previous[0] <= key[0]),
                                "unordered Classic flipbook keys"
                            );
                            output.push(key);
                        }
                    }
                }
            }
        }
    }

    // Each sequence's band and loop flag (flags bit 0 clear loops); a model with none gets one
    // whole-timeline slot so its tracks still bake.
    let mut seq_slots: Vec<SeqSlot> = {
        let (n, o) = (le_u32(bytes, 0x1c) as usize, le_u32(bytes, 0x20) as usize);
        (0..n)
            .map_while(|i| {
                let e = o + i * 0x44;
                (e + 0x44 <= bytes.len()).then(|| SeqSlot {
                    index: i,
                    band: (le_u32(bytes, e + 0x04), le_u32(bytes, e + 0x08)),
                    looping: le_u32(bytes, e + 0x10) & 1 == 0,
                })
            })
            .collect()
    };
    if seq_slots.is_empty() {
        seq_slots.push(SeqSlot {
            index: 0,
            band: (0, u32::MAX),
            looping: true,
        });
    }
    // Global-sequence durations (header +0x14/+0x18): a gseq-tagged track loops on its own clock.
    let gseq: Vec<u32> = {
        let (n, o) = (le_u32(bytes, 0x14) as usize, le_u32(bytes, 0x18) as usize);
        (0..n)
            .map_while(|i| (o + i * 4 + 4 <= bytes.len()).then(|| le_u32(bytes, o + i * 4)))
            .collect()
    };

    let color_key = |o: usize| -> [f32; 4] {
        let v = le_u32(bytes, o);
        [
            ((v >> 16) & 0xff) as f32 / 255.0, // R
            ((v >> 8) & 0xff) as f32 / 255.0,  // G
            (v & 0xff) as f32 / 255.0,         // B
            ((v >> 24) & 0xff) as f32 / 255.0, // A
        ]
    };

    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let e = base + i * STRIDE;
        let tex_index = le_u16(bytes, e + 0x16) as usize;
        let texture = textures.get(tex_index).cloned().flatten();
        let shape = shape_of(le_u16(bytes, e + 0x2a));
        // The geometry and recursion model paths (`M2Array<char>`, file-relative offsets).
        let model_path = |cnt_off: usize| -> Option<String> {
            let n = le_u32(bytes, e + cnt_off) as usize;
            let ofs = le_u32(bytes, e + cnt_off + 4) as usize;
            if n < 2 || ofs + n > bytes.len() {
                return None;
            }
            let s = String::from_utf8_lossy(&bytes[ofs..ofs + n])
                .trim_end_matches('\0')
                .to_string();
            (!s.is_empty()).then_some(s)
        };
        let geometry_model = model_path(0x18);
        let recursion_model = model_path(0x20);
        let spline = (shape == ParticleShape::Spline)
            .then(|| {
                let q = le_u32(bytes, e + 0x1d4) as usize;
                let ofs = le_u32(bytes, e + 0x1d8) as usize;
                let n = 3 * (q / 3) + 1;
                if q < 3 || ofs + n * 12 > bytes.len() {
                    return None;
                }
                SplineData::new((0..n).map(|p| le_vec3(bytes, ofs + p * 12)).collect())
            })
            .flatten();
        let tiles = match (le_u16(bytes, e + 0x30), le_u16(bytes, e + 0x32)) {
            (r, c) if r.is_power_of_two() && c.is_power_of_two() => (r, c),
            _ => (1, 1),
        };
        let over_life = OverLife {
            mid: le_f32(bytes, e + 0x14c),
            color: [
                color_key(e + 0x150),
                color_key(e + 0x154),
                color_key(e + 0x158),
            ],
            scale: [
                le_f32(bytes, e + 0x15c),
                le_f32(bytes, e + 0x160),
                le_f32(bytes, e + 0x164),
            ],
            // Ten u16s at +0x168..+0x17b (`0x70ebd0`), a repeat count after each head pair, not
            // the eight wowdev's `*UVAnim` names imply.
            head_cells: [
                CellRamp::new(le_u16(bytes, e + 0x168), le_u16(bytes, e + 0x16a)),
                CellRamp::new(le_u16(bytes, e + 0x16e), le_u16(bytes, e + 0x170)),
            ],
            tail_cells: [
                CellRamp::new(le_u16(bytes, e + 0x174), le_u16(bytes, e + 0x176)),
                CellRamp::new(le_u16(bytes, e + 0x178), le_u16(bytes, e + 0x17a)),
            ],
            repeat: [
                f32::from(le_u16(bytes, e + 0x16c)),
                f32::from(le_u16(bytes, e + 0x172)),
            ],
        };
        out.push(ParticleEmitterDef {
            modern_material: modern_materials[i].take(),
            modern_variation: modern_variations[i],
            life_color_curve: life_curves[i].0.clone(),
            life_alpha_curve: life_curves[i].1.clone(),
            life_scale_curve: life_curves[i].2.clone(),
            head_cell_curve: cell_curves[i].0.clone(),
            tail_cell_curve: cell_curves[i].1.clone(),
            lifespan_variation: variations[i].0,
            emission_rate_variation: variations[i].1,
            flags: le_u32(bytes, e + 0x04),
            position: le_vec3(bytes, e + 0x08),
            bone: le_u16(bytes, e + 0x14),
            shape,
            spline,
            geometry_model,
            recursion_model,
            blend: adapted_blend_of(bytes[e + 0x28], modern_variations[i].is_some()),
            lit: lit_of(le_u32(bytes, e + 0x04), bytes[e + 0x28]),
            texture,
            tile_rows: tiles.0,
            tile_cols: tiles.1,
            head_tail: bytes[e + 0x2c],
            timing: EmitTiming::bake(
                &read_raw_track(bytes, e + 0xdc, 4, le_f32),
                &read_raw_track(bytes, e + 0x1dc, 1, |b, o| f32::from(b[o] != 0)),
                &seq_slots,
                &gseq,
            ),
            params: EmitParams::bake(
                [
                    &read_raw_track(bytes, e + 0x34, 4, le_f32),  // speed
                    &read_raw_track(bytes, e + 0x50, 4, le_f32),  // speedVar
                    &read_raw_track(bytes, e + 0x6c, 4, le_f32),  // latitude
                    &read_raw_track(bytes, e + 0x88, 4, le_f32),  // longitude
                    &read_raw_track(bytes, e + 0xa4, 4, le_f32),  // gravity
                    &read_raw_track(bytes, e + 0xc0, 4, le_f32),  // lifespan
                    &read_raw_track(bytes, e + 0xf8, 4, le_f32),  // areaLength
                    &read_raw_track(bytes, e + 0x114, 4, le_f32), // areaWidth
                    &read_raw_track(bytes, e + 0x130, 4, le_f32), // zSource
                ],
                &seq_slots,
                &gseq,
            )
            .with_vector_gravity(vector_gravity_tracks[i].as_ref(), &seq_slots, &gseq),
            drag: le_f32(bytes, e + 0x194),
            tail_time: le_f32(bytes, e + 0x17c),
            angular_velocity_min: le_vec3(bytes, e + 0x19c),
            angular_velocity_max: le_vec3(bytes, e + 0x1a8),
            inherit_scale: le_f32(bytes, e + 0x190),
            follow_speed1: le_f32(bytes, e + 0x1c4),
            follow_scale1: le_f32(bytes, e + 0x1c8),
            follow_speed2: le_f32(bytes, e + 0x1cc),
            follow_scale2: le_f32(bytes, e + 0x1d0),
            twinkle_speed: le_f32(bytes, e + 0x180),
            twinkle_percent: le_f32(bytes, e + 0x184),
            twinkle_min: le_f32(bytes, e + 0x188),
            twinkle_max: le_f32(bytes, e + 0x18c),
            spin: le_f32(bytes, e + 0x198),
            over_life,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod classic_tests {
    use super::*;
    #[test]
    fn modern_packed_gravity_real_models() {
        let Some(root) = std::env::var_os("PULLFICTION_PACKED_GRAVITY_FIXTURES") else {
            eprintln!("real-model check requires PULLFICTION_PACKED_GRAVITY_FIXTURES");
            return;
        };
        let root = std::path::PathBuf::from(root);
        for model in [1367069, 1367070, 1367253, 1722376] {
            let bytes = std::fs::read(root.join(format!("{model}.m2"))).unwrap();
            let defs = parse_m2_particle_emitters(&bytes).unwrap();
            let expected: &[(usize, [f32; 3])] = if model == 1722376 {
                &[(1, [6.8548656, 0., -0.8619167])]
            } else {
                &[
                    (3, [0., -0.2914005, 0.6123709]),
                    (4, [0., -0.48213536, 0.47692546]),
                ]
            };
            for &(emitter, vector) in expected {
                let actual = defs[emitter].params.vector_gravity(None, 0., 0.).unwrap();
                for axis in 0..3 {
                    assert!(
                        (actual[axis] - vector[axis]).abs() < 1e-6,
                        "model{model}, emitter{emitter}, axis{axis}"
                    );
                }
            }
        }
    }

    #[test]
    fn modern_vector_gravity_footer_preserves_sequence_and_global_clocks() {
        fn put(bytes: &mut [u8], at: usize, value: u32) {
            bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
        }
        let mut bytes = vec![0u8; 0x144 + STRIDE];
        bytes[..4].copy_from_slice(b"MD20");
        put(&mut bytes, 4, 256);
        put(&mut bytes, HDR_COUNT, 1);
        put(&mut bytes, HDR_PTR, 0x144);
        let sequences = bytes.len();
        bytes.resize(sequences + 2 * 0x44, 0);
        put(&mut bytes, 0x1c, 2);
        put(&mut bytes, 0x20, sequences as u32);
        for (i, start) in [1000, 3000].into_iter().enumerate() {
            put(&mut bytes, sequences + i * 0x44 + 4, start);
            put(&mut bytes, sequences + i * 0x44 + 8, start + 1000);
            put(&mut bytes, sequences + i * 0x44 + 16, 1); // one-shot bands
        }
        let global = bytes.len();
        bytes.extend(1000u32.to_le_bytes());
        put(&mut bytes, 0x14, 1);
        put(&mut bytes, 0x18, global as u32);
        let ranges = bytes.len();
        for value in [0u32, 1, 2, 3] {
            bytes.extend(value.to_le_bytes());
        }
        let times = bytes.len();
        for value in [1000u32, 2000, 3000, 4000] {
            bytes.extend(value.to_le_bytes());
        }
        let values = bytes.len();
        for axis in 0..3 {
            for value in [axis as f32 * 2., axis as f32 * 2. + 2., -4., -8.] {
                bytes.extend(value.to_le_bytes());
            }
        }
        let table = bytes.len();
        bytes.resize(table + 248, 0);
        put(&mut bytes, table + 160, 1);
        for axis in 0..3 {
            let at = table + 164 + axis * 28;
            bytes[at..at + 2].copy_from_slice(&1u16.to_le_bytes());
            bytes[at + 2..at + 4].copy_from_slice(&u16::MAX.to_le_bytes());
            for (field, value) in [
                (4, 2),
                (8, ranges as u32),
                (12, 4),
                (16, times as u32),
                (20, 4),
                (24, (values + axis * 16) as u32),
            ] {
                put(&mut bytes, at + field, value);
            }
        }
        bytes.extend(b"PFP6");
        bytes.extend((table as u32).to_le_bytes());
        bytes.extend(1u32.to_le_bytes());
        let defs = parse_m2_particle_emitters(&bytes).unwrap();
        assert_eq!(
            defs[0].params.vector_gravity(Some(0), 0.5, 17.),
            Some([1., 3., 5.])
        );
        assert_eq!(
            defs[0].params.vector_gravity(Some(1), 0.5, 17.),
            Some([-6.; 3])
        );
        assert_eq!(
            defs[0].params.vector_gravity(Some(1), 3., 17.),
            Some([-8.; 3])
        );
        // Global clocks ignore the selected clip and sample the instance's shared age.
        for (i, value) in [0u32, 1000, 2000, 3000].into_iter().enumerate() {
            put(&mut bytes, times + i * 4, value);
        }
        for axis in 0..3 {
            bytes[table + 166 + axis * 28..table + 168 + axis * 28].fill(0);
        }
        let defs = parse_m2_particle_emitters(&bytes).unwrap();
        assert_eq!(
            defs[0].params.vector_gravity(Some(1), 0.9, 1.25),
            Some([0.5, 2.5, 4.5])
        );
        put(&mut bytes, table + 188, u32::MAX);
        assert!(
            parse_m2_particle_emitters(&bytes).is_err(),
            "invalid explicit vector tracks are terminal errors"
        );
    }

    #[test]
    fn modern_multitexture_footer_preserves_stages_and_lifetime_materials() {
        let mut bytes = vec![0u8; 0x144 + STRIDE];
        bytes[..4].copy_from_slice(b"MD20");
        bytes[4..8].copy_from_slice(&256u32.to_le_bytes());
        bytes[HDR_COUNT..HDR_COUNT + 4].copy_from_slice(&1u32.to_le_bytes());
        bytes[HDR_PTR..HDR_PTR + 4].copy_from_slice(&0x144u32.to_le_bytes());
        bytes[0x144 + 0x2a..0x144 + 0x2c].copy_from_slice(&1u16.to_le_bytes());
        for i in 0..3 {
            bytes[0x144 + 336 + i * 4..0x144 + 340 + i * 4]
                .copy_from_slice(&u32::MAX.to_le_bytes());
        }
        let texture_table = bytes.len();
        bytes.resize(bytes.len() + 48, 0);
        bytes[0x5c..0x60].copy_from_slice(&3u32.to_le_bytes());
        bytes[0x60..0x64].copy_from_slice(&(texture_table as u32).to_le_bytes());
        for i in 0..3 {
            let path = format!("stage{i}.blp\0");
            let at = bytes.len() as u32;
            bytes.extend(path.as_bytes());
            bytes[texture_table + i * 16 + 8..texture_table + i * 16 + 12]
                .copy_from_slice(&(path.len() as u32).to_le_bytes());
            bytes[texture_table + i * 16 + 12..texture_table + i * 16 + 16]
                .copy_from_slice(&at.to_le_bytes());
        }
        let cutoff = bytes.len() as u32;
        for value in [0f32, 0.25, 1., 0.75] {
            bytes.extend(value.to_le_bytes());
        }
        let table = bytes.len();
        bytes.resize(table + 160, 0);
        let put_u32 = |bytes: &mut [u8], at: usize, value: u32| {
            bytes[at..at + 4].copy_from_slice(&value.to_le_bytes())
        };
        let put_f32 = |bytes: &mut [u8], at: usize, value: f32| {
            bytes[at..at + 4].copy_from_slice(&value.to_le_bytes())
        };
        for (at, value) in [
            (76, 0x70830021),
            (80, 0),
            (84, 1),
            (88, 2),
            (140, 2),
            (144, cutoff),
            (156, 1),
        ] {
            put_u32(&mut bytes, table + at, value);
        }
        for (at, value) in [
            (92, 1.),
            (96, 0.5),
            (100, -25. / 512.),
            (132, 1.5),
            (136, 0.75),
            (148, 2.5),
        ] {
            put_f32(&mut bytes, table + at, value);
        }
        bytes.extend(b"PFP5");
        bytes.extend((table as u32).to_le_bytes());
        bytes.extend(1u32.to_le_bytes());
        let defs = parse_m2_particle_emitters(&bytes).unwrap();
        let material = defs[0].modern_material.as_ref().unwrap();
        assert_eq!(
            material.textures,
            std::array::from_fn(|i| Some(format!("stage{i}.blp")))
        );
        assert_eq!(material.uv_velocity[0][0], -25. / 512.);
        assert_eq!(material.shader_mode(), 7.);
        assert_eq!(material.cutoff(0.5), 0.5);
        assert_eq!(material.z_source, Some(2.5));
        assert_eq!(defs[0].sample_life(0.5).color, [1.5, 1.5, 1.5, 0.75]);
        put_u32(&mut bytes, table + 152, 1);
        assert!(
            parse_m2_particle_emitters(&bytes).is_err(),
            "unvalidated animated coordinates remain explicit"
        );
        put_u32(&mut bytes, table + 152, 0);
        put_u32(&mut bytes, table + 88, 3);
        assert!(
            parse_m2_particle_emitters(&bytes).is_err(),
            "an unresolved third stage never degrades to the first"
        );
    }
    #[test]
    fn modern_blends_are_explicit_and_do_not_change_original_particle_modes() {
        for (raw, expected) in [
            (5, ParticleBlend::Mod),
            (6, ParticleBlend::Mod2x),
            (7, ParticleBlend::BlendAdd),
        ] {
            assert_eq!(adapted_blend_of(raw, true), expected);
            assert_eq!(adapted_blend_of(raw, false), blend_of(raw));
        }
        assert_eq!(adapted_blend_of(7, false), ParticleBlend::Opaque);
        for raw in 0..5 {
            assert_eq!(adapted_blend_of(raw, true), blend_of(raw));
        }
    }

    #[test]
    fn modern_footer_selects_blends_through_the_production_parser() {
        for (raw, expected) in [
            (5, ParticleBlend::Mod),
            (6, ParticleBlend::Mod2x),
            (7, ParticleBlend::BlendAdd),
        ] {
            let mut bytes = vec![0u8; 0x144 + STRIDE];
            bytes[..4].copy_from_slice(b"MD20");
            bytes[HDR_COUNT..HDR_COUNT + 4].copy_from_slice(&1u32.to_le_bytes());
            bytes[HDR_PTR..HDR_PTR + 4].copy_from_slice(&0x144u32.to_le_bytes());
            bytes[0x144 + 0x2a..0x144 + 0x2c].copy_from_slice(&1u16.to_le_bytes());
            bytes[0x144 + 0x28] = raw;
            assert_eq!(
                parse_m2_particle_emitters(&bytes).unwrap()[0].blend,
                blend_of(raw)
            );
            let table = bytes.len() as u32;
            bytes.extend([0u8; 76]);
            bytes.extend(b"PFP4");
            bytes.extend(table.to_le_bytes());
            bytes.extend(1u32.to_le_bytes());
            assert_eq!(
                parse_m2_particle_emitters(&bytes).unwrap()[0].blend,
                expected
            );
        }
    }

    #[test]
    fn classic_footer_validates_and_samples_discontinuous_flipbooks() {
        let mut bytes = vec![0u8; 0x144 + STRIDE];
        bytes[..4].copy_from_slice(b"MD20");
        bytes[HDR_COUNT..HDR_COUNT + 4].copy_from_slice(&1u32.to_le_bytes());
        bytes[HDR_PTR..HDR_PTR + 4].copy_from_slice(&0x144u32.to_le_bytes());
        bytes[0x144 + 0x2a..0x144 + 0x2c].copy_from_slice(&1u16.to_le_bytes());
        let keys = bytes.len() as u32;
        for key in [[0.0f32, 0.0f32], [0.5, 7.0], [0.5, 8.0], [1.0, 16.0]] {
            for value in key {
                bytes.extend(value.to_le_bytes());
            }
        }
        let table = bytes.len() as u32;
        for value in [0.5f32, 10.0] {
            bytes.extend(value.to_le_bytes());
        }
        for value in [4u32, keys, 0, 0] {
            bytes.extend(value.to_le_bytes());
        }
        bytes.extend(b"PFP2");
        bytes.extend(table.to_le_bytes());
        bytes.extend(1u32.to_le_bytes());
        let defs = parse_m2_particle_emitters(&bytes).unwrap();
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].lifespan_variation, 0.5);
        assert_eq!(defs[0].emission_rate_variation, 10.0);
        assert_eq!(defs[0].sample_life(0.25).head_cell, 3);
        assert_eq!(defs[0].sample_life(0.5).head_cell, 8);
        assert_eq!(defs[0].sample_life(0.75).head_cell, 12);
        let end = bytes.len();
        bytes[end - 8..end - 4].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(parse_m2_particle_emitters(&bytes).is_err());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bit_one_is_the_unlit_flag_and_mod_blends_never_light() {
        // The Elwynn waterfall: bit 0x1 clear, blend 2 (alpha), so the scene lights it.
        assert!(
            lit_of(0x0002, 2),
            "an emitter that CLEARS 0x1 takes the light"
        );
        // The Orgrimmar bonfire's flame (0x29) and smoke (0x21) set 0x1, so both are unlit.
        assert!(!lit_of(0x0029, 4), "0x1 set: unlit, whatever the blend");
        assert!(!lit_of(0x0021, 2));
        for blend in 0u8..=4 {
            assert!(lit_of(0x0000, blend), "blend {blend} lights");
        }
        assert!(!lit_of(0x0000, 5), "Mod never lights");
        assert!(!lit_of(0x0000, 6), "Mod2x never lights");
        // A byte past the 7-entry table folds to `Opaque`, which lights.
        assert!(lit_of(0x0000, 7));
    }

    #[test]
    fn the_waterfall_emitter_is_lit() {
        let data = crate::wow_data_or_skip!();
        let mut chain = crate::open_chain(&data).expect("open chain");
        let bytes = chain
            .read_file(
                "World\\Azeroth\\Elwynn\\PassiveDoodads\\Waterfall\\ElwynnTallWaterfall01.m2",
            )
            .expect("read ElwynnTallWaterfall01.m2");
        let defs = parse_m2_particle_emitters(&bytes).expect("parse emitters");
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].flags, 0x0002, "authored flag word");
        assert_eq!(defs[0].blend, ParticleBlend::Alpha);
        assert!(defs[0].lit, "the spray sheet is shaded by the world");
    }

    /// Straight segments of 1 and 3 yd (control points at thirds, so each cubic is linear) put
    /// the boundary at t = 0.25, not 0.5.
    #[test]
    fn spline_chain_is_arc_length_parameterized() {
        let x = |v: f32| [v, 0.0, 0.0];
        let s = SplineData::new(vec![
            x(0.0),
            x(1.0 / 3.0),
            x(2.0 / 3.0),
            x(1.0), // segment 0: 1 yd
            x(2.0),
            x(3.0),
            x(4.0), // segment 1: 3 yd
        ])
        .expect("3K+1 chain");
        assert!((s.eval(0.25)[0] - 1.0).abs() < 1e-4, "boundary at arc 1/4");
        assert!((s.eval(0.625)[0] - 2.5).abs() < 1e-4, "mid of segment 1");
        assert_eq!(s.eval(-0.5), [0.0, 0.0, 0.0], "clamp to first point");
        assert_eq!(s.eval(1.5), [4.0, 0.0, 0.0], "clamp to last point");
        let tan = s.tangent(0.1);
        assert!(tan[0] > 0.0 && tan[1] == 0.0 && tan[2] == 0.0, "+X tangent");
        assert!(SplineData::new(vec![x(0.0)]).is_none(), "below one segment");
    }

    /// `BloodSpurt.m2`, the melee impact flash: emitters 1 to 3 are keyed bursts.
    #[test]
    fn real_blood_spurt_emitters_are_keyed_bursts() {
        let data = crate::wow_data_or_skip!();
        let mut chain = crate::open_chain(&data).expect("open chain");
        let bytes = chain
            .read_file("Particles\\BloodSpurts\\BloodSpurt.m2")
            .expect("read BloodSpurt.m2");
        let defs = parse_m2_particle_emitters(&bytes).expect("parse emitters");
        assert_eq!(defs.len(), 4);
        // Emitter 0, the red spray: 100/s at t = 0.
        assert_eq!(defs[0].timing.rate(None, 0.0, 0.0), 100.0);
        // Emitter 3, the starflash: first key 0, 20/s within 67..100 ms, 0 again by 133 ms.
        let flash = &defs[3];
        assert!(flash
            .texture
            .as_deref()
            .is_some_and(|t| t.to_ascii_uppercase().contains("STARFLASH")));
        assert_eq!(flash.blend, ParticleBlend::Add);
        assert_eq!(flash.timing.rate(None, 0.0, 0.0), 0.0, "silent at t=0");
        assert_eq!(flash.timing.peak_rate(), 20.0);
        assert_eq!(flash.timing.rate(None, 0.080, 0.0), 20.0);
        assert_eq!(flash.timing.rate(None, 0.200, 0.0), 0.0);
        // Emitters 1 and 2, the glowball droplets: the same burst shape, peaking at 200.
        assert_eq!(defs[1].timing.peak_rate(), 200.0);
        assert_eq!(defs[2].timing.peak_rate(), 200.0);
        // The spray's enabled track cuts emission at 500 ms, where its rate track goes negative.
        assert!(defs[0].timing.emitting(None, 0.4, 0.0));
        assert!(!defs[0].timing.emitting(None, 0.6, 0.0));
    }

    /// `Feint_Impact_Chest.m2`: the plume (e0) and crescents (e3) set flag 0x8000, one puff at
    /// their 67 ms key; `Eviscerate_Cast_Hands.m2` has the same 1.6 s shape with the flag clear.
    #[test]
    fn real_feint_impact_authors_burst_emitters() {
        let data = crate::wow_data_or_skip!();
        let mut chain = crate::open_chain(&data).expect("open chain");
        let impact = parse_m2_particle_emitters(
            &chain
                .read_file("Spells\\Feint_Impact_Chest.m2")
                .expect("read Feint_Impact_Chest.m2"),
        )
        .expect("parse emitters");
        assert_eq!(impact.len(), 4);
        assert!(impact[0].burst(), "plume is a one-shot burst");
        assert!(!impact[1].burst(), "lava pours (enabled window 0–333 ms)");
        assert!(!impact[2].burst(), "dust pours (enabled window 67–200 ms)");
        assert!(impact[3].burst(), "crescents are a one-shot burst");
        // A step rate: 0 before the 67 ms key, its full value from it on.
        assert_eq!(impact[0].timing.rate(None, 0.050, 0.0), 0.0);
        assert_eq!(impact[0].timing.rate(None, 0.067, 0.0), 30.0);
        assert_eq!(impact[0].timing.rate(None, 1.500, 0.0), 30.0);
        let cast = parse_m2_particle_emitters(
            &chain
                .read_file("Spells\\Eviscerate_Cast_Hands.m2")
                .expect("read Eviscerate_Cast_Hands.m2"),
        )
        .expect("parse emitters");
        assert!(
            cast.iter().all(|e| !e.burst()),
            "the cast-hands flame is continuous — same asset shape, opposite flag"
        );
    }

    /// `FlameStrike_Area.m2`'s four fire columns: type-3 chains of 16 and 19 points, no spin.
    #[test]
    fn real_flamestrike_authors_spline_chains() {
        let data = crate::wow_data_or_skip!();
        let mut chain = crate::open_chain(&data).expect("open chain");
        let defs = parse_m2_particle_emitters(
            &chain
                .read_file("Spells\\FlameStrike_Area.m2")
                .expect("read FlameStrike_Area.m2"),
        )
        .expect("parse emitters");
        let splines: Vec<_> = defs
            .iter()
            .filter(|d| d.shape == ParticleShape::Spline)
            .collect();
        assert_eq!(splines.len(), 4, "the four fire-column emitters");
        for d in &splines {
            let s = d.spline.as_ref().expect("chain parses");
            assert_eq!(s.points.len() % 3, 1, "3K+1 control points");
            assert!(s.points.len() >= 16);
            let now = d.params.sample(None, 0.0, 0.0);
            assert_eq!(now.area_length, 0.0, "tMin");
            assert_eq!(now.area_width, 1.0, "tMax");
            assert_eq!(now.vertical_range, 0.0, "no tangent spin");
            assert!(d.burst(), "one puff of standing flames");
            assert!(
                (5.0..15.0).contains(&s.points[0][2]),
                "z {}",
                s.points[0][2]
            );
            assert_eq!(s.eval(0.0), s.points[0], "t=0 is the first point");
        }
    }

    /// Fireball (spell 133): the cast flash is on for its clip's first 200 ms and the impact plume
    /// ramps 0 → 60 over 133 ms of clip time, though seq 0 spans [1000, 2600] of the file.
    #[test]
    fn real_fireball_effects_rebase_to_clip_time() {
        let data = crate::wow_data_or_skip!();
        let mut chain = crate::open_chain(&data).expect("open chain");
        let cast = parse_m2_particle_emitters(
            &chain
                .read_file("Spells\\Fire_Cast_Hand.m2")
                .expect("read Fire_Cast_Hand.m2"),
        )
        .expect("parse emitters");
        assert_eq!(cast.len(), 3);
        for em in &cast {
            assert!(
                em.timing.emitting(None, 0.1, 0.0),
                "the flash is ON at its start"
            );
            assert!(
                !em.timing.emitting(None, 0.25, 0.0),
                "and OFF from 200 ms — the 1.0 s clip does not burn through"
            );
        }
        let impact = parse_m2_particle_emitters(
            &chain
                .read_file("Spells\\MoltenBlast_Impact_Chest.m2")
                .expect("read MoltenBlast_Impact_Chest.m2"),
        )
        .expect("parse emitters");
        assert_eq!(impact.len(), 6);
        assert_eq!(impact[0].timing.rate(None, 0.0, 0.0), 0.0);
        assert_eq!(
            impact[0].timing.rate(None, 0.133, 0.0),
            60.0,
            "the plume bursts at impact"
        );
        assert!(impact[1].timing.emitting(None, 0.1, 0.0));
        assert!(
            !impact[1].timing.emitting(None, 0.4, 0.0),
            "shockwave window is 300 ms"
        );
        assert!(
            !impact[4].timing.emitting(None, 0.05, 0.0),
            "smoke starts staggered…"
        );
        assert!(impact[4].timing.emitting(None, 0.2, 0.0));
        assert!(
            !impact[4].timing.emitting(None, 0.7, 0.0),
            "…and ends by 567 ms"
        );
    }
}

#[cfg(test)]
mod modern_curve_tests {
    // Read the same extension as the browser renderer; independent timestamps must
    // never be forced into the original shared three-key ramp.
    use super::*;
    #[test]
    fn modern_lifetime_keys_are_not_resampled_to_a_three_key_curve() {
        let mut bytes = vec![0u8; 0x150 + 0x1f8];
        bytes[..4].copy_from_slice(b"MD20");
        bytes[4..8].copy_from_slice(&256u32.to_le_bytes());
        bytes[0x13c..0x140].copy_from_slice(&1u32.to_le_bytes());
        bytes[0x140..0x144].copy_from_slice(&0x150u32.to_le_bytes());
        // Unsupported/empty shapes are omitted before parsing life ramps; use plane.
        bytes[0x150 + 0x2a..0x150 + 0x2c].copy_from_slice(&1u16.to_le_bytes());
        let mut defs = parse_m2_particle_emitters(&bytes).unwrap();
        assert_eq!(defs.len(), 1);
        let def = &mut defs[0];
        def.life_color_curve = vec![[0., 1., 0., 0.], [0.25, 0., 1., 0.], [1., 0., 0., 1.]];
        def.life_alpha_curve = vec![[0., 0.], [0.5, 1.], [1., 0.]];
        def.life_scale_curve = vec![[0., 1., 2.], [1., 3., 6.]];
        let value = def.sample_life(0.25);
        assert_eq!(value.color, [0., 1., 0., 0.5]);
        assert_eq!(value.size, 1.5);
        assert_eq!(value.size_y, 3.);
    }
}
