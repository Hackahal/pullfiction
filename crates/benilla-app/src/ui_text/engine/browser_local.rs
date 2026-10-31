//! Preloaded client font bytes, rendered and measured by the existing font engine.

use super::*;

impl UiFontAtlas {
    pub(crate) fn from_local_fonts(
        fonts: Vec<(String, Vec<u8>)>,
        images: &Assets<Image>,
        dpi: f32,
    ) -> Option<Self> {
        let mut font_system = client_font_system();
        let mut faces = Vec::new();
        let mut path_to_face = HashMap::new();
        for (path, bytes) in fonts {
            let charmap = unicode_charmap(&bytes)?;
            let ascent_ratio = hhea_ascent_ratio(&bytes).unwrap_or(0.794);
            let sfnt = sfnt::Sfnt::parse(bytes.clone()).map(Arc::new);
            let registered = register_font(&mut font_system, bytes).ok()?;
            path_to_face.insert(path.replace('/', "\\").to_ascii_lowercase(), faces.len());
            faces.push(Face {
                id: registered.id,
                path,
                family: registered.family,
                weight: registered.weight,
                style: registered.style,
                stretch: registered.stretch,
                ascent_ratio,
                sfnt,
                charmap,
            });
        }
        let default_face = *path_to_face.get(&CLIENT_FONTS[0].to_ascii_lowercase())?;
        Some(Self {
            engine: Arc::new(Mutex::new(TextEngine {
                font_system,
                swash: SwashCache::new(),
                faces,
                path_to_face,
                source: None,
                missing_fonts: HashSet::new(),
                loose_generation: 0,
                default_face,
                dpi,
                chars: HashMap::new(),
                cells: HashMap::new(),
                sheet: Sheet::new(images),
                generation: 0,
                reset_pending: false,
                complained: HashSet::new(),
                substituted: HashSet::new(),
                over_ceiling: false,
                stats: CacheStats::default(),
            })),
            generation: 0,
            ellipsis: crate::ui_text::EllipsisMemo::default(),
        })
    }
}
