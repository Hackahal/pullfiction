//! Shared editor geometry rendered by the native world and native UI passes.
use benilla_assets::coords::{bevy_to_wow, wow_to_bevy};
use benilla_world::collision::WorldCollision;
use benilla_world::view::WorldCamera;
use bevy::asset::RenderAssetUsages;
use bevy::mesh::{Indices, PrimitiveTopology};
use bevy::prelude::*;
use serde::Deserialize;
const ANNOTATION_LIFT: f32 = 0.18;

#[derive(Clone, Deserialize, PartialEq)]
pub struct Mark {
    #[serde(default)]
    pub inert: bool,
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub anchor: [f32; 3],
    #[serde(default)]
    pub paths: Vec<Vec<[f32; 3]>>,
    #[serde(default)]
    pub triangles: Vec<[f32; 3]>,
    pub color: String,
    pub width: f32,
    pub label: String,
    pub icon: String,
    pub size: f32,
    #[serde(default)]
    pub selected: bool,
    #[serde(default)]
    pub handles: Vec<[f32; 3]>,
    #[serde(default, rename = "handleKinds")]
    pub handle_kinds: Vec<String>,
    #[serde(default)]
    pub locked: bool,
    #[serde(default)]
    pub actor: Option<String>,
}
#[derive(Default, Deserialize)]
pub struct Payload {
    #[serde(default)]
    pub ranges: Vec<RangeRing>,
    #[serde(default)]
    pub marks: Vec<Mark>,
    #[serde(default)]
    pub markers: Vec<[f32; 3]>,
    #[serde(default)]
    pub route: Vec<[f32; 3]>,
}
#[derive(Default, Resource)]
pub struct Annotations {
    pub ranges: Vec<RangeRing>,
    pub marks: Vec<Mark>,
    source: Vec<Mark>,
    pub revision: u64,
}
impl Payload {
    pub fn valid(&self) -> bool {
        let count = self
            .marks
            .iter()
            .map(|m| m.paths.iter().map(Vec::len).sum::<usize>() + m.triangles.len() + 1)
            .sum::<usize>();
        self.ranges.len() <= 80
            && self.ranges.iter().all(|r| {
                !r.key.is_empty()
                    && r.key.len() <= 80
                    && r.radius.is_finite()
                    && (1.0..=100.0).contains(&r.radius)
            })
            && self.marks.len() <= 1000
            && count <= 200000
            && self.markers.len() <= 500
            && self.route.len() <= 2000
            && self
                .markers
                .iter()
                .chain(&self.route)
                .flatten()
                .all(|v| v.is_finite() && v.abs() <= 20000.0)
            && self.marks.iter().all(|m| {
                m.id.len() <= 80
                    && m.label.len() <= 480
                    && m.color.len() == 7
                    && m.color.starts_with('#')
                    && u32::from_str_radix(&m.color[1..], 16).is_ok()
                    && m.size.is_finite()
                    && (0.5..=100.0).contains(&m.size)
                    && m.width.is_finite()
                    && (1.0..=8.0).contains(&m.width)
                    && m.triangles.len() % 3 == 0
                    && m.handles.len() <= 20000
                    && m.handles
                        .iter()
                        .flatten()
                        .all(|v| v.is_finite() && v.abs() <= 20000.)
                    && m.anchor
                        .iter()
                        .chain(m.paths.iter().flatten().flatten())
                        .chain(m.triangles.iter().flatten())
                        .all(|v| v.is_finite() && v.abs() <= 20000.0)
                    && m.icon.len() <= 120
                    && m.icon
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_')
            })
    }
}
impl Annotations {
    pub fn replace(&mut self, mut p: Payload) {
        for (i, point) in p.markers.into_iter().enumerate() {
            p.marks.push(Mark {
                inert: false,
                id: format!("legacy-{i}"),
                kind: "marker".into(),
                anchor: point,
                paths: vec![],
                triangles: vec![],
                color: "#edc66d".into(),
                width: 3.,
                label: format!("{}", i + 1),
                icon: "8".into(),
                size: 5.,
                selected: false,
                handles: vec![],
                handle_kinds: vec![],
                locked: false,
                actor: None,
            });
        }
        if !p.route.is_empty() {
            p.marks.push(Mark {
                inert: false,
                id: "legacy-route".into(),
                kind: "route".into(),
                anchor: p.route[0],
                paths: vec![p.route],
                triangles: vec![],
                color: "#65c6b4".into(),
                width: 3.,
                label: String::new(),
                icon: "8".into(),
                size: 5.,
                selected: false,
                handles: vec![],
                handle_kinds: vec![],
                locked: false,
                actor: None,
            });
        }
        // Live range colours must not rebuild terrain-conformed plan meshes.
        self.ranges = p.ranges;
        if self.source != p.marks {
            self.source = p.marks.clone();
            self.marks = p.marks;
            self.revision += 1;
        }
    }
    pub fn conform(&mut self, world: &WorldCollision) {
        self.marks = self.source.clone();
        for mark in &mut self.marks {
            mark.anchor = ground(mark.anchor, world);
            for p in &mut mark.handles {
                *p = ground(*p, world);
            }
            let mut samples = std::collections::HashMap::new();
            let mut sample = |p: [f32; 3]| {
                *samples
                    .entry(p.map(f32::to_bits))
                    .or_insert_with(|| ground_sample(p, world))
            };
            mark.paths = crate::surface_geometry::paths(&mark.paths, &mut sample);
            let original = std::mem::take(&mut mark.triangles);
            for tri in original.chunks_exact(3) {
                crate::surface_geometry::triangle(
                    [tri[0], tri[1], tri[2]],
                    &mut sample,
                    0,
                    &mut mark.triangles,
                );
            }
        }
        self.revision += 1;
    }

