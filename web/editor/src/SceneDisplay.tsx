import { PanelSettings } from "./PanelSettings";
import type { Snapshot, Options } from "./types";
import type { EditorController } from "./controller";

export function CameraDistanceControl({
  state,
  controller,
}: {
  state: Snapshot;
  controller: EditorController;
}) {
  return (
    <select
      aria-label="Maximum camera distance"
      title="Maximum camera distance"
      value={state.cameraMaxDistance}
      onChange={(event) =>
        controller.setCameraDistance(Number(event.target.value))
      }
    >
      {[20, 30, 40, 50, 60].map((distance) => (
        <option key={distance} value={distance}>
          {distance} yd max
        </option>
      ))}
    </select>
  );
}

export function SceneDisplay({
  state,
  controller,
  cameraDistance = false,
}: {
  state: Snapshot;
  controller: EditorController;
  cameraDistance?: boolean;
}) {
  const options = state.options;
  const detailed = state.raidFrameSize.height >= 220;
  const standardNameplates =
    options.nameplates && options.enemyNameplates && options.bossNameplates;
  const scene =
    standardNameplates &&
    !options.raidFrames &&
    !options.friendlyNameplates &&
    !options.trashNameplates &&
    !options.auras;
  const raid =
    standardNameplates &&
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
          onClick={() => {
            if (!raid) controller.setScenePresentation("raid");
          }}
        >
          <strong>Raid overview</strong>
          <span>
            {raid && detailed
              ? "Show all roster details"
              : "Scan a compact roster"}
          </span>
        </button>
      </div>
      {cameraDistance && (
        <label className="scene-display-camera-distance">
          Camera distance
          <CameraDistanceControl state={state} controller={controller} />
        </label>
      )}
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
                checked={detailed}
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
