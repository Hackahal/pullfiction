//! Player identity colours stay independent of replay position confidence.

pub(crate) fn nameplate_color(
    player: bool,
    class: u8,
    estimated: bool,
    friendly: bool,
) -> [f32; 3] {
    if player {
        match class {
            1 => [0.78, 0.61, 0.43],
            2 => [0.96, 0.55, 0.73],
            3 => [0.67, 0.83, 0.45],
            4 => [1., 0.96, 0.41],
            5 => [0.9, 0.91, 0.96],
            7 => [0.1, 0.4, 0.95],
            8 => [0.41, 0.8, 0.94],
            9 => [0.58, 0.51, 0.79],
            11 => [1., 0.49, 0.04],
            _ => [0.6, 0.65, 0.72],
        }
    } else if estimated {
        [0.35, 0.75, 0.94]
    } else if friendly {
        [0.39, 0.69, 0.61]
    } else {
        [0.83, 0.28, 0.23]
    }
}

#[cfg(test)]
mod tests {
    use super::nameplate_color;

    #[test]
    fn every_player_keeps_their_class_colour_through_estimated_gaps() {
        let mage = nameplate_color(true, 8, false, false);
        for class in [1, 2, 3, 4, 5, 7, 8, 9, 11] {
            let recorded = nameplate_color(true, class, false, false);
            assert_eq!(nameplate_color(true, class, true, false), recorded);
            assert_eq!(nameplate_color(true, class, true, true), recorded);
            if class != 8 {
                assert_ne!(recorded, mage, "class {class} must not look like a mage");
            }
        }
        assert_eq!(nameplate_color(true, 1, true, false), [0.78, 0.61, 0.43]);
        assert_eq!(nameplate_color(true, 11, true, false), [1., 0.49, 0.04]);
    }

    #[test]
    fn unknown_players_remain_neutral_and_nonplayer_colours_stay_distinct() {
        assert_eq!(nameplate_color(true, 0, true, false), [0.6, 0.65, 0.72]);
        assert_eq!(nameplate_color(false, 0, false, true), [0.39, 0.69, 0.61]);
        assert_eq!(nameplate_color(false, 0, false, false), [0.83, 0.28, 0.23]);
        assert_eq!(nameplate_color(false, 0, true, false), [0.35, 0.75, 0.94]);
    }
}
