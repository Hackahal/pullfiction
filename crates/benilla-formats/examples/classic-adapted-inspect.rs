//! Exercise the production renderer's shared parsers against a caller-supplied adapted M2.
fn main() -> anyhow::Result<()> {
    let path = std::env::args()
        .nth(1)
        .ok_or_else(|| anyhow::anyhow!("usage: classic-adapted-inspect MODEL"))?;
    let bytes = std::fs::read(path)?;
    let subs = benilla_formats::parse_m2_render_submeshes(&bytes, "", &[])?;
    let skeleton = benilla_formats::parse_m2_skeleton(&bytes)?;
    let sequences = benilla_formats::parse_m2_animations(&bytes);
    let cameras = benilla_formats::parse_m2_pane_cameras(&bytes);
    let particles = benilla_formats::parse_m2_particle_emitters(&bytes)?;
    println!("{} particle emitters", particles.len());
    let attachments = benilla_formats::parse_m2_attachments(&bytes)?;
    println!(
        "{} render batches, {} bones, {} clips, {} cameras, {} attachments",
        subs.len(),
        skeleton.bones.len(),
        sequences.len(),
        cameras.len(),
        attachments.len()
    );
    anyhow::ensure!(
        !subs.is_empty() && !skeleton.bones.is_empty() && !sequences.is_empty(),
        "empty adapted model"
    );
    for clip in &sequences {
        anyhow::ensure!(
            clip.duration.is_finite() && clip.duration > 0.0,
            "bad duration"
        );
        for keys in &clip.bones {
            for (t, q) in &keys.rotation {
                anyhow::ensure!(
                    *t >= 0.0 && *t <= clip.duration + 0.001 && q.iter().all(|x| x.is_finite()),
                    "bad quaternion key"
                );
            }
        }
    }
    Ok(())
}
