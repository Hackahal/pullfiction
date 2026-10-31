//! Cached triangle queries for browser worlds. This file also runs as a standalone Rust test.
use std::collections::HashMap;

type Point = [f32; 3];
type Triangle = [Point; 3];

fn sub(a: Point, b: Point) -> Point {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: Point, b: Point) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: Point, b: Point) -> Point {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

#[derive(Clone, Copy)]
struct Bounds {
    min: Point,
    max: Point,
}
impl Bounds {
    fn triangles(tris: &[Triangle]) -> Self {
        let mut b = Self {
            min: [f32::INFINITY; 3],
            max: [f32::NEG_INFINITY; 3],
        };
        for p in tris.iter().flatten() {
            for axis in 0..3 {
                b.min[axis] = b.min[axis].min(p[axis]);
                b.max[axis] = b.max[axis].max(p[axis]);
            }
        }
        b
    }
    fn column(self, x: f32, z: f32) -> bool {
        x >= self.min[0] - 0.001
            && x <= self.max[0] + 0.001
            && z >= self.min[2] - 0.001
            && z <= self.max[2] + 0.001
    }
    fn ray(self, origin: Point, dir: Point, max: f32) -> bool {
        let (mut near, mut far) = (0.0_f32, max);
        for axis in 0..3 {
            if dir[axis].abs() < 1e-8 {
                if origin[axis] < self.min[axis] || origin[axis] > self.max[axis] {
                    return false;
                }
            } else {
                let a = (self.min[axis] - origin[axis]) / dir[axis];
                let b = (self.max[axis] - origin[axis]) / dir[axis];
                near = near.max(a.min(b));
                far = far.min(a.max(b));
                if near > far {
                    return false;
                }
            }
        }
        true
    }
}

enum Node {
    Leaf {
        bounds: Bounds,
        tris: Vec<Triangle>,
    },
    Branch {
        bounds: Bounds,
        left: Box<Node>,
        right: Box<Node>,
    },
}
impl Node {
    fn build(mut tris: Vec<Triangle>) -> Self {
        let bounds = Bounds::triangles(&tris);
        if tris.len() <= 12 {
            return Self::Leaf { bounds, tris };
        }
        let axis = (0..3)
            .max_by(|a, b| {
                (bounds.max[*a] - bounds.min[*a]).total_cmp(&(bounds.max[*b] - bounds.min[*b]))
            })
            .unwrap();
        let middle = tris.len() / 2;
        tris.select_nth_unstable_by(middle, |a, b| {
            (a[0][axis] + a[1][axis] + a[2][axis])
                .total_cmp(&(b[0][axis] + b[1][axis] + b[2][axis]))
        });
        let right = tris.split_off(middle);
        Self::Branch {
            bounds,
            left: Box::new(Self::build(tris)),
            right: Box::new(Self::build(right)),
        }
    }
    fn bounds(&self) -> Bounds {
        match self {
            Self::Leaf { bounds, .. } | Self::Branch { bounds, .. } => *bounds,
        }
    }
    fn floors(&self, x: f32, z: f32, hint: f32, best: &mut Option<f32>) {
        if !self.bounds().column(x, z) {
            return;
        }
        match self {
            Self::Branch { left, right, .. } => {
                left.floors(x, z, hint, best);
                right.floors(x, z, hint, best);
            }
            Self::Leaf { tris, .. } => {
                for tri in tris {
                    let normal = cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]));
                    // Only upward walking faces ground actors. Downward ceilings never become floors.
                    if normal[1] <= 0.05 * dot(normal, normal).sqrt() {
                        continue;
                    }
                    let start = [x, self.bounds().max[1] + 1., z];
                    if let Some((t, _)) = triangle_ray(*tri, start, [0., -1., 0.]) {
                        let height = start[1] - t;
                        if best.is_none_or(|old| {
                            (height - hint).abs() < (old - hint).abs() - 0.001
                                || ((height - hint).abs() - (old - hint).abs()).abs() < 0.001
                                    && height < old
                        }) {
                            *best = Some(height);
                        }
                    }
                }
            }
        }
    }
    fn ray(&self, origin: Point, dir: Point, best: &mut Option<(f32, Point)>, max: f32) {
        if !self.bounds().ray(origin, dir, best.map_or(max, |x| x.0)) {
            return;
        }
        match self {
            Self::Branch { left, right, .. } => {
                left.ray(origin, dir, best, max);
                right.ray(origin, dir, best, max);
            }
            Self::Leaf { tris, .. } => {
                for tri in tris {
                    if let Some(hit) = triangle_ray(*tri, origin, dir) {
                        if hit.0 <= best.map_or(max, |x| x.0) {
                            *best = Some(hit);
                        }
                    }
                }
            }
        }
    }
}

fn triangle_ray(tri: Triangle, origin: Point, dir: Point) -> Option<(f32, Point)> {
    let a = sub(tri[1], tri[0]);
    let b = sub(tri[2], tri[0]);
    let p = cross(dir, b);
    let det = dot(a, p);
    if det.abs() < 1e-7 {
        return None;
    }
    let delta = sub(origin, tri[0]);
    let u = dot(delta, p) / det;
    if !(-0.0001..=1.0001).contains(&u) {
        return None;
    }
    let q = cross(delta, a);
    let v = dot(dir, q) / det;
    if v < -0.0001 || u + v > 1.0001 {
        return None;
    }
    let distance = dot(b, q) / det;
    if distance < 0. || !distance.is_finite() {
        return None;
    }
    let mut n = cross(a, b);
    let length = dot(n, n).sqrt();
    if length < 1e-8 {
        return None;
    }
    for axis in &mut n {
        *axis /= length;
    }
    if dot(n, dir) > 0. {
        for axis in &mut n {
            *axis = -*axis;
        }
    }
    Some((distance, n))
}

