//! Owned root definitions for the planner's existing native UI lifecycle.
//! This file defines no renderer, frame feed, input pass, replay adapter or layout algorithm.

/// Load through the original UI file runner as the configured planner core's Lua entry.
pub const LUA: &str = include_str!("planner_ui_bootstrap.lua");

/// Virtual entry served by the local asset provider as this planner core's TOC.
pub const TOC: &str = "PullFictionBootstrap.lua\n";

/// The original binding parser registers these native camera commands after the core TOC.
pub const BINDINGS: &str = include_str!("planner_ui_bindings.xml");

/// The original binding store loads defaults and applies saved account/character overrides.
pub const DEFAULT_BINDINGS: &str = include_str!("planner_ui_default_bindings.wtf");

/// The browser-local planner supplies only its owned root program. Native game launches keep
/// their existing install-sourced UI; tests opt into this mode explicitly on their own thread.
pub(crate) fn active() -> bool {
    #[cfg(target_arch = "wasm32")]
    {
        benilla_formats::browser_local::active()
    }
    #[cfg(all(test, not(target_arch = "wasm32")))]
    {
        TEST_MODE.with(std::cell::Cell::get)
    }
    #[cfg(all(not(test), not(target_arch = "wasm32")))]
    {
        false
    }
}

/// Project code under the original loader's logical paths. Other assets still use its provider.
pub(crate) fn file(name: &str) -> Option<Vec<u8>> {
    if !active() {
        return None;
    }
    let text = match name.replace('\\', "/").to_ascii_lowercase().as_str() {
        "interface/framexml/framexml.toc" => TOC,
        "interface/framexml/pullfictionbootstrap.lua" => LUA,
        "interface/framexml/bindings.xml" => BINDINGS,
        "wtf/defaultbindings.wtf" => DEFAULT_BINDINGS,
        _ => return None,
    };
    Some(text.as_bytes().to_vec())
}

#[cfg(all(test, not(target_arch = "wasm32")))]
thread_local! {
    static TEST_MODE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(all(test, not(target_arch = "wasm32")))]
pub(crate) fn with_test_mode<R>(f: impl FnOnce() -> R) -> R {
    struct Restore(bool);
    impl Drop for Restore {
        fn drop(&mut self) {
            TEST_MODE.with(|mode| mode.set(self.0));
        }
    }
    let restore = Restore(TEST_MODE.with(|mode| mode.replace(true)));
    let result = f();
    drop(restore);
    result
}

#[cfg(test)]
mod tests {
    use benilla_ui::script::{QuadContent, UiScript};

    fn vm() -> UiScript {
        let mut s = UiScript::new().unwrap();
        s.set_window_size(1024., 768.);
        s.run(super::LUA).unwrap();
        s.run(include_str!("planner_nameplates.lua")).unwrap();
        s.run(include_str!("planner_raid.lua")).unwrap();
        s
    }

    fn measure(s: &mut UiScript) {
        for _ in 0..3 {
            s.resolve();
            let rows: Vec<_> = s
                .fontstrings_needing_measure()
                .into_iter()
                .map(|r| {
                    let width = r.text.chars().count() as f32 * 5.;
                    let height = r.height.unwrap_or(12.);
                    (r.id, width, height, width, r.key)
                })
                .collect();
            s.set_measured_text(&rows);
        }
        s.resolve();
    }

