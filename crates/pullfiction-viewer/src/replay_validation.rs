//! Bounds on data crossing the replay transport, independent of the renderer.

pub(crate) fn valid_object_scale(scale: f32) -> bool {
    // The client's authored object scale can be below the editor's manual
    // placement minimum. For example, Flame of Ragnaros is approximately 0.01.
    scale.is_finite() && scale > 0.0 && scale <= 20.0
}

#[cfg(test)]
mod tests {
    use super::valid_object_scale;

    #[test]
    fn accepts_small_authored_objects_without_rescaling_them() {
        assert!(valid_object_scale(0.009_999_999_8));
        assert!(valid_object_scale(0.001));
        assert!(valid_object_scale(1.0));
        assert!(valid_object_scale(20.0));
    }

    #[test]
    fn rejects_invalid_or_excessive_scales() {
        for value in [0.0, -0.01, 20.1, f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert!(!valid_object_scale(value));
        }
    }
}