    pub fn handle_hit(
        &self,
        camera: &Camera,
        xf: &GlobalTransform,
        p: Vec2,
    ) -> Option<(&str, usize)> {
        for mark in self.marks.iter().rev().filter(|m| m.selected && !m.locked) {
            for (i, handle) in mark.handles.iter().enumerate() {
                if camera
                    .world_to_viewport(xf, wow_to_bevy(*handle) + Vec3::Y * 0.20)
                    .is_ok_and(|q| q.distance(p) < 12.)
                {
                    return Some((&mark.id, i));
                }
            }
        }
        None
    }
    pub fn update_actor_anchors(&mut self, actors: &Query<(&crate::ReplayBody, &GlobalTransform)>) {
        for mark in &mut self.marks {
            if let Some(key) = &mark.actor {
                if let Some((body, xf)) = actors.iter().find(|(a, _)| &a.key == key) {
                    mark.anchor = benilla_assets::coords::bevy_to_wow(
                        xf.translation() + Vec3::Y * (body.label_height - 2.).max(0.),
                    );
                }
            }
        }
    }
    pub fn box_hits(&self, camera: &Camera, xf: &GlobalTransform, a: Vec2, b: Vec2) -> Vec<String> {
        let min = a.min(b);
        let max = a.max(b);
        let project = |p: [f32; 3], lift: f32| {
            camera
                .world_to_viewport(xf, wow_to_bevy(p) + Vec3::Y * lift)
                .ok()
        };
        let inside = |p: Vec2| p.cmpge(min).all() && p.cmple(max).all();
        self.marks
            .iter()
            .filter(|m| !m.inert)
            .filter(|m| {
                project(
                    m.anchor,
                    if m.kind == "marker" {
                        3.
                    } else {
                        ANNOTATION_LIFT
                    },
                )
                .is_some_and(inside)
                    || m.paths.iter().any(|path| {
                        path.windows(2).any(|e| {
                            let (Some(a), Some(b)) = (
                                project(e[0], ANNOTATION_LIFT),
                                project(e[1], ANNOTATION_LIFT),
                            ) else {
                                return false;
                            };
                            let mut lo = 0.0f32;
                            let mut hi = 1.0f32;
                            for axis in 0..2 {
                                let d = b[axis] - a[axis];
                                if d.abs() < 0.0001 {
                                    if a[axis] < min[axis] || a[axis] > max[axis] {
                                        return false;
                                    }
                                } else {
                                    let u = (min[axis] - a[axis]) / d;
                                    let v = (max[axis] - a[axis]) / d;
                                    lo = lo.max(u.min(v));
                                    hi = hi.min(u.max(v));
                                    if lo > hi {
                                        return false;
                                    }
                                }
                            }
                            true
                        })
                    })
            })
            .map(|m| m.id.clone())
            .collect()
    }
    pub fn hit(&self, camera: &Camera, xf: &GlobalTransform, p: Vec2) -> Option<&str> {
        self.hits(camera, xf, p).into_iter().next()
    }
    pub fn hits(&self, camera: &Camera, xf: &GlobalTransform, p: Vec2) -> Vec<&str> {
        let mut hits = Vec::new();
        let screen = |p: [f32; 3], lift: f32| {
            camera
                .world_to_viewport(xf, wow_to_bevy(p) + Vec3::Y * lift)
                .ok()
        };
        for mark in self.marks.iter().rev().filter(|m| !m.inert) {
            if ["marker", "label"].contains(&mark.kind.as_str())
                && screen(
                    mark.anchor,
                    if mark.kind == "marker" {
                        3.0
                    } else {
                        ANNOTATION_LIFT + 0.6
                    },
                )
                .is_some_and(|q| q.distance(p) < 20.)
            {
                hits.push(mark.id.as_str());
                continue;
            }
            if mark.kind == "marker"
                && screen(mark.anchor, ANNOTATION_LIFT).is_some_and(|q| q.distance(p) < 18.)
            {
                hits.push(mark.id.as_str());
                continue;
            }
            if mark.paths.iter().any(|path| {
                path.windows(2).any(|v| {
                    let (Some(a), Some(b)) =
                        (screen(v[0], ANNOTATION_LIFT), screen(v[1], ANNOTATION_LIFT))
                    else {
                        return false;
                    };
                    let delta = b - a;
                    let u = if delta.length_squared() > 0.0 {
                        ((p - a).dot(delta) / delta.length_squared()).clamp(0., 1.)
                    } else {
                        0.
                    };
                    (a + delta * u).distance(p) < 9.
                })
            }) {
                hits.push(mark.id.as_str());
                continue;
            }
        }
        hits
    }
}
fn ground_sample(p: [f32; 3], world: &WorldCollision) -> Option<[f32; 3]> {
    let quick = wow_to_bevy(p) + Vec3::Y * 2.;
    if let Some(hit) = world.ray_body(quick, Dir3::NEG_Y, 4.) {
        let at = bevy_to_wow(quick + Vec3::NEG_Y * hit.distance);
        if hit.normal.y > 0.25 {
            return Some(at);
        }
    }

    let mut origin = wow_to_bevy(p) + Vec3::Y * 24.;
    let bottom = origin.y - 48.;
    let mut best: Option<[f32; 3]> = None;
    for _ in 0..6 {
        let Some(hit) = world.ray_body(origin, Dir3::NEG_Y, (origin.y - bottom).max(0.)) else {
            break;
        };
        let point = origin + Vec3::NEG_Y * hit.distance;
        if hit.normal.y > 0.25 {
            let at = benilla_assets::coords::bevy_to_wow(point);
            if best.is_none_or(|old| (at[2] - p[2]).abs() < (old[2] - p[2]).abs()) {
                best = Some(at);
            }
            if (at[2] - p[2]).abs() < 0.08 {
                return best;
            }
        }
        origin.y = point.y - 0.05;
        if origin.y <= bottom {
            break;
        }
    }
    best
}

