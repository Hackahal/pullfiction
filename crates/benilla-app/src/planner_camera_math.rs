//! Player-anchored raid observer geometry and shot lifetime.
use bevy::math::Vec3;
#[derive(Clone)]
pub(crate) struct Subject {
    pub key: String,
    pub point: Vec3,
    pub player: bool,
    pub weight: f32,
}
#[derive(Clone)]
pub(crate) struct Shot {
    pub key: String,
    pub position: Vec3,
    pub look: Vec3,
    pub yaw: f32,
    pub score: f32,
}
pub(crate) fn ease(dt: f32, rate: f32) -> f32 {
    1. - (-dt.clamp(0., 0.1) * rate).exp()
}
pub(crate) fn clear_boom(
    target: Vec3,
    boom: Vec3,
    mut cast: impl FnMut(Vec3, Vec3) -> Option<f32>,
) -> Vec3 {
    let length = boom.length();
    if length < 0.001 {
        return target;
    }
    let allowed = cast(target, boom)
        .map(|hit| (hit - 0.4).max(0.))
        .unwrap_or(length)
        .min(length);
    target + boom / length * allowed
}
pub(crate) fn capped_position(anchor: Vec3, position: Vec3, maximum: f32) -> Vec3 {
    anchor + (position - anchor).clamp_length_max(maximum)
}
/// A replay seek or teleport changes rooms; interpolating across it hits unrelated walls.
pub(crate) fn camera_cut(reset: bool, previous: Vec3, anchor: Vec3, maximum: f32) -> bool {
    reset || previous.distance_squared(anchor) > maximum * maximum
}
fn in_frame(position: Vec3, look: Vec3, point: Vec3, fov: f32, aspect: f32) -> bool {
    let forward = (look - position).normalize_or_zero();
    let right = forward.cross(Vec3::Y).normalize_or_zero();
    let up = right.cross(forward);
    let v = point - position;
    let depth = v.dot(forward);
    let half = (fov * 0.5).tan() * 0.85;
    depth > 0.5
        && v.dot(up).abs() < depth * half
        && v.dot(right).abs() < depth * half * aspect.max(0.2)
}
pub(crate) fn candidate_keys(
    subjects: &[Subject],
    current: Option<&str>,
    locked: &str,
) -> Vec<String> {
    let mut candidates: Vec<_> = subjects
        .iter()
        .filter(|s| s.player)
        .map(|s| {
            let coverage = subjects
                .iter()
                .filter(|p| p.point.distance(s.point) < 40.)
                .map(|p| p.weight)
                .sum::<f32>();
            (s.key.clone(), coverage)
        })
        .collect();
    candidates.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    let mut keys: Vec<_> = candidates.iter().take(6).map(|p| p.0.clone()).collect();
    for key in current
        .into_iter()
        .chain((!locked.is_empty()).then_some(locked))
    {
        if candidates.iter().any(|p| p.0 == key) && !keys.iter().any(|k| k == key) {
            keys.push(key.to_string());
        }
    }
    keys
}
pub(crate) fn player_shot(
    anchor: &Subject,
    subjects: &[Subject],
    heading: f32,
    maximum: f32,
    fov: f32,
    aspect: f32,
    mut cast: impl FnMut(Vec3, Vec3) -> Option<f32>,
) -> Shot {
    let nearby: Vec<_> = subjects
        .iter()
        .filter(|p| p.point.distance(anchor.point) < 45.)
        .collect();
    let total = nearby.iter().map(|p| p.weight).sum::<f32>().max(1.);
    let center = nearby.iter().map(|p| p.point * p.weight).sum::<Vec3>() / total;
    // Aim slightly into the group, but keep the positional pivot on a real player.
    let look = anchor.point + ((center - anchor.point) * 0.35).clamp_length_max(6.);
    let radius = nearby
        .iter()
        .map(|p| p.point.distance(anchor.point))
        .fold(0_f32, f32::max);
    let distance = (25. + (radius - 12.).max(0.) * 0.35).min(maximum);
    let all_weight = subjects.iter().map(|p| p.weight).sum::<f32>().max(1.);
    let mut best = Shot {
        key: anchor.key.clone(),
        position: anchor.point,
        look,
        yaw: heading,
        score: f32::NEG_INFINITY,
    };
    for turn in [0_f32, 0.6, -0.6, 1.2, -1.2] {
        for pitch in [0.65_f32, 0.95] {
            let yaw = heading + turn;
            let boom = Vec3::new(
                yaw.sin() * pitch.cos(),
                pitch.sin(),
                yaw.cos() * pitch.cos(),
            ) * distance;
            let position = clear_boom(anchor.point, boom, &mut cast);
            let coverage = subjects
                .iter()
                .filter(|s| in_frame(position, look, s.point, fov, aspect))
                .map(|s| s.weight)
                .sum::<f32>()
                / all_weight;
            // Deterministic sample of at most eight subjects bounds collision cost.
            let probes: Vec<_> = subjects
                .iter()
                .step_by(subjects.len().div_ceil(8).max(1))
                .collect();
            let visible = probes
                .iter()
                .filter(|s| {
                    if !in_frame(position, look, s.point, fov, aspect) {
                        return false;
                    }
                    let line = s.point - position;
                    cast(position, line).is_none_or(|hit| hit >= line.length() - 0.8)
                })
                .count() as f32
                / probes.len().max(1) as f32;
            let reach = position.distance(anchor.point) / distance;
            let score = coverage * 0.55 + visible * 0.3 + reach * 0.15
                - turn.abs() * 0.06
                - (pitch - 0.65) * 0.08;
            if score > best.score {
                best = Shot {
                    key: anchor.key.clone(),
                    position,
                    look,
                    yaw,
                    score,
                };
            }
        }
    }
    best
}
#[derive(Default)]
pub(crate) struct AnchorHold {
    pub key: Option<String>,
    since: f32,
    challenger: Option<(String, f32)>,
}
impl AnchorHold {
    pub fn select(&mut self, shots: &[Shot], now: f32, locked: &str) -> Option<String> {
        let best = shots
            .iter()
            .max_by(|a, b| a.score.total_cmp(&b.score).then_with(|| b.key.cmp(&a.key)))?;
        let current = self
            .key
            .as_ref()
            .and_then(|k| shots.iter().find(|s| s.key == *k));
        let locked_shot = shots.iter().find(|s| s.key == locked);
        let next = if let Some(s) = locked_shot {
            Some(s)
        } else if current.is_none() {
            Some(best)
        } else {
            let old = current.unwrap();
            let poor = old.score < 0.55;
            let better =
                best.key != old.key && best.score > old.score + if poor { 0.12 } else { 0.25 };
            if better && (now - self.since >= 5. || old.score < 0.15) {
                match self.challenger.as_ref() {
                    Some((key, at)) if key == &best.key && now - *at >= 1. => Some(best),
                    Some((key, _)) if key == &best.key => None,
                    _ => {
                        self.challenger = Some((best.key.clone(), now));
                        None
                    }
                }
            } else {
                self.challenger = None;
                None
            }
        };
        if let Some(s) = next {
            if self.key.as_deref() != Some(&s.key) {
                self.since = now;
            }
            self.key = Some(s.key.clone());
            self.challenger = None;
        }
        self.key.clone()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn subject(key: &str, x: f32) -> Subject {
        Subject {
            key: key.into(),
            point: Vec3::X * x,
            player: true,
            weight: 1.,
        }
    }
    fn shot(key: &str, score: f32) -> Shot {
        Shot {
            key: key.into(),
            score,
            position: Vec3::ZERO,
            look: Vec3::Z,
            yaw: 0.,
        }
    }
    #[test]
    fn teleports_and_seeks_cut_but_walking_stays_smooth() {
        assert!(camera_cut(true, Vec3::ZERO, Vec3::ZERO, 40.));
        assert!(camera_cut(false, Vec3::ZERO, Vec3::X * 500., 40.));
        assert!(camera_cut(false, Vec3::ZERO, Vec3::Y * 80., 40.));
        assert!(!camera_cut(false, Vec3::ZERO, Vec3::X * 2., 40.));
    }
    #[test]
    fn anchor_holds_through_small_and_brief_improvements() {
        let mut h = AnchorHold::default();
        h.select(&[shot("a", 0.7), shot("b", 0.6)], 0., "");
        assert_eq!(
            h.select(&[shot("a", 0.7), shot("b", 0.8)], 10., "")
                .as_deref(),
            Some("a")
        );
        h.select(&[shot("a", 0.3), shot("b", 0.8)], 11., "");
        assert_eq!(
            h.select(&[shot("a", 0.3), shot("b", 0.8)], 11.5, "")
                .as_deref(),
            Some("a")
        );
        assert_eq!(
            h.select(&[shot("a", 0.3), shot("b", 0.8)], 12.1, "")
                .as_deref(),
            Some("b")
        );
    }
    #[test]
    fn missing_anchor_and_explicit_lock_replace_immediately() {
        let mut h = AnchorHold::default();
        h.select(&[shot("a", 0.9)], 0., "");
        assert_eq!(
            h.select(&[shot("b", 0.6), shot("c", 0.9)], 1., "b")
                .as_deref(),
            Some("b")
        );
        assert_eq!(h.select(&[shot("c", 0.9)], 2., "b").as_deref(), Some("c"));
    }
    #[test]
    fn five_second_hold_and_challenger_reset_prevent_oscillation() {
        let mut h = AnchorHold::default();
        h.select(&[shot("a", 0.8)], 0., "");
        h.select(&[shot("a", 0.3), shot("b", 0.9)], 3., "");
        assert_eq!(
            h.select(&[shot("a", 0.3), shot("b", 0.9)], 4.9, "")
                .as_deref(),
            Some("a")
        );
        h.select(&[shot("a", 0.3), shot("b", 0.9)], 5., "");
        h.select(&[shot("a", 0.8), shot("b", 0.7)], 5.5, "");
        h.select(&[shot("a", 0.3), shot("b", 0.9)], 6., "");
        assert_eq!(
            h.select(&[shot("a", 0.3), shot("b", 0.9)], 6.5, "")
                .as_deref(),
            Some("a")
        );
    }
    #[test]
    fn central_players_outrank_a_straggler_and_distance_is_capped() {
        let mut players: Vec<_> = (0..10).map(|i| subject(&i.to_string(), i as f32)).collect();
        players.push(subject("runner", 500.));
        assert!(!candidate_keys(&players, None, "")
            .iter()
            .any(|k| k == "runner"));
        let s = player_shot(&players[0], &players, 0., 40., 1., 1.6, |_, _| None);
        assert!(s.position.distance(players[0].point) <= 40.001);
        assert!(capped_position(Vec3::ZERO, Vec3::X * 100., 40.).length() <= 40.001);
    }
    #[test]
    fn blocked_local_view_tries_other_angles_and_collision_never_pushes_out() {
        let a = subject("a", 0.);
        let s = player_shot(&a, &[a.clone()], 0., 40., 1., 1.6, |_, v| {
            (v.z > 2.).then_some(2.)
        });
        assert!(s.position.z <= 2.001);
        let p = clear_boom(Vec3::ZERO, Vec3::Z * 20., |_, _| Some(3.));
        assert!((p.z - 2.6).abs() < 0.001);
    }
    #[test]
    fn easing_and_screen_projection_are_stable() {
        assert!(in_frame(Vec3::Z * 20., Vec3::ZERO, Vec3::ZERO, 1., 1.6));
        assert!(!in_frame(
            Vec3::Z * 20.,
            Vec3::ZERO,
            Vec3::X * 100.,
            1.,
            1.6
        ));
        assert!(
            ((1. - ease(1. / 60., 5.)).powi(60) - (1. - ease(1. / 30., 5.)).powi(30)).abs()
                < 0.0001
        );
    }
}
