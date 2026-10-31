//! Check supplied modern WMO group geometry with the shared renderer's geometry reader.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut vertices = 0;
    let mut triangles = 0;
    let mut groups = 0;
    for path in std::env::args().skip(1) {
        let bytes = std::fs::read(path)?;
        match benilla_wmo::parse_wmo(&mut std::io::Cursor::new(bytes.as_slice()))? {
            benilla_wmo::ParsedWmo::Group(group) => {
                if group
                    .vertex_indices
                    .iter()
                    .any(|&i| usize::from(i) >= group.vertex_positions.len())
                {
                    return Err("WMO index exceeds vertex array".into());
                }
                if !group.vertex_indices.len().is_multiple_of(3) {
                    return Err("WMO index array is not a triangle list".into());
                }
                vertices += group.vertex_positions.len();
                triangles += group.vertex_indices.len() / 3;
                groups += 1;
            }
            _ => return Err("expected a WMO group, got a root".into()),
        }
    }
    if groups == 0 {
        return Err("usage: classic-world-inspect GROUP...".into());
    }
    println!("{groups} WMO groups: {vertices} vertices, {triangles} triangles; modern material and placement integration pending");
    Ok(())
}