fn ground(p: [f32; 3], world: &WorldCollision) -> [f32; 3] {
    ground_sample(p, world).unwrap_or(p)
}
#[derive(Default, Resource)]
pub struct Interaction {
    pub editing: bool,
    pub hover: Option<String>,
    pub hover_handle: Option<usize>,
    pub point: Option<[f32; 3]>,
    pub placing: bool,
}
#[derive(Component)]
struct Follow {
    key: Option<String>,
    origin: Vec3,
    base: Vec3,
    head: bool,
}
fn follower(mark: &Mark, base: Vec3, head: bool) -> Follow {
    Follow {
        key: mark.actor.clone(),
        origin: wow_to_bevy(mark.anchor),
        base,
        head,
    }
}
fn follow_actors(
    actors: Query<(&crate::ReplayBody, &GlobalTransform)>,
    mut visuals: Query<(&Follow, &mut Transform)>,
) {
    for (f, mut transform) in &mut visuals {
        if let Some(key) = &f.key {
            if let Some((body, actor)) = actors.iter().find(|(a, _)| &a.key == key) {
                transform.translation = f.base + actor.translation() - f.origin
                    + if f.head {
                        Vec3::Y * (body.label_height - 2.).max(0.)
                    } else {
                        Vec3::ZERO
                    };
            }
        }
    }
}
#[derive(Component)]
struct Visual;
#[derive(Component)]
struct Billboard;
#[derive(Component)]
struct Caption(Vec3);
#[derive(Component)]
struct CaptionFollow(Option<String>, Vec3);
fn color(hex: &str, alpha: f32) -> Color {
    let n = u32::from_str_radix(&hex[1..], 16).unwrap_or(0xedc66d);
    Color::srgba(
        ((n >> 16) & 255) as f32 / 255.,
        ((n >> 8) & 255) as f32 / 255.,
        (n & 255) as f32 / 255.,
        alpha,
    )
}
fn mesh(vertices: Vec<[f32; 3]>, uv: Option<Vec<[f32; 2]>>) -> Mesh {
    let mut m = Mesh::new(
        PrimitiveTopology::TriangleList,
        RenderAssetUsages::default(),
    );
    let n = vertices.len();
    m.insert_attribute(Mesh::ATTRIBUTE_POSITION, vertices);
    m.insert_attribute(Mesh::ATTRIBUTE_NORMAL, vec![[0., 1., 0.]; n]);
    if let Some(uv) = uv {
        m.insert_attribute(Mesh::ATTRIBUTE_UV_0, uv);
    }
    m.insert_indices(Indices::U32((0..n as u32).collect()));
    m
}
// Feather alpha at the edges and cap every join with a radial fade.
// Geometry stays in world units so it retains depth and occlusion.
fn strip(paths: &[Vec<[f32; 3]>], width: f32, lift: f32) -> Option<Mesh> {
    let mut positions = Vec::new();
    let mut colors = Vec::new();
    // The centerline is already conformed. Feather vertices share its height;
    // a sub-yard ribbon does not need recursive collision queries of its own.
    let mut triangle = |p: [Vec3; 3], alpha: [f32; 3]| {
        positions.extend(p.map(|v| v.to_array()));
        colors.extend(alpha.map(|a| [1., 1., 1., a]));
    };
    for path in paths {
        for edge in path.windows(2) {
            let a = wow_to_bevy(edge[0]) + Vec3::Y * lift;
            let b = wow_to_bevy(edge[1]) + Vec3::Y * lift;
            let side = (b - a).cross(Vec3::Y).normalize_or_zero() * width * 0.5;
            for (lo, hi, la, ha) in [
                (-1.8, -0.7, 0., 1.),
                (-0.7, 0.7, 1., 1.),
                (0.7, 1.8, 1., 0.),
            ] {
                triangle([a + side * lo, a + side * hi, b + side * hi], [la, ha, ha]);
                triangle([a + side * lo, b + side * hi, b + side * lo], [la, ha, la]);
            }
        }
        for (index, point) in path.iter().enumerate() {
            if index > 0 && index + 1 < path.len() {
                let incoming = wow_to_bevy(*point) - wow_to_bevy(path[index - 1]);
                let outgoing = wow_to_bevy(path[index + 1]) - wow_to_bevy(*point);
                if incoming
                    .normalize_or_zero()
                    .dot(outgoing.normalize_or_zero())
                    > 0.9
                {
                    continue;
                }
            }
            let center = wow_to_bevy(*point) + Vec3::Y * lift;
            for i in 0..8 {
                let angle = i as f32 * std::f32::consts::TAU / 8.;
                let next = (i + 1) as f32 * std::f32::consts::TAU / 8.;
                let a = Vec3::new(angle.cos(), 0., angle.sin()) * width * 0.5;
                let b = Vec3::new(next.cos(), 0., next.sin()) * width * 0.5;
                triangle([center, center + a * 0.7, center + b * 0.7], [1., 1., 1.]);
                triangle(
                    [center + a * 0.7, center + a * 1.8, center + b * 1.8],
                    [1., 0., 0.],
                );
                triangle(
                    [center + a * 0.7, center + b * 1.8, center + b * 0.7],
                    [1., 0., 1.],
                );
            }
        }
    }
    if positions.is_empty() {
        return None;
    }
    let mut m = mesh(positions, None);
    m.insert_attribute(Mesh::ATTRIBUTE_COLOR, colors);
    Some(m)
}
#[derive(Component)]
struct Flow {
    path: Vec<Vec3>,
    total: f32,
    phase: f32,
}
fn flow(time: Res<Time>, mut highlights: Query<(&Flow, &mut Transform)>) {
    for (f, mut transform) in &mut highlights {
        let mut distance = (time.elapsed_secs() * 3.0 + f.phase).rem_euclid(f.total);
        for edge in f.path.windows(2) {
            let delta = edge[1] - edge[0];
            let length = delta.length();
            if distance <= length && length > 0.001 {
                transform.translation = edge[0] + delta * (distance / length);
                transform.rotation = Quat::from_rotation_y(-delta.z.atan2(delta.x));
                break;
            }
            distance -= length;
        }
    }
}

