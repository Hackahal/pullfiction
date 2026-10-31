//! Native readiness retries retain the latest replay input without cloning gear, auras or events.

pub(crate) struct RetainedFrame<T> {
    source: Option<(u32, u64)>,
    frame: Option<T>,
    applied_revision: Option<u64>,
}
impl<T> Default for RetainedFrame<T> {
    fn default() -> Self {
        Self {
            source: None,
            frame: None,
            applied_revision: None,
        }
    }
}
impl<T> RetainedFrame<T> {
    pub(crate) fn synchronize(&mut self, source: (u32, u64), reset: bool) -> bool {
        let changed = self.source != Some(source);
        if reset || changed {
            self.frame = None;
            self.applied_revision = None;
        }
        self.source = Some(source);
        reset || changed
    }

    pub(crate) fn replace(&mut self, frame: T) {
        self.frame = Some(frame);
        self.applied_revision = None;
    }

    pub(crate) fn ready(&self, revision: u64, playing: bool) -> Option<&T> {
        if self.applied_revision.is_none() || (!playing && self.applied_revision != Some(revision))
        {
            self.frame.as_ref()
        } else {
            None
        }
    }

    pub(crate) fn applied(&mut self, revision: u64) {
        self.applied_revision = Some(revision);
    }

    pub(crate) fn retry_after_spawn(&mut self) {
        self.applied_revision = None;
    }
}

pub(crate) struct NativeReadiness<P> {
    context: Option<(u64, Option<f32>, bool)>,
    placements: Vec<P>,
    revision: u64,
}
impl<P> Default for NativeReadiness<P> {
    fn default() -> Self {
        Self {
            context: None,
            placements: Vec::new(),
            revision: 0,
        }
    }
}
impl<P: PartialEq> NativeReadiness<P> {
    pub(crate) fn observe(
        &mut self,
        collider_epoch: u64,
        placements: impl IntoIterator<Item = P>,
        fallback_height: Option<f32>,
        character_catalog_present: bool,
        assets_changed: bool,
    ) -> u64 {
        let context = (collider_epoch, fallback_height, character_catalog_present);
        let mut changed = self.context != Some(context) || assets_changed;
        self.context = Some(context);
        let mut count = 0;
        for placement in placements {
            if let Some(old) = self.placements.get_mut(count) {
                if *old != placement {
                    *old = placement;
                    changed = true;
                }
            } else {
                self.placements.push(placement);
                changed = true;
            }
            count += 1;
        }
        if self.placements.len() != count {
            self.placements.truncate(count);
            changed = true;
        }
        if changed {
            self.revision = self.revision.wrapping_add(1);
        }
        self.revision
    }
}

#[cfg(test)]
#[path = "planner_grounding.rs"]
mod grounding;

#[cfg(test)]
mod tests {
    use super::{grounding::GroundMemo, NativeReadiness, RetainedFrame};

    #[test]
    fn a_missing_floor_recovers_while_paused_when_wmo_geometry_arrives() {
        let mut retained = RetainedFrame::default();
        let mut readiness = NativeReadiness::<(u32, [f32; 3])>::default();
        let mut memo = GroundMemo::default();
        retained.synchronize((531, 1), false);
        retained.replace([1., 0., 2.]);
        let before = readiness.observe(7, [], None, true, false);
        let request = *retained.ready(before, false).unwrap();
        assert_eq!(memo.resolve(request, before, || None), None);
        retained.applied(before);
        assert!(retained.ready(before, false).is_none());

        // The loaded WMO can supply floors before its colliders enter the paced attach queue.
        let loaded = readiness.observe(7, [(10, [0.; 3])], None, true, true);
        assert_ne!(loaded, before);
        let request = *retained.ready(loaded, false).unwrap();
        assert_eq!(
            memo.resolve(request, loaded, || Some([1., 10.05, 2.])),
            Some([1., 10.05, 2.])
        );
        retained.applied(loaded);
        for _ in 0..100 {
            let unchanged = readiness.observe(7, [(10, [0.; 3])], None, true, false);
            assert_eq!(unchanged, loaded);
            assert!(retained.ready(unchanged, false).is_none());
        }
    }

