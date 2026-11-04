//! Retain native plate metadata until its recorded values actually change.
#[derive(Clone, Debug, serde::Deserialize)]
pub struct ReplayCast {
    pub name: String,
    pub icon: String,
    pub progress: f32,
    pub remaining: f32,
}
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
pub struct ReplayAura {
    #[serde(default)]
    pub name: String,
    pub spell: u32,
    pub icon: String,
    pub stack: u32,
    pub debuff: bool,
}

impl PartialEq for ReplayCast {
    fn eq(&self, other: &Self) -> bool {
        self.name == other.name
            && self.icon == other.icon
            && self.progress.to_bits() == other.progress.to_bits()
            && self.remaining.to_bits() == other.remaining.to_bits()
    }
}

pub(crate) fn refresh_cast(current: &mut Option<ReplayCast>, incoming: &Option<ReplayCast>) {
    if current != incoming {
        *current = incoming.clone();
    }
}

pub(crate) fn refresh_auras(current: &mut Vec<ReplayAura>, incoming: &[ReplayAura]) {
    if current != incoming {
        *current = incoming.to_vec();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn aura() -> ReplayAura {
        ReplayAura {
            name: "Earth Shield".into(),
            spell: 408514,
            icon: "spell_nature_skinofearth.jpg".into(),
            stack: 1,
            debuff: false,
        }
    }
    fn cast() -> ReplayCast {
        ReplayCast {
            name: "Chain Heal".into(),
            icon: "chainheal.jpg".into(),
            progress: 0.25,
            remaining: 1.5,
        }
    }
    #[test]
    fn unchanged_plate_data_retains_owned_strings_and_aura_storage() {
        let incoming_cast = Some(cast());
        let incoming_auras = vec![aura()];
        let mut current_cast = incoming_cast.clone();
        let mut current_auras = incoming_auras.clone();
        let cast_ptr = current_cast.as_ref().unwrap().name.as_ptr();
        let aura_ptr = current_auras.as_ptr();
        let name_ptr = current_auras[0].name.as_ptr();
        for _ in 0..120 {
            refresh_cast(&mut current_cast, &incoming_cast);
            refresh_auras(&mut current_auras, &incoming_auras);
        }
        assert_eq!(current_cast, incoming_cast);
        assert_eq!(current_auras, incoming_auras);
        assert_eq!(current_cast.as_ref().unwrap().name.as_ptr(), cast_ptr);
        assert_eq!(current_auras.as_ptr(), aura_ptr);
        assert_eq!(current_auras[0].name.as_ptr(), name_ptr);
    }
    #[test]
    fn every_aura_field_and_order_removal_remain_observable() {
        let base = aura();
        let mut current = vec![base.clone()];
        let mut changes = Vec::new();
        let mut a = base.clone();
        a.name.push('!');
        changes.push(a);
        let mut a = base.clone();
        a.spell += 1;
        changes.push(a);
        let mut a = base.clone();
        a.icon.push('!');
        changes.push(a);
        let mut a = base.clone();
        a.stack += 1;
        changes.push(a);
        let mut a = base.clone();
        a.debuff = true;
        changes.push(a);
        for changed in changes {
            assert_ne!(changed, base);
            refresh_auras(&mut current, &[changed.clone()]);
            assert_eq!(current, [changed]);
        }
        let mut second = base.clone();
        second.spell += 1;
        let mut rows = vec![base, second];
        refresh_auras(&mut current, &rows);
        assert_eq!(current, rows);
        rows.reverse();
        refresh_auras(&mut current, &rows);
        assert_eq!(current, rows);
        refresh_auras(&mut current, &[]);
        assert!(current.is_empty());
    }
    #[test]
    fn cast_fields_clear_and_float_bits_are_preserved() {
        let base = cast();
        let mut current = None;
        refresh_cast(&mut current, &Some(base.clone()));
        assert_eq!(current, Some(base.clone()));
        let mut changes = Vec::new();
        let mut c = base.clone();
        c.name.push('!');
        changes.push(c);
        let mut c = base.clone();
        c.icon.push('!');
        changes.push(c);
        let mut c = base.clone();
        c.progress += 0.01;
        changes.push(c);
        let mut c = base.clone();
        c.remaining += 0.01;
        changes.push(c);
        for changed in changes {
            assert_ne!(changed, base);
            refresh_cast(&mut current, &Some(changed.clone()));
            assert_eq!(current, Some(changed));
        }
        for progress in [
            0.0,
            -0.0,
            f32::from_bits(0x7fc00001),
            f32::from_bits(0x7fc00002),
        ] {
            let mut c = base.clone();
            c.progress = progress;
            refresh_cast(&mut current, &Some(c));
            assert_eq!(
                current.as_ref().unwrap().progress.to_bits(),
                progress.to_bits()
            );
        }
        refresh_cast(&mut current, &None);
        assert!(current.is_none());
    }
}