fn beacon() -> Mesh {
    let mut positions = Vec::new();
    let mut colors = Vec::new();
    let xs = [-1.3, -0.6, 0., 0.6, 1.3];
    let alphas = [0., 0.06, 0.13, 0.06, 0.];
    let ys = [0.25, 2., 5.8];
    let fades = [0.4, 1., 0.];
    for plane in 0..4 {
        let angle = plane as f32 * std::f32::consts::FRAC_PI_4;
        for x in 0..4 {
            for y in 0..2 {
                for (i, j) in [
                    (x, y),
                    (x + 1, y),
                    (x + 1, y + 1),
                    (x, y),
                    (x + 1, y + 1),
                    (x, y + 1),
                ] {
                    positions.push([xs[i] * angle.cos(), ys[j], xs[i] * angle.sin()]);
                    colors.push([1., 1., 1., alphas[i] * fades[j]]);
                }
            }
        }
    }
    let mut m = mesh(positions, None);
    m.insert_attribute(Mesh::ATTRIBUTE_COLOR, colors);
    m
}
#[derive(Component)]
struct HoverOutline(String, bool);
#[derive(Component)]
struct HoverTint(String, bool, Color);
fn highlight_hover(
    interaction: Res<Interaction>,
    mut outlines: Query<(&HoverOutline, &mut Visibility)>,
    tints: Query<(&HoverTint, &MeshMaterial3d<StandardMaterial>)>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    for (outline, mut visibility) in &mut outlines {
        let visible = outline.1 || interaction.hover.as_deref() == Some(outline.0.as_str());
        visibility.set_if_neq(if visible {
            Visibility::Visible
        } else {
            Visibility::Hidden
        });
    }
    for (tint, handle) in &tints {
        let selected = tint.1 || interaction.hover.as_deref() == Some(tint.0.as_str());
        let color = if selected {
            Color::srgba(1., 0.93, 0.65, 0.95)
        } else {
            tint.2
        };
        if materials
            .get(&handle.0)
            .is_some_and(|m| m.base_color != color)
        {
            if let Some(material) = materials.get_mut(&handle.0) {
                material.base_color = color;
            }
        }
    }
}
fn rebuild(
    mut commands: Commands,
    points: Res<Annotations>,
    interaction: Res<Interaction>,
    mut previous: Local<Option<u64>>,
    old: Query<Entity, With<Visual>>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    assets: Res<AssetServer>,
    world: WorldCollision,
) {
    let key = points.revision;
    if *previous == Some(key) {
        return;
    }
    *previous = Some(key);
    for e in &old {
        commands.entity(e).despawn();
    }
    for mark in &points.marks {
        let material = |materials: &mut Assets<StandardMaterial>, c: Color| {
            materials.add(StandardMaterial {
                base_color: c,
                unlit: true,
                alpha_mode: AlphaMode::Blend,
                cull_mode: None,
                ..default()
            })
        };
        if !mark.triangles.is_empty() {
            let vertices = mark
                .triangles
                .iter()
                .map(|p| (wow_to_bevy(*p) + Vec3::Y * (ANNOTATION_LIFT - 0.05)).to_array())
                .collect();
            commands.spawn((
                Visual,
                Mesh3d(meshes.add(mesh(vertices, None))),
                MeshMaterial3d(material(&mut materials, color(&mark.color, 0.14))),
                Transform::default(),
            ));
        }
        {
            if let Some(stroke) = strip(&mark.paths, mark.width * 0.16, ANNOTATION_LIFT - 0.02) {
                commands.spawn((
                    Visual,
                    HoverOutline(mark.id.clone(), mark.selected),
                    if mark.selected || interaction.hover.as_deref() == Some(mark.id.as_str()) {
                        Visibility::Visible
                    } else {
                        Visibility::Hidden
                    },
                    Mesh3d(meshes.add(stroke)),
                    MeshMaterial3d(material(&mut materials, Color::srgba(1., 0.94, 0.75, 0.9))),
                    Transform::default(),
                ));
            }
        }
        if let Some(stroke) = strip(&mark.paths, mark.width * 0.09, ANNOTATION_LIFT) {
            commands.spawn((
                Visual,
                Mesh3d(meshes.add(stroke)),
                MeshMaterial3d(material(&mut materials, color(&mark.color, 0.95))),
                Transform::default(),
            ));
        }
        if ["route", "arrow"].contains(&mark.kind.as_str()) {
            if let Some(path) = mark.paths.first() {
                let path: Vec<Vec3> = path
                    .iter()
                    .map(|p| wow_to_bevy(*p) + Vec3::Y * (ANNOTATION_LIFT + 0.025))
                    .collect();
                let total: f32 = path.windows(2).map(|e| e[0].distance(e[1])).sum();
                if total > 1.0 {
                    if let Some(glint) = strip(
                        &[vec![[0., 0.6, 0.], [0., -0.6, 0.]]],
                        mark.width * 0.065,
                        0.,
                    ) {
                        let handle = meshes.add(glint);
                        let mat = material(&mut materials, Color::srgba(1., 0.94, 0.77, 0.55));
                        for i in 0..((total / 24.).ceil() as usize).clamp(1, 12) {
                            commands.spawn((
                                Visual,
                                Flow {
                                    path: path.clone(),
                                    total,
                                    phase: i as f32 * 24.,
                                },
                                Mesh3d(handle.clone()),
                                MeshMaterial3d(mat.clone()),
                                Transform::default(),
                            ));
                        }
                    }
                }
            }
        }
        if mark.selected && !mark.locked {
            for (index, point) in mark.handles.iter().enumerate() {
                let kind = mark
                    .handle_kinds
                    .get(index)
                    .map(String::as_str)
                    .unwrap_or("point");
                let round = kind == "rotate" || kind == "point";
                let size = if kind == "move" || kind == "rotate" {
                    10.
                } else {
                    8.
                };
                commands.spawn((
                    Visual,
                    HandlePoint {
                        world: wow_to_bevy(*point) + Vec3::Y * 0.20,
                        id: mark.id.clone(),
                        index,
                        kind: kind.to_owned(),
                    },
                    Node {
                        position_type: PositionType::Absolute,
                        width: px(size),
                        height: px(size),
                        border: UiRect::all(px(1.5)),
                        border_radius: BorderRadius::all(if round { percent(50.) } else { px(1.) }),
                        ..default()
                    },
                    UiTransform::from_rotation(if kind == "move" {
                        Rot2::radians(std::f32::consts::FRAC_PI_4)
                    } else {
                        Rot2::IDENTITY
                    }),
                    BackgroundColor(Color::srgb(0.96, 0.91, 0.77)),
                    BorderColor::all(Color::srgb(0.12, 0.15, 0.16)),
                    Outline::new(px(1.), px(2.), Color::NONE),
                    ZIndex(35),
                ));
            }
        }
        let anchor = wow_to_bevy(mark.anchor);
        if mark.kind == "marker" {
            let highlighted =
                mark.selected || interaction.hover.as_deref() == Some(mark.id.as_str());
            if mark.actor.is_none() {
                commands.spawn((
                    Visual,
                    follower(mark, anchor, false),
                    Mesh3d(meshes.add(beacon())),
                    MeshMaterial3d(material(&mut materials, color(&mark.color, 1.))),
                    Transform::from_translation(anchor),
                ));
            }
            let ring: Vec<[f32; 3]> = (0..=64)
                .map(|i| {
                    let angle = i as f32 * std::f32::consts::TAU / 64.;
                    [
                        mark.anchor[0] + angle.cos() * 1.6,
                        mark.anchor[1] + angle.sin() * 1.6,
                        mark.anchor[2],
                    ]
                })
                .collect();
            let ring = crate::surface_geometry::paths(&[ring], &mut |p| ground_sample(p, &world));
            if let Some(ring) = strip(&ring, 0.13, 0.25) {
                commands.spawn((
                    Visual,
                    follower(mark, Vec3::ZERO, false),
                    HoverTint(mark.id.clone(), mark.selected, color(&mark.color, 0.75)),
                    Mesh3d(meshes.add(ring)),
                    MeshMaterial3d(material(
                        &mut materials,
                        if highlighted {
                            Color::srgba(1., 0.93, 0.65, 0.95)
                        } else {
                            color(&mark.color, 0.75)
                        },
                    )),
                    Transform::default(),
                ));
            }
            let (path, uv) = if let Some(index) = mark
                .icon
                .parse::<usize>()
                .ok()
                .filter(|i| (1..=8).contains(i))
            {
                let i = index - 1;
                let u = (i % 4) as f32 * 0.25;
                let v = (i / 4) as f32 * 0.25;
                (
                    "mpq://interface/targetingframe/ui-raidtargetingicons.blp".to_string(),
                    vec![
                        [u, v + 0.25],
                        [u + 0.25, v + 0.25],
                        [u + 0.25, v],
                        [u, v + 0.25],
                        [u + 0.25, v],
                        [u, v],
                    ],
                )
            } else {
                (
                    format!("mpq://interface/icons/{}.blp", mark.icon),
                    vec![[0., 1.], [1., 1.], [1., 0.], [0., 1.], [1., 0.], [0., 0.]],
                )
            };
            let quad = mesh(
                vec![
                    [-0.5, -0.5, 0.],
                    [0.5, -0.5, 0.],
                    [0.5, 0.5, 0.],
                    [-0.5, -0.5, 0.],
                    [0.5, 0.5, 0.],
                    [-0.5, 0.5, 0.],
                ],
                Some(uv),
            );
            let mat = materials.add(StandardMaterial {
                base_color_texture: Some(assets.load(path)),
                unlit: true,
                alpha_mode: AlphaMode::Blend,
                cull_mode: None,
                ..default()
            });
            commands.spawn((
                Visual,
                Billboard,
                follower(mark, anchor + Vec3::Y * 3., true),
                Mesh3d(meshes.add(quad)),
                MeshMaterial3d(mat),
                Transform::from_translation(anchor + Vec3::Y * 3.)
                    .with_scale(Vec3::splat((mark.size * 0.5).clamp(1., 8.))),
            ));
        }
        if !mark.label.is_empty() && (mark.actor.is_none() || mark.kind == "label") {
            commands.spawn((
                Visual,
                Caption(
                    anchor
                        + Vec3::Y
                            * if mark.kind == "marker" {
                                5.0
                            } else {
                                ANNOTATION_LIFT + 0.6
                            },
                ),
                CaptionFollow(mark.actor.clone(), anchor),
                Text::new(mark.label.clone()),
                TextFont {
                    font: assets.load("mpq://fonts/frizqt__.ttf"),
                    font_size: 14.,
                    ..default()
                },
                TextColor(Color::srgb(0.96, 0.92, 0.82)),
                Node {
                    position_type: PositionType::Absolute,
                    padding: UiRect::axes(px(6), px(3)),
                    max_width: px(250),
                    ..default()
                },
                BackgroundColor(Color::srgba(0.04, 0.055, 0.07, 0.88)),
                ZIndex(30),
            ));
        }
    }
}
fn face(
    camera: Query<&Transform, (With<WorldCamera>, Without<Billboard>)>,
    mut icons: Query<&mut Transform, (With<Billboard>, Without<WorldCamera>)>,
) {
    if let Ok(camera) = camera.single() {
        for mut xf in &mut icons {
            xf.rotation = camera.rotation;
        }
    }
}
fn captions(
    camera: Query<(&Camera, &GlobalTransform), With<WorldCamera>>,
    actors: Query<(&crate::ReplayBody, &GlobalTransform)>,
    mut captions: Query<(&Caption, &CaptionFollow, &mut Node)>,
) {
    if let Ok((camera, xf)) = camera.single() {
        for (Caption(world), follow, mut node) in &mut captions {
            let offset = follow
                .0
                .as_ref()
                .and_then(|key| {
                    actors
                        .iter()
                        .find(|(a, _)| &a.key == key)
                        .map(|(_, xf)| xf.translation() - follow.1)
                })
                .unwrap_or(Vec3::ZERO);
            if let Ok(p) = camera.world_to_viewport(xf, *world + offset) {
                node.display = Display::Flex;
                node.left = px(p.x + 10.);
                node.top = px(p.y - 12.);
            } else {
                node.display = Display::None;
            }
        }
    }
}
#[derive(Component)]
struct HandlePoint {
    world: Vec3,
    id: String,
    index: usize,
    kind: String,
}
fn handles(
    camera: Query<(&Camera, &GlobalTransform), With<WorldCamera>>,
    interaction: Res<Interaction>,
    mut handles: Query<(
        &HandlePoint,
        &mut Node,
        &mut BackgroundColor,
        &mut BorderColor,
        &mut Outline,
    )>,
) {
    if let Ok((camera, xf)) = camera.single() {
        for (point, mut node, mut fill, mut border, mut outline) in &mut handles {
            let active = interaction.hover.as_deref() == Some(point.id.as_str())
                && interaction.hover_handle == Some(point.index);
            let size = if point.kind == "move" || point.kind == "rotate" {
                10.
            } else {
                8.
            } + if active { 2. } else { 0. };
            let accent = if point.kind == "rotate" {
                Color::srgb(0.61, 0.84, 0.95)
            } else {
                Color::srgb(1., 0.83, 0.42)
            };
            fill.set_if_neq(BackgroundColor(if active {
                accent
            } else if point.kind == "move" || point.kind == "rotate" {
                Color::srgb(0.14, 0.18, 0.20)
            } else {
                Color::srgb(0.96, 0.91, 0.77)
            }));
            border.set_if_neq(BorderColor::all(
                if point.kind == "move" || point.kind == "rotate" {
                    if active {
                        Color::srgb(1., 0.95, 0.8)
                    } else {
                        accent
                    }
                } else {
                    Color::srgb(0.12, 0.15, 0.16)
                },
            ));
            outline.color = if active {
                accent.with_alpha(0.55)
            } else {
                Color::NONE
            };
            node.width = px(size);
            node.height = px(size);
            if let Ok(p) = camera.world_to_viewport(xf, point.world) {
                node.display = Display::Flex;
                node.left = px((p.x - size * 0.5).round());
                node.top = px((p.y - size * 0.5).round());
            } else {
                node.display = Display::None;
            }
        }
    }
}
#[derive(Clone, Deserialize)]
pub struct RangeRing {
    pub key: String,
    pub radius: f32,
    pub status: RangeStatus,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RangeStatus {
    #[serde(alias = "unknown")]
    Clear,
    Crowded,
}

fn draw_ranges(
    annotations: Res<Annotations>,
    actors: Query<(&crate::ReplayBody, &GlobalTransform, &Visibility)>,
    mut gizmos: Gizmos,
) {
    if annotations.ranges.is_empty() {
        return;
    }
    let ranges: std::collections::HashMap<_, _> = annotations
        .ranges
        .iter()
        .map(|range| (range.key.as_str(), range))
        .collect();
    for (body, transform, visibility) in &actors {
        let Some(range) = ranges.get(body.key.as_str()) else {
            continue;
        };
        if *visibility == Visibility::Hidden {
            continue;
        }
        let center = transform.translation() + Vec3::Y * (body.label_height * 0.55).clamp(0.6, 2.0);
        let tint = match range.status {
            RangeStatus::Clear => Color::srgba(0.396, 0.776, 0.631, 0.85),
            RangeStatus::Crowded => Color::srgba(0.941, 0.459, 0.427, 0.95),
        };
        // Real yard units, following the grounded body without terrain raycasts.
        for segment in 0..64 {
            let a = segment as f32 * std::f32::consts::TAU / 64.;
            let b = (segment + 1) as f32 * std::f32::consts::TAU / 64.;
            gizmos.line(
                center + Vec3::new(a.cos(), 0., a.sin()) * range.radius,
                center + Vec3::new(b.cos(), 0., b.sin()) * range.radius,
                tint,
            );
        }
    }
}
fn preview(interaction: Res<Interaction>, mut gizmos: Gizmos) {
    if interaction.placing {
        if let Some(point) = interaction.point {
            let p = wow_to_bevy(point) + Vec3::Y * 0.16;
            let color = Color::srgba(1., 0.86, 0.5, 0.8);
            gizmos.circle(
                Isometry3d::new(p, Quat::from_rotation_x(std::f32::consts::FRAC_PI_2)),
                0.65,
                color,
            );
            gizmos.line(p - Vec3::X * 0.25, p + Vec3::X * 0.25, color);
            gizmos.line(p - Vec3::Z * 0.25, p + Vec3::Z * 0.25, color);
        }
    }
}
fn terrain_refresh(
    progress: Res<benilla_world::terrain_stream::WorldLoadProgress>,
    world: WorldCollision,
    mut points: ResMut<Annotations>,
    mut previous: Local<(bool, Option<(i32, i32)>)>,
) {
    let key = (progress.presentable(), progress.focus_tile);
    if key.0 && *previous != key && !points.source.is_empty() {
        points.conform(&world);
    }
    *previous = key;
}
pub fn install(app: &mut App) {
    app.init_resource::<Annotations>()
        .init_resource::<Interaction>()
        .add_systems(
            PostUpdate,
            draw_ranges.after(bevy::transform::TransformSystems::Propagate),
        )
        .add_systems(
            Update,
            (
                terrain_refresh.before(rebuild),
                rebuild,
                highlight_hover.after(rebuild),
                face.after(rebuild),
                captions.after(rebuild),
                flow.after(rebuild),
                follow_actors.after(rebuild),
                handles.after(rebuild),
                preview,
            ),
        );
}
