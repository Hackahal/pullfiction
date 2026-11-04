import { DrawingDefaults } from "./DrawingDefaults";
import { RangeCheck } from "./RangeCheck";
import type { EditorController } from "./controller";
import type { Snapshot } from "./types";
import { PANEL_MIME, type PaneId } from "./dock-model";
import { EditorIcon as Icon } from "./EditorIcon";
const runPanel = {
  id: "run",
  label: "Run timeline",
  icon: "timeline",
} as const;
export const panelCatalogue: { id: PaneId; label: string; icon: string }[] = [
  runPanel,
  { id: "inspector", label: "Focus", icon: "person" },
  { id: "analysis", label: "Statistics", icon: "table" },
  { id: "damage", label: "Damage graph", icon: "chart" },
  { id: "events", label: "Combat events", icon: "events" },
  { id: "healing", label: "Healing graph", icon: "heal" },
  { id: "timeline", label: "Cast timeline", icon: "timeline" },
  { id: "resources", label: "Resources", icon: "resource" },
  { id: "speedrun", label: "Speedrun timer", icon: "timeline" },
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
      key={label}
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
  const panelButton = (p: (typeof panelCatalogue)[number]) => {
    const visible = open.includes(p.id);
    const available =
      p.id !== "run" || !!state.replay || state.workspaceMode === "plan";
    return (
      <button
        key={p.id}
        className="panel-tool"
        aria-pressed={available && visible}
        disabled={!available}
        draggable={available && p.id !== "inspector"}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData(PANEL_MIME, p.id);
        }}
        onClick={() => (visible ? onClose(p.id) : onOpen(p.id))}
        title={`${visible ? "Hide" : "Show"} ${p.label}${p.id !== "inspector" ? " · Drag to dock" : ""}`}
      >
        <Icon name={p.icon} />
        <span className="panel-tool-name">{p.label}</span>
        <span className="panel-tool-status" aria-hidden="true" />
        {p.id !== "inspector" && (
          <span className="toolbox-grip" aria-hidden="true">
            <Icon name="grip" />
          </span>
        )}
      </button>
    );
  };
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
      {state.workspaceMode === "plan" && controller.snapshot() && (
        <div
          className="workspace-mode"
          role="group"
          aria-label="Compare positions"
        >
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
      {state.workspaceMode === "plan" &&
        (
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
            onClick={() =>
              panel.visible ? onClose(panel.id) : onOpen(panel.id)
            }
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
          <div className="toolbox-label">Drawing tools</div>
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
              : state.tool === "marker"
                ? "Click to place · Shift-click to select"
                : "Click to select · Drag to draw"}
          </p>
          <DrawingDefaults state={state} controller={controller} />
          {panelButton(runPanel)}
        </>
      )}
      {state.workspaceMode === "analyse" && (
        <>
          <div className="toolbox-label">Replay tools</div>
          <div className="primary-replay-tools">
            {panelCatalogue.slice(0, 5).map(panelButton)}
          </div>
          <details className="analysis-tools">
            <summary>More analysis tools</summary>
            <RangeCheck state={state} controller={controller} />
            {panelCatalogue.slice(5).map(panelButton)}
          </details>
        </>
      )}
    </nav>
  );
}
