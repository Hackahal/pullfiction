//! Modern MOMT sampler flags, kept separate from the original WMO reader.

/// MOMT 0x40/0x80 clamp S/T. False means clamp, matching RenderSubmesh address modes.
pub(crate) fn repeat_axes(flags: u32) -> (bool, bool) {
    (flags & 0x40 == 0, flags & 0x80 == 0)
}

#[cfg(test)]
mod tests {
    use super::repeat_axes;

    #[test]
    fn each_axis_uses_its_authored_clamp_bit() {
        assert_eq!(repeat_axes(0), (true, true));
        assert_eq!(repeat_axes(0x40), (false, true));
        assert_eq!(repeat_axes(0x80), (true, false));
        assert_eq!(repeat_axes(0xc0), (false, false));
    }

    #[test]
    fn other_material_flags_do_not_change_address_modes() {
        let unrelated = 0x01 | 0x02 | 0x04 | 0x08 | 0x10 | 0x20 | 0x100;
        for clamp in [0, 0x40, 0x80, 0xc0] {
            assert_eq!(repeat_axes(clamp | unrelated), repeat_axes(clamp));
        }
    }
}