    fn raid(s: &mut UiScript) {
        s.run(r#"PullFictionRaid_Update({{guid='42',name='Mage',class=8,hp=150,max=200,power=100,maxpower=200,powertype=0,powerknown=true,selected=false,cast={name='Frostbolt',progress=.25},auras={{name='Shadow Word: Pain',icon='Interface\\Icons\\Spell_Shadow_ShadowWordPain',stack=3,debuff=true}}}},true,1,5,1); UIParent:Hide()"#).unwrap();
        measure(s);
    }

    #[test]
    fn the_native_world_frame_does_not_claim_empty_world_input() {
        let mut s = vm();
        s.resolve();
        let id = s.mouse_move(500., 400.).unwrap();
        assert!(s.is_world_frame(id));
        assert!(!s.mouse_button(500., 400., "LeftButton", true));
        assert!(!s.mouse_button(500., 400., "LeftButton", false));
        assert!(s.take_errors().is_empty());
    }

    #[test]
    fn unchanged_raid_lua_owns_the_aura_tooltip_and_hides_it_on_leave() {
        let mut s = vm();
        raid(&mut s);
        s.mouse_move(20., 768. - 35.);
        measure(&mut s);
        assert!(s
            .eval::<bool>("return GameTooltip:IsOwned(PullFictionRaid[1].icons[1]) ~= nil")
            .unwrap());
        assert_eq!(s.eval::<i64>("return GameTooltip:NumLines()").unwrap(), 2);
        assert_eq!(
            s.eval::<String>("return GameTooltipTextLeft1:GetText()")
                .unwrap(),
            "Shadow Word: Pain"
        );
        assert_eq!(
            s.eval::<String>("return GameTooltipTextLeft2:GetText()")
                .unwrap(),
            "Stacks: 3"
        );
        assert!(s
            .extract()
            .iter()
            .any(|q| matches!(&q.content, QuadContent::Text {text:Some(t),..} if t=="Stacks: 3")));
        let world = s.mouse_move(900., 200.).unwrap();
        assert!(s.is_world_frame(world));
        assert!(!s
            .eval::<bool>("return GameTooltip:IsShown() ~= nil")
            .unwrap());
        assert!(s.take_errors().is_empty());
    }

    #[test]
    fn unchanged_raid_button_scripts_keep_selection_and_focus() {
        let mut s = vm();
        raid(&mut s);
        for (button, global) in [
            ("LeftButton", "PullFictionPlateClick"),
            ("RightButton", "PullFictionRaidFocus"),
        ] {
            assert!(s.mouse_button(30., 768. - 20., button, true));
            assert!(s.mouse_button(30., 768. - 20., button, false));
            assert_eq!(s.eval::<String>(&format!("return {global}")).unwrap(), "42");
        }
        assert!(s.take_errors().is_empty());
    }

    #[test]
    fn tooltip_line_capacity_is_the_original_thirty_pairs() {
        let mut s = vm();
        s.run("GameTooltip:SetOwner(WorldFrame,'ANCHOR_RIGHT');for i=1,40 do GameTooltip:AddLine('line '..i) end;GameTooltip:Show()").unwrap();
        measure(&mut s);
        assert_eq!(s.eval::<i64>("return GameTooltip:NumLines()").unwrap(), 30);
        assert!(s.take_errors().is_empty());
    }

    #[test]
    fn unchanged_nameplate_lua_yields_to_camera_look_and_selects_on_click() {
        let mut s = vm();
        let data = "{{key='99',name='Enemy',x=500,y=300,w=140,h=23,friendly=false,selected=false,r=.83,g=.28,b=.23,health=.6,hptext='60%',auras={}}}";
        s.run(&format!("PullFictionPlates_Update({data},1,true)"))
            .unwrap();
        measure(&mut s);
        let world = s.mouse_move(510., 768. - 315.).unwrap();
        assert!(s.is_world_frame(world));
        s.run(&format!("PullFictionPlates_Update({data},1,false)"))
            .unwrap();
        measure(&mut s);
        let plate = s.mouse_move(510., 768. - 315.).unwrap();
        assert!(!s.is_world_frame(plate));
        assert!(s.mouse_button(510., 768. - 315., "LeftButton", true));
        assert!(s.mouse_button(510., 768. - 315., "LeftButton", false));
        assert_eq!(
            s.eval::<String>("return PullFictionPlateClick").unwrap(),
            "99"
        );
        assert!(s.take_errors().is_empty());
    }

    #[test]
    fn original_binding_parser_drives_original_camera_channels() {
        use benilla_ui::script::{BindingInput, FiredInput, HeldInput};

        let mut s = vm();
        let commands = benilla_ui::bindings_xml::parse(super::BINDINGS).unwrap();
        s.register_bindings(&commands);
        s.set_default_bindings(benilla_ui::script::keybind::parse_bindings_wtf(
            super::DEFAULT_BINDINGS,
        ));
        s.load_binding_set(0);
        for (chord, command) in [
            ("BUTTON1", "CAMERAORSELECTORMOVE"),
            ("BUTTON2", "TURNORACTION"),
            ("MOUSEWHEELUP", "CAMERAZOOMIN"),
            ("MOUSEWHEELDOWN", "CAMERAZOOMOUT"),
        ] {
            assert_eq!(
                s.eval::<String>(&format!("return GetBindingAction('{chord}')"))
                    .unwrap(),
                command
            );
            assert!(s.execute_binding(command, true).unwrap());
            assert_eq!(
                s.execute_binding(command, false).unwrap(),
                commands
                    .iter()
                    .find(|b| b.name == command)
                    .unwrap()
                    .run_on_up
            );
        }
        assert_eq!(
            s.take_binding_input(),
            vec![
                BindingInput::Start(HeldInput::CameraOrSelectOrMove),
                BindingInput::Stop(HeldInput::CameraOrSelectOrMove),
                BindingInput::Start(HeldInput::TurnOrAction),
                BindingInput::Stop(HeldInput::TurnOrAction),
                BindingInput::Fire(FiredInput::CameraZoomIn(1.)),
                BindingInput::Fire(FiredInput::CameraZoomOut(1.)),
            ]
        );
        assert!(s.take_errors().is_empty());
    }

    #[test]
    fn root_bootstrap_does_not_replace_the_original_binding_store_or_saved_keys() {
        let mut s = UiScript::new().unwrap();
        s.register_bindings(&benilla_ui::bindings_xml::parse(super::BINDINGS).unwrap());
        s.set_default_bindings(benilla_ui::script::keybind::parse_bindings_wtf(
            super::DEFAULT_BINDINGS,
        ));
        s.seed_binding_set(1, Some(vec![("F".into(), "CAMERAZOOMIN".into())]));
        s.load_binding_set(1);
        s.run(super::LUA).unwrap();
        assert_eq!(s.current_binding_set(), 1);
        assert_eq!(
            s.eval::<String>("return GetBindingAction('F')").unwrap(),
            "CAMERAZOOMIN"
        );
        assert!(s.take_errors().is_empty());
    }

    #[test]
    fn original_world_tooltip_builder_seats_and_updates_its_native_health_bar() {
        let mut s = vm();
        s.run("UIParent:Hide();GameTooltip:SetParent(WorldFrame)")
            .unwrap();
        s.set_player_req_state(benilla_ui::script::PlayerReqState {
            level: 60,
            ..Default::default()
        });
        s.set_unit(
            "mouseover",
            Some(benilla_ui::script::UnitState {
                exists: true,
                has_object: true,
                guid: 100,
                name: Some("Recorded creature".into()),
                health: 30,
                max_health: 50,
                reaction: 2,
                player_reaction: 2,
                level: 10,
                creature_type_name: Some("Beast".into()),
                rank: 2,
                skinnable: true,
                ..Default::default()
            }),
        );
        assert!(s.world_tooltip_unit("mouseover"));
        measure(&mut s);
        assert_eq!(s.eval::<(f64,f64,f64)>("local lo,hi=GameTooltipStatusBar:GetMinMaxValues();return lo,hi,GameTooltipStatusBar:GetValue()").unwrap(), (0.,50.,30.));
        assert!(s
            .eval::<bool>(
                "return GameTooltip.default == 1 and GameTooltipStatusBar:IsShown() ~= nil"
            )
            .unwrap());
        assert!(s.eval::<bool>("return GameTooltip:GetRight() > GameTooltip:GetLeft() and GameTooltip:GetBottom() > 0").unwrap());
        assert_eq!(
            s.eval::<String>("return GameTooltipTextLeft2:GetText()")
                .unwrap(),
            "Level 10 Beast (Elite)"
        );
        assert_eq!(
            s.eval::<String>("return GameTooltipTextLeft3:GetText()")
                .unwrap(),
            "Skinnable"
        );
        assert!(s.take_errors().is_empty());
    }
}
