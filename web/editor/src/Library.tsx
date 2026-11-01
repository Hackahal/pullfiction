import { LandingPage } from "./LandingPage";
import { SourceIcon } from "./IdentityIcon";
import { useEffect, useRef, useState } from "react";
import { CommunityLinks } from "./CommunityLinks";
import { GitHubLink } from "./GitHubLink";
import { EditorIcon } from "./EditorIcon";
import { BrowserClient } from "./BrowserClient";
import type { EditorController } from "./controller";
import type { Snapshot, GameVersion, Fight } from "./types";
import type { LocalProject } from "./project-store";
import {
  raidByMap,
  raidsForVersion,
  raidForZone,
  reportRaids,
  time,
} from "./domain";
import { GAME_VERSIONS } from "../../planner/game-versions.mjs";
import { FindRuns } from "./FindRuns";
import { Rankings } from "./Rankings";
import { RaidArt } from "./RaidArt";
import { isSavedRun, viewedProjects, relativeDate } from "./library-model";
import {
  readFollowed,
  toggleFollowed,
  sourceKey,
  type FollowedSource,
} from "./followed-sources";

import type { LibraryTab } from "./library-navigation";
import { libraryNavigationUrl } from "./library-navigation";
export type { LibraryTab } from "./library-navigation";
export function Library({
  state,
  controller,
  initialTab,
  close,
}: {
  state: Snapshot;
  controller: EditorController;
  initialTab: LibraryTab;
  close: () => void;
}) {
  const [tab, setTab] = useState<LibraryTab>(initialTab),
    [filter, setFilter] = useState(""),
    [trash, setTrash] = useState(false),
    [error, setError] = useState("");
  const [fightFilter, setFightFilter] = useState(""),
    [kind, setKind] = useState("all"),
    [selection, setSelection] = useState<{
      fight: string;
      map?: number;
    } | null>(null),
    [action, setAction] = useState<"analyse" | "plan">("analyse");
  const [newPlan, setNewPlan] = useState(
      () =>
        initialTab === "projects" &&
        new URLSearchParams(globalThis.location?.search ?? "").get("create") ===
          "1",
    ),
    [planName, setPlanName] = useState(""),
    [map, setMap] = useState(() => {
      const requested = Number(
        new URLSearchParams(globalThis.location?.search ?? "").get("map"),
      );
      return initialTab === "projects" &&
        raidsForVersion(state.gameVersion).some(
          (raid) => raid.map === requested,
        )
        ? requested
        : state.plan.mapId;
    }),
    [version, setVersion] = useState<GameVersion>(state.gameVersion),
    [opening, setOpening] = useState(false),
    [assetAttempted, setAssetAttempted] = useState(false);
  const [renaming, setRenaming] = useState(""),
    [rename, setRename] = useState("");
  const [followed, setFollowed] = useState<FollowedSource[]>([]),
    [chosen, setChosen] = useState<FollowedSource | null>(null),
    [previewVisible, setPreviewVisible] = useState(false);
  const importer = useRef<HTMLInputElement>(null),
    replayImporter = useRef<HTMLInputElement>(null),
    root = useRef<HTMLDivElement>(null);
  const previewScroll = useRef(0);
  const previewIntent = useRef(0);
  const activeProject = state.projects.find((p) => p.id === state.projectId);
  const disabled = state.busy || opening;
  const allPlans = state.projects.filter(
    (p) => !p.deletedAt && p.kind === "plan",
  );
  const recent = viewedProjects(state.projects),
    saved = recent.filter(isSavedRun);
  const plans = state.projects
    .filter(
      (p) =>
        Boolean(p.deletedAt) === trash &&
        (trash || p.kind === "plan") &&
        `${p.plan.name} ${raidByMap(p.plan.mapId, p.plan.gameVersion)?.name ?? ""}`
          .toLowerCase()
          .includes(filter.toLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt,
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
  useEffect(() => {
    try {
      sessionStorage.setItem("pullfiction.library.tab", tab);
    } catch {}
  }, [tab]);
  useEffect(() => {
    try {
      if (new URLSearchParams(location.search).get("create") === "1")
        history.replaceState(
          history.state,
          "",
          libraryNavigationUrl(location.href, initialTab),
        );
    } catch {}
  }, []);
  useEffect(() => {
    const previous = document.activeElement,
      background = Array.from(root.current?.parentElement?.children ?? [])
        .filter(
          (e): e is HTMLElement =>
            e instanceof HTMLElement && e !== root.current,
        )
        .map((element) => ({ element, inert: element.inert }));
    background.forEach(({ element }) => (element.inert = true));
    root.current?.focus();
    controller.setSceneFocused(false);
    controller.setTyping(true);
    void controller.initializeLibrary();
    return () => {
      background.forEach(({ element, inert }) => (element.inert = inert));
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
      controller.setTyping(false);
    };
  }, [controller]);
  useEffect(() => {
    const read = () => {
      try {
        setFollowed(readFollowed(localStorage));
      } catch (e) {
        setError(`Could not read followed sources: ${String(e)}`);
      }
    };
    read();
    window.addEventListener("storage", read);
    return () => window.removeEventListener("storage", read);
  }, []);
  useEffect(() => {
    setSelection(null);
    setPreviewVisible(false);
    setChosen(null);
    setError("");
  }, [state.gameVersion, state.wclConnected]);
  useEffect(() => {
    setSelection(null);
    setFightFilter("");
  }, [state.report]);
  useEffect(() => {
    if (previewVisible)
      root.current
        ?.querySelector<HTMLElement>(".library-report-panel")
        ?.focus();
  }, [previewVisible]);
  function closePreview() {
    previewIntent.current++;
    setPreviewVisible(false);
    requestAnimationFrame(() => {
      const main = root.current?.querySelector<HTMLElement>(".library-main");
      if (main) main.scrollTop = previewScroll.current;
    });
  }
  useEffect(() => {
    const main = root.current?.querySelector<HTMLElement>(".library-main");
    if (main) main.scrollTop = 0;
  }, [tab]);
  function navigate(next: LibraryTab) {
    previewIntent.current++;
    try {
      history.replaceState(
        history.state,
        "",
        libraryNavigationUrl(location.href, next),
      );
    } catch {}
    setTab(next);
    setTrash(false);
    setFilter("");
    setPreviewVisible(false);
    setNewPlan(false);
    setError("");
  }
  function follow(source: FollowedSource) {
    try {
      setFollowed(toggleFollowed(localStorage, source));
    } catch (e) {
      setError(`Could not save followed source: ${String(e)}`);
    }
  }
  async function preview(code: string) {
    const intent = ++previewIntent.current;
    previewScroll.current =
      root.current?.querySelector<HTMLElement>(".library-main")?.scrollTop ?? 0;
    setError("");
    setSelection(null);
    setPreviewVisible(true);
    await controller.loadReport(code);
    if (previewIntent.current !== intent) return;
    const next = controller.getSnapshot();
    if (next.report) setPreviewVisible(true);
    else {
      setPreviewVisible(false);
      setError(
        next.notice || "Could not open this report. Try the link again.",
      );
    }
  }
  async function openSelection() {
    if (!selection) return;
    setAssetAttempted(true);
    setOpening(true);
    try {
      await controller.boot();
      if (
        state.browserAssets &&
        controller.getSnapshot().clientStatus !== "ready"
      ) {
        setError(
          controller.getSnapshot().error ??
            "Raid assets could not be prepared. Retry the download to continue.",
        );
        return;
      }
      const before = controller.getSnapshot().replay;
      await controller.loadReplay(selection.fight, selection.map, action);
      if (controller.getSnapshot().replay !== before) close();
      else
        setError(
          controller.getSnapshot().notice ||
            "Replay could not be opened. Try again.",
        );
    } catch (e) {
      setError(String(e));
    } finally {
      setOpening(false);
    }
  }
  async function open(p: LocalProject) {
    if (await controller.openProject(p.id)) close();
  }
  function runList(items: LocalProject[]) {
    return (
      <div className="run-table" aria-label="Runs">
        <div className="run-columns">
          <span>Raid / run</span>
          <span>Clear time</span>
          <span>Bosses</span>
          <span>Last viewed</span>
          <span />
        </div>
        {items.map((p) => {
          const r = p.source?.summary;
          return (
            <div className="run-row" key={p.id}>
              <button
                className="run-identity"
                disabled={disabled}
                onClick={() => void open(p)}
              >
                <RaidArt map={p.plan.mapId} version={p.plan.gameVersion} />
                <span>
                  <strong>
                    {raidByMap(p.plan.mapId, p.plan.gameVersion)?.name ??
                      "Raid"}
                  </strong>
                  <small>
                    {p.source?.title ?? p.plan.name} ·{" "}
                    {p.source?.fight === "run" ? "Full raid" : "Encounter"} ·{" "}
                    {p.plan.gameVersion === "sod" ? "SoD" : "Era"}
                  </small>
                </span>
              </button>
              <span
                className="run-duration"
                title="Recorded first pull to final boss kill, excluding leaderboard penalties"
              >
                {r?.clearTime != null ? time(r.clearTime) : "—"}
              </span>
              <span className={r?.clearTime != null ? "run-complete" : ""}>
                {r ? `${r.bossesKilled}/${r.bossCount ?? "?"}` : "—"}
              </span>
              <span
                className="run-viewed"
                title={
                  p.lastViewedAt
                    ? new Date(p.lastViewedAt).toLocaleString()
                    : undefined
                }
              >
                {relativeDate(p.lastViewedAt)}
              </span>
              <div className="run-controls">
                {" "}
                <button
                  className="run-save"
                  aria-label={`${isSavedRun(p) ? "Unsave" : "Save"} ${p.plan.name}`}
                  aria-pressed={isSavedRun(p)}
                  disabled={disabled}
                  onClick={() =>
                    void controller.updateProjectMetadata(p.id, {
                      savedRun: !isSavedRun(p),
                    })
                  }
                >
                  {isSavedRun(p) ? "★" : "☆"}
                </button>
                <details className="run-more">
                  <summary aria-label={`More actions for ${p.plan.name}`}>
                    ⋯
                  </summary>
                  <div>
                    <button
                      disabled={disabled}
                      onClick={() => void controller.exportProject(p.id)}
                    >
                      Export
                    </button>
                    <button
                      disabled={disabled}
                      onClick={() => void controller.duplicateProject(p.id)}
                    >
                      Duplicate
                    </button>
                    <button
                      disabled={disabled}
                      onClick={() => void controller.trashProject(p.id)}
                    >
                      Trash
                    </button>
                  </div>
                </details>
              </div>
            </div>
          );
        })}
        {!items.length && (
          <div className="library-empty">
            <h2>No runs here yet</h2>
            <p>
              Browse a guild, a player or the rankings to find your next
              reference run.
            </p>
            <button onClick={() => navigate("logs")}>Find runs</button>
          </div>
        )}
      </div>
    );
  }
  function planList(items: LocalProject[]) {
    return (
      <div className="plan-list">
        {items.map((p) => (
          <div className="plan-row" key={p.id} data-project-id={p.id}>
            <button
              className="plan-identity"
              disabled={disabled || trash}
              onClick={() => void open(p)}
            >
              <RaidArt map={p.plan.mapId} version={p.plan.gameVersion} />
              <span>
                <strong>{p.plan.name}</strong>
                <small>
                  {raidByMap(p.plan.mapId, p.plan.gameVersion)?.name} ·{" "}
                  {relativeDate(p.updatedAt)}
                  {p.pinned ? " · Pinned" : ""}
                </small>
                <small>{p.source?.title ?? "Empty raid plan"}</small>
              </span>
            </button>
            <div className="project-actions">
              {trash ? (
                <button
                  disabled={disabled}
                  onClick={() => void controller.trashProject(p.id, true)}
                >
                  Restore
                </button>
              ) : (
                <>
                  <button
                    disabled={disabled}
                    aria-pressed={!!p.pinned}
                    onClick={() =>
                      void controller.updateProjectMetadata(p.id, {
                        pinned: !p.pinned,
                      })
                    }
                  >
                    {p.pinned ? "Unpin" : "Pin"}
                  </button>
                  <button
                    disabled={disabled}
                    onClick={() => {
                      setRenaming(p.id);
                      setRename(p.plan.name);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    disabled={disabled}
                    onClick={() => void controller.duplicateProject(p.id)}
                  >
                    Duplicate
                  </button>
                  <button
                    disabled={disabled}
                    onClick={() => void controller.exportProject(p.id)}
                  >
                    Export
                  </button>
                  <button
                    disabled={disabled}
                    onClick={() => void controller.trashProject(p.id)}
                  >
                    Trash
                  </button>
                </>
              )}
            </div>
            {renaming === p.id && (
              <form
                className="plan-rename"
                onSubmit={(e) => {
                  e.preventDefault();
                  void controller.updateProjectMetadata(p.id, { name: rename });
                  setRenaming("");
                }}
              >
                <input
                  aria-label="Plan name"
                  value={rename}
                  maxLength={100}
                  required
                  onChange={(e) => setRename(e.target.value)}
                />
                <button disabled={disabled}>Save name</button>
                <button type="button" onClick={() => setRenaming("")}>
                  Cancel
                </button>
              </form>
            )}
          </div>
        ))}
      </div>
    );
  }
  const createForm = newPlan && (
    <form
      className="library-new-plan"
      onSubmit={(e) => {
        e.preventDefault();
        void controller.createProject(map, version, planName).then((ok) => {
          if (ok) close();
        });
      }}
    >
      <label>
        Name
        <input
          aria-label="New plan name"
          placeholder="Next raid night"
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
        Raid
        <select value={map} onChange={(e) => setMap(Number(e.target.value))}>
          {raidsForVersion(version).map((r) => (
            <option key={r.map} value={r.map}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <button className="gold-button" disabled={disabled}>
        Create plan
      </button>
      <button type="button" onClick={() => setNewPlan(false)}>
        Cancel
      </button>
    </form>
  );
  return (
    <div
      className={`library-backdrop library-front-door ${tab === "landing" ? "library-landing" : ""}`}
      role={tab === "landing" ? undefined : "dialog"}
      aria-modal={tab === "landing" ? undefined : true}
      aria-label={tab === "landing" ? undefined : "Library"}
      ref={root}
      tabIndex={-1}
      onFocusCapture={() => controller.setTyping(true)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !disabled && state.projectId) {
          e.stopPropagation();
          close();
        }
      }}
    >
      {tab !== "landing" && (
        <header className="library-header">
          <button
            className="library-brand"
            aria-label="Pull Fiction landing page"
            onClick={() => navigate("landing")}
          >
            Pull <span>Fiction</span>
          </button>
          <nav aria-label="Library sections">
            {(
              [
                ["workspace", "Workspace"],
                ["projects", "My plans"],
                ["logs", "Find runs"],
                ["rankings", "Rankings"],
              ] as const
            ).map(([t, label]) => (
              <button
                key={t}
                aria-pressed={tab === t}
                onClick={() => navigate(t)}
              >
                {label}
              </button>
            ))}
          </nav>
          <select
            aria-label="Game version"
            value={state.gameVersion}
            disabled={disabled}
            onChange={(e) => {
              previewIntent.current++;
              controller.setGameVersion(e.target.value as GameVersion);
            }}
          >
            {GAME_VERSIONS.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
          {state.projectId && (
            <button
              className="library-return"
              disabled={disabled}
              onClick={close}
            >
              Return to editor
            </button>
          )}
          {state.clientNeedsFiles && state.clientPromptHidden && (
            <button onClick={() => controller.showClientSource()}>
              Load game assets
            </button>
          )}
          {(state.busy || opening) && (
            <div className="library-loading" role="status">
              <span>
                {opening && state.clientStatus !== "ready"
                  ? "Preparing raid assets…"
                  : "Loading replay…"}
              </span>
              {(state.busy || state.clientStatus !== "ready") && (
                <button
                  onClick={() => {
                    controller.cancelImport();
                    if (opening && state.clientStatus !== "ready")
                      controller.cancelClient();
                    setOpening(false);
                  }}
                >
                  Cancel loading
                </button>
              )}
            </div>
          )}
          <GitHubLink />
        </header>
      )}
      {(error || state.libraryError) && (
        <div className="library-error" role="alert">
          {error || state.libraryError}
          {state.saveStatus === "error" && (
            <>
              <button onClick={() => void controller.saveProject(true)}>
                Retry save
              </button>
              {state.projectId && (
                <button
                  onClick={() =>
                    void controller.exportProject(state.projectId!)
                  }
                >
                  Export current edits
                </button>
              )}
            </>
          )}
        </div>
      )}
      {state.notice && (
        <div className="library-notice" role="status">
          {state.notice}
        </div>
      )}
      {tab === "landing" ? (
        <LandingPage
          onNavigate={navigate}
          onCreatePlan={(raidMap) => {
            navigate("projects");
            if (raidMap) setMap(raidMap);
            setVersion(state.gameVersion);
            setNewPlan(true);
          }}
          onReturnToEditor={state.projectId ? close : undefined}
        />
      ) : (
        <div className="library-layout">
          <aside className="library-sidebar">
            <p className="eyebrow">Your library</p>
            <button
              aria-pressed={tab === "runs"}
              onClick={() => navigate("runs")}
            >
              Saved runs <small>{saved.length}</small>
            </button>
            <button
              aria-pressed={tab === "recent"}
              onClick={() => navigate("recent")}
            >
              Recently opened
            </button>
            <p className="eyebrow">Following</p>
            {followed
              .filter((s) => s.gameVersion === state.gameVersion)
              .map((s) => (
                <button
                  key={sourceKey(s)}
                  onClick={() => {
                    navigate("logs");
                    setChosen(s);
                  }}
                >
                  <SourceIcon source={s} />
                  <span>
                    {s.name}
                    <small>
                      {s.kind === "guild" ? "Guild" : "Player"} ·{" "}
                      {s.server.name}
                    </small>
                  </span>
                </button>
              ))}
            <button onClick={() => navigate("logs")}>
              + Find guild or player
            </button>
            <p className="eyebrow">Warcraft Logs</p>
            <span className="library-caption">
              {state.wclConnected ? "Connected" : "Not connected"}
            </span>
            <button
              disabled={!state.wclConfigured || disabled}
              onClick={() =>
                state.wclConnected
                  ? controller.disconnectWcl()
                  : void controller.connectWcl()
              }
            >
              {state.wclConnected ? "Disconnect" : "Connect Warcraft Logs"}
            </button>
            {!state.wclConfigured && (
              <small>WCL connection is not configured for this site.</small>
            )}
            <CommunityLinks />
          </aside>
          <main className="library-main">
            {tab === "workspace" && (
              <>
                <div className="library-toolbar">
                  <div>
                    <h1>Your workspace</h1>
                    <p>Pick up your plan, or find the next run to study.</p>
                  </div>
                  <button
                    className="gold-button"
                    onClick={() => setNewPlan(!newPlan)}
                  >
                    New plan
                  </button>
                </div>
                {createForm}
                {allPlans.length ? (
                  <>
                    <section className="workspace-resume">
                      <div>
                        <p className="eyebrow">Continue planning</p>
                        <h2>
                          {
                            [...allPlans].sort(
                              (a, b) =>
                                (b.lastViewedAt ?? b.updatedAt) -
                                (a.lastViewedAt ?? a.updatedAt),
                            )[0].plan.name
                          }
                        </h2>
                        <p>
                          {relativeDate(
                            [...allPlans].sort(
                              (a, b) =>
                                (b.lastViewedAt ?? b.updatedAt) -
                                (a.lastViewedAt ?? a.updatedAt),
                            )[0].updatedAt,
                          )}
                        </p>
                      </div>
                      <button
                        className="gold-button"
                        disabled={disabled}
                        onClick={() =>
                          void open(
                            [...allPlans].sort(
                              (a, b) =>
                                (b.lastViewedAt ?? b.updatedAt) -
                                (a.lastViewedAt ?? a.updatedAt),
                            )[0],
                          )
                        }
                      >
                        Resume plan
                      </button>
                    </section>
                    <div className="library-section-heading">
                      <h2>Pinned plans</h2>
                      <button onClick={() => navigate("projects")}>
                        All plans
                      </button>
                    </div>
                    {planList(allPlans.filter((p) => p.pinned).slice(0, 3))}
                  </>
                ) : (
                  <div className="workspace-empty">
                    <h2>Your next raid starts here</h2>
                    <p>Find your guild, create a plan, or study a top run.</p>
                    <button onClick={() => navigate("logs")}>
                      Find your guild
                    </button>
                  </div>
                )}
                <div className="library-section-heading">
                  <h2>Recently opened</h2>
                  <button onClick={() => navigate("recent")}>View all</button>
                </div>
                {runList(recent.slice(0, 4))}
              </>
            )}
            {tab === "projects" && (
              <>
                <div className="library-toolbar">
                  <h1>{trash ? "Trash" : "My plans"}</h1>
                  <label className="library-search">
                    <EditorIcon name="search" />
                    <input
                      aria-label="Search saved plans"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder="Search plans or raids"
                    />
                  </label>
                  <button onClick={() => setTrash(!trash)}>
                    {trash ? "Back to plans" : "Trash"}
                  </button>
                  <button
                    disabled={disabled}
                    onClick={() => importer.current?.click()}
                  >
                    Import project
                  </button>
                  <button
                    className="gold-button"
                    onClick={() => setNewPlan(!newPlan)}
                  >
                    New plan
                  </button>
                </div>
                {createForm}
                {!state.libraryReady ? (
                  <p role="status">Opening local projects…</p>
                ) : plans.length ? (
                  planList(plans)
                ) : (
                  <div className="library-empty">
                    <h2>
                      {trash
                        ? "Trash is empty"
                        : filter
                          ? "No matching plans"
                          : "No plans yet"}
                    </h2>
                    <p>
                      Start with an empty raid, or create a plan from a run.
                    </p>
                  </div>
                )}
                <p className="library-local">
                  Saved in this browser on this device. Export a project to keep
                  a portable backup.
                </p>
              </>
            )}
            {(tab === "runs" || tab === "recent") && (
              <>
                <div className="library-toolbar">
                  <h1>{tab === "runs" ? "Saved runs" : "Recently opened"}</h1>
                  <button
                    disabled={disabled}
                    onClick={() => replayImporter.current?.click()}
                  >
                    Import replay JSON
                  </button>
                </div>
                {runList(tab === "runs" ? saved : recent)}
                <p className="library-caption">
                  Clear time is the recorded first pull to final boss kill.
                  Missing legacy values are shown as —.
                </p>
              </>
            )}
            {tab === "logs" && (
              <FindRuns
                key={state.gameVersion}
                state={state}
                controller={controller}
                preview={preview}
                followed={followed}
                chosen={chosen}
                choose={setChosen}
                toggle={follow}
              />
            )}
            {tab === "rankings" && (
              <Rankings
                key={state.gameVersion}
                state={state}
                controller={controller}
                preview={preview}
              />
            )}
            {activeProject?.source && state.sourceStatus === "missing" && (
              <div className="source-reload">
                <span>
                  Source replay for {activeProject.plan.name} is not cached.
                </span>
                <button
                  disabled={disabled || !state.wclConnected}
                  onClick={() => {
                    setAssetAttempted(true);
                    setOpening(true);
                    void controller
                      .boot()
                      .then(() =>
                        controller.reloadProjectSource(activeProject.id),
                      )
                      .then((ok) => {
                        if (ok) close();
                      })
                      .finally(() => setOpening(false));
                  }}
                >
                  Reload source log
                </button>
              </div>
            )}
            {previewVisible && (
              <section
                className="library-report-panel"
                role="region"
                aria-label="Run preview"
                tabIndex={-1}
              >
                <div className="library-section-heading">
                  <h2>Run preview</h2>
                  <button disabled={disabled} onClick={closePreview}>
                    Close preview
                  </button>
                </div>
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
                          {
                            state.report.fights.filter((f) => !f.completeRaid)
                              .length
                          }{" "}
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
                                selection?.fight === "run" &&
                                selection.map === r.map
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
                                          raidForZone(
                                            f.gameZone,
                                            state.gameVersion,
                                          )?.map === r.map && !f.completeRaid,
                                      )
                                      .map((f) => f.endTime),
                                  ) -
                                    Math.min(
                                      ...state
                                        .report!.fights.filter(
                                          (f) =>
                                            raidForZone(
                                              f.gameZone,
                                              state.gameVersion,
                                            )?.map === r.map && !f.completeRaid,
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
                            onClick={() =>
                              setSelection({ fight: String(f.id) })
                            }
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
                                {f.encounterID
                                  ? f.kill
                                    ? "Kill"
                                    : "Wipe"
                                  : "Trash"}
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
                          disabled={!selection || state.busy || opening}
                          onClick={() => void openSelection()}
                        >
                          {state.busy || opening
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
                        <span role="status">
                          {state.busy ? state.status : ""}
                        </span>
                      </footer>
                    </>
                  ) : (
                    <>
                      <div className="library-empty preview-empty">
                        <EditorIcon name="logs" />
                        <h2>Choose a run</h2>
                        <p>Preview its encounters before loading the replay.</p>
                      </div>
                    </>
                  )}
                </div>{" "}
              </section>
            )}
            {assetAttempted &&
              state.browserAssets &&
              !state.clientNeedsFiles &&
              state.clientStatus !== "ready" && (
                <BrowserClient state={state} controller={controller} />
              )}
          </main>
        </div>
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
          if (file) {
            setAssetAttempted(true);
            setOpening(true);
            void controller
              .boot()
              .then(() => {
                const next = controller.getSnapshot();
                if (!next.browserAssets || next.clientStatus === "ready")
                  return controller.importFile(file, "replay");
              })
              .then(() => {
                if (controller.getSnapshot().replay !== state.replay) close();
              })
              .finally(() => setOpening(false));
          }
        }}
      />
    </div>
  );
}
