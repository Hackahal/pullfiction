//! An explicit table boundary for browser embedders. The existing sampler owns every blend.
use super::*;
use anyhow::{bail, ensure};
use serde_json::Value;

fn array<'a>(v: &'a Value, name: &str, len: Option<usize>) -> Result<&'a [Value]> {
    let a = v
        .get(name)
        .and_then(Value::as_array)
        .with_context(|| format!("lighting {name} must be an array"))?;
    ensure!(
        len.is_none_or(|n| n == a.len()),
        "invalid lighting {name} length"
    );
    Ok(a)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> Value {
        let red = vec![16711680; 18];
        let blue = vec![255; 18];
        let green = vec![65280; 18];
        json!({"schema":1,
            "lights":[{"id":1,"map":0,"position":[0,0,0],"falloffStart":0,"falloffEnd":0,"params":[1,2,2,2,2]}],
            "params":[
                {"id":1,"glow":0.65,"highlightSky":true,"waterAlpha":[0.5,1,0.75,1],"skybox":0},
                {"id":2,"glow":0.2,"highlightSky":false,"waterAlpha":[0.5,1,0.75,1],"skybox":0}],
            "samples":[
                {"id":1,"param":1,"time":720,"colors":red,"fogEnd":18000,"fogStart":0.25,"cloudDensity":0.5},
                {"id":2,"param":1,"time":2160,"colors":blue,"fogEnd":9000,"fogStart":-0.5,"cloudDensity":0},
                {"id":3,"param":2,"time":0,"colors":green,"fogEnd":3600,"fogStart":0.1,"cloudDensity":1}],
            "skyboxes":[]})
    }

    #[test]
    fn embedded_tables_keep_original_time_wrap_distance_and_profile_selection() {
        let catalog = LightCatalog::from_embedded_classic(&fixture().to_string()).unwrap();
        let dry = catalog.sample_blended(0, [0.0; 3], 0, false, Submersion::Dry, false);
        assert_eq!(dry.sun_diffuse, [0.5, 0.0, 0.5]);
        assert_eq!(dry.fog_end, 375.0);
        assert_eq!(dry.fog_start_frac, -0.125);
        assert_eq!(
            catalog
                .sample_blended(0, [0.0; 3], 0, false, Submersion::Water, false)
                .sun_diffuse,
            [0.0, 1.0, 0.0]
        );
        assert_eq!(
            catalog
                .sample_blended(0, [0.0; 3], 0, true, Submersion::Dry, false)
                .sun_diffuse,
            [0.0, 1.0, 0.0]
        );
        assert_eq!(
            catalog
                .sample_blended(0, [0.0; 3], 0, false, Submersion::Dry, true)
                .sun_diffuse,
            [0.0, 1.0, 0.0]
        );
        assert_eq!(
            catalog
                .sample_blended(409, [0.0; 3], 0, false, Submersion::Dry, false)
                .sun_diffuse,
            dry.sun_diffuse
        );
    }

    #[test]
    fn unknown_underwater_links_fail_without_inventing_profiles() {
        let mut input = fixture();
        input["lights"][0]["params"][1] = Value::Null;
        let error = LightCatalog::from_embedded_classic(&input.to_string())
            .err()
            .unwrap();
        assert!(error
            .to_string()
            .contains("omits the original underwater profile links"));
    }

    #[test]
    fn explicit_modern_underwater_policy_keeps_surface_profiles_and_dry_sampling() {
        let mut input = fixture();
        input["lights"][0]["params"] = json!([1, null, 2, null, 2]);
        input["coverage"] =
            json!({"underwaterProfileLinks":false,"underwaterPolicy":"surface-profile"});
        let catalog = LightCatalog::from_embedded_classic(&input.to_string()).unwrap();
        let dry = catalog.sample_blended(0, [0.; 3], 0, false, Submersion::Dry, false);
        let wet = catalog.sample_blended(0, [0.; 3], 0, false, Submersion::Water, false);
        assert_eq!(dry.sun_diffuse, [0.5, 0., 0.5]);
        assert_eq!(wet.sun_diffuse, dry.sun_diffuse);
        assert_eq!(
            catalog
                .sample_blended(0, [0.; 3], 0, false, Submersion::Water, true)
                .sun_diffuse,
            [0., 1., 0.]
        );
        input["lights"][0]["params"][4] = Value::Null;
        assert!(LightCatalog::from_embedded_classic(&input.to_string()).is_err());
    }

    #[test]
    fn incomplete_or_ambiguous_tables_fail_before_sampling() {
        for key in ["params", "samples"] {
            let mut input = fixture();
            let duplicate = input[key][0].clone();
            input[key].as_array_mut().unwrap().push(duplicate);
            assert!(LightCatalog::from_embedded_classic(&input.to_string()).is_err());
        }
        let mut input = fixture();
        input["samples"][0]["time"] = json!(2880);
        assert!(LightCatalog::from_embedded_classic(&input.to_string()).is_err());
    }
}
fn uint(v: &Value, name: &str) -> Result<u32> {
    v.get(name)
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .with_context(|| format!("invalid lighting {name}"))
}
fn real(v: &Value, name: &str) -> Result<f32> {
    let n = v
        .get(name)
        .and_then(Value::as_f64)
        .context("lighting number missing")? as f32;
    ensure!(n.is_finite(), "non-finite lighting {name}");
    Ok(n)
}
fn reals<const N: usize>(v: &Value, name: &str) -> Result<[f32; N]> {
    let a = array(v, name, Some(N))?;
    let mut result = [0.0; N];
    for (n, value) in result.iter_mut().zip(a) {
        *n = value.as_f64().context("lighting array number missing")? as f32;
        ensure!(n.is_finite(), "non-finite lighting {name}");
    }
    Ok(result)
}

