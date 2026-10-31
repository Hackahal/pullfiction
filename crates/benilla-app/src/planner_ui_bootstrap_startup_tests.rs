//! Exercise the original sliced entry loader with the planner's owned source configuration.

use super::*;
use bevy::ecs::system::RunSystemOnce;

#[test]
fn planner_owned_source_runs_the_original_entry_lifecycle_and_releases_its_feed_gate() {
    use crate::local_state::test_env::{EnvGuard, ENV_LOCK};

    let _lock = ENV_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let scratch =
        std::env::temp_dir().join(format!("benilla-planner-ui-startup-{}", std::process::id()));
    let _home = EnvGuard::set("BENILLA_HOME", scratch.to_str().unwrap());
    let _data = EnvGuard::set("WOW_DATA", "");
    let _capture = EnvGuard::unset("WOW_CAPTURE");
    let _ = std::fs::create_dir_all(&scratch);
    crate::planner_ui_bootstrap::with_test_mode(|| {
        let mut world = World::new();
        world.insert_resource(State::new(crate::client_state::ClientState::InWorld));
        world.init_resource::<crate::minimap::MinimapZoom>();
        world.init_resource::<super::super::UiClock>();
        let mut step = FrameStep::default();
        step.elapsed = std::time::Duration::from_secs(42);
        world.insert_resource(step);
        world.spawn((Window::default(), bevy::window::PrimaryWindow));

        setup_script(&mut world);
        assert!(
            world.get_non_send_resource::<UiScript>().is_none(),
            "no unused login UI is loaded"
        );
        arm_entry_ui_load(&mut world);
        assert!(!world.run_system_once(ingame_ui_up).unwrap());
        for _ in 0..32 {
            run_pending_entry_load(&mut world);
            if !world.contains_resource::<PendingEntryUiLoad>() {
                break;
            }
        }
        assert!(!world.contains_resource::<PendingEntryUiLoad>());
        assert!(world.run_system_once(ingame_ui_up).unwrap());
        assert!(!world.contains_non_send::<ParkedGlueVm>());
        let script = world.non_send_resource_mut::<UiScript>();
        assert_eq!(script.vm_kind(), benilla_ui::script::VmKind::InGame);
        assert_eq!(
            script.eval::<i64>("return math.floor(GetTime())").unwrap(),
            42
        );
        assert!(script
            .eval::<bool>("return WorldFrame ~= nil and UIParent ~= nil and GameTooltip ~= nil")
            .unwrap());
        assert!(!script
            .eval::<bool>(
                "return CharacterSelect ~= nil or PlayerFrame ~= nil or MainMenuBar ~= nil"
            )
            .unwrap());
        assert_eq!(
            script
                .eval::<String>("return GetBindingAction('BUTTON2')")
                .unwrap(),
            "TURNORACTION"
        );
        assert_eq!(
            script
                .eval::<String>("return GetBindingAction('MOUSEWHEELUP')")
                .unwrap(),
            "CAMERAZOOMIN"
        );
        assert!(script.errors().is_empty(), "{:?}", script.errors());
        drop(script);
        let mut script = world.non_send_resource_mut::<UiScript>();
        script.resolve();
        let id = script.mouse_move(500., 400.).unwrap();
        assert!(script.is_world_frame(id));
        assert!(!script.mouse_button(500., 400., "RightButton", true));
        assert!(!script.mouse_button(500., 400., "RightButton", false));
        assert!(script.execute_binding("TURNORACTION", true).unwrap());
        assert!(script.execute_binding("TURNORACTION", false).unwrap());
        assert_eq!(
            script.take_binding_input(),
            vec![
                benilla_ui::script::BindingInput::Start(
                    benilla_ui::script::HeldInput::TurnOrAction
                ),
                benilla_ui::script::BindingInput::Stop(benilla_ui::script::HeldInput::TurnOrAction),
            ]
        );
        assert!(script.errors().is_empty(), "{:?}", script.errors());
    });
    let _ = std::fs::remove_dir_all(&scratch);
}
