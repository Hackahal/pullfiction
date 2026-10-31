import { CommunityLinks } from "./CommunityLinks";
import { GitHubLink } from "./GitHubLink";
import { useEffect, useRef, useState } from "react";
import type { EditorController } from "./controller";
import type { Snapshot, GameVersion, Fight } from "./types";
import {
  raidByMap,
  raidsForVersion,
  raidForZone,
  reportRaids,
  time,
} from "./domain";
import { GAME_VERSIONS } from "../../planner/game-versions.mjs";
import { BrowserClient } from "./BrowserClient";
import { EditorIcon } from "./EditorIcon";
import { GuildBrowser } from "./GuildBrowser";

type Tab = "projects" | "logs" | "runs";
export function Library({
  state,
  controller,
  initialTab,
  close,
}: {
  state: Snapshot;
  controller: EditorController;
  initialTab: Tab;
  close: () => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [filter, setFilter] = useState("");
  const [trash, setTrash] = useState(false);
  const [error, setError] = useState("");
  const [fightFilter, setFightFilter] = useState("");
  const [kind, setKind] = useState("all");
  const [selection, setSelection] = useState<{
    fight: string;
    map?: number;
  } | null>(null);
  const [action, setAction] = useState<"analyse" | "plan">("analyse");
  const [newPlan, setNewPlan] = useState(false);
  const [planName, setPlanName] = useState("");
  const [map, setMap] = useState(state.plan.mapId);
  const [version, setVersion] = useState<GameVersion>(state.gameVersion);
  const importer = useRef<HTMLInputElement>(null);
  const replayImporter = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const activeProject = state.projects.find((p) => p.id === state.projectId);
  useEffect(() => {
    try {
      sessionStorage.setItem("pullfiction.library.tab", tab);
    } catch {}
  }, [tab]);
  useEffect(() => {
    const previousFocus = document.activeElement;
    const background = Array.from(root.current?.parentElement?.children ?? [])
      .filter(
        (element): element is HTMLElement =>
          element instanceof HTMLElement && element !== root.current,
      )
      .map((element) => ({ element, inert: element.inert }));
    for (const { element } of background) element.inert = true;
    root.current?.focus();
    controller.setSceneFocused(false);
    controller.setTyping(true);
    void controller.initializeLibrary();
    return () => {
      for (const { element, inert } of background) element.inert = inert;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus();
      controller.setTyping(false);
    };
  }, [controller]);
  useEffect(() => {
    setSelection(null);
    setError("");
  }, [state.gameVersion, state.wclConnected]);
  useEffect(() => {
    setSelection(null);
    setFightFilter("");
  }, [state.report]);
  async function preview(code: string) {
    setError("");
    setSelection(null);
    await controller.loadReport(code);
  }
  async function openSelection() {
    if (!selection) return;
    const before = state.replay;
    await controller.loadReplay(selection.fight, selection.map, action);
    if (controller.getSnapshot().replay !== before) close();
  }
  const projects = state.projects.filter(
    (p) =>
      Boolean(p.deletedAt) === trash &&
      (trash || p.kind === (tab === "runs" ? "replay" : "plan")) &&
      `${p.plan.name} ${raidByMap(p.plan.mapId, p.plan.gameVersion)?.name ?? ""} ${p.source?.title ?? ""}`
        .toLowerCase()
        .includes(filter.toLowerCase()),
  );
  const fights =
    state.report?.fights.filter(
      (f) =>
        !f.completeRaid &&
        Boolean(raidForZone(f.gameZone, state.gameVersion)) &&
        f.name.toLowerCase().includes(fightFilter.toLowerCase()) &&
        (kind === "all" ||
          (kind === "boss" && f.encounterID) ||
          (kind === "trash" && !f.encounterID) ||
          (kind === "kills" && f.encounterID && f.kill)),
    ) ?? [];
  const raids = state.report ? reportRaids(state.report) : [];
  const disabled = state.busy;
  return (
    <div
      className="library-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Library"
      ref={root}
      tabIndex={-1}
      onFocusCapture={() => controller.setTyping(true)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !state.busy) {
          e.stopPropagation();
          close();
        }
      }}
    >
      <header className="library-header">
        <div className="library-identity">
          <div className="library-brand">
            Pull <span>Fiction</span>
          </div>
          <GitHubLink />
        </div>
        <nav aria-label="Library sections">
          <button
            aria-pressed={tab === "projects"}
            onClick={() => {
              setTab("projects");
              setError("");
            }}
          >
            <EditorIcon name="plan" />
            My plans
          </button>
          <button
            aria-pressed={tab === "runs"}
            onClick={() => {
              setTab("runs");
              setError("");
            }}
          >
            <EditorIcon name="timeline" />
            Recent runs
          </button>
          <button
            aria-pressed={tab === "logs"}
            onClick={() => {
              setTab("logs");
              setError("");
            }}
          >
            <EditorIcon name="logs" />
            Find logs
          </button>
        </nav>
        <CommunityLinks />
        <button
          className="library-return"
          disabled={state.busy}
          onClick={close}
        >
          <EditorIcon name="arrow" />
          Return to editor
        </button>
        {state.clientNeedsFiles && state.clientPromptHidden && (
          <button onClick={() => controller.showClientSource()}>
            Load game assets
          </button>
        )}
        {state.busy && (
          <button onClick={() => controller.cancelImport()}>
            Cancel loading
          </button>
        )}
      </header>
      {state.notice && (
        <div className="library-notice" role="status">
          {state.notice}
        </div>
      )}
      {(error || state.libraryError) && (
        <div className="library-error" role="alert">
          <span>{error || state.libraryError}</span>
          {state.saveStatus === "error" && (
            <button onClick={() => void controller.saveProject(true)}>
              Retry save
            </button>
          )}
          {state.saveStatus === "error" && state.projectId && (
            <button
              onClick={() => void controller.exportProject(state.projectId!)}
            >
              Export current edits
            </button>
          )}
        </div>
      )}
      {tab !== "logs" ? (
        <section className="library-projects">
          <div className="library-toolbar">
            <h1>{tab === "runs" ? "Recent runs" : "My plans"}</h1>
            <label className="library-search">
              <EditorIcon name="search" />
              <input
                aria-label="Search saved plans"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Search plans, runs or raids"
              />
            </label>
            <button onClick={() => setTrash(!trash)} aria-pressed={trash}>
              <EditorIcon name="trash" />
              {trash ? "Back to plans" : "Trash"}
            </button>
            <button onClick={() => importer.current?.click()}>
              <EditorIcon name="upload" />
              Import project
            </button>
            <button
              className="gold-button"
              onClick={() => setNewPlan(!newPlan)}
            >
              <EditorIcon name="plus" />
              New plan
            </button>
          </div>
          {newPlan && (
            <form
              className="library-new-plan"
              onSubmit={(e) => {
                e.preventDefault();
                void controller
                  .createProject(map, version, planName)
                  .then((ok) => {
                    if (ok) close();
                  });
              }}
            >
              <label>
                Name
                <input
                  aria-label="New plan name"
                  placeholder="Untitled plan"
                  maxLength={100}
                  value={planName}
                  onChange={(e) => setPlanName(e.target.value)}
                />
              </label>
              <label>
                Game
                <select
                  value={version}
                  onChange={(e) => {
                    setVersion(e.target.value as GameVersion);
                    setMap(409);
                  }}
                >
                  {GAME_VERSIONS.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Instance
                <select
                  value={map}
                  onChange={(e) => setMap(Number(e.target.value))}
                >
                  {raidsForVersion(version).map((r) => (
                    <option key={r.map} value={r.map}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
              <button className="gold-button" disabled={state.busy}>
                Create plan
              </button>
              <button type="button" onClick={() => setNewPlan(false)}>
                Cancel
              </button>
            </form>
          )}
          {!state.libraryReady ? (
            <div className="library-empty">Opening local projects…</div>
          ) : projects.length ? (
            <div
              className="project-table"
              role="table"
              aria-label="Local plans"
            >
              <div className="project-row project-columns" role="row">
                <span>{tab === "runs" ? "Run" : "Plan"}</span>
                <span>Source</span>
                <span>Updated</span>
                <span>Actions</span>
              </div>
              {projects.map((p) => (
                <div
                  key={p.id}
                  data-project-id={p.id}
                  className={`project-row ${p.id === state.projectId ? "current" : ""}`}
                  role="row"
                >
                  <button
                    className="project-title"
                    disabled={disabled || trash}
                    onClick={() =>
                      void controller.openProject(p.id).then((ok) => {
                        if (ok) close();
                      })
                    }
                  >
                    <EditorIcon name="plan" />
                    <span>
                      <strong>{p.plan.name}</strong>
                      <small>
                        {raidByMap(p.plan.mapId, p.plan.gameVersion)?.name} ·{" "}
                        {p.plan.gameVersion === "sod"
                          ? "Season of Discovery"
                          : "Classic Era"}{" "}
                        ·{" "}
                        {p.plan.steps.reduce(
                          (n, s) =>
                            n +
                            s.annotations.length +
                            (s.snapshot?.actors.length ?? 0),
                          0,
                        )}{" "}
                        edits
                      </small>
                    </span>
                  </button>
                  <span className="project-source">
                    {p.source ? (
                      <>
                        <span>{p.source.title}</span>
                        <small>
                          {p.source.fight === "run"
                            ? "Full run"
                            : `Encounter ${p.source.fight}`}
                          {state.cachedSources.includes(p.source.cacheKey)
                            ? p.source.buffered
                              ? " · Streamed source"
                              : " · Cached"
                            : " · Source not cached"}
                        </small>
                      </>
                    ) : (
                      "No log"
                    )}
                  </span>
                  <time dateTime={new Date(p.updatedAt).toISOString()}>
                    {new Date(p.updatedAt).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </time>
                  <div className="project-actions">
                    {trash ? (
                      <button
                        onClick={() => void controller.trashProject(p.id, true)}
                      >
                        <EditorIcon name="undo" />
                        Restore
                      </button>
                    ) : (
                      <>
                        <button
                          aria-label={`Duplicate ${p.plan.name}`}
                          title="Duplicate plan"
                          disabled={disabled}
                          onClick={() => void controller.duplicateProject(p.id)}
                        >
                          <EditorIcon name="copy" />
                        </button>
                        <button
                          aria-label={`Export ${p.plan.name}`}
                          title="Export project with cached log"
                          disabled={disabled}
                          onClick={() => void controller.exportProject(p.id)}
                        >
                          <EditorIcon name="download" />
                        </button>
                        <button
                          aria-label={`Move ${p.plan.name} to trash`}
                          title="Move to trash"
                          disabled={disabled}
                          onClick={() => void controller.trashProject(p.id)}
                        >
                          <EditorIcon name="trash" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="library-empty">
              <EditorIcon name="plan" />
              <h2>
                {trash
                  ? "Trash is empty"
                  : filter
                    ? "No matching plans"
                    : "Your next run starts here"}
              </h2>
              <p>
                {trash
                  ? "Deleted plans can be restored here."
                  : "Find a log to plan from, or start with an empty instance."}
              </p>
              {!trash && (
                <button className="gold-button" onClick={() => setTab("logs")}>
                  Find a log
                </button>
              )}
            </div>
          )}
          <footer className="library-local">
            <EditorIcon name="device" />
            Saved in this browser on this device. Export a project to keep a
            portable backup.
          </footer>
        </section>
      ) : (
        <section className="library-logs">
          <aside className="log-browser">
            <div className="library-toolbar">
              <h1>Find logs</h1>
              <select
                aria-label="Log game version"
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
            </div>
            <div className="log-connection">
              <span className={state.wclConnected ? "connected" : ""}>
                {state.wclConnected
                  ? "Warcraft Logs connected"
                  : "Connect to browse reports"}
              </span>
              <button
                disabled={state.browserAssets && !state.wclConfigured}
                onClick={() =>
                  state.wclConnected
                    ? controller.disconnectWcl()
                    : void controller.connectWcl()
                }
              >
                {state.wclConnected ? "Disconnect" : "Connect Warcraft Logs"}
              </button>
            </div>
            {activeProject?.source && state.sourceStatus === "missing" && (
              <div className="source-reload">
                <span>Source for {activeProject.plan.name}</span>
                <button
                  disabled={
                    !state.wclConnected ||
                    state.busy ||
                    (state.browserAssets && state.clientStatus !== "ready")
                  }
                  onClick={() =>
                    void controller
                      .reloadProjectSource(activeProject.id)
                      .then((ok) => {
                        if (ok) close();
                      })
                  }
                >
                  Reload source log
                </button>
              </div>
            )}
            <GuildBrowser
              key={state.gameVersion}
              state={state}
              controller={controller}
              preview={preview}
            />
            <button
              className="log-json"
              disabled={
                state.busy ||
                (state.browserAssets && state.clientStatus !== "ready")
              }
              onClick={() => replayImporter.current?.click()}
            >
              <EditorIcon name="upload" />
              Import replay JSON
            </button>
          </aside>
          <div className="report-preview">
            {state.report ? (
              <>
                <header>
                  <span className="eyebrow">
                    {state.gameVersion === "sod"
                      ? "Season of Discovery"
                      : "Classic Era"}
                  </span>
                  <h1>{state.report.title}</h1>
                  <p>
                    {state.report.fights.filter((f) => !f.completeRaid).length}{" "}
                    pulls · {state.reportCode}
                  </p>
                </header>
                <div className="preview-controls">
                  <input
                    aria-label="Search encounters"
                    placeholder="Find a boss or pull"
                    value={fightFilter}
                    onChange={(e) => setFightFilter(e.target.value)}
                  />
                  <select
                    aria-label="Encounter filter"
                    value={kind}
                    onChange={(e) => setKind(e.target.value)}
                  >
                    <option value="all">All pulls</option>
                    <option value="boss">Bosses</option>
                    <option value="kills">Kills</option>
                    <option value="trash">Trash</option>
                  </select>
                </div>
                <div
                  className="encounter-list"
                  aria-label="Choose what to open"
                >
                  {!fightFilter &&
                    raids.map((r) => (
                      <button
                        key={`run-${r.map}`}
                        className={`encounter-option full-run ${selection?.fight === "run" && selection.map === r.map ? "active" : ""}`}
                        aria-pressed={
                          selection?.fight === "run" && selection.map === r.map
                        }
                        onClick={() =>
                          setSelection({ fight: "run", map: r.map })
                        }
                      >
                        <EditorIcon name="route" />
                        <span>
                          <strong>Full {r.short} run</strong>
                          <small>{r.name}</small>
                        </span>
                        <span>
                          {time(
                            Math.max(
                              ...state
                                .report!.fights.filter(
                                  (f) =>
                                    raidForZone(f.gameZone, state.gameVersion)
                                      ?.map === r.map && !f.completeRaid,
                                )
                                .map((f) => f.endTime),
                            ) -
                              Math.min(
                                ...state
                                  .report!.fights.filter(
                                    (f) =>
                                      raidForZone(f.gameZone, state.gameVersion)
                                        ?.map === r.map && !f.completeRaid,
                                  )
                                  .map((f) => f.startTime),
                              ),
                          )}
                        </span>
                      </button>
                    ))}
                  {fights.map((f: Fight) => (
                    <button
                      key={f.id}
                      className={`encounter-option ${selection?.fight === String(f.id) ? "active" : ""}`}
                      aria-pressed={selection?.fight === String(f.id)}
                      onClick={() => setSelection({ fight: String(f.id) })}
                    >
                      <span
                        className={`encounter-status ${f.kill ? "kill" : f.encounterID ? "wipe" : "trash"}`}
                      >
                        {f.encounterID ? (
                          <EditorIcon name={f.kill ? "check" : "raid"} />
                        ) : (
                          <EditorIcon name="actors" />
                        )}
                      </span>
                      <span>
                        <strong>{f.name}</strong>
                        <small>
                          {time(f.startTime)} ·{" "}
                          {f.encounterID ? (f.kill ? "Kill" : "Wipe") : "Trash"}
                        </small>
                      </span>
                      <span>{time(f.endTime - f.startTime)}</span>
                    </button>
                  ))}
                  {!fights.length && (
                    <div className="library-empty">
                      No supported pulls match this filter.
                    </div>
                  )}
                </div>
                {state.browserAssets &&
                  state.clientStatus !== "ready" &&
                  !state.clientNeedsFiles && (
                    <BrowserClient state={state} controller={controller} />
                  )}
                <footer className="preview-open">
                  <div
                    className="open-mode"
                    role="group"
                    aria-label="Open log for"
                  >
                    <button
                      aria-pressed={action === "analyse"}
                      onClick={() => setAction("analyse")}
                    >
                      <EditorIcon name="chart" />
                      Analyse
                    </button>
                    <button
                      aria-pressed={action === "plan"}
                      onClick={() => setAction("plan")}
                    >
                      <EditorIcon name="drawing" />
                      Create plan
                    </button>
                  </div>
                  <button
                    className="gold-button"
                    disabled={
                      !selection ||
                      state.busy ||
                      (state.browserAssets && state.clientStatus !== "ready")
                    }
                    onClick={() => void openSelection()}
                  >
                    {state.busy
                      ? "Opening…"
                      : action === "plan"
                        ? "Create plan from log"
                        : "Open replay"}
                  </button>
                  {state.busy && (
                    <button onClick={() => controller.cancelImport()}>
                      Cancel
                    </button>
                  )}
                  <span role="status">{state.busy ? state.status : ""}</span>
                </footer>
              </>
            ) : (
              <>
                <div className="library-empty preview-empty">
                  <EditorIcon name="logs" />
                  <h2>Choose a run</h2>
                  <p>Preview its encounters before loading the replay.</p>
                </div>
                {state.browserAssets &&
                  state.clientStatus !== "ready" &&
                  !state.clientNeedsFiles && (
                    <BrowserClient state={state} controller={controller} />
                  )}
              </>
            )}
          </div>
        </section>
      )}
      {state.browserAssets &&
        state.clientNeedsFiles &&
        !state.clientPromptHidden && (
          <BrowserClient state={state} controller={controller} />
        )}
      <input
        hidden
        type="file"
        accept=".json,application/json"
        ref={importer}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.currentTarget.value = "";
          if (file)
            void controller
              .importProject(file)
              .then((id) => (id ? controller.openProject(id) : false))
              .then((ok) => {
                if (ok) close();
              });
        }}
      />
      <input
        hidden
        type="file"
        accept=".json,application/json"
        ref={replayImporter}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.currentTarget.value = "";
          const before = state.replay;
          if (file)
            void controller.importFile(file, "replay").then(() => {
              if (controller.getSnapshot().replay !== before) close();
            });
        }}
      />
    </div>
  );
}
