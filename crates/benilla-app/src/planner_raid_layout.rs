//! Native raid frames choose a grid that maximizes readable cell size in the requested rectangle.
#[derive(Clone, Copy, Debug)]
pub(crate) struct RaidLayout {
    pub rows: usize,
    pub columns: usize,
    pub scale: f32,
}
pub(crate) fn layout(count: usize, width: f32, height: f32) -> RaidLayout {
    let count = count.max(1);
    let mut best = RaidLayout {
        rows: count,
        columns: 1,
        scale: 0.,
    };
    for columns in 1..=count {
        let rows = count.div_ceil(columns);
        let scale = (width.max(1.) / (columns as f32 * 91. - 4.))
            .min(height.max(1.) / (rows as f32 * 56. - 4.));
        if scale > best.scale {
            best = RaidLayout {
                rows,
                columns,
                scale,
            };
        }
    }
    best
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classic_default_preserves_five_rows_and_eight_columns() {
        let l = layout(40, 724., 276.);
        assert_eq!((l.rows, l.columns), (5, 8));
        assert!((l.scale - 1.).abs() < 0.001);
    }
    #[test]
    fn tall_and_wide_rectangles_choose_different_grids() {
        let tall = layout(40, 300., 600.);
        let wide = layout(40, 900., 170.);
        assert!(tall.rows > wide.rows);
        assert!(tall.columns < wide.columns);
    }
    #[test]
    fn cells_fit_and_all_members_have_a_slot() {
        for n in [1, 5, 20, 40, 60] {
            for (w, h) in [(240., 120.), (320., 600.), (1000., 300.)] {
                let l = layout(n, w, h);
                assert!(l.rows * l.columns >= n);
                assert!((l.columns as f32 * 91. - 4.) * l.scale <= w + 0.001);
                assert!((l.rows as f32 * 56. - 4.) * l.scale <= h + 0.001);
            }
        }
    }
}
