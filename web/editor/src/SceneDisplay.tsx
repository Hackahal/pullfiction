import { PanelSettings } from "./PanelSettings";
import type { Snapshot, Options } from "./types";
import type { EditorController } from "./controller";

export function SceneDisplay({
  state,
  controller,
}: {
  state: Snapshot;
  controller: EditorController;
}) {
  const options = state.options;
  const scene =
    !options.raidFrames &&
    !options.friendlyNameplates &&
    !options.trashNameplates &&
    !options.auras;
  const raid =
    options.raidFrames &&
    !options.friendlyNameplates &&
    !options.trashNameplates &&
    options.auras;
  return (
    <PanelSettings title="Scene display" label="Display" icon="eye" width={340}>
      <div className="scene-display-presets" aria-label="Scene presentation">
        <button
          aria-pressed={scene}
          onClick={() => controller.setScenePresentation("scene")}
        >
          <strong>Scene focus</strong>
          <span>Keep the fight in view</span>
        </button>
        <button
          aria-pressed={raid}
          onClick={() => controller.setScenePresentation("raid")}
        >
          <strong>Raid overview</strong>
          <span>Scan a compact roster</span>
        </button>
      </div>
      <fieldset className="scene-display-options">
        <legend>Overlays</legend>
        {(
          [
            ["raidFrames", "Raid frames"],
            ["friendlyNameplates", "Player nameplates"],
            ["enemyNameplates", "Enemy nameplates"],
            ["trashNameplates", "Trash nameplates"],
            ["bossNameplates", "Boss nameplates"],
            ["auras", "Buff and debuff details"],
            ["spells", "Spell effects"],
          ] as [keyof Options, string][]
        ).map(([key, title]) => (
          <label key={key}>
            <span>{title}</span>
            <input
              type="checkbox"
              checked={options[key]}
              onChange={(event) =>
                controller.setOption(key, event.target.checked)
              }
            />
          </label>
        ))}
        {options.raidFrames && (
          <>
            <label>
              <span>Detailed raid frames</span>
              <input
                type="checkbox"
                checked={state.raidFrameSize.height >= 220}
                onChange={(event) =>
                  controller.setRaidFrameSize(
                    state.raidFrameSize.width,
                    event.target.checked ? 276 : 186,
                  )
                }
              />
            </label>
            <small>Small viewers use compact frames automatically.</small>
          </>
        )}
      </fieldset>
      <div className="scene-display-actions">
        <button onClick={() => controller.focusCurrent()}>Frame raid</button>
        <button onClick={() => controller.home()}>Raid entrance</button>
      </div>
    </PanelSettings>
  );
}
