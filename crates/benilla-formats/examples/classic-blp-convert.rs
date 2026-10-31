//! Convert a caller-supplied local BLP without opening an archive or game install.
fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let input = args.next().expect("input BLP");
    let output = args.next().expect("output PNG");
    benilla_formats::blp_to_png(&std::fs::read(input)?, std::path::Path::new(&output))?;
    Ok(())
}
