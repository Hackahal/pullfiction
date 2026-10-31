//! One diagnostic simulation step drives both Bevy time and replay missile time.
pub(super) fn delta_seconds(step: f64, advancing: bool, frozen: bool, capturing: bool) -> f64 {
    if !capturing && (advancing || !frozen) {
        step
    } else {
        0.
    }
}

#[cfg(test)]
mod tests {
    use super::delta_seconds;
    #[test]
    fn explicit_and_continuous_simulation_use_the_same_clock_step() {
        let step = 1. / 60.;
        assert_eq!(delta_seconds(step, true, true, false), step);
        assert_eq!(delta_seconds(step, false, false, false), step);
        assert_eq!(delta_seconds(step, false, true, false), 0.);
        for advancing in [false, true] {
            for frozen in [false, true] {
                assert_eq!(delta_seconds(step, advancing, frozen, true), 0.);
            }
        }
    }
}
