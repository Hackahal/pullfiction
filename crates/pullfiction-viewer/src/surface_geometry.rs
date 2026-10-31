//! Terrain annotation projection. Missing or discontinuous floor clips the mark.
//! This module is engine-independent so cliff/void behavior can be checked without a GPU.
type Point = [f32; 3];
fn distance(a: Point, b: Point) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}
fn midpoint(a: Point, b: Point) -> Point {
    [
        (a[0] + b[0]) * 0.5,
        (a[1] + b[1]) * 0.5,
        (a[2] + b[2]) * 0.5,
    ]
}
pub fn connected(a: Point, b: Point) -> bool {
    let horizontal = ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt();
    (a[2] - b[2]).abs() <= 0.20 + horizontal * 1.2
}
pub fn paths(
    input: &[Vec<Point>],
    sample: &mut impl FnMut(Point) -> Option<Point>,
) -> Vec<Vec<Point>> {
    let mut out = Vec::new();
    for path in input {
        let mut span: Vec<Point> = Vec::new();
        let flush = |span: &mut Vec<Point>, out: &mut Vec<Vec<Point>>| {
            if span.len() > 1 {
                out.push(std::mem::take(span));
            } else {
                span.clear();
            }
        };
        let mut add = |point: Point| {
            if let Some(p) = sample(point) {
                if span.last().is_some_and(|last| !connected(*last, p)) {
                    flush(&mut span, &mut out);
                }
                if span.last() != Some(&p) {
                    span.push(p);
                }
            } else {
                flush(&mut span, &mut out);
            }
        };
        for edge in path.windows(2) {
            let count = (distance(edge[0], edge[1]) / 1.5).ceil().clamp(1., 512.) as usize;
            for i in 0..count {
                let t = i as f32 / count as f32;
                add([
                    edge[0][0] + (edge[1][0] - edge[0][0]) * t,
                    edge[0][1] + (edge[1][1] - edge[0][1]) * t,
                    edge[0][2] + (edge[1][2] - edge[0][2]) * t,
                ]);
            }
        }
        if let Some(last) = path.last() {
            add(*last);
        }
        flush(&mut span, &mut out);
    }
    out
}
pub fn triangle(
    tri: [Point; 3],
    sample: &mut impl FnMut(Point) -> Option<Point>,
    depth: u8,
    out: &mut Vec<Point>,
) {
    let mut alpha = Vec::new();
    colored_triangle(tri, [1.; 3], sample, depth, out, &mut alpha);
}
pub fn colored_triangle(
    tri: [Point; 3],
    alpha: [f32; 3],
    sample: &mut impl FnMut(Point) -> Option<Point>,
    depth: u8,
    out: &mut Vec<Point>,
    colors: &mut Vec<f32>,
) {
    if out.len() > 24_000 {
        return;
    }
    let lengths = [
        distance(tri[0], tri[1]),
        distance(tri[1], tri[2]),
        distance(tri[2], tri[0]),
    ];
    let edge = (0..3)
        .max_by(|a, b| lengths[*a].total_cmp(&lengths[*b]))
        .unwrap();
    let longest = lengths[edge];
    let projected = tri.map(&mut *sample);
    let center = [
        (tri[0][0] + tri[1][0] + tri[2][0]) / 3.,
        (tri[0][1] + tri[1][1] + tri[2][1]) / 3.,
        (tri[0][2] + tri[1][2] + tri[2][2]) / 3.,
    ];
    let middle = [
        midpoint(tri[0], tri[1]),
        midpoint(tri[1], tri[2]),
        midpoint(tri[2], tri[0]),
    ]
    .map(&mut *sample);
    let center_floor = sample(center);
    if projected.iter().all(Option::is_none)
        && middle.iter().all(Option::is_none)
        && center_floor.is_none()
    {
        return;
    }

    let acceptable =
        if let ([Some(a), Some(b), Some(c)], [Some(ab), Some(bc), Some(ca)], Some(floor)) =
            (projected, middle, center_floor)
        {
            connected(a, b)
                && connected(b, c)
                && connected(c, a)
                && ((a[2] + b[2] + c[2]) / 3. - floor[2]).abs() <= 0.20
                && ((a[2] + b[2]) * 0.5 - ab[2]).abs() <= 0.20
                && ((b[2] + c[2]) * 0.5 - bc[2]).abs() <= 0.20
                && ((c[2] + a[2]) * 0.5 - ca[2]).abs() <= 0.20
        } else {
            false
        };
    if depth < 10 && (longest > 6. || (!acceptable && longest > 0.75)) {
        let i = edge;
        let j = (edge + 1) % 3;
        let k = (edge + 2) % 3;
        let mid = midpoint(tri[i], tri[j]);
        let fade = (alpha[i] + alpha[j]) * 0.5;
        colored_triangle(
            [tri[i], mid, tri[k]],
            [alpha[i], fade, alpha[k]],
            sample,
            depth + 1,
            out,
            colors,
        );
        colored_triangle(
            [mid, tri[j], tri[k]],
            [fade, alpha[j], alpha[k]],
            sample,
            depth + 1,
            out,
            colors,
        );
        return;
    }
    if acceptable {
        out.extend(projected.map(Option::unwrap));
        colors.extend(alpha);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn voids_break_strokes_instead_of_falling_back_to_the_original_height() {
        let input = vec![vec![[0., 0., 10.], [10., 0., 10.]]];
        let result = paths(&input, &mut |p| {
            if (4.0..6.0).contains(&p[0]) {
                None
            } else {
                Some([p[0], p[1], 0.])
            }
        });
        assert_eq!(result.len(), 2);
        assert!(result.iter().flatten().all(|p| p[2] == 0.));
        assert!(result
            .iter()
            .all(|path| path.windows(2).all(|e| (e[1][0] - e[0][0]).abs() <= 1.5)));
    }
    #[test]
    fn cliffs_never_form_vertical_path_walls() {
        let result = paths(&[vec![[0., 0., 0.], [10., 0., 0.]]], &mut |p| {
            Some([p[0], p[1], if p[0] < 5. { 0. } else { -20. }])
        });
        assert_eq!(result.len(), 2);
        assert!(result
            .iter()
            .all(|p| p.windows(2).all(|e| connected(e[0], e[1]))));
    }
    #[test]
    fn area_triangles_reject_cliffs_and_missing_floor() {
        let mut out = Vec::new();
        let tri = [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]];
        triangle(
            tri,
            &mut |p| Some([p[0], p[1], if p[0] > 0.5 { -20. } else { 0. }]),
            0,
            &mut out,
        );
        assert!(out
            .chunks_exact(3)
            .all(|t| connected(t[0], t[1]) && connected(t[1], t[2]) && connected(t[2], t[0])));
        out.clear();
        triangle(tri, &mut |_| None, 0, &mut out);
        assert!(out.is_empty());
    }
    #[test]
    fn sloped_floor_stays_on_the_sampled_surface() {
        let mut out = Vec::new();
        triangle(
            [[0., 0., 0.], [10., 0., 0.], [0., 10., 0.]],
            &mut |p| Some([p[0], p[1], p[0] * 0.4]),
            0,
            &mut out,
        );
        assert!(!out.is_empty());
        assert!(out.iter().all(|p| (p[2] - p[0] * 0.4).abs() < 1e-5));
        assert!(out
            .chunks_exact(3)
            .all(|t| connected(t[0], t[1]) && connected(t[1], t[2]) && connected(t[2], t[0])));
    }
}

