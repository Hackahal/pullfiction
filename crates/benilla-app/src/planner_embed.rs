//! The planner's existing native Lua UI without a game session or stock FrameXML bootstrap.
//! Font bytes and texture reads come from the host's local client provider. Layout, widget
//! behavior, font measurement, glyph emission and the gamma-byte quad renderer remain native.

use std::collections::HashMap;

use benilla_ui::script::{QuadContent, TexCoords, UiScript};
use bevy::prelude::*;
use bevy::window::PrimaryWindow;

use crate::ui_pass::{UiQuad, UiQuadAppend, UiQuads, UvRect};
use crate::ui_text::UiFontAtlas;

mod state;
#[path = "ui_script/extract/text.rs"]
mod text;
pub use state::{PlannerUiAura, PlannerUiCast, PlannerUiFrame, PlannerUiUnit};

/// Preload the original client faces through the browser-local provider before starting the app.
/// `Fonts\\FRIZQT__.TTF` is required. No operating-system or built-in font is substituted.
#[derive(Resource, Default)]
pub struct PlannerUiFonts(pub Vec<(String, Vec<u8>)>);

/// Optional owned root UI definitions, loaded before the unchanged planner scripts.
/// A tooltip definition must provide its real line pairs and backdrop, as the native engine does.
#[derive(Resource, Default)]
pub struct PlannerUiPrelude(pub String);

/// Read after `PlannerUiInput`; the host applies the same selection and focus as the game adapter.
#[derive(Resource, Default, Clone, Debug)]
pub struct PlannerUiActions {
    pub select: Option<u64>,
    pub focus: Option<u64>,
    pub pointer_over: bool,
    pub press_consumed: bool,
}

/// The mouse ownership decision, before world camera input.
#[derive(SystemSet, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct PlannerUiInput;

/// Feed this frame's projected unit anchors before this set, after updating the camera.
#[derive(SystemSet, Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct PlannerUiPaint;

pub struct PlannerUiPlugin {
    /// Use the original FFX world backdrop and gamma-byte composition. The world host installs
    /// `FfxGlowPlugin` and marks its world camera with `FfxGlow::WORLD`.
    pub compose_world: bool,
}

impl Default for PlannerUiPlugin {
    fn default() -> Self {
        Self {
            compose_world: true,
        }
    }
}

impl Plugin for PlannerUiPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins(crate::shaders::plugin)
            .add_plugins((crate::ui_pass::PlayerUiPlugin, crate::ui_text::UiTextPlugin));
        if self.compose_world {
            app.add_plugins(crate::world_backdrop::WorldBackdropPlugin);
        }
        app.init_resource::<PlannerUiFonts>()
            .init_resource::<PlannerUiPrelude>()
            .init_resource::<PlannerUiFrame>()
            .init_resource::<PlannerUiActions>()
            .init_resource::<TextureCache>()
            .configure_sets(
                Update,
                PlannerUiInput.before(benilla_world::schedule::WorldStage::Input),
            )
            .configure_sets(
                Update,
                PlannerUiPaint.after(PlannerUiInput).before(UiQuadAppend),
            )
            .add_systems(Startup, setup)
            .add_systems(Update, feed_input.in_set(PlannerUiInput))
            .add_systems(Update, paint.in_set(PlannerUiPaint));
    }
}

struct Runtime {
    script: UiScript,
    layout: crate::planner_plate_layout::Layout,
    seam: f32,
    dpi: f32,
}

