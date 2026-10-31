//! Bounded transport and stale-readback rules for the independent actor inspector.
pub(super) const WIDTH: u32 = 512;
pub(super) const HEIGHT: u32 = 768;
pub(super) const TIMEOUT: f64 = 15.0;

/// Initial geometry/material preparation retains the full settle. Only a previously successful
/// copy can use the one-render yaw path; appearance or lighting rebuilds make it cold again.
#[derive(Default)]
pub(super) struct CaptureTiming {
    warm: bool,
    phase: u32,
}
impl CaptureTiming {
    pub(super) fn request(&mut self, same_appearance: bool) {
        if !same_appearance {
            self.warm = false;
        }
        self.phase = 0;
    }
    pub(super) fn rebuilt(&mut self) {
        self.request(false);
    }
    pub(super) fn reframe_wake(&self, before: u32, placed: u32) -> u32 {
        if self.warm {
            before.max(1)
        } else {
            placed
        }
    }
    pub(super) fn capture_frame(&mut self) -> bool {
        self.phase += 1;
        self.phase >= if self.warm { 1 } else { 4 }
    }
    pub(super) fn empty_readback(&mut self) {
        self.phase = 0;
    }
    pub(super) fn valid_readback(&mut self) {
        self.warm = true;
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request<T> {
    pub key: String,
    pub request_id: u64,
    pub yaw: f32,
    pub unit: T,
}
impl<T> Request<T> {
    pub fn validate_header(&self) -> Result<(), &'static str> {
        if self.key.is_empty() || self.key.len() > 80 {
            return Err("Inspection key must contain 1–80 bytes");
        }
        if self.request_id > 9_007_199_254_740_991 {
            return Err("Inspection requestId must be a safe JavaScript integer");
        }
        if !self.yaw.is_finite() || self.yaw.abs() > std::f32::consts::TAU * 4.0 {
            return Err("Inspection yaw must be finite and within four turns");
        }
        Ok(())
    }
}

pub(super) fn visible_readback(width: u32, height: u32, rgba: &[u8]) -> bool {
    width == WIDTH
        && height == HEIGHT
        && rgba.len() == (WIDTH * HEIGHT * 4) as usize
        && rgba.chunks_exact(4).any(|p| p[3] != 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn warm_yaw_requests_fit_120ms_at_30fps_without_shortening_initial_or_rebuilt_settle() {
        fn render_until_capture(timing: &mut CaptureTiming) -> u32 {
            let mut wake = timing.reframe_wake(0, 4);
            for frame in 1..=8 {
                // The real booth camera gate spends a wake frame before capture runs.
                wake = wake.saturating_sub(1);
                if wake == 0 && timing.capture_frame() {
                    return frame;
                }
            }
            panic!("capture did not become eligible");
        }
        let mut timing = CaptureTiming::default();
        timing.request(false);
        assert_eq!(render_until_capture(&mut timing), 7, "full initial settle");
        // An empty GPU target must not establish a reusable warm copy.
        timing.empty_readback();
        timing.request(true);
        assert_eq!(render_until_capture(&mut timing), 7);
        timing.valid_readback();
        for _ in 0..8 {
            timing.request(true);
            let frames = render_until_capture(&mut timing);
            assert_eq!(frames, 1, "same equipped model, only yaw changed");
            assert!(frames as f32 / 30.0 < 0.120);
        }
        timing.rebuilt();
        assert_eq!(
            render_until_capture(&mut timing),
            7,
            "a new lighting/material build stays cold"
        );
        timing.valid_readback();
        timing.request(false);
        assert_eq!(
            render_until_capture(&mut timing),
            7,
            "appearance changes retain full settle"
        );
    }
    #[test]
    fn rejects_invalid_transport_without_coercing_rotation_or_identity() {
        let mut r = Request {
            key: "actor-1".into(),
            request_id: 4,
            yaw: 0.0,
            unit: (),
        };
        assert!(r.validate_header().is_ok());
        r.yaw = f32::NAN;
        assert!(r.validate_header().is_err());
        r.yaw = std::f32::consts::TAU * 4.0 + 0.01;
        assert!(r.validate_header().is_err());
        r.yaw = 0.0;
        r.request_id = 9_007_199_254_740_992;
        assert!(r.validate_header().is_err());
        r.request_id = 4;
        r.key.clear();
        assert!(r.validate_header().is_err());
    }
    #[test]
    fn accepts_only_fixed_size_nonempty_transparent_target_readback() {
        let mut rgba = vec![0; (WIDTH * HEIGHT * 4) as usize];
        assert!(!visible_readback(WIDTH, HEIGHT, &rgba));
        rgba[3] = 255;
        assert!(visible_readback(WIDTH, HEIGHT, &rgba)); // even a real black model counts
        assert!(!visible_readback(256, 256, &rgba));
        assert!(!visible_readback(WIDTH, HEIGHT, &rgba[..rgba.len() - 1]));
    }
    #[test]
    fn accepts_the_documented_camelcase_envelope() {
        let r: Request<serde_json::Value> = serde_json::from_str(
            r#"{"key":"actor-1","requestId":12,"yaw":1.5,"unit":{"player":true}}"#,
        )
        .unwrap();
        assert_eq!(r.request_id, 12);
        assert_eq!(r.unit["player"], true);
    }
}