impl LightCatalog {
    /// Construct from locally decoded Classic `Light`/`LightData` tables, retaining the original
    /// band interpolation, area priority, weather, ghost and no-map fallback algorithms.
    /// Coordinates are world yards. `FogEnd` stays in the table's inches until `sample_param`.
    #[cfg(any(target_arch = "wasm32", test))]
    pub fn from_embedded_classic(json: &str) -> Result<Self> {
        let root: Value = serde_json::from_str(json).context("invalid embedded lighting JSON")?;
        ensure!(
            uint(&root, "schema")? == 1,
            "unsupported embedded lighting schema"
        );
        let surface_underwater = root["coverage"]["underwaterProfileLinks"] == false
            && root["coverage"]["underwaterPolicy"] == "surface-profile";
        let mut catalog = Self {
            lights: Vec::new(),
            int_bands: HashMap::new(),
            float_bands: HashMap::new(),
            light_params_glow: HashMap::new(),
            light_params_highlight: HashMap::new(),
            light_params_water_alpha: HashMap::new(),
            light_params_skybox: HashMap::new(),
            skyboxes: HashMap::new(),
        };
        for row in array(&root, "params", None)? {
            let id = uint(row, "id")?;
            ensure!(id > 0 && id < u32::MAX / 18, "invalid LightParams ID");
            ensure!(
                catalog
                    .light_params_glow
                    .insert(id, real(row, "glow")?)
                    .is_none(),
                "duplicate LightParams ID"
            );
            let highlight = row
                .get("highlightSky")
                .and_then(Value::as_bool)
                .context("invalid highlightSky")?;
            catalog
                .light_params_highlight
                .insert(id, if highlight { 1.0 } else { 0.0 });
            catalog
                .light_params_water_alpha
                .insert(id, reals(row, "waterAlpha")?);
            let sky = uint(row, "skybox")?;
            if sky != 0 {
                catalog.light_params_skybox.insert(id, sky);
            }
        }
        for row in array(&root, "lights", None)? {
            let id = uint(row, "id")?;
            ensure!(
                !catalog.lights.iter().any(|l| l.id == id),
                "duplicate Light ID"
            );
            let mut params = [0; 5];
            let slots = array(row, "params", Some(5))?;
            for (index, (p, value)) in params.iter_mut().zip(slots).enumerate() {
                let value = if value.is_null() {
                    ensure!(
                        surface_underwater && matches!(index, 1 | 3),
                        "Classic Light omits the original underwater profile links; an explicit fallback policy is required"
                    );
                    &slots[index - 1]
                } else {
                    value
                };
                *p = value
                    .as_u64()
                    .and_then(|v| u32::try_from(v).ok())
                    .context("invalid Light slot")?;
                ensure!(
                    *p == 0 || catalog.light_params_glow.contains_key(p),
                    "Light names absent LightParams"
                );
            }
            let pos = reals(row, "position")?;
            catalog.lights.push(Light {
                id,
                map: uint(row, "map")?,
                pos,
                falloff_start: real(row, "falloffStart")?,
                falloff_end: real(row, "falloffEnd")?,
                global: pos == [0.0; 3],
                params,
            });
        }
        let mut samples = array(&root, "samples", None)?.iter().collect::<Vec<_>>();
        samples.sort_by_key(|row| {
            (
                uint(row, "param").unwrap_or(0),
                uint(row, "time").unwrap_or(0),
            )
        });
        let mut previous = None;
        for row in samples {
            let p = uint(row, "param")?;
            let t = uint(row, "time")?;
            ensure!(
                t < DAY && catalog.light_params_glow.contains_key(&p),
                "invalid LightData key"
            );
            ensure!(previous != Some((p, t)), "duplicate LightData time");
            previous = Some((p, t));
            for (i, value) in array(row, "colors", Some(18))?.iter().enumerate() {
                let c = value
                    .as_u64()
                    .and_then(|v| u32::try_from(v).ok())
                    .context("invalid packed light colour")?;
                let b = catalog
                    .int_bands
                    .entry((p - 1) * 18 + i as u32 + 1)
                    .or_insert_with(Band::embedded);
                b.push_embedded(t, c);
            }
            for (i, name) in [(0, "fogEnd"), (1, "fogStart"), (3, "cloudDensity")] {
                let b = catalog
                    .float_bands
                    .entry((p - 1) * 6 + i + 1)
                    .or_insert_with(Band::embedded);
                b.push_embedded(t, real(row, name)?);
            }
        }
        for row in array(&root, "skyboxes", None)? {
            let path = row
                .get("path")
                .and_then(Value::as_str)
                .context("invalid skybox path")?;
            ensure!(
                !path.is_empty()
                    && !path.contains(':')
                    && !path.split(['/', '\\']).any(|p| p == ".."),
                "invalid skybox path"
            );
            ensure!(
                catalog
                    .skyboxes
                    .insert(uint(row, "id")?, path.to_owned())
                    .is_none(),
                "duplicate skybox ID"
            );
        }
        for id in catalog.light_params_skybox.values() {
            ensure!(catalog.skyboxes.contains_key(id), "absent LightSkybox");
        }
        for light in &catalog.lights {
            for p in light.params {
                if p != 0 && !catalog.has_param(p) {
                    bail!("Light names an empty LightData profile {p}");
                }
            }
        }
        ensure!(
            catalog.lights.iter().any(|l| l.id == FALLBACK_LIGHT_ID),
            "missing original no-map fallback record"
        );
        Ok(catalog)
    }
}
