//! Motion of an explicitly illustrative five-yard launch cue, not server simulation.
pub const DURATION_MS: f64 = 1500.;
pub const DISTANCE: f32 = 5.;

pub fn sample(age_ms: f64) -> Option<(f32, f32)> {
    if !(0.0..DURATION_MS).contains(&age_ms) {
        return None;
    }
    let fraction = (age_ms / DURATION_MS) as f32;
    let fade = ((1. - fraction) / 0.6).clamp(0., 1.);
    Some((DISTANCE * fraction, fade * fade * (3. - 2. * fade)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cue_travels_then_fades_and_expires_at_the_boundary() {
        assert_eq!(sample(0.), Some((0., 1.)));
        let (distance, alpha) = sample(750.).unwrap();
        assert_eq!(distance, 2.5);
        assert!(alpha > 0.8 && alpha < 1.);
        let (distance, alpha) = sample(1400.).unwrap();
        assert!(distance > 4.6 && distance < 5.);
        assert!(alpha > 0. && alpha < 0.04);
        assert_eq!(sample(1500.), None);
        assert_eq!(sample(-1.), None);
        assert_eq!(sample(f64::NAN), None);
    }
}