#[cfg(test)]
mod adaptive_tests {
    use super::*;
    #[test]
    fn a_rolling_hill_is_tessellated_instead_of_buried_or_dropped() {
        let floor = |p: Point| Some([p[0], p[1], (p[0] * 1.4).sin() * 0.7]);
        let mut out = Vec::new();
        triangle(
            [[0., 0., 0.], [8., 0., 0.], [0., 8., 0.]],
            &mut |p| floor(p),
            0,
            &mut out,
        );
        assert!(!out.is_empty());
        for t in out.chunks_exact(3) {
            let center = [
                (t[0][0] + t[1][0] + t[2][0]) / 3.,
                (t[0][1] + t[1][1] + t[2][1]) / 3.,
                0.,
            ];
            assert!(
                ((t[0][2] + t[1][2] + t[2][2]) / 3. - floor(center).unwrap()[2]).abs() <= 0.201
            );
        }
    }
    #[test]
    fn ribbon_width_and_fades_are_projected_onto_a_cross_slope() {
        let mut out = Vec::new();
        let mut alpha = Vec::new();
        colored_triangle(
            [[0., -1., 0.], [0., 1., 0.], [4., 1., 0.]],
            [0., 1., 0.],
            &mut |p| Some([p[0], p[1], p[1] * 0.8]),
            0,
            &mut out,
            &mut alpha,
        );
        assert_eq!(out.len(), alpha.len());
        assert!(!out.is_empty());
        assert!(alpha.iter().all(|a| (0.0..=1.0).contains(a)));
        assert!(out.iter().all(|p| (p[2] - p[1] * 0.8).abs() < 0.001));
    }
}

#[cfg(test)]
mod performance_tests {
    use super::*;
    #[test]
    fn forty_yard_range_stays_within_interactive_projection_budget() {
        let mut cache = std::collections::HashMap::new();
        let mut queries = 0;
        let mut vertices = Vec::new();
        let mut sample = |p: Point| {
            *cache.entry(p.map(f32::to_bits)).or_insert_with(|| {
                queries += 1;
                Some([
                    p[0],
                    p[1],
                    (p[0] * 0.25).sin() * 1.2 + (p[1] * 0.19).cos() * 0.8,
                ])
            })
        };
        for i in 0..48 {
            let a = i as f32 * std::f32::consts::TAU / 48.;
            let b = (i + 1) as f32 * std::f32::consts::TAU / 48.;
            triangle(
                [
                    [0., 0., 0.],
                    [a.cos() * 40., a.sin() * 40., 0.],
                    [b.cos() * 40., b.sin() * 40., 0.],
                ],
                &mut sample,
                0,
                &mut vertices,
            );
        }
        assert!(queries < 8_000, "range needed {queries} collision queries");
        assert!(!vertices.is_empty());
        assert!(
            vertices.len() / 3 < 2_500,
            "range generated {} triangles",
            vertices.len() / 3
        );
    }
}
