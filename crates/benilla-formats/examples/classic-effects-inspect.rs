//! Validate caller-supplied adapted effect files through production decoders.
fn main() -> anyhow::Result<()> {
    let dir = std::env::args().nth(1).expect("adapted effect directory");
    let mut count = 0;
    let mut emitters = 0;
    for entry in std::fs::read_dir(dir)? {
        let bytes = std::fs::read(entry?.path())?;
        let _ = benilla_formats::parse_m2_render_submeshes(&bytes, "", &[])?;
        for def in benilla_formats::parse_m2_particle_emitters(&bytes)? {
            emitters += 1;
            for age in [0., 0.25, 0.5, 0.75, 1.] {
                let v = def.sample_life(age);
                anyhow::ensure!(
                    v.color.iter().all(|n| n.is_finite())
                        && v.size.is_finite()
                        && v.size_y.is_finite(),
                    "invalid particle ramp"
                );
            }
        }
        count += 1;
    }
    println!("{count} effect models and {emitters} emitters parsed through production decoders");
    Ok(())
}
