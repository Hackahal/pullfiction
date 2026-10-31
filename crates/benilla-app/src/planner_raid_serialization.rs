//! Exact static raid-row source, bounded to the current compact roster.
use std::collections::HashMap;

const MAX_ROWS: usize = 40;

pub(crate) fn quote(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn icon(s: &str) -> String {
    let stem = s
        .rsplit('/')
        .next()
        .unwrap_or(s)
        .split('.')
        .next()
        .unwrap_or("");
    format!(
        "Interface\\Icons\\{}",
        if stem.is_empty() {
            "INV_Misc_QuestionMark"
        } else {
            stem
        }
    )
}

pub(crate) struct AuraInput<'a> {
    pub spell: u32,
    pub name: &'a str,
    pub icon: &'a str,
    pub stack: u32,
    pub debuff: bool,
}

struct StoredAura {
    spell: u32,
    name: String,
    icon: String,
    stack: u32,
    debuff: bool,
}
impl StoredAura {
    fn matches(&self, input: &AuraInput<'_>) -> bool {
        self.spell == input.spell
            && self.name == input.name
            && self.icon == input.icon
            && self.stack == input.stack
            && self.debuff == input.debuff
    }
}
impl From<AuraInput<'_>> for StoredAura {
    fn from(input: AuraInput<'_>) -> Self {
        Self {
            spell: input.spell,
            name: input.name.to_owned(),
            icon: input.icon.to_owned(),
            stack: input.stack,
            debuff: input.debuff,
        }
    }
}

pub(crate) struct Sources {
    pub guid: String,
    pub name: String,
    pub auras: String,
    raw_name: String,
    raw_auras: Vec<StoredAura>,
}
impl Sources {
    fn new(guid: u64, name: &str) -> Self {
        Self {
            guid: quote(&guid.to_string()),
            name: quote(name),
            auras: String::new(),
            raw_name: name.to_owned(),
            raw_auras: Vec::new(),
        }
    }
}

#[derive(Default)]
pub(crate) struct RaidSerialization {
    context: Option<(u64, u64)>,
    entries: HashMap<u64, Sources>,
    #[cfg(test)]
    aura_builds: usize,
    #[cfg(test)]
    aura_reuses: usize,
}
impl RaidSerialization {
    pub(crate) fn clear(&mut self) {
        self.context = None;
        self.entries.clear();
    }

    pub(crate) fn begin(&mut self, session: u64, generation: u64, guids: &[u64]) {
        if self.context != Some((session, generation)) {
            self.clear();
            self.context = Some((session, generation));
        }
        self.entries.retain(|guid, _| guids.contains(guid));
    }

