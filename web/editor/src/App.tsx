import { CommunityLinks } from "./CommunityLinks";
import { GitHubLink } from "./GitHubLink";
import { nameplateShortcut } from "./nameplate-model";
import { GameIcon } from "./GameIcon";
import { handleCursor, handleLabel, rotateCursor } from "./edit-affordances";
import { EditsPanel } from "./EditsPanel";
import { Inspection } from "./Inspection";
import {
  sceneGesture,
  drawsOnRelease,
  startsDrag,
  usesNativeMouseLook,
} from "./interaction-policy";
import { SceneToolbar } from "./SceneToolbar";
import { ReplayLoading } from "./ReplayLoading";
import { RaidFrameResize } from "./RaidFrameResize";
import { BrowserClient } from "./BrowserClient";
import { EditorIcon } from "./EditorIcon";
import { contextOf } from "./editor-controls";
import { GameVersionContext } from "./Wowhead";
import { GAME_VERSIONS } from "../../planner/game-versions.mjs";
import { selectionMode } from "./selection-model";
import { MapView } from "./MapView";
import { SpeedrunPanel } from "./SpeedrunTimer";
import { RunTimeline } from "./RunTimeline";
import { Toolbox } from "./Toolbox";
import { readPanels, VISIBILITY_STORAGE, type PaneId } from "./dock-model";
import { Analysis } from "./Analysis";
import { Focus } from "./Focus";
import { followingStart } from "./timeline-model";
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { DockWorkspace } from "./DockWorkspace";
import { DamageGraph } from "./DamageGraph";
import { EditorController } from "./controller";
import { Library } from "./Library";
const Timeline = lazy(() =>
  import("./Timeline").then((module) => ({ default: module.Timeline })),
);
import {
  RAIDS,
  raidsForVersion,
  raidByMap,
  raidForZone,
  reportRaids,
  chapterAt,
  preciseTime,
  routeLength,
  time,
} from "./domain";
import type { GameVersion, Options, Snapshot } from "./types";
export { GameIcon } from "./GameIcon";
export function App({ controller }: { controller: EditorController }) {
  useEffect(() => {
    controller.start();
    void controller.boot();
    return () => controller.stop();
  }, [controller]);
  const state = useSyncExternalStore(
      controller.subscribe,
      controller.getSnapshot,
      controller.getSnapshot,
    ),
    [dialog, setDialog] = useState<"import" | "settings" | null>(null),
    [library, setLibrary] = useState<"projects" | "logs" | "runs" | null>(
      () => {
        try {
          const tab = sessionStorage.getItem("pullfiction.library.tab");
          return tab === "logs" || tab === "runs" ? tab : "projects";
        } catch {
          return "projects";
        }
      },
    ),
    [panelLayouts, setPanelLayouts] = useState<
      Record<"analyse" | "plan", PaneId[]>
    >(() => {
      const read = (mode: string) => {
        try {
          const saved =
            localStorage.getItem(`${VISIBILITY_STORAGE}.${mode}`) ??
            (mode === "analyse"
              ? localStorage.getItem(VISIBILITY_STORAGE)
              : null);
          const panels = readPanels(saved);
          if (!localStorage.getItem("pullfiction.runNavigator.docked.v1"))
            panels.push("run");
          return [...new Set(panels)];
        } catch {
          return ["run"] as PaneId[];
        }
      };
      return { analyse: read("analyse"), plan: read("plan") };
    }),
    [pageDetails, setPageDetails] = useState(false),
    [timelineRange, setTimelineRange] = useState<[number, number]>([0, 60000]),
    [source, setSource] = useState(
      "https://vanilla.warcraftlogs.com/reports/DyN7vF94QR8aj1Lc",
    );
  const openPanels = panelLayouts[state.workspaceMode];
  function showPageDetails(on: boolean) {
    if (on) {
      controller.finishDrawing();
      controller.selectMark(null);
      controller.clearActorSelection();
      controller.setPlanning(true);
    }
    setPageDetails(on);
  }
  useEffect(() => {
    if (
      state.selectedMarks.length ||
      state.selectedActors.length ||
      state.workspaceMode !== "plan"
    )
      setPageDetails(false);
  }, [
    state.selectedMarks.join("|"),
    state.selectedActors.join("|"),
    state.workspaceMode,
    state.projectId,
  ]);
  function openLibrary(tab: "projects" | "logs") {
    if (state.playing || state.playPreparing) controller.toggle();
    if (state.projectId || state.dirty) void controller.saveProject();
    setLibrary(tab);
  }
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (controller.getSnapshot().dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [controller]);
  function setOpenPanels(update: PaneId[] | ((old: PaneId[]) => PaneId[])) {
    setPanelLayouts((old) => ({
      ...old,
      [state.workspaceMode]:
        typeof update === "function"
          ? update(old[state.workspaceMode])
          : update,
    }));
  }
  const inspector = openPanels.includes("inspector"),
    analysis = openPanels.includes("analysis");
  function openPanel(id: PaneId) {
    if (id === "playbook") {
      controller.setPlanning(true);
      return;
    }
    if (id !== "scene")
      setOpenPanels((old) => (old.includes(id) ? old : [...old, id]));
  }
  function closePanel(id: PaneId) {
    if (id === "playbook") {
      controller.setPlanning(false);
      return;
    }
    setOpenPanels((old) => old.filter((p) => p !== id));
  }
  function setInspector(value: boolean) {
    value ? openPanel("inspector") : closePanel("inspector");
  }
  function setAnalysis(value: boolean | ((v: boolean) => boolean)) {
    const on = typeof value === "function" ? value(analysis) : value;
    on ? openPanel("analysis") : closePanel("analysis");
  }
  useEffect(() => {
    try {
      if (!localStorage.getItem("pullfiction.runNavigator.docked.v1")) {
        localStorage.setItem(
          `${VISIBILITY_STORAGE}.analyse`,
          JSON.stringify(panelLayouts.analyse),
        );
        localStorage.setItem(
          `${VISIBILITY_STORAGE}.plan`,
          JSON.stringify(panelLayouts.plan),
        );
        localStorage.setItem("pullfiction.runNavigator.docked.v1", "1");
      }
      localStorage.setItem(
        `${VISIBILITY_STORAGE}.${state.workspaceMode}`,
        JSON.stringify(openPanels),
      );
    } catch {}
  }, [openPanels, state.workspaceMode]);
  useEffect(() => {
    if (openPanels.includes("timeline") || !state.replay) return;
    const duration = state.replay.duration,
      span = Math.min(60000, duration);
    setTimelineRange((old) => {
      const start = followingStart(state.time, old[0], span, duration);
      return old[0] === start && old[1] === start + span
        ? old
        : [start, start + span];
    });
  }, [state.time, state.replay, openPanels]);
  const planFile = useRef<HTMLInputElement>(null),
    logFile = useRef<HTMLInputElement>(null);
  const selected = state.replay?.actors.find((a) => a.key === state.selected),
    chapter = state.replay && chapterAt(state.replay, state.time);
  useEffect(() => {
    if (state.selectedMark) setInspector(false);
  }, [state.selectedMark]);
  useEffect(() => {
    if (state.workspaceMode === "analyse" && (state.selected || state.detail))
      setInspector(true);
  }, [state.selected, state.detail, state.workspaceMode]);
  useEffect(() => {
    const callback = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLElement &&
        (event.target.matches(
          "input,textarea,select,[contenteditable=true],[role=slider]",
        ) ||
          event.target.closest('[role="dialog"]'))
      )
        return;
      const command = event.ctrlKey || event.metaKey,
        key = event.key.toLowerCase();
      const context = contextOf(
        event.target instanceof Element ? event.target : null,
      );
      if (
        context === "scene" &&
        !command &&
        controller.numericDrawingAvailable()
      ) {
        if (/^[0-9.]$/.test(event.key)) {
          event.preventDefault();
          controller.setDrawingDimension(
            controller.getSnapshot().dimensionInput + event.key,
          );
          return;
        }
        if (event.key === "Backspace" && state.dimensionInput) {
          event.preventDefault();
          controller.setDrawingDimension(state.dimensionInput.slice(0, -1));
          return;
        }
        if (event.key === "Enter" && state.dimensionInput) {
          event.preventDefault();
          controller.confirmDrawingDimension();
          return;
        }
        if (event.key === "Escape" && state.dimensionInput) {
          event.preventDefault();
          controller.cancelDrawingDimension();
          return;
        }
      }

      if (context === "scene" && command) controller.setShortcutCapture(true);
      if (
        context === "scene" &&
        !command &&
        !event.altKey &&
        controller.freeCameraInput() &&
        ["w", "a", "s", "d", "c", " "].includes(key)
      )
        return;

      if (context === "playbook" && !command) {
        const i = state.plan.steps.findIndex((s) => s.id === state.activeStep);
        if (["ArrowUp", "ArrowDown"].includes(event.key)) {
          event.preventDefault();
          const next =
            state.plan.steps[i + (event.key === "ArrowDown" ? 1 : -1)];
          if (next) controller.setActiveStep(next.id);
          return;
        }
      }
      if (context === "timeline" && !command) {
        if (event.code === "Space") {
          event.preventDefault();
          if (!state.replay) controller.stepPage(1);
          else controller.toggle();
          return;
        }
        if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
          event.preventDefault();
          if (!state.replay) {
            controller.stepPage(event.key === "ArrowRight" ? 1 : -1);
            return;
          }
          controller.seek(
            state.time +
              (event.key === "ArrowRight" ? 1 : -1) *
                (event.shiftKey ? 10000 : 1000),
          );
          return;
        }
      }
      const plateOption = nameplateShortcut(event);
      if (plateOption) {
        event.preventDefault();
        if (!event.repeat) {
          controller.setOption(
            plateOption,
            !controller.getSnapshot().options[plateOption],
          );
        }
        return;
      }
      const scene = context === "scene";

      if (state.workspaceMode === "plan" && scene) {
        if (command && ["a", "c", "x", "v", "y"].includes(key)) {
          event.preventDefault();
          if (key === "a") controller.selectAllMarks();
          if (key === "c") controller.copyMarks();
          if (key === "x") controller.copyMarks(true);
          if (key === "v") controller.pasteMarks();
          if (key === "y") controller.redo();
          return;
        }
        if (
          (state.selectedMarks.length || state.selectedActors.length) &&
          ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
            event.key,
          )
        ) {
          event.preventDefault();
          const amount = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
          controller.nudgeScreen(
            event.key === "ArrowRight"
              ? amount
              : event.key === "ArrowLeft"
                ? -amount
                : 0,
            event.key === "ArrowUp"
              ? amount
              : event.key === "ArrowDown"
                ? -amount
                : 0,
          );
          return;
        }
      }
      if (scene && !command && !event.altKey && key === "f") {
        event.preventDefault();
        controller.frameSelection();
        return;
      }
      if (event.key === "Escape") {
        if (dialog) setDialog(null);
        else if (state.drawing) controller.cancelDrawing();
        else if (state.tool !== "explore" || state.transformActive) {
          controller.setTool("explore");
        } else if (state.selectedMarks.length || state.selectedActors.length) {
          controller.selectMark(null);
          controller.clearActorSelection();
        } else if (inspector) setInspector(false);
        return;
      }
      if (scene && event.key === "Enter" && state.drawing) {
        event.preventDefault();
        controller.finishDrawing();
      }
      if (
        scene &&
        (event.key === "Delete" || event.key === "Backspace") &&
        state.selectedMark
      ) {
        event.preventDefault();
        controller.removeMark();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        controller.save();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? controller.redo() : controller.undo();
      }
    };
    const release = (event: KeyboardEvent) => {
      controller.setShortcutCapture(event.ctrlKey || event.metaKey);
      if (event.code === "Space") controller.setSpacePan(false);
      if (event.key.toLowerCase() === "b") controller.setSnapBypass(false);
    };
    const blur = () => {
      controller.setSceneFocused(false);
      controller.setShortcutCapture(false);
      controller.setSpacePan(false);
      controller.setSnapBypass(false);
    };
    const focus = () =>
      controller.setSceneFocused(
        document.activeElement === document.getElementById("benilla"),
      );
    window.addEventListener("focus", focus);
    document.addEventListener("keydown", callback);
    document.addEventListener("keyup", release);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("keydown", callback);
      document.removeEventListener("keyup", release);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
    };
  }, [
    controller,
    state.drawing,
    state.dimensionInput,
    state.selectedMark,
    state.workspaceMode,
    state.selectedMarks,
    state.selectedActors,
    state.plan,
    state.activeStep,
    state.time,
    state.replay,
    state.transform,
    state.transformActive,
    dialog,
    inspector,
  ]);
  return (
    <GameVersionContext.Provider value={state.gameVersion}>
      <div
        className={`editor ${state.browserAssets ? "browser-assets" : ""}`}
        onFocusCapture={(e) =>
          controller.setTyping(
            e.target instanceof HTMLElement &&
              e.target.matches(
                "input,select,textarea,[contenteditable=true],[role=slider]",
              ),
          )
        }
        onBlurCapture={() => controller.setTyping(false)}
      >
        <header className="menubar">
          <button
            className="brand"
            onClick={() => openLibrary("projects")}
            aria-label="Open library"
          >
            Pull <span>Fiction</span>
          </button>
          <select
            aria-label="Game version"
            value={state.gameVersion}
            disabled={state.busy}
            onChange={(e) =>
              controller.setGameVersion(e.target.value as GameVersion)
            }
          >
            {GAME_VERSIONS.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
          <span className="menu-divider" />
          <input
            className="plan-name"
            aria-label="Plan name"
            maxLength={100}
            value={state.plan.name}
            onChange={(e) => controller.rename(e.target.value)}
          />
          <span
            className={`save-dot ${state.dirty ? "dirty" : ""}`}
            title={state.dirty ? "Unsaved changes" : "Saved"}
          />
          <button onClick={() => openLibrary("projects")}>Library</button>
          <button onClick={() => openLibrary("logs")}>Logs</button>
          {state.projectId && state.sourceStatus === "missing" && (
            <button
              onClick={() => openLibrary("logs")}
              title="Reload the log without changing this plan"
            >
              Reload source
            </button>
          )}
          <button onClick={() => controller.save()} title="Save · ⌘S">
            Save
          </button>
          <span
            className={`local-save-status ${state.saveStatus}`}
            role="status"
          >
            {state.saveStatus === "saved"
              ? "Saved locally"
              : state.saveStatus === "saving"
                ? "Saving…"
                : state.saveStatus === "pending"
                  ? "Unsaved"
                  : state.saveStatus === "error"
                    ? "Save failed"
                    : ""}
          </span>
          <details
            className="file-menu"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                e.currentTarget.removeAttribute("open");
                e.currentTarget.querySelector("summary")?.focus();
              }
            }}
          >
            <summary>File</summary>
            <div
              className="menu-popover"
              onClick={(e) => {
                if ((e.target as Element).closest("button"))
                  e.currentTarget.closest("details")?.removeAttribute("open");
              }}
            >
              <button onClick={() => planFile.current?.click()}>
                Import plan
              </button>
              <button onClick={() => controller.exportFile("plan")}>
                Export plan
              </button>
              <button
                disabled={!state.projectId}
                onClick={() =>
                  state.projectId &&
                  void controller.exportProject(state.projectId)
                }
              >
                Export project backup
              </button>
              <button
                disabled={!state.replay}
                onClick={() => controller.exportFile("replay")}
              >
                Export replay
              </button>
            </div>
          </details>
          <span className="menu-divider" />
          <button
            className="history-button"
            aria-label="Undo"
            title="Undo · ⌘Z"
            disabled={!state.canUndo}
            onClick={() => controller.undo()}
          >
            ↶
          </button>
          <button
            className="history-button"
            aria-label="Redo"
            title="Redo · ⇧⌘Z"
            disabled={!state.canRedo}
            onClick={() => controller.redo()}
          >
            ↷
          </button>
          <div className="menu-spacer" />
          <label className="raid-picker">
            <span>Raid</span>
            <select
              className="raid-selector"
              aria-label="Raid map"
              value={state.plan.mapId}
              onChange={(e) => controller.selectRaid(Number(e.target.value))}
            >
              {raidsForVersion(state.gameVersion).map((raid) => (
                <option key={raid.map} value={raid.map}>
                  {raid.name}
                </option>
              ))}
            </select>
          </label>
          <GitHubLink />
          {state.clientNeedsFiles && state.clientPromptHidden && (
            <button onClick={() => controller.showClientSource()}>
              Load game assets
            </button>
          )}
          <button onClick={() => setDialog("settings")}>Settings</button>
        </header>
        <div className="editor-body">
          <Toolbox
            state={state}
            controller={controller}
            open={openPanels}
            onOpen={openPanel}
            onClose={closePanel}
          />
          <div className="editor-workarea">
            <DockWorkspace
              mode={state.workspaceMode}
              onOpen={openPanel}
              onReset={() => {
                setOpenPanels(["run"]);
                controller.setPlanning(state.workspaceMode === "plan");
              }}
              panels={[
                {
                  id: "run",
                  title: "Run timeline",
                  visible:
                    openPanels.includes("run") &&
                    (!!state.replay || state.workspaceMode === "plan"),
                  close: () => closePanel("run"),
                  content: (
                    <RunTimeline
                      state={state}
                      controller={controller}
                      pageDetails={pageDetails && state.planning}
                      onPageDetails={showPageDetails}
                    />
                  ),
                },
                {
                  id: "speedrun",
                  title: "Speedrun timer",
                  visible:
                    openPanels.includes("speedrun") &&
                    state.workspaceMode === "analyse",
                  close: () => closePanel("speedrun"),
                  content: (
                    <SpeedrunPanel state={state} controller={controller} />
                  ),
                },
                {
                  id: "playbook",
                  title: "Edits",
                  visible: state.planning,
                  close: () => controller.setPlanning(false),
                  content: (
                    <EditsPanel
                      state={state}
                      controller={controller}
                      pageDetails={pageDetails}
                      onPageDetails={showPageDetails}
                    />
                  ),
                },
                {
                  id: "healing",
                  title: "Healing",
                  visible: openPanels.includes("healing"),
                  close: () => closePanel("healing"),
                  content: (
                    <DamageGraph
                      state={state}
                      controller={controller}
                      actor={selected?.type === "Player" ? selected : undefined}
                      range={timelineRange}
                      metric="heal"
                    />
                  ),
                },
                {
                  id: "resources",
                  title: "Resources",
                  visible: openPanels.includes("resources"),
                  close: () => closePanel("resources"),
                  content: (
                    <Analysis
                      state={state}
                      controller={controller}
                      close={() => closePanel("resources")}
                      preset={{ view: "resources" }}
                      storageKey="pullfiction.resources"
                    />
                  ),
                },
                {
                  id: "events",
                  title: "Combat events",
                  visible: openPanels.includes("events"),
                  close: () => closePanel("events"),
                  content: (
                    <Analysis
                      state={state}
                      controller={controller}
                      close={() => closePanel("events")}
                      preset={{ view: "events" }}
                      storageKey="pullfiction.events"
                    />
                  ),
                },
                {
                  id: "scene",
                  title: "Scene",
                  content: (
                    <Viewport
                      state={state}
                      controller={controller}
                      focus={inspector}
                      closeFocus={() => setInspector(false)}
                    />
                  ),
                },
                {
                  id: "analysis",
                  title: "Statistics",
                  visible: analysis,
                  close: () => setAnalysis(false),
                  content: (
                    <Analysis
                      state={state}
                      controller={controller}
                      close={() => setAnalysis(false)}
                    />
                  ),
                },
                {
                  id: "damage",
                  title: "Damage",
                  visible: openPanels.includes("damage"),
                  close: () => closePanel("damage"),
                  content: (
                    <DamageGraph
                      state={state}
                      controller={controller}
                      actor={selected?.type === "Player" ? selected : undefined}
                      range={timelineRange}
                    />
                  ),
                },
                {
                  id: "timeline",
                  title: "Cast timeline",
                  visible: openPanels.includes("timeline"),
                  close: () => closePanel("timeline"),
                  content: (
                    <Suspense fallback={<div className="timeline" />}>
                      <Timeline
                        state={state}
                        controller={controller}
                        actor={
                          selected?.type === "Player" ? selected : undefined
                        }
                        onRaid={() => controller.select(null)}
                        onRange={(a, b) =>
                          setTimelineRange((old) =>
                            old[0] === a && old[1] === b ? old : [a, b],
                          )
                        }
                      />
                    </Suspense>
                  ),
                },
              ]}
            />
            <ReplayLoading state={state} controller={controller} />
            <div className="transport" hidden={!state.replay}>
              <button
                aria-label="Previous encounter"
                title="Previous encounter"
                disabled={!state.replay}
                onClick={() => controller.stepChapter(-1)}
              >
                <EditorIcon name="previous" />
              </button>
              <button
                className="play"
                aria-label={
                  state.playPreparing
                    ? "Cancel preparation"
                    : state.playing
                      ? "Pause"
                      : "Play"
                }
                disabled={!state.replay && state.workspaceMode !== "plan"}
                onClick={() => controller.toggle()}
              >
                <EditorIcon
                  name={state.playing || state.playPreparing ? "pause" : "play"}
                />
              </button>
              <button
                aria-label="Next encounter"
                title="Next encounter"
                disabled={!state.replay}
                onClick={() => controller.stepChapter(1)}
              >
                <EditorIcon name="next" />
              </button>
              <span className="timecode">
                {preciseTime(state.time)}
                <span> / {time(controller.duration())}</span>
              </span>
              <select
                aria-label="Playback speed"
                value={state.rate}
                onChange={(e) => controller.setRate(Number(e.target.value))}
              >
                {[0.5, 1, 2, 4].map((v) => (
                  <option key={v} value={v}>
                    {v}×
                  </option>
                ))}
              </select>
              <button
                className={state.loop ? "active" : ""}
                title="Loop current encounter"
                disabled={!state.replay}
                onClick={() => controller.toggleLoop()}
              >
                Loop
              </button>
              <span className="menu-divider" />
              {state.replay?.chapters.length ? (
                <select
                  className="chapter-select"
                  aria-label="Encounter"
                  value={chapter?.id ?? ""}
                  onChange={(e) => controller.jump(e.target.value)}
                >
                  <option value="" disabled>
                    Between pulls
                  </option>
                  {state.replay.chapters.map((c) => (
                    <option key={c.id} value={c.id}>
                      {time(c.start)} · {c.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="current-encounter">
                  {state.replay?.fight.name ?? "No replay"}
                </span>
              )}
              <div className="menu-spacer" />
              {state.busy && <span className="busy-dot" />}
              <button onClick={() => setDialog("import")}>
                {state.replay?.report.title ?? "Open log"}
              </button>
            </div>
          </div>
        </div>
        <footer className="statusbar">
          <span>
            {state.tool === "explore"
              ? controller.cameraPresentation().label
              : {
                  marker: "Place marker",
                  route: "Draw route",
                  arrow: "Draw arrow",
                  circle: "Draw circle",
                  cone: "Draw cone",
                  polygon: "Draw area",
                  drawing: "Freehand drawing",
                  label: "Place text",
                  move: "Move mark",
                }[state.tool]}
          </span>
          <span>
            {state.plan.steps.length} steps ·{" "}
            {state.plan.steps.reduce((n, s) => n + s.annotations.length, 0)}{" "}
            marks · {Math.round(routeLength(state.plan.route))} yd
          </span>
          <div className="menu-spacer" />
          <span>
            {state.busy || state.error
              ? state.status
              : (controller.referenceSpawnNotice() ?? state.status)}
          </span>
          <CommunityLinks />
        </footer>
        {state.notice && (
          <div role="status" className="toast">
            {state.notice}
            <button
              aria-label="Dismiss message"
              onClick={() => controller.notify("")}
            >
              ×
            </button>
          </div>
        )}
        <input
          ref={planFile}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void controller.importFile(file, "plan");
            e.target.value = "";
          }}
        />
        <input
          ref={logFile}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void controller.importFile(file, "replay");
            e.target.value = "";
          }}
        />
        {library && (
          <Library
            state={state}
            controller={controller}
            initialTab={library}
            close={() => setLibrary(null)}
          />
        )}
        {dialog && (
          <Modal
            title={dialog === "import" ? "Import" : "Settings"}
            close={() => setDialog(null)}
          >
            {dialog === "import" ? (
              <>
                {state.browserAssets && (
                  <div className="browser-wcl">
                    {state.wclConfigured ? (
                      <>
                        <span>
                          {state.wclConnected
                            ? "Warcraft Logs connected"
                            : "Connect to import your Warcraft Logs reports"}
                        </span>
                        <button
                          onClick={() =>
                            state.wclConnected
                              ? controller.disconnectWcl()
                              : void controller.connectWcl()
                          }
                        >
                          {state.wclConnected
                            ? "Disconnect Warcraft Logs"
                            : "Connect Warcraft Logs"}
                        </button>
                      </>
                    ) : (
                      <p>
                        Warcraft Logs sign-in is not configured for this site.
                        Import an exported replay JSON file below.
                      </p>
                    )}
                    {state.busy && (
                      <button onClick={() => controller.cancelImport()}>
                        Cancel import
                      </button>
                    )}
                  </div>
                )}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void controller.loadReport(source);
                  }}
                >
                  <label htmlFor="game-version">Game version</label>
                  <select
                    id="game-version"
                    value={state.gameVersion}
                    disabled={state.busy}
                    onChange={(e) =>
                      controller.setGameVersion(e.target.value as GameVersion)
                    }
                  >
                    {GAME_VERSIONS.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                  <label htmlFor="report-url">Warcraft Logs report</label>
                  <div className="input-row">
                    <input
                      id="report-url"
                      value={source}
                      onChange={(e) => setSource(e.target.value)}
                      spellCheck={false}
                    />
                    <button
                      className="gold-button"
                      disabled={
                        state.busy ||
                        (state.browserAssets && !state.wclConnected)
                      }
                    >
                      Load
                    </button>
                  </div>
                </form>
                {state.report && (
                  <div className="report-pulls">
                    <div className="report-heading">
                      <strong>{state.report.title}</strong>
                      {reportRaids(state.report).map((raid) => (
                        <button
                          key={raid.map}
                          className="gold-button"
                          disabled={state.busy}
                          onClick={() =>
                            void controller
                              .loadReplay("run", raid.map)
                              .then(() => {
                                if (
                                  controller.getSnapshot().replay?.chapters
                                    .length
                                )
                                  setDialog(null);
                              })
                          }
                        >
                          Full {raid.short} run
                        </button>
                      ))}
                    </div>
                    {state.report.fights
                      .filter(
                        (f) =>
                          Boolean(raidForZone(f.gameZone)) &&
                          !(f as unknown as { completeRaid: boolean })
                            .completeRaid,
                      )
                      .map((f) => (
                        <button
                          className="pull-row"
                          key={f.id}
                          disabled={state.busy}
                          onClick={() =>
                            void controller
                              .loadReplay(String(f.id))
                              .then(() => {
                                if (
                                  controller.getSnapshot().replay?.fight.id ===
                                  f.id
                                )
                                  setDialog(null);
                              })
                          }
                        >
                          <GameIcon
                            name={
                              f.encounterID
                                ? "INV_Misc_Head_Dragon_01"
                                : "Ability_Warrior_Challange"
                            }
                          />
                          <span>
                            {reportRaids(state.report).length > 1
                              ? `${raidForZone(f.gameZone)?.short} · `
                              : ""}
                            {f.name}
                          </span>
                          <span>{time(f.endTime - f.startTime)}</span>
                          {f.kill && <span className="kill-dot" />}
                        </button>
                      ))}
                  </div>
                )}
                <div className="modal-footer">
                  <button
                    disabled={state.busy}
                    onClick={() => logFile.current?.click()}
                  >
                    Import replay JSON
                  </button>
                  {state.busy && <span>Loading…</span>}
                </div>
              </>
            ) : (
              <div className="settings-list">
                {(
                  [
                    ["raidFrames", "Raid frames"],
                    ["friendlyNameplates", "Friendly nameplates (Shift+V)"],
                    ["enemyNameplates", "Enemy nameplates (V)"],
                    ["trashNameplates", "Trash nameplates"],
                    ["bossNameplates", "Boss nameplates"],
                    ["auras", "Buffs and debuffs"],
                    ["spells", "Spell effects"],
                    ["smoothGaps", "Smooth gaps as wisps"],
                    ["followPulls", "Follow encounters"],
                    ["actors", "Replay actors"],
                  ] as [keyof Options, string][]
                ).map(([key, label]) => (
                  <label key={key}>
                    <span>{label}</span>
                    <input
                      type="checkbox"
                      checked={state.options[key]}
                      onChange={(e) =>
                        controller.setOption(key, e.target.checked)
                      }
                    />
                  </label>
                ))}
              </div>
            )}
          </Modal>
        )}
      </div>
    </GameVersionContext.Provider>
  );
}
function Viewport({
  state,
  controller,
  focus,
  closeFocus,
}: {
  state: Snapshot;
  controller: EditorController;
  focus: boolean;
  closeFocus: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [map, setMap] = useState(false);
  const [inspectionOpen, setInspectionOpen] = useState(false);
  const focusedActor = state.replay?.actors.find(
    (a) => a.key === state.selected,
  );
  useEffect(() => {
    if (state.workspaceMode !== "analyse" || focusedActor?.type !== "Player")
      setInspectionOpen(false);
  }, [state.workspaceMode, focusedActor?.key, focusedActor?.type]);
  const shape = useRef(false);
  const stroke = useRef(false),
    dragging = useRef(false),
    suppressClick = useRef(false),
    dragStart = useRef<[number, number]>([0, 0]),
    lastPick = useRef(0),
    lastHover = useRef(0);
  const [draggingMark, setDraggingMark] = useState(false);
  const pendingPress = useRef<{
    x: number;
    y: number;
    local: [number, number];
    gesture: "draw" | "transform";
    actor: string | null;
    id: string | null;
    handle: number | null;
    point: import("./types").Point | null;
    moved: boolean;
  } | null>(null);
  const navigation = useRef<{
    x: number;
    y: number;
    pan: boolean;
    native?: boolean;
  } | null>(null);
  const [selectionModifier, setSelectionModifier] = useState(false);
  const [nativeLook, setNativeLook] = useState(false);
  useEffect(() => {
    const changed = () => {
      const locked = document.pointerLockElement === canvas.current;
      setNativeLook(locked);
      if (!locked && navigation.current?.native) navigation.current = null;
    };
    document.addEventListener("pointerlockchange", changed);
    return () => document.removeEventListener("pointerlockchange", changed);
  }, []);

  const box = useRef<{
    start: [number, number];
    end: [number, number];
    mode: "replace" | "add" | "toggle";
  } | null>(null);
  const [boxRect, setBoxRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const hovered = state.sceneHover;
  const editing = state.workspaceMode === "plan";
  const hoverTarget =
    hovered?.handle != null
      ? hovered.id
      : hovered?.actor
        ? state.selected === hovered.actor ||
          state.selectedActors.includes(hovered.actor)
          ? `actor-gizmo:${hovered.actor}`
          : null
        : (hovered?.id ?? null);
  const hoverEdit = hovered?.id
    ? controller.displayMarks().find((a) => a.id === hovered.id)
    : undefined;
  const hoverEditable =
    (editing || !!hoverTarget?.startsWith("actor-gizmo:")) &&
    !state.compareRecorded &&
    !state.drawing &&
    !hovered?.locked &&
    !!hoverTarget &&
    !!hovered?.point &&
    (hovered.handle !== null ||
      (state.tool === "explore" &&
        ((!!hoverEdit?.id &&
          state.selectedMarks.includes(hoverEdit.id) &&
          !hoverEdit.actor) ||
          (!!hovered.actor &&
            (state.selected === hovered.actor ||
              state.selectedActors.includes(hovered.actor))))));
  const hoverKind = hoverTarget
    ? controller.handleKind(hoverTarget, hovered?.handle ?? null)
    : "move";
  const direction =
    hovered?.pixel && hovered.anchorPixel
      ? [
          hovered.pixel[0] - hovered.anchorPixel[0],
          hovered.pixel[1] - hovered.anchorPixel[1],
        ]
      : [1, 1];
  const activeCursor = handleCursor(hoverKind, direction[0], direction[1]);
  const cursor =
    navigation.current || draggingMark
      ? "grabbing"
      : hoverEditable && !selectionModifier
        ? activeCursor
        : editing &&
            !selectionModifier &&
            !["explore", "move"].includes(state.tool)
          ? "crosshair"
          : hovered?.id || hovered?.actor
            ? "pointer"
            : "default";
  const hint = !editing
    ? ""
    : hovered?.id && state.tool === "explore"
      ? hovered.locked
        ? "Locked mark · Click to inspect"
        : hovered.handle !== null
          ? "Drag point"
          : "Click to select · Use handles to transform"
      : state.tool === "explore"
        ? state.cameraMode === "orbit"
          ? "Right-drag to orbit · Drag empty space to select"
          : "WASD to move · Right-drag to look · Drag empty space to select"
        : state.tool === "marker" && hovered?.actor
          ? "Click to attach marker to actor"
          : !hovered?.point
            ? "Aim at loaded terrain"
            : state.tool === "drawing"
              ? "Drag to draw · Esc to cancel"
              : state.tool === "marker" || state.tool === "label"
                ? state.tool === "marker"
                  ? "Click to place · Shift-click to select"
                  : "Drag to place · Click selects"
                : ["circle", "cone", "arrow"].includes(state.tool)
                  ? "Drag to size and aim · Type yards · Release to place"
                  : "Click waypoints · Finish or Enter to end";
  useEffect(() => {
    const reset = (event: KeyboardEvent | Event) => {
      if (event.type === "keydown" && (event as KeyboardEvent).key !== "Escape")
        return;
      navigation.current = null;
      pendingPress.current = null;
      box.current = null;
      shape.current = false;
      stroke.current = false;
      dragging.current = false;
      setBoxRect(null);
      setDraggingMark(false);
      suppressClick.current = true;
      if (event.type === "blur") controller.cancelDrawing();
    };
    window.addEventListener("keydown", reset);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", reset);
      window.removeEventListener("blur", reset);
    };
  }, [controller]);
  useEffect(() => {
    controller.setMapView(map);
    return () => controller.setMapView(false);
  }, [map, controller]);
  return (
    <div className="viewport-shell">
      <div className="scene-chrome">
        {editing && <SceneToolbar state={state} controller={controller} />}
        <div className="viewport-modes" role="group" aria-label="Scene view">
          <select
            aria-label="Camera mode"
            title="Free camera: right-drag to look; WASD to move"
            value={controller.cameraPresentation(map).value}
            onChange={(e) => {
              const mode = e.target.value;
              if (mode === "orbit") controller.setCameraMode("orbit");
              else {
                controller.setCameraMode("free");
                controller.setOption("lockCamera", mode === "player");
                controller.setOption("followRaid", mode !== "free");
              }
            }}
          >
            <option value="free">Free camera</option>
            {state.replay && <option value="raid">Follow raid</option>}
            {!map && state.replay && controller.orbitCandidate() && (
              <option value="player">
                Follow {controller.orbitCandidate()?.name ?? "selected player"}
              </option>
            )}
            {!map && controller.orbitCandidate() && (
              <option value="orbit">
                Orbit {controller.orbitCandidate()?.name}
              </option>
            )}
          </select>
          <button
            onClick={() => controller.frameSelection()}
            title="Frame selection (F)"
          >
            Frame
          </button>
          {!map &&
            ((state.replay && state.options.followRaid) ||
              state.cameraMode === "orbit") && (
              <select
                aria-label="Maximum camera distance"
                title="Maximum camera distance"
                value={state.cameraMaxDistance}
                onChange={(e) =>
                  controller.setCameraDistance(Number(e.target.value))
                }
              >
                {[20, 30, 40, 50, 60].map((v) => (
                  <option key={v} value={v}>
                    {v} yd max
                  </option>
                ))}
              </select>
            )}
          <button aria-pressed={!map} onClick={() => setMap(false)}>
            3D
          </button>
          <button
            aria-pressed={map}
            onClick={() => {
              controller.setNavigationTool("select");
              setMap(true);
            }}
          >
            Map
          </button>
        </div>
      </div>
      <div className="viewport" data-input-context="scene">
        <canvas
          id="benilla"
          ref={canvas}
          tabIndex={0}
          aria-label={raidByMap(state.plan.mapId)?.name ?? "Raid viewport"}
          onFocus={() => controller.setSceneFocused(true)}
          onBlur={() => controller.setSceneFocused(false)}
          onKeyUpCapture={(e) =>
            setSelectionModifier(e.shiftKey || e.ctrlKey || e.metaKey)
          }
          onKeyDownCapture={(e) => {
            setSelectionModifier(e.shiftKey || e.ctrlKey || e.metaKey);
            if (e.ctrlKey || e.metaKey) controller.setShortcutCapture(true);
          }}

          onKeyDown={(e) => {
            if (
              ["KeyW", "KeyA", "KeyS", "KeyD", "KeyC", "Space"].includes(
                e.code,
              ) &&
              state.options.followRaid &&
              controller.freeCameraInput()
            )
              controller.setOption("followRaid", false);
          }}
          onWheel={(e) => {
            e.preventDefault();
            controller.setOption("followRaid", false);
            controller.zoomCamera(
              Math.max(-50, Math.min(50, -e.deltaY * 0.035)),
            );
          }}
          onContextMenu={(e) => e.preventDefault()}
          className={!nativeLook ? "editor-canvas" : ""}
          data-cursor={cursor}
          onPointerDown={(e) => {
            e.currentTarget.focus({ preventScroll: true });
            controller.setSceneFocused(true);
            if (hovered?.nativeUI) return;
            const r = e.currentTarget.getBoundingClientRect(),
              p: [number, number] = [e.clientX - r.left, e.clientY - r.top];
            const handle = hoverEditable;
            const gesture = sceneGesture(
              e.button,
              e.shiftKey || e.ctrlKey || e.metaKey,
              state.tool,
              handle,
            );
            if (gesture === "native") return;
            suppressClick.current = true;
            if (gesture === "camera" || gesture === "pan") {
              navigation.current = {
                x: e.clientX,
                y: e.clientY,
                pan: gesture === "pan",
                native: usesNativeMouseLook(
                  gesture,
                  state.cameraMode,
                  state.browserAssets,
                ),
              };
              controller.setOption("followRaid", false);
              if (!navigation.current.native)
                e.currentTarget.setPointerCapture(e.pointerId);
              return;
            }
            if (gesture === "transform" || gesture === "draw") {
              pendingPress.current = {
                x: e.clientX,
                y: e.clientY,
                local: p,
                gesture,
                actor:
                  controller.selectedActorForDrawing() ??
                  hovered?.actor ??
                  null,
                id: hoverTarget,
                handle: hovered?.handle ?? null,
                point: hovered?.point ?? null,
                moved: false,
              };
              e.currentTarget.setPointerCapture(e.pointerId);
              return;
            }
            if (state.drawing) controller.finishDrawing();
            box.current = { start: p, end: p, mode: selectionMode(e) };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            setSelectionModifier(e.shiftKey || e.ctrlKey || e.metaKey);
            const now = performance.now(),
              r = e.currentTarget.getBoundingClientRect();
            const nav = navigation.current;
            if (nav) {
              if (nav.native) return;
              controller.navigate(
                nav.pan,
                e.clientX - nav.x,
                e.clientY - nav.y,
              );
              nav.x = e.clientX;
              nav.y = e.clientY;
              return;
            }
            const press = pendingPress.current;
            if (press) {
              if (
                press.gesture === "draw" &&
                ["route", "polygon"].includes(state.tool)
              )
                return;
              if (!startsDrag([press.x, press.y], [e.clientX, e.clientY]))
                return;
              press.moved = true;
              dragStart.current = [press.x, press.y];
              if (
                press.gesture === "draw" &&
                ["marker", "label"].includes(state.tool)
              )
                return;
              pendingPress.current = null;
              if (press.gesture === "transform") {
                if (!press.id || !press.point) return;
                const axis =
                  state.transform === "move"
                    ? press.handle === 1
                      ? 0
                      : press.handle === 2
                        ? 1
                        : undefined
                    : undefined;
                const begun = press.id.startsWith("actor-gizmo:")
                  ? controller.beginActorDrag(
                      press.id.slice(12),
                      press.point,
                      false,
                      axis,
                    )
                  : controller.beginMarkDrag(
                      press.id,
                      press.handle,
                      press.point,
                    );
                if (!begun) return;
                dragging.current = true;
                setDraggingMark(true);
                controller.pick(
                  e.clientX - r.left,
                  e.clientY - r.top,
                  e.shiftKey,
                );
                return;
              }
              shape.current = ["circle", "cone", "arrow"].includes(state.tool);
              stroke.current = !shape.current;
              if (!press.actor || !controller.startActorDrawing(press.actor))
                controller.pick(...press.local, e.shiftKey);
              controller.pick(
                e.clientX - r.left,
                e.clientY - r.top,
                e.shiftKey,
                shape.current,
              );
              return;
            }
            if (
              state.drawing &&
              !box.current &&
              !e.shiftKey &&
              !e.ctrlKey &&
              !e.metaKey &&
              !shape.current &&
              !stroke.current &&
              !dragging.current &&
              ["circle", "cone", "arrow", "route", "polygon"].includes(
                state.tool,
              ) &&
              now - lastPick.current > 25
            ) {
              lastPick.current = now;
              controller.pick(
                e.clientX - r.left,
                e.clientY - r.top,
                e.shiftKey,
                true,
              );
            }

            if (box.current) {
              const b = box.current;
              b.end = [e.clientX - r.left, e.clientY - r.top];
              setBoxRect({
                left: Math.min(b.start[0], b.end[0]),
                top: Math.min(b.start[1], b.end[1]),
                width: Math.abs(b.end[0] - b.start[0]),
                height: Math.abs(b.end[1] - b.start[1]),
              });
              return;
            }
            if (shape.current) {
              if (
                now - lastPick.current > 25 &&
                Math.hypot(
                  e.clientX - dragStart.current[0],
                  e.clientY - dragStart.current[1],
                ) > 3
              ) {
                lastPick.current = now;
                controller.pick(
                  e.clientX - r.left,
                  e.clientY - r.top,
                  e.shiftKey,
                  true,
                );
              }
              return;
            }
            if (now - lastHover.current >= 50 && !dragging.current) {
              lastHover.current = now;
              controller.hoverScene(e.clientX - r.left, e.clientY - r.top);
            }
            if (
              (!stroke.current && !dragging.current) ||
              now - lastPick.current < 40
            )
              return;
            if (
              dragging.current &&
              Math.hypot(
                e.clientX - dragStart.current[0],
                e.clientY - dragStart.current[1],
              ) < 3
            )
              return;
            lastPick.current = now;
            controller.pick(e.clientX - r.left, e.clientY - r.top, e.shiftKey);
          }}
          onPointerUp={(e) => {
            if (navigation.current) {
              navigation.current = null;
              if (e.currentTarget.hasPointerCapture(e.pointerId))
                e.currentTarget.releasePointerCapture(e.pointerId);
              return;
            }
            if (e.button === 0 && pendingPress.current) {
              const press = pendingPress.current;
              pendingPress.current = null;
              const r = e.currentTarget.getBoundingClientRect();
              if (
                press.gesture === "draw" &&
                ["route", "polygon"].includes(state.tool)
              ) {
                if (
                  state.drawing ||
                  !press.actor ||
                  !controller.startActorDrawing(press.actor)
                )
                  controller.pick(e.clientX - r.left, e.clientY - r.top);
                if (e.currentTarget.hasPointerCapture(e.pointerId))
                  e.currentTarget.releasePointerCapture(e.pointerId);
                return;
              }
              const moved =
                press.moved ||
                startsDrag([press.x, press.y], [e.clientX, e.clientY]);
              if (
                press.gesture === "draw" &&
                drawsOnRelease(state.tool, moved)
              ) {
                const drop = ["marker", "label"].includes(state.tool);
                if (state.tool === "marker") {
                  controller.placeSceneMarkerAt(
                    e.clientX - r.left,
                    e.clientY - r.top,
                  );
                  if (e.currentTarget.hasPointerCapture(e.pointerId))
                    e.currentTarget.releasePointerCapture(e.pointerId);
                  return;
                }
                if (!press.actor || !controller.startActorDrawing(press.actor))
                  controller.pick(
                    ...((drop
                      ? [e.clientX - r.left, e.clientY - r.top]
                      : press.local) as [number, number]),
                  );
                if (!drop)
                  controller.pick(e.clientX - r.left, e.clientY - r.top);
                controller.finishDrawing();
              } else if (press.gesture === "transform" && press.id) {
                press.id.startsWith("actor-gizmo:")
                  ? controller.selectActor(press.id.slice(12))
                  : controller.selectMark(press.id);
              } else
                controller.selectSceneAt(
                  e.clientX - r.left,
                  e.clientY - r.top,
                  e.shiftKey || e.ctrlKey || e.metaKey,
                );
              if (e.currentTarget.hasPointerCapture(e.pointerId))
                e.currentTarget.releasePointerCapture(e.pointerId);
              return;
            }
            if (e.button === 0 && shape.current) {
              shape.current = false;
              const r = e.currentTarget.getBoundingClientRect();
              if (
                Math.hypot(
                  e.clientX - dragStart.current[0],
                  e.clientY - dragStart.current[1],
                ) > 3
              ) {
                controller.pick(
                  e.clientX - r.left,
                  e.clientY - r.top,
                  e.shiftKey,
                );
                controller.finishDrawing();
              }
              if (e.currentTarget.hasPointerCapture(e.pointerId))
                e.currentTarget.releasePointerCapture(e.pointerId);
              return;
            }
            if (e.button === 0 && box.current) {
              const b = box.current;
              box.current = null;
              setBoxRect(null);
              suppressClick.current = true;
              if (Math.hypot(b.end[0] - b.start[0], b.end[1] - b.start[1]) > 3)
                controller.boxSelect(...b.start, ...b.end, b.mode);
              else
                controller.selectSceneAt(
                  ...b.start,
                  e.shiftKey || e.ctrlKey || e.metaKey,
                );
              if (e.currentTarget.hasPointerCapture(e.pointerId))
                e.currentTarget.releasePointerCapture(e.pointerId);
              return;
            }
            if (e.button !== 0 || (!stroke.current && !dragging.current))
              return;
            const moved =
              Math.hypot(
                e.clientX - dragStart.current[0],
                e.clientY - dragStart.current[1],
              ) >= 3;
            const r = e.currentTarget.getBoundingClientRect();
            if (stroke.current || moved)
              controller.pick(
                e.clientX - r.left,
                e.clientY - r.top,
                e.shiftKey,
              );
            stroke.current = false;
            dragging.current = false;
            setDraggingMark(false);
            if (e.currentTarget.hasPointerCapture(e.pointerId))
              e.currentTarget.releasePointerCapture(e.pointerId);
            controller.finishDrawing();
          }}
          onPointerLeave={() => {
            setSelectionModifier(false);
            if (!dragging.current && !stroke.current)
              controller.clearSceneHover();
          }}
          onDoubleClick={() => {
            if (state.tool === "route" || state.tool === "polygon")
              controller.finishDrawing();
          }}
          onLostPointerCapture={() => {
            if (
              !pendingPress.current &&
              !box.current &&
              !shape.current &&
              !stroke.current &&
              !dragging.current
            )
              return;
            pendingPress.current = null;
            box.current = null;
            shape.current = false;
            stroke.current = false;
            dragging.current = false;
            setBoxRect(null);
            setDraggingMark(false);
            controller.cancelDrawing();
            controller.clearSceneHover();
          }}
          onPointerCancel={() => {
            navigation.current = null;
            pendingPress.current = null;
            shape.current = false;
            box.current = null;
            setBoxRect(null);
            stroke.current = false;
            dragging.current = false;
            setDraggingMark(false);
            suppressClick.current = true;
            controller.cancelDrawing();
            controller.clearSceneHover();
          }}
          style={
            {
              visibility: map ? "hidden" : "visible",
              "--rotate-cursor": rotateCursor,
            } as React.CSSProperties
          }
        />
        {!map && state.options.raidFrames && (
          <RaidFrameResize state={state} controller={controller} />
        )}
        {hoverEditable &&
          !selectionModifier &&
          hovered?.pixel &&
          !navigation.current &&
          !draggingMark && (
            <div
              className="scene-grip-hint"
              style={{
                left: hovered.pixel[0] + 16,
                top: hovered.pixel[1] + 16,
              }}
            >
              {handleLabel(hoverKind)} · drag
            </div>
          )}
        {boxRect && <div className="selection-box" style={boxRect} />}
        {map && <MapView state={state} controller={controller} />}
        {editing && (
          <div className="scene-edit-hint" aria-live="polite">
            {state.drawing
              ? (() => {
                  const mark = controller
                    .displayMarks()
                    .find((a) => a.id === state.selectedMark);
                  return (
                    <>
                      {mark && ["circle", "cone"].includes(mark.type)
                        ? `${mark.size.toFixed(1)} yd radius · `
                        : ""}
                      {state.transformActive ? `${state.transform} · ` : ""}
                      {state.snapBypass
                        ? "Snap bypassed"
                        : state.snap.position
                          ? `Snap ${state.snap.yards} yd · ${state.snap.mode}`
                          : ""}{" "}
                      · Enter to confirm · Esc to cancel
                    </>
                  );
                })()
              : map
                ? state.tool === "marker"
                  ? "Right-drag to pan · Scroll to zoom · Click to place · Shift-click to select"
                  : "Right-drag to pan · Scroll to zoom · Click to select"
                : hint}
          </div>
        )}
        {state.browserAssets &&
        (state.clientStatus !== "ready" ||
          (state.clientNeedsFiles && !state.clientPromptHidden)) ? (
          <BrowserClient state={state} controller={controller} />
        ) : !map && !state.sceneReady ? (
          <div className="scene-loading" role="status">
            <GameIcon name="Spell_Fire_Immolation" />
            <span>
              {state.error ??
                `Loading ${raidByMap(state.plan.mapId)?.name ?? "raid"}…`}
            </span>
            {state.error && (
              <button onClick={() => location.reload()}>Reload</button>
            )}
          </div>
        ) : null}
        {!map &&
          state.replay &&
          state.sceneReady &&
          !(state.workspaceMode === "plan" && controller.displaySnapshot()) &&
          (state.playPreparing ||
            state.movementPreparing ||
            state.movementConflicted) && (
            <div className="scene-movement-status" role="status">
              {state.playPreparing || state.movementPreparing
                ? "Preparing movement…"
                : "Some movement could not be reconstructed."}
            </div>
          )}
        {focus && state.workspaceMode === "analyse" && (
          <Focus
            state={state}
            actor={state.replay?.actors.find((a) => a.key === state.selected)}
            controller={controller}
            close={closeFocus}
            inspect={() => setInspectionOpen(true)}
          />
        )}
        {inspectionOpen &&
          focusedActor?.type === "Player" &&
          state.workspaceMode === "analyse" && (
            <Inspection
              state={state}
              actor={focusedActor}
              controller={controller}
              close={() => {
                setInspectionOpen(false);
                requestAnimationFrame(() =>
                  document
                    .querySelector<HTMLButtonElement>(".focus-inspect")
                    ?.focus(),
                );
              }}
            />
          )}
      </div>
    </div>
  );
}
function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div role="dialog" aria-modal="true" aria-label={title}>
        <div className="panel-heading">
          <strong>{title}</strong>
          <button aria-label={`Close ${title}`} onClick={close}>
            ×
          </button>
        </div>
        <div className="modal-content">{children}</div>
      </div>
    </dialog>
  );
}
