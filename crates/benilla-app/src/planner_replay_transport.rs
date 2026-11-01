//! Versioned replay field updates, validated transactionally before becoming a full native frame.
use super::ReplayUnit;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Delta {
    version: u32,
    source: String,
    reset: bool,
    order: Vec<String>,
    updates: Vec<Map<String, Value>>,
}
#[derive(Default)]
pub struct FrameDecoder {
    source: Option<String>,
    actors: HashMap<String, ReplayUnit>,
}
impl FrameDecoder {
    pub fn clear(&mut self) {
        self.source = None;
        self.actors.clear();
    }
    pub fn decode(&mut self, json: &str) -> Result<Vec<ReplayUnit>, String> {
        if json.len() > 4_000_000 {
            return Err("Replay delta exceeds byte limit".into());
        }
        let delta: Delta = serde_json::from_str(json).map_err(|e| e.to_string())?;
        if delta.version != 1
            || delta.source.len() > 1024
            || delta.order.len() > 4096
            || delta.updates.len() > 4096
            || (!delta.reset && self.source.as_ref() != Some(&delta.source))
        {
            return Err("Invalid replay delta source or bounds".into());
        }
        let order: HashSet<_> = delta.order.iter().collect();
        if order.len() != delta.order.len() || delta.order.iter().any(|k| k.len() > 80) {
            return Err("Invalid replay delta order".into());
        }
        let mut updates = HashMap::new();
        for fields in delta.updates {
            let key = fields
                .get("key")
                .and_then(Value::as_str)
                .ok_or("Missing replay actor key")?
                .to_owned();
            if !order.contains(&key) || updates.contains_key(&key) {
                return Err("Invalid replay delta actor".into());
            }
            let mut actor = if !delta.reset {
                self.actors.get(&key).cloned()
            } else {
                None
            };
            if let Some(actor) = actor.as_mut() {
                patch(actor, fields)?;
            } else {
                actor =
                    Some(serde_json::from_value(Value::Object(fields)).map_err(|e| e.to_string())?);
            }
            let mut actor = actor.unwrap();
            validate(&mut actor)?;
            updates.insert(key, actor);
        }
        // No mutation before every changed/new row and order reference has passed validation.
        for key in &delta.order {
            if !updates.contains_key(key) && (delta.reset || !self.actors.contains_key(key)) {
                return Err("Replay delta references an unknown actor".into());
            }
        }
        if delta.reset {
            self.actors.clear();
        }
        self.actors.retain(|key, _| order.contains(key));
        self.actors.extend(updates);
        self.source = Some(delta.source);
        Ok(delta
            .order
            .iter()
            .map(|key| self.actors[key].clone())
            .collect())
    }
}
fn patch(actor: &mut ReplayUnit, fields: Map<String, Value>) -> Result<(), String> {
    macro_rules! update {
        ($value:expr, $field:ident) => {
            actor.$field = serde_json::from_value($value).map_err(|e| e.to_string())?
        };
    }
    for (key, value) in fields {
        match key.as_str() {
            "key" => {
                if value.as_str() != Some(&actor.key) {
                    return Err("Replay key changed".into());
                }
            }
            // Full-frame deserialization intentionally drops malformed optional movement.
            "movement" => {
                actor.movement = serde_json::from_value(value).ok().flatten();
            }
            "name" => update!(value, name),
            "player" => update!(value, player),
            "class" => update!(value, class),
            "entry" => update!(value, entry),
            "display" => update!(value, display),
            "scale" => update!(value, scale),
            "position" => update!(value, position),
            "ground" => update!(value, ground),
            "floor_hint" => update!(value, floor_hint),
            "facing" => update!(value, facing),
            "speed" => update!(value, speed),
            "trajectory" => update!(value, trajectory),
            "trajectory_prepare" => update!(value, trajectory_prepare),
            "trajectory_bridge" => update!(value, trajectory_bridge),
            "dead" => update!(value, dead),
            "friendly" => update!(value, friendly),
            "nameplate" => update!(value, nameplate),
            "raid" => update!(value, raid),
            "estimated" => update!(value, estimated),
            "wisp" => update!(value, wisp),
            "race" => update!(value, race),
            "sex" => update!(value, sex),
            "look" => update!(value, look),
            "gear" => update!(value, gear),
            "health" => update!(value, health),
            "max_health" => update!(value, max_health),
            "power" => update!(value, power),
            "max_power" => update!(value, max_power),
            "power_type" => update!(value, power_type),
            "plate_cast" => update!(value, plate_cast),
            "plate_auras" => update!(value, plate_auras),
            "channel" => update!(value, channel),
            "channel_target" => update!(value, channel_target),
            "cast" => update!(value, cast),
            "auras" => update!(value, auras),
            "self_auras" => update!(value, self_auras),
            _ => return Err(format!("Unknown replay field: {key}")),
        }
    }
    Ok(())
}
fn validate(actor: &mut ReplayUnit) -> Result<(), String> {
    if actor.key.len() > 80
        || actor.channel_target.as_ref().is_some_and(|s| s.len() > 80)
        || actor.name.len() > 120
        || !actor.facing.is_finite()
        || !actor.speed.is_finite()
        || !actor.scale.is_finite()
        || actor.scale <= 0.
        || actor.scale > 20.
        || actor
            .floor_hint
            .is_some_and(|z| !z.is_finite() || z.abs() > 20000.)
        || actor
            .position
            .iter()
            .flatten()
            .any(|v| !v.is_finite() || v.abs() > 20000.)
    {
        return Err("Invalid replay frame".into());
    }
    actor.movement = actor.movement.take().and_then(|s| s.validated());
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn row(key: &str) -> Value {
        serde_json::json!({"key":key,"name":"Mage","player":true,"class":1,"entry":0,"display":null,
            "scale":1,"position":[1,2,3],"ground":false,"facing":0,"speed":0,"dead":false})
    }
    fn packet(reset: bool, order: Vec<&str>, updates: Vec<Value>) -> String {
        serde_json::json!({"version":1,"source":"report","reset":reset,"order":order,"updates":updates}).to_string()
    }
    #[test]
    fn deltas_preserve_metadata_clear_optional_fields_and_remove_absent_actors() {
        let mut decoder = FrameDecoder::default();
        decoder
            .decode(&packet(true, vec!["a", "b"], vec![row("a"), row("b")]))
            .unwrap();
        let frame = decoder
            .decode(&packet(
                false,
                vec!["b", "a"],
                vec![serde_json::json!({"key":"a","position":null,"health":7})],
            ))
            .unwrap();
        assert_eq!(frame[0].key, "b");
        assert_eq!(frame[1].name, "Mage");
        assert_eq!(frame[1].position, None);
        assert_eq!(frame[1].health, Some(7));
        assert_eq!(
            decoder
                .decode(&packet(false, vec!["a"], vec![]))
                .unwrap()
                .len(),
            1
        );
        assert!(decoder.decode(&packet(false, vec!["b"], vec![])).is_err());
        assert_eq!(
            decoder.decode(&packet(false, vec!["a"], vec![])).unwrap()[0].health,
            Some(7)
        );
    }
    #[test]
    fn self_aura_deltas_hold_clear_and_reject_malformed_updates() {
        let mut decoder = FrameDecoder::default();
        decoder
            .decode(&packet(true, vec!["a"], vec![row("a")]))
            .unwrap();
        let frame = decoder
            .decode(&packet(
                false,
                vec!["a"],
                vec![serde_json::json!({"key":"a","auras":[10,20],"self_auras":[20]})],
            ))
            .unwrap();
        assert_eq!(frame[0].self_auras, vec![20]);
        assert_eq!(
            decoder.decode(&packet(false, vec!["a"], vec![])).unwrap()[0].self_auras,
            vec![20]
        );
        assert!(decoder
            .decode(&packet(
                false,
                vec!["a"],
                vec![serde_json::json!({"key":"a","self_auras":"invalid"})]
            ))
            .is_err());
        assert_eq!(
            decoder.decode(&packet(false, vec!["a"], vec![])).unwrap()[0].self_auras,
            vec![20]
        );
        let cleared = decoder
            .decode(&packet(
                false,
                vec!["a"],
                vec![serde_json::json!({"key":"a","self_auras":[]})],
            ))
            .unwrap();
        assert!(cleared[0].self_auras.is_empty());
        assert_eq!(cleared[0].auras, vec![10, 20]);
    }
    #[test]
    fn invalid_changes_and_source_replacements_are_transactional() {
        let mut decoder = FrameDecoder::default();
        decoder
            .decode(&packet(true, vec!["a"], vec![row("a")]))
            .unwrap();
        assert!(decoder
            .decode(&packet(
                false,
                vec!["a"],
                vec![serde_json::json!({"key":"a","position":[1e9,0,0]})]
            ))
            .is_err());
        assert_eq!(
            decoder.decode(&packet(false, vec!["a"], vec![])).unwrap()[0].position,
            Some([1., 2., 3.])
        );
        let different = packet(false, vec!["a"], vec![]).replace("report", "other");
        assert!(decoder.decode(&different).is_err());
        assert!(decoder.decode(&packet(true, vec!["a"], vec![])).is_err());
        decoder.clear();
        assert!(decoder.decode(&packet(false, vec!["a"], vec![])).is_err());
    }
}
