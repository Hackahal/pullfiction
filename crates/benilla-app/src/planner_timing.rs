//! Replay-time projectile integration, independent of wall-clock/render cadence.
#[derive(Clone, Copy)]
pub(crate) struct ReplayFlight {
    pub at: f64,
    pub generation: u64,
    pub recorded: bool,
}
#[derive(Debug, PartialEq)]
pub(crate) enum FlightStep {
    Reset,
    Arrived,
    Progress(f32),
}
impl ReplayFlight {
    pub(crate) fn step(self, previous: f64, now: f64, generation: u64) -> FlightStep {
        if self.generation != generation {
            FlightStep::Reset
        } else if now >= self.at {
            FlightStep::Arrived
        } else {
            FlightStep::Progress(
                ((now - previous) / (self.at - previous).max(0.001)).clamp(0.0, 1.0) as f32,
            )
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn flight() -> ReplayFlight {
        ReplayFlight {
            at: 1000.0,
            generation: 1,
            recorded: true,
        }
    }
    #[test]
    fn paused_clock_never_moves_projectiles() {
        assert_eq!(flight().step(500.0, 500.0, 1), FlightStep::Progress(0.0));
    }
    #[test]
    fn accelerated_clock_covers_the_recorded_fraction() {
        assert_eq!(flight().step(200.0, 600.0, 1), FlightStep::Progress(0.5));
    }
    #[test]
    fn arrival_occurs_at_the_exact_recorded_boundary() {
        assert!(matches!(flight().step(950.0,999.0,1),FlightStep::Progress(x) if x<1.0));
        assert_eq!(flight().step(950.0, 1000.0, 1), FlightStep::Arrived);
        assert_eq!(flight().step(950.0, 1500.0, 1), FlightStep::Arrived);
    }
    #[test]
    fn seek_generation_discards_old_flights_even_past_the_deadline() {
        assert_eq!(flight().step(900.0, 2000.0, 2), FlightStep::Reset);
    }
    #[test]
    fn rewind_cannot_run_a_missile_backwards() {
        assert_eq!(flight().step(600.0, 200.0, 1), FlightStep::Progress(0.0));
    }
    #[test]
    fn render_frame_partition_does_not_change_the_position() {
        let mut position = 0.0_f32;
        let mut previous = 0.0;
        for now in [100.0, 275.0, 400.0, 600.0] {
            if let FlightStep::Progress(fraction) = flight().step(previous, now, 1) {
                position += (10.0 - position) * fraction;
            }
            previous = now;
        }
        assert!((position - 6.0).abs() < 0.0001);
    }
}