    #[test]
    fn a_visible_actor_refreshes_on_collision_or_wmo_changes_and_survives_a_miss() {
        let mut readiness = NativeReadiness::<u32>::default();
        let mut retained = RetainedFrame::default();
        let mut memo = GroundMemo::default();
        retained.synchronize((469, 1), false);
        retained.replace([1., 413., 2.]);
        let initial = readiness.observe(1, [5], None, true, false);
        let request = *retained.ready(initial, false).unwrap();
        assert_eq!(
            memo.resolve(request, initial, || Some([1., 413.05, 2.])),
            Some([1., 413.05, 2.])
        );
        retained.applied(initial);
        let collider = readiness.observe(2, [5], None, true, false);
        let request = *retained.ready(collider, false).unwrap();
        assert_eq!(
            memo.resolve(request, collider, || Some([1., 414.05, 2.])),
            Some([1., 414.05, 2.])
        );
        retained.applied(collider);
        let modified = readiness.observe(2, [5], None, true, true);
        let request = *retained.ready(modified, false).unwrap();
        assert_eq!(
            memo.resolve(request, modified, || None),
            Some([1., 414.05, 2.])
        );
    }

    #[test]
    fn latest_owned_playing_input_remains_available_when_pause_has_no_new_frame() {
        // No Clone bound: nested replay inputs stay owned and are read by reference on retries.
        struct Input(u32);
        let mut retained = RetainedFrame::default();
        retained.synchronize((531, 1), false);
        retained.replace(Input(1));
        assert_eq!(retained.ready(1, true).unwrap().0, 1);
        retained.applied(1);
        retained.replace(Input(2));
        assert_eq!(retained.ready(1, true).unwrap().0, 2);
        retained.applied(1);
        assert!(retained.ready(2, true).is_none());
        assert_eq!(retained.ready(2, false).unwrap().0, 2);
        retained.applied(2);
        assert!(retained.ready(2, false).is_none());
    }

    #[test]
    fn resets_maps_and_report_generations_cannot_replay_stale_inputs() {
        let mut retained = RetainedFrame::default();
        for (source, reset) in [((531, 1), true), ((469, 1), false), ((469, 2), false)] {
            retained.replace("old actor/cast data");
            retained.applied(1);
            assert!(retained.synchronize(source, reset));
            assert!(retained.ready(2, false).is_none());
        }
        retained.replace("replacement report");
        assert_eq!(retained.ready(2, false), Some(&"replacement report"));
        retained.applied(2);
        assert!(!retained.synchronize((469, 2), false));
        assert!(retained.ready(2, false).is_none());
    }

    #[test]
    fn every_native_floor_and_character_readiness_input_invalidates_once() {
        let mut r = NativeReadiness::<(u32, [f32; 3])>::default();
        let initial = r.observe(1, [(5, [0.; 3])], Some(0.), false, false);
        assert_eq!(
            r.observe(1, [(5, [0.; 3])], Some(0.), false, false),
            initial
        );
        let mut prior = initial;
        for (epoch, placements, height, catalog, asset_event) in [
            (2, vec![(5, [0.; 3])], Some(0.), false, false),
            (2, vec![(6, [0.; 3])], Some(0.), false, false),
            (2, vec![(6, [0., 10., 0.])], Some(0.), false, false),
            (2, vec![], Some(0.), false, false),
            (2, vec![], Some(10.), false, false),
            (2, vec![], Some(10.), true, false),
            (2, vec![], Some(10.), true, true),
        ] {
            let revision = r.observe(epoch, placements.clone(), height, catalog, asset_event);
            assert_ne!(revision, prior);
            assert_eq!(
                r.observe(epoch, placements, height, catalog, false),
                revision
            );
            prior = revision;
        }
    }

    #[test]
    fn deferred_actor_creation_gets_one_followup_even_without_a_geometry_change() {
        let mut retained = RetainedFrame::default();
        retained.synchronize((531, 1), false);
        retained.replace("actor with an active recorded cast");
        assert!(retained.ready(1, false).is_some());
        retained.applied(1);
        retained.retry_after_spawn();
        assert_eq!(
            retained.ready(1, false),
            Some(&"actor with an active recorded cast")
        );
        retained.applied(1);
        for _ in 0..30 {
            assert!(retained.ready(1, false).is_none());
        }
    }

    #[test]
    fn replacing_with_an_empty_frame_drops_the_previous_roster() {
        let mut retained = RetainedFrame::default();
        retained.synchronize((531, 1), false);
        retained.replace(vec![42]);
        retained.applied(1);
        retained.replace(Vec::<u32>::new());
        assert!(retained.ready(1, false).unwrap().is_empty());
        retained.applied(1);
        assert!(retained.ready(2, false).unwrap().is_empty());
    }
}
