import { DrawingDefaults } from "./DrawingDefaults";
import { RangeCheck } from "./RangeCheck";
import type { EditorController } from "./controller";
import type { Snapshot } from "./types";
import { PANEL_MIME, type PaneId } from "./dock-model";
import { EditorIcon as Icon } from "./EditorIcon";
export const panelCatalogue: { id: PaneId; label: string; icon: string }[] = [
  { id: "speedrun", label: "Speedrun timer", icon: "timeline" },
  { id: "run", label: "Run timeline", icon: "timeline" },
  { id: "damage", label: "Damage graph", icon: "chart" },
  { id: "healing", label: "Healing graph", icon: "heal" },
  { id: "timeline", label: "Cast timeline", icon: "timeline" },
  { id: "analysis", label: "Statistics", icon: "table" },
  { id: "resources", label: "Resources", icon: "resource" },
  { id: "events", label: "Combat events", icon: "events" },
  { id: "inspector", label: "Focus", icon: "person" },
];
export function Toolbox({
  state,
  controller,
  open,
  onOpen,
  onClose,
}: {
  state: Snapshot;
  controller: EditorController;
  open: PaneId[];
  onOpen: (id: PaneId) => void;
  onClose: (id: PaneId) => void;
}) {
  const button = (
    icon: string,
    label: string,
    onClick: () => void,
    active?: boolean,
    shortLabel = label,
  ) => (
    <button
      className={active ? "active" : ""}
      aria-pressed={active}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Icon name={icon} />
      <span>{shortLabel}</span>
    </button>
  );
  return (
    <nav
      className={`toolbox ${state.workspaceMode === "plan" ? "editing" : ""}`}
      aria-label="Tools"
    >
      <div className="workspace-mode" role="group" aria-label="Workspace mode">
        <button
          aria-pressed={state.workspaceMode === "analyse"}
          onClick={() => controller.setWorkspaceMode("analyse")}
        >
          Analyse
        </button>
        <button
          aria-pressed={state.workspaceMode === "plan"}
          onClick={() => controller.setWorkspaceMode("plan")}
        >
          Plan
        </button>
      </div>
      {state.replay && state.workspaceMode === "analyse" && (
        <button
          className="plan-from-moment"
          onClick={() => controller.planFromMoment()}
        >
          <Icon name="pin" />
          <span>Plan from this moment</span>
        </button>
      )}
      {state.workspaceMode === "plan" && controller.snapshot() && (
        <div className="workspace-mode" aria-label="Compare positions">
          <button
            aria-pressed={!state.compareRecorded}
            onClick={() => controller.setCompareRecorded(false)}
          >
            Planned
          </button>
          <button
            disabled={!controller.snapshot()?.actors.some((a) => a.recorded)}
            aria-pressed={state.compareRecorded}
            onClick={() => controller.setCompareRecorded(true)}
          >
            Recorded
          </button>
        </div>
      )}
      {(
        [
          {
            id: "playbook",
            label: "Edits",
            icon: "pointer",
            visible: state.planning,
          },
        ] as const
      ).map((panel) => (
        <button
          key={panel.id}
          className={panel.visible ? "active" : ""}
          aria-pressed={panel.visible}
          draggable
          title={`Show or hide ${panel.label} · Drag to dock`}
          onClick={() => (panel.visible ? onClose(panel.id) : onOpen(panel.id))}
          onDragStart={(e) => {
            e.dataTransfer.setData(PANEL_MIME, panel.id);
            e.dataTransfer.effectAllowed = "move";
          }}
        >
          <Icon name={panel.icon} />
          <span>{panel.label}</span>
          <span className="toolbox-grip" aria-hidden="true">
            <Icon name="grip" />
          </span>
        </button>
      ))}
      {state.workspaceMode === "plan" && (
        <>
          <div className="toolbox-label">Marking</div>
          <div className="editor-tools">
            {button(
              "pointer",
              "Select",
              () => controller.setTool("explore"),
              state.tool === "explore",
            )}
            {button(
              "pin",
              "Place marker",
              () =>
                controller.selectedActorForDrawing()
                  ? controller.applyMarker(state.markStyle.icon)
                  : controller.setTool("marker"),
              state.tool === "marker",
              "Marker",
            )}
            {button(
              "route",
              "Draw route",
              () => controller.setTool("route"),
              state.tool === "route",
              "Route",
            )}
            {(
              [
                ["arrow", "Arrow"],
                ["circle", "Radius"],
                ["cone", "Cone"],
                ["polygon", "Area"],
                ["drawing", "Freehand"],
                ["label", "Text"],
              ] as const
            ).map(([tool, label]) => (
              <div key={tool}>
                {button(
                  tool,
                  label,
                  () => controller.setTool(tool),
                  state.tool === tool,
                )}
              </div>
            ))}
            {state.drawing &&
              button(
                "pointer",
                "Finish drawing",
                () => controller.finishDrawing(),
                undefined,
                "Finish",
              )}
          </div>
          <p className="toolbox-gesture">
            {["route", "polygon"].includes(state.tool)
              ? "Click waypoints · Finish to end"
              : "Click to select · Drag to draw"}
          </p>
          <DrawingDefaults state={state} controller={controller} />
          {button(
            "timeline",
            "Run timeline",
            () => onOpen("run"),
            open.includes("run"),
          )}
        </>
      )}
      {state.workspaceMode === "analyse" && (
        <>
          <RangeCheck state={state} controller={controller} />
          <div className="toolbox-label">Panels</div>
          {panelCatalogue.map((p) => (
            <button
              key={p.id}
              draggable={p.id !== "inspector"}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData(PANEL_MIME, p.id);
              }}
              onClick={() => onOpen(p.id)}
              className={open.includes(p.id) ? "open" : ""}
              title={
                p.id === "inspector"
                  ? "Open Focus"
                  : `Drag ${p.label} into the workspace, or click to open`
              }
            >
              <Icon name={p.icon} />
              <span>{p.label}</span>
              {p.id !== "inspector" && (
                <span className="toolbox-grip" aria-hidden="true">
                  <Icon name="grip" />
                </span>
              )}
            </button>
          ))}
        </>
      )}
      <details className="toolbox-view">
        <summary>View</summary>
        {button("home", "Entrance", () => controller.home())}
        {button(
          "person",
          "Friendly nameplates",
          () =>
            controller.setOption(
              "friendlyNameplates",
              !state.options.friendlyNameplates,
            ),
          state.options.friendlyNameplates,
        )}
        {button(
          "raid",
          "Enemy nameplates",
          () =>
            controller.setOption(
              "enemyNameplates",
              !state.options.enemyNameplates,
            ),
          state.options.enemyNameplates,
        )}
        {button(
          "raid",
          "Raid frames",
          () => controller.setOption("raidFrames", !state.options.raidFrames),
          state.options.raidFrames,
        )}
        {button("focus", "Focus raid", () => controller.focusCurrent())}
      </details>
    </nav>
  );
}