#[derive(Default)]
pub struct Geometry {
    owners: HashMap<u64, Vec<Node>>,
    pub triangles: usize,
}
impl Geometry {
    pub fn insert(&mut self, owner: u64, tris: Vec<Triangle>) -> bool {
        let tris: Vec<_> = tris
            .into_iter()
            .filter(|t| {
                t.iter().flatten().all(|x| x.is_finite())
                    && dot(
                        cross(sub(t[1], t[0]), sub(t[2], t[0])),
                        cross(sub(t[1], t[0]), sub(t[2], t[0])),
                    ) > 1e-10
            })
            .collect();
        if tris.is_empty() {
            return false;
        }
        self.triangles += tris.len();
        self.owners
            .entry(owner)
            .or_default()
            .push(Node::build(tris));
        true
    }
    pub fn remove(&mut self, owner: u64) -> bool {
        let Some(nodes) = self.owners.remove(&owner) else {
            return false;
        };
        fn count(n: &Node) -> usize {
            match n {
                Node::Leaf { tris, .. } => tris.len(),
                Node::Branch { left, right, .. } => count(left) + count(right),
            }
        }
        self.triangles -= nodes.iter().map(count).sum::<usize>();
        true
    }
    pub fn ground(&self, point: Point, hint: Option<f32>) -> Option<f32> {
        if !point.iter().all(|n| n.is_finite()) {
            return None;
        }
        let hint = hint.filter(|n| n.is_finite()).unwrap_or(point[1]);
        let mut best = None;
        for n in self.owners.values().flatten() {
            n.floors(point[0], point[2], hint, &mut best);
        }
        best
    }
    pub fn ray(&self, origin: Point, dir: Point, max: f32) -> Option<(f32, Point)> {
        if max <= 0. || !max.is_finite() || !origin.iter().chain(dir.iter()).all(|x| x.is_finite())
        {
            return None;
        }
        let mut best = None;
        for n in self.owners.values().flatten() {
            n.ray(origin, dir, &mut best, max);
        }
        best
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn floor(y: f32) -> Triangle {
        [[-4., y, -4.], [0., y, 4.], [4., y, -4.]]
    }
    #[test]
    fn unknown_geometry_stays_unknown() {
        let g = Geometry::default();
        assert_eq!(g.ground([0., 0., 0.], None), None);
        assert_eq!(g.ray([0., 10., 0.], [0., -1., 0.], 20.), None);
    }
    #[test]
    fn recorded_floor_hint_selects_the_actual_stacked_floor() {
        let mut g = Geometry::default();
        g.insert(1, vec![floor(0.), floor(20.), floor(40.)]);
        assert_eq!(g.ground([0., 0., 0.], Some(19.)), Some(20.));
        assert_eq!(g.ground([0., 39., 0.], None), Some(40.));
        assert_eq!(g.ground([30., 0., 0.], None), None);
    }
    #[test]
    fn ceilings_do_not_ground_actors_but_stop_picks() {
        let mut ceiling = floor(10.);
        ceiling.swap(1, 2);
        let mut g = Geometry::default();
        g.insert(1, vec![floor(0.), ceiling]);
        assert_eq!(g.ground([0., 9., 0.], None), Some(0.));
        assert_eq!(g.ray([0., 12., 0.], [0., -1., 0.], 20.).unwrap().0, 2.);
    }
    #[test]
    fn unloading_a_tile_releases_its_query_geometry() {
        let mut g = Geometry::default();
        g.insert(1, vec![floor(0.)]);
        g.insert(2, vec![floor(20.)]);
        assert!(g.remove(2));
        assert_eq!(g.triangles, 1);
        assert_eq!(g.ground([0., 20., 0.], None), Some(0.));
    }
    #[test]
    fn bvh_matches_nearest_ray_and_rejects_rays_outside_bounds() {
        let mut g = Geometry::default();
        g.insert(1, (0..200).map(|i| floor(i as f32 * 2.)).collect());
        let hit = g.ray([0., 401., 0.], [0., -1., 0.], 500.).unwrap();
        assert_eq!(hit.0, 3.);
        assert_eq!(hit.1, [0., 1., 0.]);
        assert!(g.ray([50., 401., 0.], [0., -1., 0.], 500.).is_none());
        assert!(g.ray([0., 401., 0.], [0., -1., 0.], 2.).is_none());
        assert!(g.ray([0., 401., 0.], [0., 1., 0.], 500.).is_none());
    }
    #[test]
    fn sloped_floor_interpolates_height() {
        let mut g = Geometry::default();
        g.insert(1, vec![[[-2., 0., -2.], [0., 2., 2.], [2., 4., -2.]]]);
        assert!((g.ground([1., 0., 0.], None).unwrap() - 3.).abs() < 0.0001);
    }
}