fn roots(script: &UiScript, prelude: &str) -> Result<(), String> {
    script.run("UIParent=CreateFrame('Frame','UIParent'); UIParent:SetAllPoints(); WorldFrame=CreateFrame('Frame','WorldFrame'); WorldFrame:SetAllPoints(); WorldFrame:SetFrameStrata('BACKGROUND')")
        .map_err(|e| e.to_string())?;
    if !prelude.is_empty() {
        script.run(prelude).map_err(|e| e.to_string())?;
    }
    script
        .run(include_str!("planner_nameplates.lua"))
        .map_err(|e| e.to_string())?;
    script
        .run(include_str!("planner_raid.lua"))
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn setup(world: &mut World) {
    let fonts = std::mem::take(&mut world.resource_mut::<PlannerUiFonts>().0);
    let dpi = world
        .query_filtered::<&Window, With<PrimaryWindow>>()
        .single(world)
        .map_or(1., Window::scale_factor);
    let Some(atlas) = UiFontAtlas::from_local_fonts(fonts, world.resource::<Assets<Image>>(), dpi)
    else {
        error!("planner UI cannot start: the local client Friz Quadrata font did not load");
        return;
    };
    let Ok(script) = UiScript::new() else {
        error!("planner UI cannot create its native Lua VM");
        return;
    };
    if let Err(error) = roots(&script, &world.resource::<PlannerUiPrelude>().0) {
        error!("planner UI cannot load its original Lua: {error}");
        return;
    }
    world.insert_resource(atlas);
    world.insert_non_send_resource(Runtime {
        script,
        layout: crate::planner_plate_layout::Layout::default(),
        seam: 0.,
        dpi: 0.,
    });
}

fn feed_input(
    runtime: Option<NonSendMut<Runtime>>,
    atlas: Option<Res<UiFontAtlas>>,
    window: Query<&Window, With<PrimaryWindow>>,
    time: Res<Time>,
    buttons: Res<ButtonInput<MouseButton>>,
    keys: Res<ButtonInput<KeyCode>>,
    mut actions: ResMut<PlannerUiActions>,
) {
    *actions = PlannerUiActions::default();
    let (Some(mut runtime), Ok(window)) = (runtime, window.single()) else {
        return;
    };
    let seam = crate::ui_script::seam_scale(window.height());
    let dpi = window.scale_factor();
    let moved = runtime.seam != seam || runtime.dpi != dpi;
    if moved {
        runtime.script.invalidate_text_measures();
        runtime.seam = seam;
        runtime.dpi = dpi;
    }
    if let Some(atlas) = atlas {
        if moved || !runtime.script.has_text_measurer() {
            crate::ui_script::extract::seat_text_measurer(&mut runtime.script, &atlas, seam);
        }
    }
    runtime
        .script
        .set_window_size(window.width(), window.height());
    runtime.script.tick(time.delta_secs());
    runtime.script.resolve();
    runtime.script.set_modifiers(
        keys.pressed(KeyCode::ShiftLeft) || keys.pressed(KeyCode::ShiftRight),
        keys.pressed(KeyCode::ControlLeft) || keys.pressed(KeyCode::ControlRight),
        keys.pressed(KeyCode::AltLeft) || keys.pressed(KeyCode::AltRight),
    );
    if let Some(cursor) = window.cursor_position() {
        let at = crate::ui_script::window_to_ui(window.height(), cursor);
        actions.pointer_over = runtime
            .script
            .mouse_move(at.x, at.y)
            .is_some_and(|id| !runtime.script.is_world_frame(id));
        for (button, name) in [
            (MouseButton::Left, "LeftButton"),
            (MouseButton::Right, "RightButton"),
        ] {
            if buttons.just_pressed(button) {
                actions.press_consumed |= runtime.script.mouse_button(at.x, at.y, name, true);
            }
            if buttons.just_released(button) {
                runtime.script.mouse_button(at.x, at.y, name, false);
            }
        }
    } else {
        runtime.script.pointer_left_hover();
        runtime.script.pointer_left_window();
    }
    actions.select = take_guid(&runtime.script, "PullFictionPlateClick");
    actions.focus = take_guid(&runtime.script, "PullFictionRaidFocus");
}

fn take_guid(script: &UiScript, global: &str) -> Option<u64> {
    script
        .eval::<String>(&format!("local k={global};{global}=nil;return k or ''"))
        .ok()?
        .parse()
        .ok()
}

#[derive(Resource, Default)]
struct TextureCache(HashMap<String, Handle<Image>>);

fn paint(
    runtime: Option<NonSendMut<Runtime>>,
    frame: Res<PlannerUiFrame>,
    window: Query<&Window, With<PrimaryWindow>>,
    time: Res<Time>,
    mut atlas: Option<ResMut<UiFontAtlas>>,
    server: Res<AssetServer>,
    images: Res<Assets<Image>>,
    mut textures: ResMut<TextureCache>,
    mut quads: ResMut<UiQuads>,
) {
    let (Some(mut runtime), Ok(window), Some(atlas)) =
        (runtime, window.single(), atlas.as_deref_mut())
    else {
        return;
    };
    let viewport = [window.width(), window.height()];
    let seam = crate::ui_script::seam_scale(viewport[1]);
    let plates = state::plate_chunk(
        &frame,
        &mut runtime.layout,
        viewport,
        time.delta_secs(),
        seam,
    );
    for chunk in [plates, state::raid_chunk(&frame, viewport, seam)] {
        if let Err(error) = runtime.script.run(&chunk) {
            error!("planner UI update: {error}");
        }
    }
    runtime.script.resolve();
    let mut out = Vec::new();
    let mut links = Vec::new();
    for eq in runtime.script.extract() {
        let Some(r) = eq.rect else { continue };
        let h = viewport[1];
        let rect = Rect::new(
            r.left * seam,
            h - r.top * seam,
            r.right * seam,
            h - r.bottom * seam,
        );
        let clip = eq.clip.map(|c| {
            Rect::new(
                c.left * seam,
                h - c.top * seam,
                c.right * seam,
                h - c.bottom * seam,
            )
        });
        match eq.content {
            QuadContent::Texture {
                path,
                color,
                tex_coords,
                blend,
                gradient,
                rotation,
                desaturated,
                ..
            } => {
                if path.is_none() && color.is_none() {
                    continue;
                }
                let texture = path.map(|p| {
                    let mut p = p.replace('\\', "/");
                    if !p.to_ascii_lowercase().ends_with(".blp") {
                        p.push_str(".blp");
                    }
                    textures
                        .0
                        .entry(p.clone())
                        .or_insert_with(|| {
                            let tagged = p
                                .strip_suffix(".blp")
                                .map_or_else(|| p.clone(), |stem| format!("{stem}@ui.blp"));
                            server.load_with_settings(
                                format!("mpq://{tagged}"),
                                |settings: &mut benilla_assets::BlpLoaderSettings| {
                                    settings.variant = benilla_assets::BlpVariant::Sprite;
                                },
                            )
                        })
                        .clone()
                });
                // An asynchronously loading path draws no fallback fill, as the original pass
                // draws no quad for a path the client provider has not resolved.
                if texture
                    .as_ref()
                    .is_some_and(|t| !server.is_loaded_with_dependencies(t.id()))
                {
                    continue;
                }
                let uv = match tex_coords {
                    Some(TexCoords::Rect(edges)) => UvRect::from_tex_coords(edges),
                    Some(TexCoords::Corners(corners)) => UvRect::from_corners(corners),
                    None => UvRect::FULL,
                };
                let mut color = color.unwrap_or([1.; 4]);
                color[3] *= eq.alpha;
                let uv_clamp = texture
                    .as_ref()
                    .and_then(|handle| images.get(handle))
                    .map(|image| image.texture_descriptor.size)
                    .and_then(|size| uv_clamp_window(&uv, (size.width, size.height)));
                let corner_colors = gradient
                    .map(|corners| corners.map(|v| std::array::from_fn(|i| v[i] * color[i])));
                out.push(UiQuad {
                    rect,
                    z_key: eq.z,
                    texture,
                    uv,
                    uv_clamp,
                    color,
                    corner_colors,
                    blend,
                    clip,
                    rotation: -rotation,
                    desaturated,
                    ..default()
                });
            }
            QuadContent::Text {
                text: Some(value),
                color,
                justify_h,
                justify_v,
                font,
                font_height,
                text_height,
                shadow,
                outline,
                monochrome,
                spacing,
                alpha_gradient,
                world_seat,
                edit_line,
                non_space_wrap,
                max_lines,
                link_owner,
            } => {
                text::emit(
                    atlas,
                    &value,
                    text::TextStyle {
                        color,
                        justify_h,
                        justify_v,
                        font,
                        font_height,
                        text_height,
                        shadow,
                        outline,
                        monochrome,
                        spacing,
                        alpha_gradient,
                        world_seat,
                        edit_line,
                        non_space_wrap,
                        max_lines,
                        link_owner,
                    },
                    text::TextHost {
                        z: eq.z,
                        alpha: eq.alpha,
                        target: eq.target,
                        rect,
                        clip,
                        ebox: None,
                        screen_h: h,
                        scale: seam,
                        font_scale: eq.scale,
                        caret_pinned: false,
                    },
                    &mut out,
                    &mut links,
                );
            }
            _ => {}
        }
    }
    if quads.quads != out {
        quads.quads = out;
        quads.dirty = true;
    }
    for error in runtime.script.take_errors() {
        error!("planner UI handler: {error}");
    }
}

// Identical to ui_script::extract's crop window. Texture paths are the only changed input;
// all authored UVs, including mirrored corners and the icon crop, keep the original rule.
fn uv_clamp_window(uv: &UvRect, size: (u32, u32)) -> Option<[f32; 4]> {
    let mut out = [1., 1., 0., 0.];
    let mut any = false;
    for (axis, texels) in [(0usize, size.0), (1usize, size.1)] {
        if texels < 2 {
            continue;
        }
        let (lo, hi) = uv.corners.iter().fold((f32::MAX, f32::MIN), |(lo, hi), c| {
            (lo.min(c[axis]), hi.max(c[axis]))
        });
        if lo < -0.001 || hi > 1.001 || (lo <= 0.001 && hi >= 0.999) {
            continue;
        }
        let half = 0.5 / texels as f32;
        let (lo, hi) = if hi - lo > 2. * half {
            (lo + half, hi - half)
        } else {
            let mid = 0.5 * (lo + hi);
            (mid, mid)
        };
        out[axis] = lo;
        out[axis + 2] = hi;
        any = true;
    }
    any.then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn script() -> UiScript {
        let mut script = UiScript::new().unwrap();
        script.set_window_size(1200., 900.);
        roots(&script, "").unwrap();
        script
    }

    fn unit() -> PlannerUiUnit {
        PlannerUiUnit {
            key: "recorded-mage".into(),
            guid: 42,
            name: "Mage".into(),
            player: true,
            raid: true,
            class: 8,
            health_known: true,
            health: 150,
            max_health: 200,
            power_known: true,
            power: 100,
            max_power: 200,
            visible: true,
            distance: 10.,
            anchor: Some([600., 500.]),
            cast: Some(PlannerUiCast {
                name: "Frostbolt".into(),
                icon: "spell_frost_frostbolt02.jpg".into(),
                progress: 0.25,
                remaining: 1.2,
            }),
            auras: vec![PlannerUiAura {
                spell: 1,
                name: "Fortitude".into(),
                icon: "spell_holy_wordfortitude.jpg".into(),
                stack: 2,
                debuff: false,
                active: true,
            }],
            ..default()
        }
    }

    #[test]
    fn unchanged_lua_uses_native_cast_aura_statusbar_and_click_handlers_without_game_boot() {
        let mut script = script();
        let frame = PlannerUiFrame {
            units: vec![unit()],
            selected: Some(42),
            nameplates: true,
            raid_frames: true,
            ..default()
        };
        script
            .run(&state::plate_chunk(
                &frame,
                &mut Default::default(),
                [1200., 900.],
                0.05,
                900. / 768.,
            ))
            .unwrap();
        script
            .run(&state::raid_chunk(&frame, [1200., 900.], 900. / 768.))
            .unwrap();
        script.resolve();
        let extracted = script.extract();
        assert!(extracted.iter().any(
            |q| matches!(&q.content, QuadContent::Text {text:Some(value),..} if value=="Frostbolt")
        ));
        assert!(extracted
            .iter()
            .any(|q| matches!(&q.content, QuadContent::Text {text:Some(value),..} if value=="2")));
        assert_eq!(
            script
                .eval::<String>("return PullFictionRaid[1].guid")
                .unwrap(),
            "42"
        );
        // A right click on the actual original raid button requests camera focus.
        let at = crate::ui_script::window_to_ui(900., Vec2::new(20., 20.));
        assert!(script.mouse_button(at.x, at.y, "RightButton", true));
        assert!(script.mouse_button(at.x, at.y, "RightButton", false));
        assert_eq!(take_guid(&script, "PullFictionRaidFocus"), Some(42));
        assert_eq!(take_guid(&script, "PullFictionRaidFocus"), None);
        assert!(script.take_errors().is_empty());
    }

    #[test]
    fn original_nameplate_filter_and_camera_look_ownership_are_preserved() {
        let mut script = script();
        let mut frame = PlannerUiFrame {
            units: vec![unit()],
            selected: Some(42),
            nameplates: true,
            looking: true,
            ..default()
        };
        let mut layout = Default::default();
        script
            .run(&state::plate_chunk(
                &frame,
                &mut layout,
                [1200., 900.],
                0.05,
                900. / 768.,
            ))
            .unwrap();
        script.resolve();
        assert!(!script
            .eval::<bool>("return PullFictionPlates['42']:IsMouseEnabled() ~= nil")
            .unwrap());
        frame.looking = false;
        script
            .run(&state::plate_chunk(
                &frame,
                &mut layout,
                [1200., 900.],
                0.05,
                900. / 768.,
            ))
            .unwrap();
        assert!(script
            .eval::<bool>("return PullFictionPlates['42']:IsMouseEnabled() ~= nil")
            .unwrap());
        frame.friendly_nameplates = false;
        script
            .run(&state::plate_chunk(
                &frame,
                &mut layout,
                [1200., 900.],
                0.05,
                900. / 768.,
            ))
            .unwrap();
        assert!(script
            .eval::<bool>("return PullFictionPlates['42']:IsShown() ~= nil and PullFictionPlates['42'].name:GetText() == 'Mage'")
            .unwrap());
        assert!(script.eval::<bool>("local f=PullFictionPlates['42']; return not f.fill:IsShown() and not f.edge:IsShown() and not f.background:IsShown() and not f.hp:IsShown() and not f.castback:IsShown() and not f.icons[1]:IsShown()").unwrap());
        frame.friendly_nameplates = true;
        script
            .run(&state::plate_chunk(
                &frame,
                &mut layout,
                [1200., 900.],
                0.05,
                900. / 768.,
            ))
            .unwrap();
        assert!(script.eval::<bool>("local f=PullFictionPlates['42']; return f.fill:IsShown() ~= nil and f.edge:IsShown() ~= nil and f.background:IsShown() ~= nil and f.hp:IsShown() ~= nil and f.castback:IsShown() ~= nil and f.icons[1]:IsShown() ~= nil").unwrap());
    }
}