    pub(crate) fn sources<'a>(
        &mut self,
        guid: u64,
        name: &str,
        auras: impl IntoIterator<Item = AuraInput<'a>>,
    ) -> &Sources {
        // The caller truncates the live roster to 40; keep the cache bounded even out of sequence.
        if self.entries.len() >= MAX_ROWS && !self.entries.contains_key(&guid) {
            self.entries.clear();
        }
        let entry = self
            .entries
            .entry(guid)
            .or_insert_with(|| Sources::new(guid, name));
        if entry.raw_name != name {
            entry.raw_name = name.to_owned();
            entry.name = quote(name);
        }
        let mut changed = false;
        let mut count = 0;
        for aura in auras {
            if let Some(old) = entry.raw_auras.get_mut(count) {
                if !old.matches(&aura) {
                    *old = aura.into();
                    changed = true;
                }
            } else {
                entry.raw_auras.push(aura.into());
                changed = true;
            }
            count += 1;
        }
        if entry.raw_auras.len() != count {
            entry.raw_auras.truncate(count);
            changed = true;
        }
        if changed {
            entry.auras = entry
                .raw_auras
                .iter()
                .map(|a| {
                    format!(
                        "{{spell={},name={},icon={},stack={},debuff={}}}",
                        a.spell,
                        quote(&a.name),
                        quote(&icon(&a.icon)),
                        a.stack,
                        a.debuff
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            #[cfg(test)]
            {
                self.aura_builds += 1;
            }
        } else {
            #[cfg(test)]
            {
                self.aura_reuses += 1;
            }
        }
        entry
    }
}

#[cfg(test)]
#[path = "planner_ui_payload.rs"]
mod payload;

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone)]
    struct Aura {
        spell: u32,
        name: String,
        icon: String,
        stack: u32,
        debuff: bool,
    }
    fn aura(i: u32) -> Aura {
        Aura {
            spell: i + 1,
            name: format!("Aura {i} Å🙂\\\"\n"),
            icon: format!("folder/icon_{i}.multi.ext"),
            stack: i % 4,
            debuff: i % 2 == 0,
        }
    }
    fn inputs(auras: &[Aura]) -> impl Iterator<Item = AuraInput<'_>> {
        auras.iter().map(|a| AuraInput {
            spell: a.spell,
            name: &a.name,
            icon: &a.icon,
            stack: a.stack,
            debuff: a.debuff,
        })
    }

    // The pre-cache serializers, retained as the byte-for-byte compatibility oracle.
    fn original_quote(s: &str) -> String {
        let mut out = String::from("\"");
        for c in s.chars() {
            match c {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                c if c.is_control() => out.push(' '),
                c => out.push(c),
            }
        }
        out.push('"');
        out
    }
    fn original_icon(s: &str) -> String {
        let stem = s
            .rsplit('/')
            .next()
            .unwrap_or(s)
            .split('.')
            .next()
            .unwrap_or("");
        format!(
            "Interface\\Icons\\{}",
            if stem.is_empty() {
                "INV_Misc_QuestionMark"
            } else {
                stem
            }
        )
    }
    fn original_sources(guid: u64, name: &str, auras: &[Aura]) -> Sources {
        Sources {
            guid: original_quote(&guid.to_string()),
            name: original_quote(name),
            auras: auras
                .iter()
                .map(|a| {
                    format!(
                        "{{spell={},name={},icon={},stack={},debuff={}}}",
                        a.spell,
                        original_quote(&a.name),
                        original_quote(&original_icon(&a.icon)),
                        a.stack,
                        a.debuff
                    )
                })
                .collect::<Vec<_>>()
                .join(","),
            raw_name: String::new(),
            raw_auras: Vec::new(),
        }
    }
    fn update(source: &Sources, step: u32) -> String {
        // Same row and update format strings as the production driver. Every dynamic input varies.
        let hp = step * 17 % 101;
        let max = 100 + step;
        let power = step * 3;
        let maxpower = 120 + step;
        let class = step % 12;
        let powertype = step % 5;
        let known = step % 2 == 0;
        let powerknown = step % 3 != 0;
        let selected = step % 4 == 0;
        let cast = if step % 2 == 0 {
            format!(
                "{{name={},progress={:.4},remaining={}}}",
                quote("Cast Å\"\\\n"),
                (step as f32 / 20.).clamp(0., 1.),
                quote(&format!("{:.1}", (15.05 - step as f32).max(0.)))
            )
        } else {
            "nil".into()
        };
        let auras = &source.auras;
        let rows = format!("{{guid={},name={},class={},hp={hp},max={max},known={},power={},maxpower={},powertype={},powerknown={},selected={},cast={cast},auras={{{auras}}}}}",source.guid,source.name,class,known,power,maxpower,powertype,powerknown,selected);
        let enabled = step % 3 != 0;
        let seam = 1. + step as f32 / 10.;
        let rows_count = step as usize % 5 + 1;
        let scale = 0.5 + step as f32 / 100.;
        format!(
            "PullFictionRaid_Update({{{rows}}},{},{:.5},{},{:.5})",
            enabled,
            1. / seam,
            rows_count,
            scale
        )
    }

    #[test]
    fn quoting_keeps_the_existing_controls_escapes_and_unicode_bytes() {
        for (input, expected) in [
            ("", "\"\""),
            ("\n", "\"\\n\""),
            ("\r", "\"\\r\""),
            ("\t\0\u{85}\u{7f}", "\"    \""),
            ("\\", "\"\\\\\""),
            ("\"", "\"\\\"\""),
            ("Å™ 你好🙂\u{2028}", "\"Å™ 你好🙂\u{2028}\""),
        ] {
            assert_eq!(quote(input).as_bytes(), expected.as_bytes());
        }
        for icon_path in ["", "/", ".png", "x/a.b.c", "a\\b.png", "你好/icon🙂.png"] {
            assert_eq!(icon(icon_path), original_icon(icon_path));
        }
    }

    #[test]
    fn complete_scripts_are_byte_identical_across_static_and_dynamic_inputs() {
        let names = ["", "Normal", "Quote\"Slash\\\n\r\t\0", "Å™ 你好🙂\u{2028}"];
        let mut cache = RaidSerialization::default();
        for (n, name) in names.into_iter().enumerate() {
            let guid = if n == 3 { u64::MAX } else { n as u64 };
            cache.begin(1, 1, &[guid]);
            for count in [0, 1, 16, 17, 48] {
                let auras: Vec<_> = (0..count).map(aura).collect();
                let original = original_sources(guid, name, &auras);
                for step in 0..32 {
                    let cached = cache.sources(guid, name, inputs(&auras));
                    assert_eq!(
                        update(cached, step).as_bytes(),
                        update(&original, step).as_bytes()
                    );
                }
            }
        }
    }

    #[test]
    fn unchanged_aura_rows_reuse_the_same_source_without_rebuilding() {
        let mut cache = RaidSerialization::default();
        let auras: Vec<_> = (0..16).map(aura).collect();
        cache.begin(1, 1, &[7]);
        let pointer = cache
            .sources(7, "Recorded actor", inputs(&auras))
            .auras
            .as_ptr();
        for _ in 0..100 {
            assert_eq!(
                cache
                    .sources(7, "Recorded actor", inputs(&auras))
                    .auras
                    .as_ptr(),
                pointer
            );
        }
        assert_eq!(cache.aura_builds, 1);
        assert_eq!(cache.aura_reuses, 100);
        let source = cache.sources(7, "Renamed actor", inputs(&auras));
        assert_eq!(source.name, quote("Renamed actor"));
        assert_eq!(source.auras.as_ptr(), pointer);
        assert_eq!(cache.aura_builds, 1);
    }

    #[test]
    fn every_serialized_aura_input_and_order_invalidates_the_cached_source() {
        let mut cache = RaidSerialization::default();
        let mut auras = vec![aura(1), aura(2)];
        cache.begin(1, 1, &[7]);
        cache.sources(7, "Actor", inputs(&auras));
        for field in 0..8 {
            match field {
                0 => auras[0].spell += 1,
                1 => auras[0].name.push('🙂'),
                2 => auras[0].icon.push('x'),
                3 => auras[0].stack += 1,
                4 => auras[0].debuff = !auras[0].debuff,
                5 => auras.swap(0, 1),
                6 => {
                    auras.pop();
                }
                _ => auras.clear(),
            }
            let expected = original_sources(7, "Actor", &auras);
            assert_eq!(
                cache.sources(7, "Actor", inputs(&auras)).auras,
                expected.auras
            );
            assert_eq!(cache.aura_builds, field + 2);
        }
    }

    #[test]
    fn roster_removal_session_and_generation_changes_drop_previous_sources() {
        let mut cache = RaidSerialization::default();
        let auras = [aura(1)];
        for (session, generation) in [(1, 1), (2, 1), (2, 2)] {
            cache.begin(session, generation, &[7]);
            assert!(cache.entries.is_empty());
            cache.sources(7, "Actor", inputs(&auras));
            assert_eq!(cache.entries.len(), 1);
        }
        assert_eq!(cache.aura_builds, 3);
        cache.begin(2, 2, &[]);
        assert!(cache.entries.is_empty());
        for roster in 0..100u64 {
            let guids: Vec<_> = (roster * 40..roster * 40 + 40).collect();
            cache.begin(2, 2, &guids);
            for guid in guids {
                cache.sources(guid, "Actor", inputs(&auras));
            }
            assert_eq!(cache.entries.len(), MAX_ROWS);
        }
        // The helper also enforces its bound if called outside the normal roster sequence.
        for guid in 10000..10100 {
            cache.sources(guid, "Actor", inputs(&auras));
            assert!(cache.entries.len() <= MAX_ROWS);
        }
    }

    #[test]
    fn a_failed_lua_update_rebuilds_serialization_and_retries_identical_bytes() {
        let mut cache = RaidSerialization::default();
        let mut payload = super::payload::UiPayload::default();
        let auras = [aura(1)];
        cache.begin(1, 1, &[7]);
        let failed = update(cache.sources(7, "Actor", inputs(&auras)), 2);
        let result = payload.run(1, failed.clone(), |_| Err("partial update"));
        if result.is_err() {
            cache.clear();
        }
        assert!(cache.entries.is_empty());
        cache.begin(1, 1, &[7]);
        let retry = update(cache.sources(7, "Actor", inputs(&auras)), 2);
        assert_eq!(retry.as_bytes(), failed.as_bytes());
        let mut executed = false;
        payload
            .run(1, retry, |_| {
                executed = true;
                Ok::<_, ()>(())
            })
            .unwrap();
        assert!(executed);
        assert_eq!(cache.aura_builds, 2);
    }
}
