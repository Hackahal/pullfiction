import {
  shareSnapshot,
  readSharedSnapshot,
  type SharedSnapshot,
} from "./share-client";
import { IncrementalReplayNormalizer } from "./incremental-replay";
import { EncounterAssetWarmer } from "./encounter-assets";
import { ReplayPresenceIndex } from "./replay-presence-index";
import { ReplayFrameTransport } from "./replay-frame-transport";
import { resetLocalMaps } from "./local-map";
import {
  recordedTransferEvidence,
  type TransferEvidence,
} from "./replay-trajectory-modes";
import type {
  WclSpeedCategory,
  WclSpeedSelection,
} from "./speedrun-world-record";
import { actorNameplateEnabled } from "./nameplate-model";
import {
  type ClientFolderAccess,
  type ClientDirectory,
  type ClientSelection,
} from "./client-folder";
import {
  defaultRangeCheck,
  rangeCircles,
  type RangeSettings,
} from "./range-check";
import { type ClientAssetCache, type PreparedClient } from "./client-cache";
import {
  loadNpcIndex,
  resolveNpcModels,
  replayNpcModels,
  type NpcModels,
} from "./npc-models";
import { editControls } from "./edit-affordances";
import { activePages } from "./layer-model";
import {
  defaultSnap,
  snapPoint,
  snapValue,
  transformPoint,
  groundPivot,
  type SnapSettings,
  type Transform,
} from "./editor-controls";
import { gameVersion, reportSource } from "../../planner/game-versions.mjs";
import {
  referenceRaidActors,
  referenceNpcModels,
  referenceSpawnNotice,
} from "./spawn-model";
import { resolveAssetRoot } from "./asset-source";
import { openHostedClient } from "./hosted-assets";
import { parseBrowserPlates } from "./browser-plates";
import { BROWSER_ASSETS } from "./browser-mode";
import {
  installLocalClientFiles,
  LocalClientFiles,
} from "./local-client-files";
import {
  originalClientFiles,
  prepareOriginalClient,
  prepareOriginalUnits,
} from "./original-client-assets";
import { prepareOriginalSpellEffects } from "./original-spell-assets";
import { installLocalUiArt } from "./local-ui-art";
import { localSpellReplay } from "./local-spell-assets";
import { setLocalTalentsProvider, type TalentCatalog } from "./local-talents";
import {
  assetBridge,
  installAssetBridge,
  removeAssetBridge,
  progressText,
  type BrowserAssetBridge,
  type ClientReader,
  type OpenClient,
} from "./browser-assets";
import {
  publicWclConfig,
  createBrowserLogs,
  isWclCallback,
  clearWclCallback,
} from "./browser-wcl";
import type { BrowserLogs, GuildSearch } from "./wcl-browser";
import type { WclSession } from "./wcl-auth";
import {
  ReplayBuffer,
  IndexedReplayPartCache,
  normalizationEvents,
  analysisAvailable,
  streamComplete,
  REPLAY_CHUNK,
  replayIdentity,
} from "./replay-buffer";
import {
  buildTrajectorySource,
  lookupTrajectorySource,
  type TrajectorySourceIndex,
  type TrajectoryComponent,
} from "./replay-trajectory-source";
import {
  buildTrajectoryPacket,
  type TrajectoryComponentPacket,
} from "./replay-trajectory-packets";
import { replayFloorHints } from "./floor-model";
import { ReplayFloorGeometry } from "./replay-floor-geometry";
import { movementFloorCandidates } from "./replay-movement-floors";
import { replayFloorAnchors } from "./replay-floor-anchors";
import { ReplayHeightCache } from "./replay-height-cache";
import { withReplayPoses } from "./replay-pose-phase";
import { raidCameraSubjects, raidCameraCenter } from "./camera-model";
import {
  IndexedProjectStore,
  newProject,
  replaySource,
  parseProjectBackup,
  encodeProjectBackup,
  type ProjectStore,
  type LocalProject,
  type ProjectSource,
} from "./project-store";
import type { ReportSearch } from "./wcl-browser";
import {
  annotationGeometry,
  RAID_ICON_COLORS,
  type MarkGeometry,
  visibleMarks,
} from "./annotation-model";
import {
  STORAGE_KEY,
  RAIDS,
  planStorageKey,
  raidByMap,
  emptyPlan,
  parsePlan,
  validatePlan,
  addPoint,
  reportCode,
  normalizeReplay,
  enrichCombat,
  poseAt,
  combatStateAt,
  visualEventsBetween,
  chapterAt,
  classIDs,
  newAnnotation,
  newStep,
  planId,
} from "./domain";
import type {
  GameVersion,
  Snapshot,
  Engine,
  Plan,
  Tool,
  Point,
  Report,
  RawReplay,
  Replay,
  Actor,
  NativeFrame,
  NativeTrajectoryReference,
  Appearance,
  Options,
  PlanStep,
  Annotation,
  Point as PlanPoint,
} from "./types";
export const ACTIVE_RAID_KEY = "pullfiction.raid.v1";
const APPEARANCE_KEY = "pullfiction.appearance.v1";
const API = BROWSER_ASSETS
  ? ""
  : import.meta.env?.DEV
    ? "/wcl"
    : "http://127.0.0.1:8091";
const initialStep = (plan: Plan) =>
  plan.steps.find(
    (s) => s.snapshot || s.annotations.length || s.notes || s.start !== null,
  )?.id ?? plan.steps[0].id;
type StoragePort = Pick<Storage, "getItem" | "setItem">;
export class EditorController {
  private projectStore: ProjectStore | null;
  private activeProject: LocalProject | null = null;
  private projectSource: ProjectSource | null = null;
  private projectKind: "plan" | "replay" = "plan";
  private restoringProject = false;
  private projectEpoch = 0;
  private projectSwitchRequest = 0;
  private autosaveTimer: ReturnType<typeof setTimeout> | undefined;
  private projectWrites: Promise<void> = Promise.resolve();
  private replayCacheWrite: Promise<void> = Promise.resolve();
  private replayBuffer: ReplayBuffer | null = null;
  private loadingBuffer: ReplayBuffer | null = null;
  private bufferRestore: Promise<void> = Promise.resolve();
  private bufferRequest = 0;
  private bufferUpdate = 0;
  private appliedBufferRevision = -1;
  private bufferTarget = 0;
  private prefetchAfter = 0;
  private downloadEpoch = 0;
  private replayParts =
    typeof indexedDB === "undefined" ? undefined : new IndexedReplayPartCache();
  private libraryPromise: Promise<void> | null = null;
  private pendingProjectReplay: {
    raw: RawReplay;
    time: number;
    mode: "analyse" | "plan";
  } | null = null;
  private listeners = new Set<() => void>();
  private draftBase: Plan | null = null;
  private draftMark: string | null = null;
  private pathPreview: Point | null = null;
  private dimensionBefore: Plan | null = null;
  private pendingSceneSelect: { x: number; y: number; toggle: boolean } | null =
    null;
  private markerRequest = 0;
  private pendingMarkerClicks: {
    x: number;
    y: number;
    epoch: number;
    projectEpoch: number;
    request: number;
    selectedActor: string | null;
  }[] = [];
  private markDrag: {
    id: string;
    handle: number | null;
    anchor: Point;
    points: Point[];
    group: Record<string, Point[]>;
    constrain?: boolean;
    axis?: 0 | 1;
    operation?: "move" | "rotate" | "scale";
  } | null = null;
  private actorDrag: {
    base: Plan;
    anchor: Point;
    positions: Record<string, Point>;
    marks: Record<string, Point[]>;
    constrain?: boolean;
    axis?: 0 | 1;
  } | null = null;
  private clipboard: Annotation[] = [];
  private viewBasis = { right: [0, -1], up: [1, 0] };
  private pickEpoch = 0;
  private pendingPicks = 0;
  private mapPickQueue: [number, number, number, boolean, boolean, boolean][] =
    [];
  private finishRequested = false;
  private saveWhenReady = false;
  private undoStack: Plan[] = [];
  private redoStack: Plan[] = [];
  private saved = "";
  private rangeSource: string | null = null;
  private mapDrafts = new Map<
    string,
    { plan: Plan; saved: string; undo: Plan[]; redo: Plan[] }
  >();
  private appearances: Record<string, Appearance> = {};
  private engine: Engine | null = null;
  private mapView = false;
  private sceneFocused = false;
  private typing = false;
  private shortcutCapture = false;
  private standaloneFrame = false;
  private portraits = new Map<number, string>();
  private frame: NativeFrame[] = [];
  private readonly replayNormalizer = new IncrementalReplayNormalizer();
  private readonly encounterWarmer = new EncounterAssetWarmer();
  private warmedEncounter = "";
  private encounterWarmEpoch = 0;
  private encounterWarmJob?: Promise<void>;
  private playPreparationToken = 0;
  private replayMetadata?: {
    models: object;
    rawModels: object | undefined;
    creatures: object;
    items: object;
    modernItems: object;
    browser: boolean;
    sod: boolean;
    renderModels: Record<string, unknown>;
    itemModels: Record<string, unknown>;
  };
  private warmEncounter() {
    // Speculative conversions use idle time; demand loading owns playback bandwidth.
    if (this.state.playing || this.state.playPreparing) return;
    const replay = this.state.replay,
      bridge = this.browserBridge,
      files = this.localFiles;
    if (!replay || !bridge || !files) return this.encounterWarmJob;
    const chapter = replay.chapters.findIndex(
      (entry) => entry.end >= this.clockTime,
    );
    const key = `${replayIdentity(replay)}:${this.trajectoryEpoch}:${this.appliedBufferRevision}:${chapter}`;
    if (this.warmedEncounter === key) return this.encounterWarmJob;
    this.warmedEncounter = key;
    const epoch = ++this.encounterWarmEpoch;
    this.encounterWarmJob = this.encounterWarmer
      .prepare(
        replay,
        this.clockTime,
        {
          geometry: (map, signal) => this.prepareFloorGeometry(map, signal),
          units: async (actors, signal) => {
            const catalog = await bridge.catalog("creatures");
            signal.throwIfAborted();
            const paths = new Set<string>();
            for (const actor of actors) {
              const display = this.appearance(actor).display ?? actor.displayID;
              const model =
                catalog.models?.[catalog.displays?.[display ?? 0]?.modelID];
              if (
                Number.isSafeInteger(model?.fileDataID) &&
                model.fileDataID > 0
              )
                paths.add(`__classic/${model.fileDataID}.m2`);
            }
            // Conversion warms the bounded on-disk cache; source buffers are released here.
            for (const path of paths) {
              signal.throwIfAborted();
              try {
                await files.readStreaming(path, signal);
              } catch (error) {
                signal.throwIfAborted(); /* Ordinary loader retains retry/error reporting. */
              }
            }
          },
          spells: async (ids, signal) => {
            // Invalid or unavailable optional effects must not cancel the rest of the warmup.
            for (const id of ids) {
              signal.throwIfAborted();
              const temporary = new LocalClientFiles(
                { read: (name) => files.readStreaming(name, signal) },
                `${files.identity}:warm:${id}`,
                32 * 1024 * 1024,
              );
              try {
                await prepareOriginalSpellEffects(
                  temporary,
                  bridge,
                  [id],
                  signal,
                );
              } catch (error) {
                signal.throwIfAborted();
              } finally {
                temporary.close();
              }
            }
          },
        },
        { adjacent: 1 },
      )
      .then(() => {})
      .catch(() => {
        if (
          epoch === this.encounterWarmEpoch &&
          this.state.replay === replay &&
          this.browserBridge === bridge
        )
          this.warmedEncounter = "";
      });
    return this.encounterWarmJob;
  }
  private readonly frameTransport = new ReplayFrameTransport();
  private frameTransportEngine: Engine | null = null;
  private readonly presenceIndexes = new WeakMap<
    Actor[],
    ReplayPresenceIndex
  >();
  private presentReplayActors(lookahead = 0) {
    const replay = this.state.replay;
    if (!replay || this.state.workspaceMode !== "analyse") return null;
    let index = this.presenceIndexes.get(replay.actors);
    if (!index) {
      index = new ReplayPresenceIndex(replay.actors);
      this.presenceIndexes.set(replay.actors, index);
    }
    return index.between(this.clockTime, this.clockTime + lookahead);
  }
  private readonly actorIndexes = new WeakMap<Actor[], Map<string, Actor>>();
  private indexActors(actors: Actor[]) {
    let index = this.actorIndexes.get(actors);
    if (!index) {
      index = new Map(actors.map((actor) => [actor.key, actor]));
      this.actorIndexes.set(actors, index);
    }
    return index;
  }
  private publishReplayFrame(
    frame: readonly {
      key: string;
      trajectory?: NativeTrajectoryReference;
      trajectory_bridge?: {
        from: NativeTrajectoryReference;
        to: NativeTrajectoryReference;
      };
    }[],
  ) {
    if (this.state.playPreparing) {
      for (const unit of frame) {
        // Background preparation is optional; only references needed by the selected pose
        // can make the current Play request fail.
        const required = [
          unit.trajectory,
          unit.trajectory_bridge?.from,
          unit.trajectory_bridge?.to,
        ];
        const failed = required.find(
          (ref) =>
            ref &&
            this.trajectoryRejected.has(
              this.trajectoryPacketKey(
                ref.source,
                unit.key,
                ref.component,
                ref.content,
              ),
            ),
        );
        if (failed) {
          const reason = this.trajectoryRejected.get(
            this.trajectoryPacketKey(
              failed.source,
              unit.key,
              failed.component,
              failed.content,
            ),
          );
          this.cancelPlayPreparation();
          this.notify(`Movement could not be prepared: ${reason}`);
          break;
        }
      }
    }
    const engine = this.engine!;
    if (this.frameTransportEngine !== engine) {
      this.frameTransport.reset();
      this.frameTransportEngine = engine;
    }
    if (
      Object.hasOwn(engine, "set_replay_frame_delta") &&
      engine.set_replay_frame_delta &&
      this.state.replay
    ) {
      this.frameTransport.send(
        `${this.trajectorySource || replayIdentity(this.state.replay)}:frame-${this.trajectoryEpoch}`,
        frame,
        (json) => engine.set_replay_frame_delta!(json),
      );
    } else {
      this.frameTransport.reset();
      engine.set_replay_frame(JSON.stringify(frame));
    }
  }
  private inspectionRequest = 0;
  private appearanceRequests = new Map<string, number>();
  private pendingAppearances = new Map<string, Appearance>();
  private followCenter: { replay: Replay; point: [number, number] } | null =
    null;
  private floorGeometry = new Map<
    number,
    Promise<ReplayFloorGeometry | undefined>
  >();
  private loadedFloors = new Map<number, ReplayFloorGeometry>();
  private actorFloorHeights = new ReplayHeightCache();
  private nearbyFloorHeights = new WeakMap<
    Actor,
    {
      geometry: ReplayFloorGeometry;
      x: number;
      y: number;
      hint: number;
      value: number | undefined;
    }
  >();
  private fromFloorHeights = new ReplayHeightCache();
  private toFloorHeights = new ReplayHeightCache();
  private floorHintCache: {
    replay: Replay;
    time: number;
    geometry?: ReplayFloorGeometry;
    models: object;
    smooth: boolean;
    filtered: boolean;
    hints: Map<string, number>;
    seeds: Map<string, number>;
  } | null = null;
  private lastFrame = -Infinity;
  private movementDiagnostics: unknown = null;
  private trajectoryDiagnostics: unknown = null;
  private trajectoryEpoch = 0;
  private trajectorySource = "";
  private trajectoryEngine: Engine | null = null;
  private trajectorySent = new Set<string>();
  private trajectoryRejected = new Map<string, string>();
  private trajectoryDemands = new Set<string>();
  private trajectoryRetries = new Map<
    string,
    { failures: number; due: number | null }
  >();
  private trajectoryRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private trajectoryRetryEpoch = 0;
  private trajectoryRetryTicket = 0;
  private trajectoryRetryStopped = false;
  private trajectoryCoverageBlocked = false;
  private trajectoryCoverage: {
    source: string;
    start: number;
    end: number;
  } | null = null;
  private trajectoryInputs = new WeakMap<
    Actor,
    {
      replay: Replay;
      source: string;
      geometry?: ReplayFloorGeometry;
      models: object;
      index: TrajectorySourceIndex;
      components: Map<string, TrajectoryComponent>;
      packets: Map<string, TrajectoryComponentPacket>;
    }
  >();
  private trajectoryTransfers = new WeakMap<
    Replay,
    ReadonlyMap<string, TransferEvidence>
  >();
  private renderedInputs: {
    state: Snapshot;
    time: number;
    models: object;
    geometry?: ReplayFloorGeometry;
    engine: Engine | null;
  } | null = null;
  private lastAnnotationPayload: string | null = null;
  private visibleCache: {
    plan: Plan;
    time: number;
    active: string;
    timed: boolean;
    all: boolean;
    pages: PlanStep[];
  } | null = null;
  private compositionCache: {
    pages: PlanStep[];
    snapshot: PlanStep["snapshot"];
  } | null = null;
  private previousEventTime: number | null = null;
  private resetEvents = true;
  private lastNativeSelection: string | null = null;
  private lastChapter: number | null = null;
  private request = 0;
  private catalogs: Promise<void> | null = null;
  private models: Record<string, unknown> = {};
  private browserModels: NpcModels = { vanilla: {}, sod: {} };
  private referenceModels: NpcModels = { vanilla: {}, sod: {} };
  private browserCreatures: Record<string, any> = {};
  private items: Record<string, unknown> = {};
  private spells: Record<string, unknown> = {};
  private modernSpells: Record<string, unknown> = {};
  private modernItems: Record<string, unknown> = {};
  private raf = 0;
  private previousTick = 0;
  private clockTime = 0;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private sceneTimer: ReturnType<typeof setTimeout> | undefined;
  private state: Snapshot;
  private clientReader: ClientReader | null = null;
  private localFiles: LocalClientFiles | null = null;
  private releaseLocalFiles: (() => void) | null = null;
  private releaseLocalArt: (() => void) | null = null;
  private browserBridge: BrowserAssetBridge | null = null;
  private clientAbort: AbortController | null = null;
  private clientFolders: ClientFolderAccess | null;
  private rememberedClientFolder: ClientDirectory | null = null;
  private clientRestoreStarted = false;
  private clientAccessEpoch = 0;
  private clientCache: ClientAssetCache | null;
  private preparedClient: PreparedClient | null = null;
  private prefetchAbort: AbortController | null = null;
  private clientAttachAbort: AbortController | null = null;
  private importAbort: AbortController | null = null;
  private wclSession: WclSession | null = null;
  private browserLogs: BrowserLogs | null = null;
  private authStarted = false;
  private bootPromise: Promise<void> | null = null;
  constructor(
    private storage?: StoragePort,
    private runtime: {
      browserAssets?: boolean;
      openClient?: OpenClient;
      clientFolders?: ClientFolderAccess | null;
      clientCache?: ClientAssetCache | null;
      loadEngine?: () => Promise<Engine>;
      loadNpcIndex?: (signal?: AbortSignal) => Promise<unknown>;
      projectStore?: ProjectStore | null;
      rendererLab?: boolean;
    } = {},
  ) {
    // Production always downloads prepared assets. Folder/cache source injection is
    // retained only for isolated reader tests and development tooling.
    this.clientFolders = runtime.openClient
      ? (runtime.clientFolders ?? null)
      : null;
    this.clientCache = runtime.openClient
      ? (runtime.clientCache ?? null)
      : null;
    this.projectStore =
      runtime.projectStore === undefined
        ? typeof indexedDB === "undefined"
          ? null
          : new IndexedProjectStore()
        : runtime.projectStore;
    let map = 409;
    let version: GameVersion = "vanilla";
    try {
      version = gameVersion(
        storage?.getItem("pullfiction.gameVersion.v1") ?? "vanilla",
      ).id as GameVersion;
    } catch {}
    try {
      const remembered = Number(storage?.getItem(ACTIVE_RAID_KEY));
      if (raidByMap(remembered, version)) map = remembered;
    } catch {}
    let plan = emptyPlan(map, version),
      notice = "";
    try {
      const stored = storage?.getItem(planStorageKey(map, version));
      if (stored) {
        const loaded = parsePlan(stored);
        if (loaded.mapId !== map || loaded.gameVersion !== version)
          throw new Error("Saved plan belongs to another raid");
        plan = loaded;
        this.saved = JSON.stringify(plan);
      }
    } catch {
      notice =
        "Saved plan could not be read. Your original data has been kept.";
    }
    try {
      this.appearances = JSON.parse(storage?.getItem(APPEARANCE_KEY) || "{}");
    } catch {}
    if (!this.saved) this.saved = JSON.stringify(plan);
    const browserAssets = runtime.browserAssets ?? BROWSER_ASSETS;
    this.state = {
      projects: [],
      cachedSources: [],
      projectId: null,
      libraryReady: false,
      libraryError: null,
      saveStatus: "unsaved",
      savedAt: null,
      sourceStatus: "none",
      browserPlates: [],
      browserAssets,
      clientStatus: "select",
      clientProgress: "Loading game assets",
      clientCanRemember: !!this.clientFolders?.supported,
      clientFolderName: null,
      clientRemembered: false,
      clientReconnect: false,
      clientFolderError: null,
      clientCacheStatus: "none",
      clientPrefetchProgress: "",
      clientNeedsFiles: false,
      clientPromptHidden: false,
      clientAttaching: false,
      clientNeedsRestart: false,
      clientBuild: "",
      wclConfigured: false,
      wclConnected: false,
      gameVersion: version,
      ready: false,
      sceneReady: false,
      error: null,
      notice,
      status: browserAssets ? "Loading game assets" : "Loading Molten Core",
      busy: false,
      plan,
      dirty: false,
      canUndo: false,
      canRedo: false,
      tool: "explore",
      planning: false,
      snap: { ...defaultSnap },
      transform: "move",
      transformActive: false,
      selectionFilter: "both",
      selectedActors: [],
      compareRecorded: false,
      frameRequest: 0,
      spacePan: false,
      navigationTool: "select",
      cameraMode: "free",
      orbitTarget: null,
      snapBypass: false,
      workspaceMode: "analyse",
      sceneHover: null,
      activeStep: initialStep(plan),
      selectedMark: null,
      selectedMarks: [],
      markStyle: { color: "#edc66d", icon: "8", size: 5, width: 3 },
      followSteps: true,
      showAllSteps: false,
      drawing: false,
      dimensionInput: "",
      raidFrameSize: { width: 724, height: 276 },
      report: null,
      reportCode: "DyN7vF94QR8aj1Lc",
      replay: null,
      time: 0,
      playing: false,
      rate: 1,
      selected: null,
      detail: null,
      options: {
        nameplates: true,
        friendlyNameplates: true,
        enemyNameplates: true,
        trashNameplates: true,
        bossNameplates: true,
        raidFrames: true,
        auras: true,
        spells: true,
        smoothGaps: true,
        followPulls: true,
        followRaid: true,
        lockCamera: false,
        actors: true,
      },
      rangeCheck: { ...defaultRangeCheck, players: [] },
      cameraMaxDistance: 40,
      portraitVersion: 0,
      inspectionModel: null,
      visualEvents: 0,
      unsupported: 0,
      loop: null,
    };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private patch(change: Partial<Snapshot>) {
    const keys = Object.keys(change) as (keyof Snapshot)[];
    // Empty patches deliberately invalidate non-snapshot inputs such as mapView.
    if (
      keys.length &&
      keys.every((key) => Object.is(this.state[key], change[key]))
    )
      return;
    const previous = this.state.workspaceMode === "plan";
    const cameraBefore = this.state.cameraMode,
      targetBefore = this.state.orbitTarget;
    const dimensionBefore = this.state.dimensionInput;
    this.state = { ...this.state, ...change };
    if (this.state.cameraMode === "orbit" && change.selected) {
      const player = this.sceneActors().find(
        (a) => a.key === change.selected && a.type === "Player",
      );
      this.state = player
        ? { ...this.state, orbitTarget: player.key }
        : { ...this.state, cameraMode: "free", orbitTarget: null };
    }
    if (
      this.state.cameraMode === "orbit" &&
      (change.plan ||
        change.activeStep ||
        change.replay !== undefined ||
        change.workspaceMode) &&
      !this.sceneActors().some(
        (a) => a.type === "Player" && a.key === this.state.orbitTarget,
      )
    ) {
      this.state = { ...this.state, cameraMode: "free", orbitTarget: null };
    }
    const editing = this.state.workspaceMode === "plan";
    if (previous !== editing) this.engine?.set_editor_mode?.(editing);
    if (
      cameraBefore !== this.state.cameraMode ||
      targetBefore !== this.state.orbitTarget
    ) {
      this.engine?.set_editor_orbit_player?.(
        this.state.cameraMode === "orbit" ? (this.state.orbitTarget ?? "") : "",
      );
      this.syncKeyboardCapture();
    }
    if (dimensionBefore !== this.state.dimensionInput)
      this.syncKeyboardCapture();
    for (const listener of this.listeners) listener();
  }
  notify(text: string) {
    clearTimeout(this.noticeTimer);
    this.patch({ notice: text });
    this.noticeTimer = setTimeout(() => this.patch({ notice: "" }), 5000);
  }
  private planState(plan: Plan) {
    const changed = plan !== this.state.plan;
    this.patch({
      plan,
      dirty: JSON.stringify(plan) !== this.saved,
      canUndo: !!this.undoStack.length,
      canRedo: !!this.redoStack.length,
    });
    const active = plan.steps.some((s) => s.id === this.state.activeStep)
      ? this.state.activeStep
      : initialStep(plan);
    const selected = plan.steps
      .flatMap((s) => s.annotations)
      .some((a) => a.id === this.state.selectedMark)
      ? this.state.selectedMark
      : null;
    if (
      active !== this.state.activeStep ||
      selected !== this.state.selectedMark
    )
      this.patch({ activeStep: active, selectedMark: selected });
    const ids = this.state.selectedMarks.filter((id) =>
      plan.steps.some((s) => s.annotations.some((a) => a.id === id)),
    );
    if (ids.length !== this.state.selectedMarks.length)
      this.patch({ selectedMarks: ids, selectedMark: ids.at(-1) ?? null });
    this.sendAnnotations();
    this.sendPositions();
    if (changed && this.state.dirty && !this.restoringProject)
      this.scheduleAutosave();
  }
  actorGizmo(): MarkGeometry[] {
    if (
      (!this.state.transformActive && this.state.tool !== "explore") ||
      this.state.compareRecorded ||
      this.state.selectedMarks.length
    )
      return [];
    const keys = this.state.selectedActors.length
      ? this.state.selectedActors
      : this.state.selected
        ? [this.state.selected]
        : [];
    let scene: Map<string, Actor> | undefined;
    const actors = keys.flatMap((key) => {
      const planned =
        this.state.workspaceMode === "plan"
          ? this.snapshot()?.actors.find((a) => a.key === key)
          : undefined;
      if (planned) return [planned];
      const actor = (scene ??= new Map(
          this.sceneActors().map((a) => [a.key, a]),
        )).get(key),
        pose = actor ? this.actorPose(actor) : null;
      return pose && !pose.dead
        ? [
            {
              key,
              position: [
                pose.pos[0],
                pose.pos[1],
                pose.pos[2] ?? raidByMap(this.state.plan.mapId)?.spawn[2] ?? 0,
              ] as Point,
            },
          ]
        : [];
    });
    if (!actors.length) return [];
    const p = groundPivot(actors.map((a) => a.position)),
      d = 5;
    const handles: Point[] = [
      p,
      [p[0] + d, p[1], p[2]],
      [p[0], p[1] + d, p[2]],
    ];
    const paths: Point[][] =
      this.state.transform === "rotate"
        ? [
            Array.from(
              { length: 49 },
              (_, i) =>
                [
                  p[0] + Math.cos((i * Math.PI) / 24) * d,
                  p[1] + Math.sin((i * Math.PI) / 24) * d,
                  p[2],
                ] as Point,
            ),
          ]
        : [[handles[1], p, handles[2]]];
    return [
      {
        ...annotationGeometry(
          newAnnotation("circle", p, {
            id: `actor-gizmo:${actors[0].key}`,
            size: 1,
            width: 2,
          }),
        ),
        type: "gizmo",
        selected: true,
        handles,
        handleKinds: [
          this.state.transformActive ? this.state.transform : "move",
          this.state.transformActive ? this.state.transform : "move",
          this.state.transformActive ? this.state.transform : "move",
        ],
        paths,
        fill: [],
        triangles: [],
      },
    ];
  }
  markGeometry(a: Annotation): MarkGeometry {
    const selected = this.state.selectedMarks.includes(a.id);
    const g = annotationGeometry(a, selected);
    if (
      this.state.workspaceMode === "plan" &&
      !this.state.compareRecorded &&
      selected &&
      this.state.selectedMarks.length === 1 &&
      !(this.state.drawing && !this.markDrag && !this.actorDrag)
    )
      Object.assign(g, editControls(a));
    else {
      g.handles = [];
      g.handleKinds = [];
    }
    if (
      !selected ||
      a.locked ||
      !this.state.transformActive ||
      a.id !== this.state.selectedMark
    )
      return g;
    const pivot = groundPivot(
      this.displayMarks()
        .filter((m) => this.state.selectedMarks.includes(m.id))
        .map((m) => m.points[0]),
    );
    const d = 5;
    g.handleKinds = [
      this.state.transform,
      this.state.transform,
      this.state.transform,
    ];
    g.handles = [
      pivot,
      [pivot[0] + d, pivot[1], pivot[2]],
      [pivot[0], pivot[1] + d, pivot[2]],
    ];
    if (this.state.transform === "rotate") {
      const ring = Array.from(
        { length: 49 },
        (_, i) =>
          [
            pivot[0] + Math.cos((i * Math.PI) / 24) * d,
            pivot[1] + Math.sin((i * Math.PI) / 24) * d,
            pivot[2],
          ] as Point,
      );
      g.paths = [...g.paths, ring];
    } else g.paths = [...g.paths, [g.handles[1], pivot, g.handles[2]]];
    return g;
  }
  handleKind(id: string, index: number | null): string {
    if (index === null) return "move";
    if (id.startsWith("actor-gizmo:"))
      return this.state.transformActive ? this.state.transform : "move";
    const edit = this.displayMarks().find((a) => a.id === id);
    return this.state.transformActive
      ? this.state.transform
      : edit
        ? (editControls(edit).handleKinds[index] ?? "point")
        : "move";
  }
  private sendAnnotations() {
    if (this.runtime.rendererLab) return;
    const { plan, activeStep, showAllSteps, selectedMark } = this.state;
    const selectedActors = this.state.selectedActors.length
      ? new Map(this.sceneActors().map((actor) => [actor.key, actor]))
      : undefined;
    const payload = JSON.stringify({
      ranges: this.rangeCheckCircles().map(({ key, radius, status }) => ({
        key,
        radius,
        status,
      })),
      marks: [
        ...this.displayMarks().map((a) => this.markGeometry(a)),
        ...this.actorGizmo(),
        ...this.state.selectedActors.flatMap((key) => {
          const actor = selectedActors?.get(key),
            pose = actor ? this.actorPose(actor) : null;
          if (!pose) return [];
          return [
            {
              ...annotationGeometry(
                newAnnotation(
                  "circle",
                  [
                    pose.pos[0],
                    pose.pos[1],
                    pose.pos[2] ??
                      raidByMap(this.state.plan.mapId)?.spawn[2] ??
                      0,
                  ],
                  {
                    id: `selection-${key}`,
                    size: 1,
                    color: "#edc66d",
                    locked: true,
                  },
                ),
              ),
              inert: true,
            },
          ];
        }),
      ],
    });
    if (this.engine && payload !== this.lastAnnotationPayload) {
      this.engine.set_annotations(payload);
      this.lastAnnotationPayload = payload;
    }
  }

  editPlan(next: Plan) {
    if (this.draftBase) {
      this.pendingPicks = 0;
      this.mapPickQueue = [];
      this.finishDrawing();
      this.pickEpoch++;
    } else this.finishDrawing();
    let plan: Plan;
    try {
      plan = validatePlan(next);
    } catch (error) {
      this.notify(message(error));
      return;
    }
    if (JSON.stringify(plan) === JSON.stringify(this.state.plan)) return;
    if (
      plan.mapId !== this.state.plan.mapId ||
      plan.gameVersion !== this.state.gameVersion
    )
      this.selectRaid(plan.mapId, true, plan.gameVersion);
    this.undoStack.push(this.state.plan);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    this.planState(plan);
  }
  rename(name: string) {
    this.editPlan({ ...this.state.plan, name });
  }
  clearPlan() {
    this.editPlan({
      ...this.state.plan,
      steps: this.state.plan.steps.map((s) => ({ ...s, annotations: [] })),
    });
  }
  undo() {
    this.pendingPicks = 0;
    this.mapPickQueue = [];
    this.finishDrawing();
    this.pickEpoch++;
    const plan = this.undoStack.pop();
    if (plan) {
      this.redoStack.push(this.state.plan);
      this.planState(plan);
    }
  }
  redo() {
    this.pendingPicks = 0;
    this.mapPickQueue = [];
    this.finishDrawing();
    this.pickEpoch++;
    const plan = this.redoStack.pop();
    if (plan) {
      this.undoStack.push(this.state.plan);
      this.planState(plan);
    }
  }
  save() {
    this.finishDrawing();
    if (this.pendingPicks) {
      this.saveWhenReady = true;
      return;
    }
    if (this.projectStore) {
      void this.saveProject(true);
      return;
    }
    try {
      const plan = validatePlan(this.state.plan);
      if (!this.storage) throw new Error("Local storage unavailable");
      this.storage.setItem(
        planStorageKey(plan.mapId, plan.gameVersion),
        JSON.stringify(plan),
      );
      this.saved = JSON.stringify(plan);
      this.planState(plan);
      this.notify("Plan saved");
    } catch (e) {
      this.notify(`Could not save: ${message(e)}`);
    }
  }
  async initializeLibrary() {
    if (this.libraryPromise) return this.libraryPromise;
    this.libraryPromise = (async () => {
      if (!this.projectStore) {
        this.patch({
          libraryReady: true,
          libraryError:
            "Local project storage is unavailable in this browser. Export a plan to keep your edits.",
        });
        return;
      }
      try {
        const existing = await this.projectStore.list();
        const ids = new Set(existing.map((p) => p.id));
        for (const version of ["vanilla", "sod"] as const) {
          for (const raid of RAIDS) {
            if (!raidByMap(raid.map, version)) continue;
            const id = `legacy-${version}-${raid.map}`;
            if (ids.has(id)) continue;
            const text = this.storage?.getItem(
              planStorageKey(raid.map, version),
            );
            if (!text) continue;
            let plan: Plan;
            try {
              plan = parsePlan(text);
              if (plan.gameVersion !== version || plan.mapId !== raid.map)
                continue;
            } catch {
              continue; // Keep unreadable legacy bytes in their original key.
            }
            await this.projectStore.put({ ...newProject(plan), id });
            ids.add(id);
          }
        }
        const projects = await this.projectStore.list();
        const sources = [
          ...new Set(
            projects.flatMap((p) => (p.source ? [p.source.cacheKey] : [])),
          ),
        ];
        const cached = await Promise.all(
          sources.map(async (key) =>
            (await this.projectStore!.hasReplay(key)) ? key : null,
          ),
        );
        this.patch({
          projects,
          cachedSources: cached.filter((key): key is string => key !== null),
          libraryError: null,
        });
      } catch (error) {
        this.patch({
          libraryError: `Could not open local projects: ${message(error)}`,
        });
      } finally {
        this.patch({ libraryReady: true });
      }
    })();
    return this.libraryPromise;
  }
  private scheduleAutosave() {
    if (!this.projectStore || this.restoringProject) return;
    clearTimeout(this.autosaveTimer);
    this.patch({ saveStatus: "pending" });
    this.autosaveTimer = setTimeout(() => {
      if (this.state.drawing || this.draftBase || this.pendingPicks)
        this.scheduleAutosave();
      else void this.saveProject();
    }, 650);
    this.autosaveTimer.unref?.();
  }
  async saveProject(announce = false): Promise<void> {
    clearTimeout(this.autosaveTimer);
    if (!this.projectStore) {
      if (announce) this.save();
      return;
    }
    if (this.pendingPicks || this.draftBase) {
      this.scheduleAutosave();
      return;
    }
    const plan = validatePlan(this.state.plan);
    const epoch = this.projectEpoch;
    const project = {
      ...(this.activeProject ?? newProject(plan, this.projectSource)),
      plan,
      source: this.projectSource,
      updatedAt: Date.now(),
      time: this.clockTime,
      mode: this.state.workspaceMode,
      kind: this.projectKind,
    };
    this.activeProject = project;
    this.patch({ projectId: project.id, saveStatus: "saving" });
    const serialized = JSON.stringify(plan);
    const write = async () => {
      try {
        await this.projectStore!.put(project);
        this.patch({
          projects: [
            project,
            ...this.state.projects.filter((p) => p.id !== project.id),
          ],
        });
        if (
          epoch === this.projectEpoch &&
          this.activeProject?.id === project.id &&
          serialized === JSON.stringify(this.state.plan)
        ) {
          this.saved = serialized;
          this.patch({
            dirty: false,
            saveStatus: "saved",
            savedAt: project.updatedAt,
            ...(this.state.libraryError?.startsWith("Local save failed")
              ? { libraryError: null }
              : {}),
          });
          if (announce) this.notify("Saved on this device");
        }
      } catch (error) {
        if (epoch === this.projectEpoch)
          this.patch({
            saveStatus: "error",
            libraryError: `Local save failed: ${message(error)}. Export a backup to keep your edits.`,
          });
        this.notify(`Local save failed: ${message(error)}`);
        throw error;
      }
    };
    const result = this.projectWrites.then(write, write);
    this.projectWrites = result.catch(() => {});
    // Autosave reports errors through state; switching uses flushProject below.
    await result.catch(() => {});
  }
  private async flushProject() {
    await this.replayBuffer?.flush();
    this.finishDrawing();
    if (this.pendingPicks)
      throw new Error(
        "Wait for the drawing to finish before switching projects",
      );
    if (this.state.dirty || this.activeProject) await this.saveProject();
    await this.projectWrites;
    if (this.state.saveStatus === "error")
      throw new Error(
        "Save failed. Export your current plan before switching projects.",
      );
  }
  private resetProject(
    project: LocalProject | null,
    source: ProjectSource | null = null,
  ) {
    this.cancelPlayPreparation();
    this.replayBuffer?.close();
    this.replayBuffer = null;
    this.bufferRequest++;
    this.downloadEpoch++;
    this.patch({
      buffering: false,
      bufferError: null,
      downloadingReplay: false,
    });
    clearTimeout(this.autosaveTimer);
    this.projectEpoch++;
    this.activeProject = project;
    this.projectSource = project?.source ?? source;
    this.projectKind = project?.kind ?? (source ? "replay" : "plan");
    this.pendingProjectReplay = null;
    this.clockTime = 0;
    this.frame = [];
    this.previousEventTime = null;
    this.resetEvents = true;
    this.lastChapter = null;
    this.frameTransport.reset();
    this.engine?.set_replay_frame("[]");
    this.engine?.replay_events("[]", true);
    this.patch({
      replay: null,
      time: 0,
      playing: false,
      selected: null,
      detail: null,
      loop: null,
      projectId: project?.id ?? null,
      savedAt: project?.updatedAt ?? null,
      saveStatus: project ? "saved" : "unsaved",
      sourceStatus: source || project?.source ? "missing" : "none",
    });
  }
  async createProject(map: number, version: GameVersion, name?: string) {
    try {
      await this.flushProject();
      this.restoringProject = true;
      this.resetProject(null);
      this.mapDrafts.clear();
      this.selectRaid(map, true, version);
      const plan = emptyPlan(map, version);
      if (name?.trim()) plan.name = name.trim().slice(0, 100);
      this.saved = "";
      this.undoStack = [];
      this.redoStack = [];
      this.planState(plan);
      this.patch({
        activeStep: initialStep(plan),
        selectedMark: null,
        selectedMarks: [],
        selectedActors: [],
      });
      this.setWorkspaceMode("plan");
      this.restoringProject = false;
      await this.saveProject();
      return !this.projectStore || this.state.saveStatus === "saved";
    } catch (error) {
      this.notify(message(error));
      return false;
    } finally {
      this.restoringProject = false;
    }
  }
  async openProject(id: string) {
    try {
      await this.flushProject();
      await this.replayCacheWrite;
      const project = await this.projectStore?.get(id);
      if (!project || project.deletedAt !== null)
        throw new Error("Local project not found");
      const epoch = ++this.request;
      this.patch({ busy: true, playing: false });
      const raw = project.source
        ? await this.projectStore!.getReplay(project.source.cacheKey)
        : null;
      if (epoch !== this.request) return false;
      if (!this.state.browserAssets || this.state.clientStatus === "ready")
        await this.preparePlanAssets(project.plan, this.clientAbort?.signal);
      if (epoch !== this.request) return false;
      this.restoringProject = true;
      this.mapDrafts.clear();
      this.selectRaid(project.plan.mapId, true, project.plan.gameVersion);
      this.patch({ busy: true });
      this.resetProject(project);
      this.saved = JSON.stringify(project.plan);
      this.undoStack = [];
      this.redoStack = [];
      this.planState(project.plan);
      this.patch({
        activeStep: initialStep(project.plan),
        selectedMark: null,
        selectedMarks: [],
        selectedActors: [],
      });
      if (
        raw &&
        (!this.state.browserAssets || this.state.clientStatus === "ready")
      ) {
        const prepared = await this.prepareReplayForInstall(
          raw,
          this.clientAbort?.signal,
        );
        if (epoch !== this.request) return false;
        this.installReplay(raw, prepared);
        this.seek(project.time);
        this.patch({ sourceStatus: "cached" });
      } else if (raw) {
        this.pendingProjectReplay = {
          raw,
          time: project.time,
          mode: project.mode,
        };
        this.patch({ sourceStatus: "cached" });
      } else if (project.source) {
        this.clockTime = project.time;
        this.patch({ time: project.time });
        this.notify(
          "Plan opened. Its source replay is not cached; reconnect to reload the source log.",
        );
      }
      this.setWorkspaceMode(project.mode);
      return true;
    } catch (error) {
      this.notify(`Could not open project: ${message(error)}`);
      return false;
    } finally {
      this.restoringProject = false;
      this.patch({ busy: false });
    }
  }
  async duplicateProject(id: string) {
    try {
      if (this.activeProject?.id === id) await this.flushProject();
      const original = await this.projectStore?.get(id);
      if (!original) return;
      const copy = newProject(
        { ...original.plan, name: `${original.plan.name.slice(0, 93)} copy` },
        original.source,
      );
      copy.time = original.time;
      copy.mode = original.mode;
      copy.kind = original.kind;
      await this.projectStore!.put(copy);
      this.patch({ projects: [copy, ...this.state.projects] });
      return copy.id;
    } catch (error) {
      this.notify(message(error));
    }
  }
  async trashProject(id: string, restore = false) {
    try {
      if (this.activeProject?.id === id) await this.flushProject();
      const project = await this.projectStore?.get(id);
      if (!project) return;
      const next = {
        ...project,
        deletedAt: restore ? null : Date.now(),
        updatedAt: Date.now(),
      };
      await this.projectStore!.put(next);
      this.patch({
        projects: this.state.projects.map((p) => (p.id === id ? next : p)),
      });
      if (!restore && this.activeProject?.id === id) this.resetProject(null);
    } catch (error) {
      this.notify(message(error));
    }
  }
  async importProject(file: File) {
    try {
      if (!this.projectStore)
        throw new Error("Local project storage unavailable");
      if (file.size > 150000000)
        throw new Error("Project backup exceeds 150 MB");
      const { project, replay } = parseProjectBackup(await file.text());
      let cached = false,
        cacheError = "";
      if (replay && project.source) {
        try {
          await this.projectStore.putReplay(project.source.cacheKey, replay);
          cached = true;
        } catch (error) {
          cacheError = message(error);
        }
      }
      await this.projectStore.put(project);
      this.patch({
        projects: [project, ...this.state.projects],
        cachedSources:
          cached && project.source
            ? [
                ...new Set([
                  ...this.state.cachedSources,
                  project.source.cacheKey,
                ]),
              ]
            : this.state.cachedSources,
      });
      if (cacheError)
        this.notify(
          `Project imported. Its source log could not be cached: ${cacheError}`,
        );
      return project.id;
    } catch (error) {
      this.notify(`Could not import project: ${message(error)}`);
    }
  }
  async projectShareSnapshot(id?: string): Promise<SharedSnapshot> {
    this.finishDrawing();
    if (this.pendingPicks)
      throw new Error("Wait for the drawing to finish before sharing");
    // Current edits remain shareable even when local persistence has failed.
    const project =
      !id || this.activeProject?.id === id
        ? {
            ...newProject(this.state.plan, this.projectSource),
            time: this.clockTime,
            mode: this.state.workspaceMode,
            kind: this.projectKind,
          }
        : await this.projectStore?.get(id);
    if (!project || project.deletedAt !== null)
      throw new Error("Local project not found");
    return shareSnapshot(project);
  }
  async importSharedSnapshot(value: unknown) {
    if (!this.projectStore)
      throw new Error("Local project storage unavailable");
    await this.initializeLibrary();
    const snapshot = readSharedSnapshot(value);
    const source = snapshot.source
      ? {
          ...snapshot.source,
          cacheKey: `${snapshot.source.gameVersion}:${snapshot.source.code}:${snapshot.source.fight}:${snapshot.source.map}:${planId()}`,
        }
      : null;
    const project = {
      ...newProject(snapshot.plan, source),
      time: snapshot.time,
      mode: snapshot.mode,
      kind: snapshot.kind,
    };
    await this.projectStore.put(project);
    this.patch({ projects: [project, ...this.state.projects] });
    return project.id;
  }
  async exportProject(id: string) {
    try {
      this.finishDrawing();
      if (this.pendingPicks)
        throw new Error("Wait for the drawing to finish before exporting");
      await this.replayCacheWrite;
      const project =
        this.activeProject?.id === id
          ? {
              ...this.activeProject,
              plan: validatePlan(this.state.plan),
              source: this.projectSource,
              updatedAt: Date.now(),
              time: this.clockTime,
              mode: this.state.workspaceMode,
              kind: this.projectKind,
            }
          : (this.state.projects.find((p) => p.id === id) ??
            (await this.projectStore?.get(id)));
      if (!project) throw new Error("Project not found");
      let replay: RawReplay | null = null;
      if (project.source) {
        if (
          this.activeProject?.id === id &&
          this.state.replay?.report.code === project.source.code
        )
          replay = this.replayBuffer?.snapshot() ?? this.state.replay.raw;
        else {
          try {
            replay = await this.projectStore!.getReplay(
              project.source.cacheKey,
            );
          } catch {
            this.notify(
              "Backup includes your edits; its source log could not be read from local storage.",
            );
          }
        }
      }
      if (replay?.stream && this.activeProject?.id !== id) {
        const buffer = this.makeReplayBuffer(replay);
        await buffer.restore();
        replay = buffer.snapshot();
        buffer.close();
      }
      const backup = encodeProjectBackup(project, replay);
      if (replay?.stream && !streamComplete(replay))
        this.notify(
          "Backup includes your edits and downloaded replay sections. Other sections still need Warcraft Logs.",
        );
      if (replay && !backup.includesReplay)
        this.notify(
          "Project exported with all edits. Its large source log is linked for reloading instead of embedded in the backup.",
        );
      this.download(
        backup.value,
        `${project.plan.name.replace(/[^a-z0-9-]+/gi, "-").slice(0, 70)}.pullfiction.json`,
        backup.text,
      );
    } catch (error) {
      this.notify(message(error));
    }
  }
  private download(value: unknown, name: string, serialized?: string) {
    const url = URL.createObjectURL(
      new Blob([serialized ?? JSON.stringify(value)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  logAccount(signal?: AbortSignal) {
    return this.requireBrowserLogs().account(this.state.gameVersion, signal);
  }
  findLogGuild(search: GuildSearch, signal?: AbortSignal) {
    return this.requireBrowserLogs().guild(
      search,
      this.state.gameVersion,
      signal,
    );
  }
  speedCategory(version: GameVersion, map: number, signal?: AbortSignal) {
    return this.requireBrowserLogs().speedCategory(version, map, signal);
  }
  speedWorldRecord(
    version: GameVersion,
    map: number,
    category: WclSpeedCategory,
    selection: WclSpeedSelection,
    signal?: AbortSignal,
  ) {
    return this.requireBrowserLogs().speedWorldRecord(
      version,
      map,
      category,
      selection,
      signal,
    );
  }
  logZones(signal?: AbortSignal) {
    return this.requireBrowserLogs().zones(this.state.gameVersion, signal);
  }
  logRealms(region: string, signal?: AbortSignal) {
    return this.requireBrowserLogs().realms(
      region,
      this.state.gameVersion,
      signal,
    );
  }
  searchLogs(search: ReportSearch, signal?: AbortSignal) {
    return this.requireBrowserLogs().reports(
      search,
      this.state.gameVersion,
      signal,
    );
  }
  async reloadProjectSource(id: string) {
    if (this.state.busy) return false;
    if (this.state.browserAssets && this.state.clientStatus !== "ready") {
      this.notify("Wait for game assets before reloading the source replay");
      return false;
    }
    if (this.state.projectId !== id && !(await this.openProject(id)))
      return false;
    try {
      await this.flushProject();
    } catch (error) {
      this.notify(message(error));
      return false;
    }
    const project = this.activeProject,
      source = this.projectSource;
    if (!project || !source) return false;
    const request = ++this.request;
    this.importAbort = new AbortController();
    this.patch({ busy: true, playing: false });
    try {
      let buffered: ReplayBuffer | undefined;
      const raw = this.state.browserAssets
        ? await (async () => {
            const header = await this.requireBrowserLogs().replayHeader(
              source.code,
              source.fight,
              source.gameVersion,
              source.map,
              { signal: this.importAbort!.signal },
            );
            buffered = this.makeReplayBuffer(header, true);
            this.loadingBuffer = buffered;
            await buffered.ensure(project.time);
            return buffered.snapshot();
          })()
        : await this.api(
            source.fight === "run"
              ? `/run?code=${source.code}&map=${source.map}`
              : `/replay?code=${source.code}&fight=${source.fight}`,
          );
      const prepared = await this.prepareReplayForInstall(
        raw,
        this.importAbort.signal,
      );
      if (request !== this.request) return false;
      this.restoringProject = true;
      try {
        this.installReplay(raw, prepared, buffered);
        this.loadingBuffer = null;
      } finally {
        this.restoringProject = false;
      }
      this.projectSource = replaySource(raw, source.map);
      this.cacheProjectReplay(raw);
      this.seek(project.time);
      this.setWorkspaceMode(project.mode);
      await this.saveProject();
      return true;
    } catch (error) {
      if (request === this.request) this.notify(message(error));
      return false;
    } finally {
      if (request === this.request) this.patch({ busy: false });
    }
  }
  private cacheProjectReplay(raw: RawReplay) {
    if (!this.projectStore || !this.projectSource) return;
    const epoch = this.projectEpoch,
      source = this.projectSource;
    this.patch({ sourceStatus: "saving" });
    this.replayCacheWrite = this.projectStore
      .putReplay(
        source.cacheKey,
        raw.stream
          ? {
              ...raw,
              events: [],
              stream: {
                ...raw.stream,
                full: [],
                history: [],
                stateEvents: [],
                contextEvents: [],
              },
            }
          : raw,
      )
      .then(
        () => {
          this.patch({
            cachedSources: [
              ...new Set([...this.state.cachedSources, source.cacheKey]),
            ],
          });
          if (epoch === this.projectEpoch)
            this.patch({ sourceStatus: "cached" });
        },
        (error) => {
          if (epoch === this.projectEpoch)
            this.patch({ sourceStatus: "missing" });
          this.notify(
            `Edits can be saved, but the source replay could not be cached: ${message(error)}`,
          );
        },
      );
  }

  setRaidFrameSize(width: number, height: number, persist = true) {
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    const raidFrameSize = {
      width: Math.max(80, Math.min(2500, width)),
      height: Math.max(80, Math.min(1800, height)),
    };
    this.patch({ raidFrameSize });
    this.engine?.set_raid_frame_size?.(
      raidFrameSize.width,
      raidFrameSize.height,
    );
    if (persist)
      try {
        this.storage?.setItem(
          "pullfiction.raidFrames.size.v1",
          JSON.stringify(raidFrameSize),
        );
      } catch {}
  }
  numericDrawingAvailable() {
    return (
      this.state.drawing &&
      !!this.draftMark &&
      !this.markDrag &&
      !this.actorDrag &&
      ["circle", "cone", "arrow", "route", "polygon"].includes(this.state.tool)
    );
  }
  setDrawingDimension(value: string) {
    if (
      !this.state.drawing ||
      value.length > 9 ||
      !/^\d*(?:\.\d*)?$/.test(value)
    )
      return;
    if (!this.state.dimensionInput && value)
      this.dimensionBefore = this.state.plan;
    this.patch({ dimensionInput: value });
    this.applyDrawingDimension();
  }
  cancelDrawingDimension() {
    const before = this.dimensionBefore;
    this.dimensionBefore = null;
    this.patch({ dimensionInput: "" });
    if (before) this.planState(before);
  }
  confirmDrawingDimension() {
    const n = Number(this.state.dimensionInput),
      max = ["circle", "cone"].includes(this.state.tool) ? 100 : 2000;
    if (!Number.isFinite(n) || n < 0.5 || n > max) {
      this.notify(`Enter a distance from 0.5 to ${max} yards`);
      return;
    }
    this.applyDrawingDimension();
    this.finishDrawing();
  }
  private dimensioned(mark: Annotation): Annotation {
    const n = Number(this.state.dimensionInput);
    if (
      !this.state.dimensionInput ||
      !Number.isFinite(n) ||
      n <= 0 ||
      !this.draftMark ||
      mark.id !== this.draftMark
    )
      return mark;
    const radial = ["circle", "cone"].includes(mark.type),
      amount = Math.max(0.5, Math.min(radial ? 100 : 2000, n));
    const points = mark.points.map((p) => [...p] as Point),
      index = ["route", "polygon"].includes(mark.type)
        ? Math.max(0, points.length - 2)
        : 0;
    const p = points[index],
      q = points.at(-1) ?? p,
      dx = q[0] - p[0],
      dy = q[1] - p[1],
      distance = Math.hypot(dx, dy),
      direction = distance > 1e-5 ? [dx / distance, dy / distance] : [1, 0];
    const end: Point = [
      p[0] + direction[0] * amount,
      p[1] + direction[1] * amount,
      q[2],
    ];
    if (points.length === 1) points.push(end);
    else points[points.length - 1] = end;
    return { ...mark, points, ...(radial ? { size: amount } : {}) };
  }
  private applyDrawingDimension() {
    if (!this.draftMark) return;
    this.planState(
      validatePlan({
        ...this.state.plan,
        steps: this.state.plan.steps.map((s) => ({
          ...s,
          annotations: s.annotations.map((a) => this.dimensioned(a)),
        })),
      }),
    );
  }
  attachEdit(id: string, key: string | null) {
    const original = this.state.plan.steps
      .flatMap((s) => s.annotations)
      .find((a) => a.id === id);
    if (!original || original.locked) return;
    const display = this.displayMarks().find((a) => a.id === id) ?? original;
    let points = display.points,
      actorReport: string | undefined;
    if (key) {
      const actor = this.sceneActors().find((a) => a.key === key),
        pose = actor ? this.actorPose(actor) : null;
      if (!pose) return;
      const anchor: Point = [
        pose.pos[0],
        pose.pos[1],
        pose.pos[2] ?? display.points[0][2],
      ];
      points = points.map(
        (p) => p.map((v, i) => v + anchor[i] - points[0][i]) as Point,
      );
      actorReport =
        this.displaySnapshot()?.report ?? this.state.replay?.report.code ?? "";
    }
    this.editPlan({
      ...this.state.plan,
      steps: this.state.plan.steps.map((s) => ({
        ...s,
        annotations: s.annotations.map((a) =>
          a.id === id
            ? { ...a, points, actor: key ?? undefined, actorReport }
            : a,
        ),
      })),
    });
  }
  selectedActorForDrawing() {
    const key = this.state.selected ?? this.state.selectedActors.at(-1);
    return key && this.sceneActors().some((a) => a.key === key) ? key : null;
  }
  applyMarker(icon: string) {
    const index = /^[1-8]$/.test(icon) ? Number(icon) - 1 : -1;
    const color =
      index >= 0 ? RAID_ICON_COLORS[index] : this.state.markStyle.color;
    const key = this.selectedActorForDrawing();
    this.setMarkStyle({ icon, color });
    if (key) {
      this.setTool("marker");
      this.markActor(key);
      return;
    }
    const edit = this.state.plan.steps
      .flatMap((s) => s.annotations)
      .find((a) => a.id === this.state.selectedMark);
    if (edit?.type === "marker") this.updateMark({ icon, color });
    else this.setTool("marker");
  }
  startActorDrawing(key: string) {
    if (
      ![
        "circle",
        "cone",
        "arrow",
        "marker",
        "route",
        "polygon",
        "drawing",
        "label",
      ].includes(this.state.tool)
    )
      return false;
    const actor = this.sceneActors().find((a) => a.key === key),
      pose = actor ? this.actorPose(actor) : null;
    if (!pose) return false;
    if (this.state.playing) this.seek(this.clockTime);
    if (this.state.tool === "marker") {
      this.markActor(key);
      return true;
    }
    const point: Point = [
      pose.pos[0],
      pose.pos[1],
      pose.pos[2] ??
        this.state.sceneHover?.point?.[2] ??
        raidByMap(this.state.plan.mapId)?.spawn[2] ??
        0,
    ];
    if (this.state.tool === "label") {
      const edit = {
        ...newAnnotation("label", point, {
          ...this.state.markStyle,
          label: actor!.name,
        }),
        actor: key,
        actorReport:
          this.displaySnapshot()?.report ??
          this.state.replay?.report.code ??
          "",
      };
      this.editPlan({
        ...this.state.plan,
        steps: this.state.plan.steps.map((s) =>
          s.id === this.state.activeStep
            ? { ...s, annotations: [...s.annotations, edit] }
            : s,
        ),
      });
      this.patch({ selectedMark: edit.id, selectedMarks: [edit.id] });
      this.sendAnnotations();
      return true;
    }
    this.placePoint(point);
    if (this.draftMark)
      this.planState(
        validatePlan({
          ...this.state.plan,
          steps: this.state.plan.steps.map((s) => ({
            ...s,
            annotations: s.annotations.map((a) =>
              a.id === this.draftMark
                ? {
                    ...a,
                    actor: key,
                    actorReport:
                      this.displaySnapshot()?.report ??
                      this.state.replay?.report.code ??
                      "",
                  }
                : a,
            ),
          })),
        }),
      );
    return true;
  }
  setTool(tool: Tool) {
    if (tool !== "explore" && this.state.options.followRaid)
      this.setOption("followRaid", false);
    this.engine?.hover_annotation?.(-1, -1, false);
    this.pendingPicks = 0;
    this.mapPickQueue = [];
    this.finishDrawing();
    this.pickEpoch++;
    this.finishRequested = false;
    this.patch({
      tool,
      transformActive: false,
      navigationTool: "select",
      ...(tool === "explore" ? { transform: "move" as const } : {}),
      sceneHover: null,
      ...(tool !== "explore" ? { workspaceMode: "plan" as const } : {}),
    });
  }
  setWorkspaceMode(workspaceMode: "plan" | "analyse") {
    if (workspaceMode === "plan") this.projectKind = "plan";
    this.cancelDrawing();
    if (
      workspaceMode === "plan" &&
      (this.state.playing || this.state.playPreparing)
    )
      this.toggle();
    this.patch({
      workspaceMode,
      planning: workspaceMode === "plan",
      navigationTool: "select",
      selectedActors: [],
      compareRecorded: false,
      tool: "explore",
      sceneHover: null,
      ...(workspaceMode === "analyse"
        ? { selectedMark: null, selectedMarks: [] }
        : {}),
    });
    this.sendAnnotations();
    this.sendPositions();
    if (workspaceMode === "analyse")
      this.engine?.hover_annotation?.(-1, -1, false);
    if (this.activeProject) this.scheduleAutosave();
  }
  hoverScene(x: number, y: number) {
    this.engine?.hover_annotation?.(x, y, false);
  }
  clearSceneHover() {
    this.patch({ sceneHover: null });
    this.engine?.hover_annotation?.(-1, -1, false);
  }
  beginMarkDrag(
    id: string,
    handle: number | null,
    anchor: Point,
    duplicate = false,
  ) {
    const originalPlan = this.state.plan;
    if (!this.state.selectedMarks.includes(id)) this.selectMark(id);
    if (duplicate) {
      if (!this.duplicateMark(0)) return false;
      this.undoStack.pop();
      id = this.state.selectedMark!;
      handle = null;
    }
    if (!duplicate && handle === null && this.state.selectedActors.length) {
      const key = this.state.selectedActors[0];
      return this.beginActorDrag(key, anchor);
    }
    const displayed = this.displayMarks();
    const mark = displayed.find((a) => a.id === id);
    if (!mark || mark.locked) return false;
    const kind = this.handleKind(id, handle);
    const operation = this.state.transformActive
      ? this.state.transform
      : kind === "rotate"
        ? "rotate"
        : kind === "scale"
          ? "scale"
          : "move";
    const control =
      operation !== "move"
        ? null
        : kind === "resize"
          ? 1
          : kind === "move"
            ? null
            : handle;
    this.draftBase = duplicate ? originalPlan : this.state.plan;
    this.draftMark = id;
    this.markDrag = {
      id,
      axis:
        this.state.transformActive &&
        this.state.transform === "move" &&
        handle === 1
          ? 0
          : this.state.transformActive &&
              this.state.transform === "move" &&
              handle === 2
            ? 1
            : undefined,
      operation,
      handle:
        !this.state.transformActive && this.state.selectedMarks.length === 1
          ? control
          : null,
      anchor,
      points: mark.points.map((p) => [...p]),
      group: Object.fromEntries(
        displayed
          .filter((a) => this.state.selectedMarks.includes(a.id) && !a.locked)
          .map((a) => [a.id, a.points.map((p) => [...p] as Point)]),
      ),
    };
    this.patch({ drawing: true });
    return true;
  }
  setSnap(change: Partial<SnapSettings>) {
    const snap = { ...this.state.snap, ...change };
    if (
      !Number.isFinite(snap.yards) ||
      snap.yards < 0.1 ||
      snap.yards > 100 ||
      !Number.isFinite(snap.degrees) ||
      snap.degrees < 1 ||
      snap.degrees > 180
    )
      return;
    this.patch({ snap });
  }
  setSnapBypass(on: boolean) {
    if (this.state.snapBypass !== on) this.patch({ snapBypass: on });
  }
  orbitCandidate() {
    const actors = this.sceneActors(),
      key = this.state.selected ?? this.state.selectedActors[0];
    return (
      actors.find((a) => a.key === key && a.type === "Player") ??
      (this.state.cameraMode === "orbit"
        ? actors.find(
            (a) => a.key === this.state.orbitTarget && a.type === "Player",
          )
        : undefined)
    );
  }
  freeCameraInput() {
    return !this.mapView && this.state.cameraMode === "free";
  }
  setCameraMode(cameraMode: Snapshot["cameraMode"]) {
    if (cameraMode === "orbit") {
      const actor = this.orbitCandidate();
      if (!actor) {
        this.notify("Select a player to orbit");
        return;
      }
      this.setOption("followRaid", false);
      this.patch({
        cameraMode,
        orbitTarget: actor.key,
        navigationTool: "select",
        spacePan: false,
      });
      this.focus(actor.key, false);
    } else this.patch({ cameraMode, orbitTarget: null, spacePan: false });
  }
  setNavigationTool(navigationTool: Snapshot["navigationTool"]) {
    if (navigationTool === "orbit") {
      this.setCameraMode("orbit");
      return;
    }
    this.setTool("explore");
    this.patch({ navigationTool });
  }
  setSpacePan(on: boolean) {
    if (this.state.spacePan !== on) this.patch({ spacePan: on });
  }
  setTransform(transform: Transform) {
    this.setTool("explore");
    this.patch({ transform, transformActive: true });
    this.sendAnnotations();
  }
  setSelectionFilter(selectionFilter: Snapshot["selectionFilter"]) {
    this.patch({ selectionFilter });
  }
  private snapSize(n: number) {
    return Math.max(
      0.5,
      Math.min(
        100,
        this.state.snap.size && !this.state.snapBypass
          ? snapValue(n, this.state.snap.yards)
          : n,
      ),
    );
  }
  visiblePages() {
    const plan = this.state.plan,
      time = this.clockTime,
      active = this.state.activeStep,
      timed = !!this.state.replay && this.state.followSteps,
      all = this.state.showAllSteps;
    const c = this.visibleCache;
    if (
      c &&
      c.plan === plan &&
      c.time === time &&
      c.active === active &&
      c.timed === timed &&
      c.all === all
    )
      return c.pages;
    const pages = activePages(plan, time, active, timed, all);
    this.visibleCache = { plan, time, active, timed, all, pages };
    return pages;
  }
  displaySnapshot() {
    const pages = this.visiblePages();
    if (this.compositionCache?.pages === pages)
      return this.compositionCache.snapshot;
    const snapshots = pages.flatMap((s) => (s.snapshot ? [s.snapshot] : [])),
      base = snapshots.at(-1);
    const actors = new Map(
      snapshots
        .filter((s) => s.report === base?.report)
        .flatMap((s) => s.actors.map((a) => [a.key, a] as const)),
    );
    const snapshot = base
      ? { ...base, actors: [...actors.values()] }
      : undefined;
    this.compositionCache = { pages, snapshot };
    return snapshot;
  }
  addLayer() {
    const layer = {
      id: planId(),
      name: `Layer ${this.state.plan.layers.length + 1}`,
      hidden: false,
    };
    const page = { ...newStep(layer.name, "phase"), layerId: layer.id };
    this.editPlan({
      ...this.state.plan,
      layers: [...this.state.plan.layers, layer],
      steps: [...this.state.plan.steps, page],
    });
    this.setActiveStep(page.id, false);
  }
  updateLayer(id: string, change: Partial<Plan["layers"][number]>) {
    this.editPlan({
      ...this.state.plan,
      layers: this.state.plan.layers.map((l) =>
        l.id === id ? { ...l, ...change, id: l.id } : l,
      ),
    });
  }
  moveLayer(id: string, direction: number) {
    const layers = [...this.state.plan.layers],
      i = layers.findIndex((l) => l.id === id),
      j = i + direction;
    if (i < 0 || j < 0 || j >= layers.length) return;
    [layers[i], layers[j]] = [layers[j], layers[i]];
    this.editPlan({ ...this.state.plan, layers });
  }
  deleteLayer(id: string) {
    if (this.state.plan.layers.length === 1) return;
    const layers = this.state.plan.layers.filter((l) => l.id !== id),
      steps = this.state.plan.steps.filter((s) => s.layerId !== id);
    this.editPlan({
      ...this.state.plan,
      layers,
      steps: steps.length ? steps : [{ ...newStep(), layerId: layers[0].id }],
    });
  }
  addLayerPage(layerId: string) {
    const layer = this.state.plan.layers.find((l) => l.id === layerId);
    if (!layer) return;
    const page = {
      ...newStep(
        `${layer.name} ${this.state.plan.steps.filter((s) => s.layerId === layerId).length + 1}`,
        "phase",
      ),
      layerId,
    };
    this.editPlan({
      ...this.state.plan,
      steps: [...this.state.plan.steps, page],
    });
    this.setActiveStep(page.id, false);
  }
  movePageTo(id: string, layerId: string, index: number) {
    if (!this.state.plan.layers.some((l) => l.id === layerId)) return;
    const steps = [...this.state.plan.steps],
      i = steps.findIndex((s) => s.id === id);
    if (i < 0) return;
    const [page] = steps.splice(i, 1);
    steps.splice(Math.max(0, Math.min(steps.length, index)), 0, {
      ...page,
      layerId,
    });
    this.editPlan({ ...this.state.plan, steps });
  }
  stepPage(direction: number) {
    const steps = this.state.plan.steps.filter(
        (s) => !this.state.plan.layers.find((l) => l.id === s.layerId)?.hidden,
      ),
      index = steps.findIndex((s) => s.id === this.state.activeStep);
    const next =
      steps[Math.max(0, Math.min(steps.length - 1, index + direction))];
    if (next) this.setActiveStep(next.id);
  }
  setPeriod(layerId: string, start: number, end: number) {
    const current = this.state.plan.steps.find(
        (s) => s.id === this.state.activeStep,
      ),
      layer = this.state.plan.layers.find((l) => l.id === layerId);
    if (
      !layer ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start
    )
      return;
    if (
      current?.layerId === layerId &&
      current.start === null &&
      current.end === null
    ) {
      this.updateStep({ start, end });
    } else {
      const page = {
        ...newStep(
          `${layer.name} ${this.state.plan.steps.filter((s) => s.layerId === layerId).length + 1}`,
          "phase",
        ),
        layerId,
        start,
        end,
      };
      this.editPlan({
        ...this.state.plan,
        steps: [...this.state.plan.steps, page],
      });
      this.setActiveStep(page.id, false);
    }
    this.setStepView({ followSteps: true });
    this.seek(start);
  }
  snapshot() {
    return this.state.plan.steps.find((s) => s.id === this.state.activeStep)
      ?.snapshot;
  }
  private defaultActorsCache?: {
    map: number;
    version: GameVersion;
    models: object;
    actors: Actor[];
  };
  private defaultRaidActors(): Actor[] {
    if (this.state.replay || this.displaySnapshot()?.report) return [];
    const { mapId: map, gameVersion: version } = this.state.plan;
    const models = this.state.browserAssets
      ? this.referenceModels[version]
      : this.models;
    const cached = this.defaultActorsCache;
    if (
      cached?.map === map &&
      cached.version === version &&
      cached.models === models
    )
      return cached.actors;
    const actors = referenceRaidActors(map, version, models);
    this.defaultActorsCache = { map, version, models, actors };
    return actors;
  }
  referenceSpawnNotice() {
    return this.state.replay || this.displaySnapshot()?.report
      ? null
      : referenceSpawnNotice(this.state.plan.mapId, this.state.gameVersion);
  }
  sceneActors(): Actor[] {
    const snapshot =
      this.state.workspaceMode === "plan" ? this.displaySnapshot() : undefined;
    if (!snapshot) return this.state.replay?.actors ?? this.defaultRaidActors();
    const source = new Map(
      this.state.replay?.report.code === snapshot.report
        ? this.state.replay.actors.map((a) => [a.key, a])
        : this.defaultRaidActors().map((a) => [a.key, a]),
    );
    const plannedKeys = new Set(snapshot.actors.map((actor) => actor.key));
    const defaults = this.defaultRaidActors().filter(
      (actor) => !plannedKeys.has(actor.key),
    );
    return [
      ...defaults,
      ...snapshot.actors
        .map((p) => source.get(p.key))
        .map(
          (a, i) =>
            a ??
            ({
              key: snapshot.actors[i].key,
              name: snapshot.actors[i].name,
              class: snapshot.actors[i].class,
              icon: snapshot.actors[i].icon,
              type: snapshot.actors[i].type,
              id: 0,
              instance: 1,
              gameID: snapshot.actors[i].gameID ?? 0,
              displayID: snapshot.actors[i].displayID ?? null,
              scale: snapshot.actors[i].scale ?? 1,
              race: snapshot.actors[i].race,
              sex: snapshot.actors[i].sex,
              samples: [],
              deaths: [],
              firstSeen: 0,
              lastSeen: Infinity,
              runLifetime: true,
              facings: [],
              headings: [],
              gear: [],
              health: [],
              power: [],
              resourceChanges: [],
              casts: [],
              auras: [],
              initialAuras: [],
            } as Actor),
        ),
    ];
  }
  private nearbyReferenceHeight(
    actor: Actor,
    geometry: ReplayFloorGeometry | undefined,
    x: number,
    y: number,
    hint: number,
  ) {
    if (!geometry) return undefined;
    const entry = this.nearbyFloorHeights.get(actor);
    if (
      entry &&
      entry.geometry === geometry &&
      Object.is(entry.x, x) &&
      Object.is(entry.y, y) &&
      Object.is(entry.hint, hint)
    )
      return entry.value;
    const value = geometry.nearbyStructureHeight(x, y, hint, 3);
    this.nearbyFloorHeights.set(actor, { geometry, x, y, hint, value });
    return value;
  }
  actorPose(actor: Actor, lookupPose: typeof poseAt = poseAt) {
    const pose = lookupPose(
      actor,
      this.clockTime,
      this.state.options.smoothGaps,
    );
    const planned =
      this.state.workspaceMode === "plan"
        ? this.displaySnapshot()?.actors.find((a) => a.key === actor.key)
        : undefined;
    if (
      !planned &&
      !this.state.replay &&
      actor.spawn &&
      pose &&
      pose.pos[2] === null
    ) {
      const geometry = this.loadedFloors.get(this.state.plan.mapId);
      const hint =
        actor.spawn.floorHint ??
        raidByMap(this.state.plan.mapId)?.spawn[2] ??
        0;
      const height = geometry
        ? this.actorFloorHeights.height(
            actor,
            geometry.referenceFloors,
            pose.pos[0],
            pose.pos[1],
            hint,
            actor.spawn.floorHint === undefined,
          )
        : undefined;
      const nearbyHeight =
        actor.spawn.referenceKind === "map-registered-reference"
          ? this.nearbyReferenceHeight(
              actor,
              geometry,
              pose.pos[0],
              pose.pos[1],
              hint,
            )
          : undefined;
      return {
        ...pose,
        nearbyGround: nearbyHeight !== undefined,
        pos: [pose.pos[0], pose.pos[1], nearbyHeight ?? height ?? hint] as [
          number,
          number,
          number,
        ],
      };
    }
    const plannedPosition = planned
      ? this.state.compareRecorded
        ? (planned.recorded ?? planned.position)
        : planned.position
      : undefined;
    return planned
      ? {
          ...(pose ?? {}),
          pos: plannedPosition!,
          nearbyGround:
            !this.state.replay &&
            actor.spawn?.referenceKind === "map-registered-reference" &&
            this.nearbyReferenceHeight(
              actor,
              this.loadedFloors.get(this.state.plan.mapId),
              plannedPosition![0],
              plannedPosition![1],
              plannedPosition![2],
            ) !== undefined,
          facing: this.state.compareRecorded
            ? (planned.recordedFacing ?? planned.facing)
            : planned.facing,
          speed: 0,
          movement: null,
          dead: false,
          estimated: false,
          wisp: false,
        }
      : pose;
  }
  addPlanActor(name: string, actorClass: string) {
    name = name.trim();
    if (!name || name.length > 120 || !classIDs[actorClass]) return;
    const snapshot = this.snapshot() ?? {
      report: "",
      time: this.clockTime,
      actors: [],
    };
    if (snapshot.actors.length >= 4096) return;
    const spawn = this.state.sceneHover?.point ??
      raidByMap(this.state.plan.mapId)?.spawn ?? [0, 0, 0];
    const key = `plan:${planId()}`,
      position: Point = [
        spawn[0] + (snapshot.actors.length % 5) * 2,
        spawn[1] + Math.floor(snapshot.actors.length / 5) * 2,
        spawn[2],
      ];
    const actor = {
      key,
      name,
      class: actorClass,
      type: "Player",
      position,
      facing: 0,
      race: 1,
      sex: 0,
      scale: 1,
    };
    this.updateStep({
      snapshot: { ...snapshot, actors: [...snapshot.actors, actor] },
    });
    this.selectActor(key);
    this.render();
    this.frameSelection();
  }
  planFromMoment() {
    if (
      this.state.replay?.raw.stream &&
      (!this.bufferedReady(this.clockTime) || this.state.buffering)
    ) {
      this.notify(
        "Wait for this replay section to load before creating a plan.",
      );
      return;
    }
    const replay = this.state.replay;
    if (!replay) return;
    if (this.state.playing) this.toggle();
    const floorHints = this.replayFloors(replay);
    const actors = replay.actors.flatMap((a) => {
      const p = poseAt(a, this.clockTime, this.state.options.smoothGaps);
      return p && !p.dead
        ? [
            {
              key: a.key,
              name: a.name,
              class: a.class ?? "",
              icon: a.icon ?? null,
              type: a.type,
              position: [
                p.pos[0],
                p.pos[1],
                p.pos[2] ??
                  floorHints.get(a.key) ??
                  raidByMap(replay.map)?.spawn[2] ??
                  0,
              ] as Point,
              recorded: [
                p.pos[0],
                p.pos[1],
                p.pos[2] ??
                  floorHints.get(a.key) ??
                  raidByMap(replay.map)?.spawn[2] ??
                  0,
              ] as Point,
              facing: p.facing ?? 0,
              recordedFacing: p.facing ?? 0,
              ...(a.displayID ? { displayID: a.displayID } : {}),
              gameID: a.gameID ?? 0,
              scale: a.scale ?? 1,
              ...(a.race ? { race: a.race } : {}),
              ...(a.sex !== null && a.sex !== undefined ? { sex: a.sex } : {}),
            },
          ]
        : [];
    });
    const start = Math.max(0, Math.min(this.clockTime, replay.duration - 100));
    const end = Math.max(
      start + 100,
      chapterAt(replay, this.clockTime)?.end ??
        Math.min(replay.duration, start + 30000),
    );
    const step = {
      ...newStep(
        `${chapterAt(replay, this.clockTime)?.name ?? replay.fight.name} · plan`.slice(
          0,
          100,
        ),
        "boss",
      ),
      start,
      end,
      snapshot: { report: replay.report.code, time: this.clockTime, actors },
    };
    step.layerId =
      this.state.plan.steps.find((s) => s.id === this.state.activeStep)
        ?.layerId ?? this.state.plan.layers[0].id;
    this.editPlan({
      ...this.state.plan,
      steps: [...this.state.plan.steps, step],
    });
    this.setWorkspaceMode("plan");
    this.setActiveStep(step.id, false);
    this.setStepView({ followSteps: true });
    this.setOption("followRaid", false);
    this.render();
  }
  setCompareRecorded(compareRecorded: boolean) {
    this.cancelDrawing();
    this.patch({ compareRecorded });
    this.sendPositions();
    this.sendAnnotations();
  }
  selectActors(keys: string[], mode: "replace" | "add" | "toggle" = "replace") {
    const valid = new Set(this.sceneActors().map((a) => a.key));
    keys = keys.filter((k) => valid.has(k));
    const old = this.state.selectedActors;
    this.patch({
      selectedActors:
        mode === "replace"
          ? keys
          : mode === "add"
            ? [...new Set([...old, ...keys])]
            : [
                ...old.filter((k) => !keys.includes(k)),
                ...keys.filter((k) => !old.includes(k)),
              ],
    });
    this.sendAnnotations();
  }
  clearActorSelection() {
    this.patch({ selectedActors: [] });
    this.sendAnnotations();
  }
  selectActor(key: string, toggle = false) {
    if (!this.snapshot()?.actors.some((a) => a.key === key)) {
      if (!this.sceneActors().some((a) => a.key === key)) return;
      if (!toggle) this.selectMark(null);
      this.select(key);
      this.selectActors([key], toggle ? "toggle" : "replace");
      return;
    }
    const old = this.state.selectedActors;
    this.patch({
      selectedActors: toggle
        ? old.includes(key)
          ? old.filter((k) => k !== key)
          : [...old, key]
        : [key],
      ...(toggle ? {} : { selectedMark: null, selectedMarks: [] }),
    });
    this.select(key);
    this.sendAnnotations();
  }
  private materializeReferenceActors(keys: string[]) {
    if (this.state.replay || this.state.compareRecorded) return;
    const snapshot = this.snapshot() ?? { report: "", time: 0, actors: [] };
    const additions = this.defaultRaidActors().flatMap((actor) => {
      if (
        !keys.includes(actor.key) ||
        snapshot.actors.some((a) => a.key === actor.key)
      )
        return [];
      const pose = this.actorPose(actor);
      return pose
        ? [
            {
              key: actor.key,
              name: actor.name,
              class: actor.class,
              type: actor.type,
              gameID: actor.gameID,
              displayID: actor.displayID,
              scale: actor.scale,
              position: [...pose.pos] as Point,
              recorded: [...pose.pos] as Point,
              facing: pose.facing,
              recordedFacing: pose.facing,
            },
          ]
        : [];
    });
    if (!additions.length) return;
    const selectedActors = this.state.selectedActors;
    if (this.state.workspaceMode !== "plan") this.setWorkspaceMode("plan");
    this.updateStep({
      snapshot: { ...snapshot, actors: [...snapshot.actors, ...additions] },
    });
    if (this.state.selectedActors !== selectedActors)
      this.patch({ selectedActors });
  }
  beginActorDrag(key: string, anchor: Point, toggle = false, axis?: 0 | 1) {
    if (this.state.compareRecorded) return false;
    this.materializeReferenceActors([...this.state.selectedActors, key]);
    if (
      this.state.workspaceMode !== "plan" ||
      !this.snapshot()?.actors.some((a) => a.key === key)
    ) {
      const actor = this.sceneActors().find((a) => a.key === key),
        pose = actor ? this.actorPose(actor) : null;
      if (!pose || pose.dead || !actor) return false;
      if (this.state.replay) this.planFromMoment();
      if (!this.snapshot()?.actors.some((a) => a.key === key)) return false;
      if (!this.state.selectedActors.includes(key)) this.selectActor(key);
    }
    if (!this.state.selectedActors.includes(key)) this.selectActor(key, toggle);
    this.actorDrag = {
      base: this.state.plan,
      anchor,
      axis,
      marks: Object.fromEntries(
        this.displayMarks()
          .filter((a) => this.state.selectedMarks.includes(a.id) && !a.locked)
          .map((a) => [a.id, a.points.map((p) => [...p] as Point)]),
      ),
      positions: Object.fromEntries(
        this.snapshot()!
          .actors.filter((a) => this.state.selectedActors.includes(a.key))
          .map((a) => [a.key, [...a.position] as Point]),
      ),
    };
    this.patch({ drawing: true });
    return true;
  }
  private moveActorDrag(point: Point) {
    const d = this.actorDrag!;
    point = snapPoint(point, d.anchor, this.state.snap, this.state.snapBypass);
    if (d.constrain) {
      point = [...point];
      const dx = Math.abs(point[0] - d.anchor[0]),
        dy = Math.abs(point[1] - d.anchor[1]);
      point[dx >= dy ? 1 : 0] = d.anchor[dx >= dy ? 1 : 0];
    }
    if (d.axis !== undefined) {
      point = [...point];
      point[d.axis === 0 ? 1 : 0] = d.anchor[d.axis === 0 ? 1 : 0];
    }
    const dx = point[0] - d.anchor[0],
      dy = point[1] - d.anchor[1];
    const pivot = groundPivot([
      ...Object.values(d.positions),
      ...Object.values(d.marks).map((p) => p[0]),
    ]);
    let angle =
      Math.atan2(point[1] - pivot[1], point[0] - pivot[0]) -
      Math.atan2(d.anchor[1] - pivot[1], d.anchor[0] - pivot[0]);
    if (this.state.snap.angle && !this.state.snapBypass)
      angle = snapValue(angle, (this.state.snap.degrees * Math.PI) / 180);
    const factor = Math.max(
      0.05,
      Math.min(
        20,
        Math.hypot(point[0] - pivot[0], point[1] - pivot[1]) /
          Math.max(
            1,
            Math.hypot(d.anchor[0] - pivot[0], d.anchor[1] - pivot[1]),
          ),
      ),
    );
    this.planState(
      validatePlan({
        ...this.state.plan,
        steps: this.state.plan.steps.map((s) =>
          s.id === this.state.activeStep && s.snapshot
            ? {
                ...s,
                annotations: s.annotations.map((a) =>
                  d.marks[a.id]
                    ? {
                        ...a,
                        actor: undefined,
                        actorReport: undefined,
                        points: d.marks[a.id].map((p) =>
                          this.state.transform === "move"
                            ? ([p[0] + dx, p[1] + dy, p[2]] as Point)
                            : transformPoint(
                                p,
                                pivot,
                                this.state.transform === "rotate" ? angle : 0,
                                this.state.transform === "scale" ? factor : 1,
                              ),
                        ),
                        size:
                          this.state.transform === "scale"
                            ? this.snapSize(
                                (d.base.steps
                                  .flatMap((s) => s.annotations)
                                  .find((m) => m.id === a.id)?.size ?? a.size) *
                                  factor,
                              )
                            : a.size,
                      }
                    : a,
                ),
                snapshot: {
                  ...s.snapshot,
                  actors: s.snapshot.actors.map((a) =>
                    d.positions[a.key]
                      ? {
                          ...a,
                          position:
                            this.state.transform === "move"
                              ? ([
                                  d.positions[a.key][0] + dx,
                                  d.positions[a.key][1] + dy,
                                  d.positions[a.key][2],
                                ] as Point)
                              : transformPoint(
                                  d.positions[a.key],
                                  pivot,
                                  this.state.transform === "rotate" ? angle : 0,
                                  this.state.transform === "scale" ? factor : 1,
                                ),
                          facing:
                            this.state.transform === "rotate"
                              ? (d.base.steps
                                  .find((s) => s.id === this.state.activeStep)
                                  ?.snapshot?.actors.find(
                                    (p) => p.key === a.key,
                                  )?.facing ?? 0) + angle
                              : a.facing,
                        }
                      : a,
                  ),
                },
              }
            : s,
        ),
      }),
    );
  }
  positionActors(axis: 0 | 1, value: number) {
    if (!Number.isFinite(value) || Math.abs(value) > 20000) return;
    this.materializeReferenceActors(this.state.selectedActors);
    const actor = this.snapshot()?.actors.find((a) =>
      this.state.selectedActors.includes(a.key),
    );
    if (!actor) return;
    const bypass = this.state.snapBypass;
    this.setSnapBypass(true);
    this.nudgeActors(
      axis === 0 ? value - actor.position[0] : 0,
      axis === 1 ? value - actor.position[1] : 0,
    );
    this.setSnapBypass(bypass);
  }
  nudgeActors(dx: number, dy: number) {
    this.materializeReferenceActors(this.state.selectedActors);
    const actor = this.snapshot()?.actors.find((a) =>
      this.state.selectedActors.includes(a.key),
    );
    if (!actor || !this.beginActorDrag(actor.key, actor.position)) return;
    const transform = this.state.transform;
    this.patch({ transform: "move" });
    this.moveActorDrag([
      actor.position[0] + dx,
      actor.position[1] + dy,
      actor.position[2],
    ]);
    this.finishDrawing();
    this.patch({ transform });
  }
  attachRange(key: string, radius = 40) {
    const actor = this.sceneActors().find((a) => a.key === key),
      planned = this.snapshot()?.actors.find((a) => a.key === key);
    const pose = actor ? this.actorPose(actor) : null;
    const position =
      planned?.position ??
      (pose
        ? ([
            pose.pos[0],
            pose.pos[1],
            pose.pos[2] ?? raidByMap(this.state.plan.mapId)?.spawn[2] ?? 0,
          ] as Point)
        : null);
    if (!position) return;
    const mark = {
      ...newAnnotation("circle", position, {
        ...this.state.markStyle,
        size: radius,
        label: planned?.name ?? actor?.name ?? "Range",
      }),
      actor: key,
      actorReport:
        this.snapshot()?.report ?? this.state.replay?.report.code ?? "",
    };
    this.editPlan({
      ...this.state.plan,
      steps: this.state.plan.steps.map((s) =>
        s.id === this.state.activeStep
          ? { ...s, annotations: [...s.annotations, mark] }
          : s,
      ),
    });
    this.selectMark(mark.id);
  }
  zoomCamera(distance: number) {
    this.engine?.zoom_editor?.(distance);
  }
  navigate(pan: boolean, dx: number, dy: number) {
    this.engine?.navigate_editor?.(pan, dx, dy);
  }
  frameSelection() {
    this.setOption("followRaid", false);
    const planning = this.state.workspaceMode === "plan";
    const mark = planning
      ? this.displayMarks().find((a) => this.state.selectedMarks.includes(a.id))
      : undefined;
    const actor = planning
      ? this.snapshot()?.actors.find((a) =>
          this.state.selectedActors.includes(a.key),
        )
      : undefined;
    const p = mark?.points[0] ?? actor?.position;
    if (p) this.engine?.focus_replay(...p);
    else if (
      this.state.selected &&
      this.sceneActors().some((a) => a.key === this.state.selected)
    )
      this.focus(this.state.selected, false);
    else if (!this.focusCurrent()) this.engine?.home();
    this.patch({ frameRequest: this.state.frameRequest + 1 });
  }
  cameraPresentation(map = this.mapView) {
    const actor = this.orbitCandidate();
    if (!map && this.state.cameraMode === "orbit")
      return { value: "orbit", label: `Orbit ${actor?.name ?? "player"}` };
    if (this.state.replay && this.state.options.followRaid) {
      if (!map && this.state.options.lockCamera && actor)
        return { value: "player", label: `Follow ${actor.name}` };
      return { value: "raid", label: "Follow raid" };
    }
    return { value: "free", label: "Free camera" };
  }
  transformSelection(angleDegrees: number, scale = 1) {
    if (
      !Number.isFinite(angleDegrees) ||
      !Number.isFinite(scale) ||
      scale <= 0 ||
      scale > 20
    )
      return;
    this.materializeReferenceActors(this.state.selectedActors);
    const marks = this.displayMarks().filter(
      (a) => this.state.selectedMarks.includes(a.id) && !a.locked,
    );
    const actors =
      this.snapshot()?.actors.filter((a) =>
        this.state.selectedActors.includes(a.key),
      ) ?? [];
    const pivot = groundPivot([
      ...marks.map((a) => a.points[0]),
      ...actors.map((a) => a.position),
    ]);
    const angle =
      ((this.state.snap.angle
        ? snapValue(angleDegrees, this.state.snap.degrees)
        : angleDegrees) *
        Math.PI) /
      180;
    this.editPlan({
      ...this.state.plan,
      steps: this.state.plan.steps.map((s) => ({
        ...s,
        ...(s.id === this.state.activeStep && s.snapshot
          ? {
              snapshot: {
                ...s.snapshot,
                actors: s.snapshot.actors.map((a) =>
                  actors.some((v) => v.key === a.key)
                    ? {
                        ...a,
                        position: transformPoint(
                          a.position,
                          pivot,
                          angle,
                          scale,
                        ),
                        facing: a.facing + angle,
                      }
                    : a,
                ),
              },
            }
          : {}),
        annotations: s.annotations.map((a) => {
          const m = marks.find((m) => m.id === a.id);
          return m
            ? {
                ...a,
                actor: undefined,
                actorReport: undefined,
                points: m.points.map((p) =>
                  transformPoint(p, pivot, angle, scale),
                ),
                size: this.snapSize(a.size * scale),
              }
            : a;
        }),
      })),
    });
  }

  setPlanning(planning: boolean) {
    this.patch({ planning });
  }
  setMarkStyle(change: Partial<Snapshot["markStyle"]>) {
    this.patch({ markStyle: { ...this.state.markStyle, ...change } });
  }
  revealEdit(id: string) {
    const page = this.state.plan.steps.find((s) =>
      s.annotations.some((a) => a.id === id),
    );
    if (!page) return;
    if (
      this.state.replay &&
      page.start !== null &&
      (this.clockTime < page.start ||
        (page.end !== null && this.clockTime >= page.end))
    )
      this.seek(page.start);
    this.selectMark(id);
  }
  revealActorEdit(key: string, pageId: string, toggle = false) {
    const page = this.state.plan.steps.find(
      (s) => s.id === pageId && s.snapshot?.actors.some((a) => a.key === key),
    );
    if (!page) return;
    if (page.id !== this.state.activeStep) this.setActiveStep(page.id, false);
    if (
      this.state.replay &&
      page.start !== null &&
      (this.clockTime < page.start ||
        (page.end !== null && this.clockTime >= page.end))
    )
      this.seek(page.start);
    this.selectActor(key, toggle);
  }
  // Resolve the release hit instead of using the throttled scene-hover snapshot.
  placeSceneMarkerAt(x: number, y: number) {
    if (this.state.tool !== "marker" || ![x, y].every(Number.isFinite)) return;
    const selected = this.selectedActorForDrawing();
    if (!this.engine?.hover_annotation) {
      if (!selected || !this.startActorDrawing(selected)) this.pick(x, y);
      return;
    }
    this.pendingMarkerClicks = this.pendingMarkerClicks.filter(
      (click) =>
        click.epoch === this.pickEpoch &&
        click.projectEpoch === this.projectEpoch,
    );
    this.markerRequest = (this.markerRequest + 1) >>> 0;
    this.pendingMarkerClicks.push({
      x,
      y,
      epoch: this.pickEpoch,
      projectEpoch: this.projectEpoch,
      request: this.markerRequest,
      selectedActor: selected,
    });
    this.engine.hover_annotation(x, y, true, this.markerRequest);
  }
  selectSceneAt(x: number, y: number, toggle = false) {
    this.pendingSceneSelect = { x, y, toggle };
    this.engine?.hover_annotation?.(x, y, false);
  }
  selectMark(
    id: string | null,
    mode: "replace" | "add" | "toggle" | "range" = "replace",
  ) {
    this.pendingPicks = 0;
    this.mapPickQueue = [];
    this.finishDrawing();
    this.pickEpoch++;
    const step = this.state.plan.steps.find((s) =>
      s.annotations.some((a) => a.id === id),
    );
    let ids =
      mode === "replace" ? (id ? [id] : []) : [...this.state.selectedMarks];
    if (id && mode === "range") {
      const list = (step?.annotations ?? []).map((a) => a.id),
        from = Math.max(0, list.indexOf(this.state.selectedMark ?? id)),
        to = list.indexOf(id);
      ids = [
        ...new Set([
          ...ids,
          ...list.slice(Math.min(from, to), Math.max(from, to) + 1),
        ]),
      ];
    } else if (id && mode === "toggle")
      ids = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    else if (id && mode === "add") ids = [...new Set([...ids, id])];
    this.patch({
      selectedMark: ids.at(-1) ?? null,
      ...(mode === "replace" ? { selectedActors: [] } : {}),
      selectedMarks: ids,
      ...(id
        ? {
            selected: null,
            detail: null,
            ...(step ? { activeStep: step.id } : {}),
          }
        : {}),
    });
    if (id) this.engine?.select_replay("");
    this.sendAnnotations();
  }
  selectMarks(ids: string[], mode: "replace" | "add" | "toggle" = "replace") {
    const valid = new Set(this.displayMarks().map((a) => a.id));
    ids = [...new Set(ids)].filter((id) => valid.has(id));
    const old = this.state.selectedMarks,
      actors = this.state.selectedActors;
    const next =
      mode === "replace"
        ? ids
        : mode === "add"
          ? [...new Set([...old, ...ids])]
          : [
              ...old.filter((id) => !ids.includes(id)),
              ...ids.filter((id) => !old.includes(id)),
            ];
    this.selectMark(null);
    this.patch({
      selectedMarks: next,
      selectedActors: actors,
      selectedMark: next.at(-1) ?? null,
      ...(next.length ? { selected: null, detail: null } : {}),
    });
    this.sendAnnotations();
  }
  displayMarks() {
    let actors: Map<string, Actor> | undefined;
    return this.visiblePages()
      .flatMap((s) => s.annotations.filter((a) => !a.hidden))
      .map((a) => {
        if (!a.actor) return a;
        const planned =
          this.state.workspaceMode === "plan"
            ? this.displaySnapshot()?.actors.find((p) => p.key === a.actor)
            : undefined;
        const actor =
          a.actorReport === (this.state.replay?.report.code ?? "")
            ? (actors ??= new Map(
                this.sceneActors().map((actor) => [actor.key, actor]),
              )).get(a.actor)
            : undefined;
        const pose = actor ? this.actorPose(actor) : null;
        if (!planned && !pose) return { ...a, actor: undefined };
        const pos: Point = (planned
          ? this.state.compareRecorded
            ? (planned.recorded ?? planned.position)
            : planned.position
          : undefined) ?? [
          pose!.pos[0],
          pose!.pos[1],
          pose!.pos[2] ?? a.points[0][2],
        ];
        return {
          ...a,
          points: a.points.map(
            (p) => p.map((n, i) => n + pos[i] - a.points[0][i]) as Point,
          ),
        };
      })
      .map((a) =>
        a.id === this.draftMark && this.pathPreview
          ? { ...a, points: [...a.points, this.pathPreview] }
          : a,
      );
  }
  markActor(key: string) {
    const actor = this.sceneActors().find((a) => a.key === key);
    const report =
      this.snapshot()?.report ?? this.state.replay?.report.code ?? "";
    if (!actor) return;
    const existing = this.state.plan.steps
      .find((s) => s.id === this.state.activeStep)
      ?.annotations.find(
        (a) =>
          a.type === "marker" && a.actor === key && a.actorReport === report,
      );
    if (existing) {
      if (existing.locked) {
        this.notify("This actor marker is locked");
        return;
      }
      this.editPlan({
        ...this.state.plan,
        steps: this.state.plan.steps.map((s) => ({
          ...s,
          annotations: s.annotations.map((a) =>
            a.id === existing.id ? { ...a, ...this.state.markStyle } : a,
          ),
        })),
      });
      this.patch({ selectedMark: existing.id, selectedMarks: [existing.id] });
      this.sendAnnotations();
      return;
    }
    const pose = this.actorPose(actor);
    if (!pose) return;
    const mark = newAnnotation(
      "marker",
      [
        pose.pos[0],
        pose.pos[1],
        pose.pos[2] ??
          this.state.sceneHover?.point?.[2] ??
          this.state.plan.steps.flatMap((s) => s.annotations)[0]
            ?.points[0]?.[2] ??
          raidByMap(this.state.plan.mapId)?.spawn[2] ??
          0,
      ],
      { ...this.state.markStyle, label: actor.name },
    );
    const attached = {
      ...mark,
      actor: key,
      actorReport: report,
    };
    this.editPlan({
      ...this.state.plan,
      steps: this.state.plan.steps.map((s) =>
        s.id === this.state.activeStep
          ? {
              ...s,
              annotations: [
                ...s.annotations.filter(
                  (a) =>
                    a.type !== "marker" ||
                    a.actor !== key ||
                    a.actorReport !== attached.actorReport,
                ),
                attached,
              ],
            }
          : s,
      ),
    });
    this.patch({ selectedMark: mark.id, selectedMarks: [mark.id] });
    this.sendAnnotations();
  }
  selectAllMarks() {
    if (this.state.selectionFilter !== "actors")
      this.selectMarks(this.displayMarks().map((a) => a.id));
    if (this.state.selectionFilter !== "drawings") {
      // Logged actors become editable through a snapshot. Standalone reference
      // actors can be materialized lazily by the next editing operation.
      const actors = this.state.replay
        ? (this.snapshot()?.actors ?? [])
        : this.sceneActors();
      this.selectActors(actors.map((a) => a.key));
    }
  }
  boxSelect(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    mode: "replace" | "add" | "toggle",
  ) {
    this.engine?.select_annotations_rect?.(
      x1,
      y1,
      x2,
      y2,
      ["replace", "add", "toggle"].indexOf(mode),
      this.pickEpoch,
    );
  }
  nudgeScreen(dx: number, dy: number) {
    if (this.mapView) this.nudgeMarks(dy, -dx);
    else
      this.nudgeMarks(
        this.viewBasis.right[0] * dx + this.viewBasis.up[0] * dy,
        this.viewBasis.right[1] * dx + this.viewBasis.up[1] * dy,
      );
  }
  nudgeMarks(dx: number, dy: number) {
    if (this.state.selectedActors.length) {
      this.nudgeActors(dx, dy);
      return;
    }
    const ids = new Set(this.state.selectedMarks);
    const displayed = new Map(this.displayMarks().map((a) => [a.id, a.points]));
    this.editPlan({
      ...this.state.plan,
      steps: this.state.plan.steps.map((s) => ({
        ...s,
        annotations: s.annotations.map((a) =>
          ids.has(a.id) && !a.locked
            ? {
                ...a,
                actor: undefined,
                actorReport: undefined,
                points: (displayed.get(a.id) ?? a.points).map(
                  (p) => [p[0] + dx, p[1] + dy, p[2]] as Point,
                ),
              }
            : a,
        ),
      })),
    });
  }
  copyMarks(cut = false) {
    if (!this.state.selectedMarks.length) return;
    this.clipboard = structuredClone(
      this.state.plan.steps
        .flatMap((s) => s.annotations)
        .filter(
          (a) => this.state.selectedMarks.includes(a.id) && (!cut || !a.locked),
        ),
    );
    if (cut) this.removeMark();
  }
  pasteMarks(offset = 3) {
    if (!this.clipboard.length) return false;
    const copies = this.clipboard.map((a) => ({
      ...structuredClone(a),
      name: "",
      id: planId(),
      locked: false,
      points: a.points.map(
        (p) => [p[0] + offset, p[1] + offset, p[2]] as Point,
      ),
      comments: a.comments.map((c) => ({ ...c, id: planId() })),
    }));
    const previous = this.state.plan;
    this.editPlan({
      ...this.state.plan,
      steps: this.state.plan.steps.map((s) =>
        s.id === this.state.activeStep
          ? { ...s, annotations: [...s.annotations, ...copies] }
          : s,
      ),
    });
    if (this.state.plan === previous) return false;
    this.selectMarks(copies.map((a) => a.id));
    return true;
  }
  updateMark(change: Partial<Annotation>) {
    const id = this.state.selectedMark,
      step = this.state.plan.steps.find((s) =>
        s.annotations.some((a) => a.id === id),
      );
    const mark = step?.annotations.find((a) => a.id === id);
    if (!mark) return;
    if (
      this.state.selectedMarks.length === 1 &&
      mark.locked &&
      Object.keys(change).some((k) => k !== "locked")
    )
      return;
    this.editPlan({
      ...this.state.plan,
      steps: this.state.plan.steps.map((s) => ({
        ...s,
        annotations: s.annotations.map((a) =>
          this.state.selectedMarks.includes(a.id) &&
          (!a.locked || Object.keys(change).every((k) => k === "locked"))
            ? { ...a, ...change, id: a.id }
            : a,
        ),
      })),
    });
  }
  removeMark() {
    const ids = new Set(this.state.selectedMarks);
    if (!ids.size) return;
    this.editPlan({
      ...this.state.plan,
      steps: this.state.plan.steps.map((s) => ({
        ...s,
        annotations: s.annotations.filter((a) => !ids.has(a.id) || a.locked),
      })),
    });
    this.selectMarks(
      this.state.selectedMarks.filter((id) =>
        this.state.plan.steps.some((s) =>
          s.annotations.some((a) => a.id === id),
        ),
      ),
    );
  }
  duplicateMark(offset = 3) {
    if (!this.state.selectedMarks.length) return false;
    this.copyMarks();
    return this.pasteMarks(offset);
  }
  comment(text: string) {
    const a = this.state.plan.steps
      .flatMap((s) => s.annotations)
      .find((a) => a.id === this.state.selectedMark);
    if (a && text.trim())
      this.updateMark({
        comments: [
          ...a.comments,
          {
            id: planId(),
            text: text.trim(),
            createdAt: new Date().toISOString(),
          },
        ],
      });
  }
  setActiveStep(id: string, seek = true) {
    if (!this.state.plan.steps.some((s) => s.id === id)) return;
    this.pendingPicks = 0;
    this.mapPickQueue = [];
    this.finishDrawing();
    this.pickEpoch++;
    this.patch({
      activeStep: id,
      selectedMark: null,
      selectedMarks: [],
      selectedActors: [],
      compareRecorded: false,
    });
    this.sendPositions();
    this.sendAnnotations();
    const step = this.state.plan.steps.find((s) => s.id === id);
    if (seek && step && step.start !== null) this.seek(step!.start!);
  }
  updateStep(change: Partial<PlanStep>) {
    this.editPlan({
      ...this.state.plan,
      steps: this.state.plan.steps.map((s) =>
        s.id === this.state.activeStep ? { ...s, ...change, id: s.id } : s,
      ),
    });
  }
  addTimedStep() {
    const start = Math.min(this.clockTime, this.duration() - 100);
    this.addStep("phase");
    this.updateStep({ start, end: Math.min(this.duration(), start + 30000) });
  }
  addStep(kind: PlanStep["kind"] = "pull") {
    const step = newStep(
      `${kind === "phase" ? "Phase" : kind === "boss" ? "Boss" : "Pull"} ${this.state.plan.steps.length + 1}`,
      kind,
    );
    step.layerId =
      this.state.plan.steps.find((s) => s.id === this.state.activeStep)
        ?.layerId ?? this.state.plan.layers[0].id;
    this.editPlan({
      ...this.state.plan,
      steps: [...this.state.plan.steps, step],
    });
    this.setActiveStep(step.id, false);
  }
  deleteStep() {
    if (this.state.plan.steps.length === 1) return;
    this.editPlan({
      ...this.state.plan,
      steps: this.state.plan.steps.filter(
        (s) => s.id !== this.state.activeStep,
      ),
    });
  }
  duplicateStep() {
    const source = this.state.plan.steps.find(
      (s) => s.id === this.state.activeStep,
    )!;
    const copy = {
      ...structuredClone(source),
      id: planId(),
      name: `${source.name} copy`.slice(0, 100),
      annotations: source.annotations.map((a) => ({
        ...structuredClone(a),
        id: planId(),
        comments: a.comments.map((c) => ({ ...c, id: planId() })),
      })),
    };
    const steps = [...this.state.plan.steps],
      i = steps.findIndex((s) => s.id === source.id);
    steps.splice(i + 1, 0, copy);
    this.editPlan({ ...this.state.plan, steps });
    this.setActiveStep(copy.id, false);
  }
  moveStep(direction: number) {
    const steps = [...this.state.plan.steps],
      i = steps.findIndex((s) => s.id === this.state.activeStep),
      j = i + direction;
    if (j < 0 || j >= steps.length) return;
    [steps[i], steps[j]] = [steps[j], steps[i]];
    this.editPlan({ ...this.state.plan, steps });
  }
  reorderStep(id: string, before: string) {
    const steps = [...this.state.plan.steps],
      from = steps.findIndex((s) => s.id === id);
    if (from < 0 || id === before) return;
    const [step] = steps.splice(from, 1);
    const to = steps.findIndex((s) => s.id === before);
    if (to < 0) return;
    steps.splice(to, 0, step);
    this.editPlan({ ...this.state.plan, steps });
  }
  stepsFromLog() {
    const r = this.state.replay;
    if (!r) return;
    const chapters = r.chapters.length
      ? r.chapters
      : [
          {
            id: r.fight.id,
            name: r.fight.name,
            start: 0,
            end: r.duration,
            encounterID: r.fight.encounterID,
          },
        ];
    const existing = this.state.plan.steps.filter(
      (s) => s.annotations.length || s.notes || s.start !== null,
    );
    const steps = chapters.slice(0, 128 - existing.length).map((c) => ({
      ...newStep(c.name, c.encounterID ? "boss" : "pull"),
      layerId:
        this.state.plan.steps.find((s) => s.id === this.state.activeStep)
          ?.layerId ?? this.state.plan.layers[0].id,
      start: c.start,
      end: c.end,
    }));
    if (!steps.length) return;
    this.editPlan({ ...this.state.plan, steps: [...existing, ...steps] });
    this.setActiveStep(steps[0].id, false);
    this.patch({ planning: true });
  }
  setStepView(change: Partial<Pick<Snapshot, "showAllSteps" | "followSteps">>) {
    this.patch(change);
    this.sendAnnotations();
  }
  finishDrawing() {
    if (this.pendingPicks) {
      this.finishRequested = true;
      return;
    }
    this.dimensionBefore = null;
    this.pathPreview = null;
    if (this.state.dimensionInput) this.patch({ dimensionInput: "" });
    if (this.actorDrag) {
      const base = this.actorDrag.base;
      this.actorDrag = null;
      this.finishRequested = false;
      if (JSON.stringify(base) !== JSON.stringify(this.state.plan)) {
        this.undoStack.push(base);
        this.redoStack = [];
      }
      this.patch({ drawing: false });
      this.planState(this.state.plan);
      return;
    }
    if (this.draftBase) {
      if (JSON.stringify(this.draftBase) !== JSON.stringify(this.state.plan)) {
        this.undoStack.push(this.draftBase);
        if (this.undoStack.length > 100) this.undoStack.shift();
        this.redoStack = [];
      }
      this.draftBase = null;
      this.draftMark = null;
      this.markDrag = null;
      this.patch({ drawing: false });
      this.planState(this.state.plan);
    }
    this.finishRequested = false;
  }
  cancelDrawing() {
    this.dimensionBefore = null;
    this.pathPreview = null;
    this.patch({ dimensionInput: "" });
    const base = this.actorDrag?.base ?? this.draftBase;
    this.actorDrag = null;
    this.draftBase = null;
    this.draftMark = null;
    this.markDrag = null;
    this.pickEpoch++;
    this.pendingMarkerClicks = [];
    this.pendingPicks = 0;
    this.mapPickQueue = [];
    this.finishRequested = false;
    this.saveWhenReady = false;
    this.patch({ drawing: false });
    if (base) this.planState(base);
  }
  private placePoint(point: Point, preview = false) {
    const layer = this.state.plan.layers.find(
      (l) =>
        l.id ===
        this.state.plan.steps.find((s) => s.id === this.state.activeStep)
          ?.layerId,
    );
    if (layer?.hidden) {
      this.notify("Show this layer before editing it");
      return;
    }
    const { tool, plan, activeStep, markStyle } = this.state;
    if (this.actorDrag) {
      this.moveActorDrag(point);
      return;
    }
    point = snapPoint(
      point,
      this.markDrag?.anchor ??
        this.state.plan.steps
          .flatMap((s) => s.annotations)
          .find((a) => a.id === this.draftMark)?.points[0],
      this.state.snap,
      this.state.snapBypass,
    );
    if (!this.markDrag && ["route", "polygon"].includes(tool)) {
      if (preview) {
        if (!this.draftMark) return;
        this.pathPreview = point;
        this.patch({});
        this.sendAnnotations();
        return;
      }
      this.pathPreview = null;
    }
    if (this.markDrag) {
      const drag = this.markDrag;
      const operation = drag.operation ?? this.state.transform;
      if (drag.axis !== undefined) {
        point = [...point];
        point[drag.axis === 0 ? 1 : 0] = drag.anchor[drag.axis === 0 ? 1 : 0];
      }
      if (drag.constrain) {
        point = [...point];
        const dx = Math.abs(point[0] - drag.anchor[0]),
          dy = Math.abs(point[1] - drag.anchor[1]);
        point[dx >= dy ? 1 : 0] = drag.anchor[dx >= dy ? 1 : 0];
      }
      const steps = plan.steps.map((s) => ({
        ...s,
        annotations: s.annotations.map((a) => {
          if (!drag.group[a.id]) return a;
          if (operation !== "move" && drag.handle === null) {
            const pivot = groundPivot(
              Object.values(drag.group).map((p) => p[0]),
            );
            const initial = Math.atan2(
              drag.anchor[1] - pivot[1],
              drag.anchor[0] - pivot[0],
            );
            let angle =
              Math.atan2(point[1] - pivot[1], point[0] - pivot[0]) - initial;
            if (this.state.snap.angle && !this.state.snapBypass)
              angle = snapValue(
                angle,
                (this.state.snap.degrees * Math.PI) / 180,
              );
            const factor = Math.max(
              0.05,
              Math.min(
                20,
                Math.hypot(point[0] - pivot[0], point[1] - pivot[1]) /
                  Math.max(
                    1,
                    Math.hypot(
                      drag.anchor[0] - pivot[0],
                      drag.anchor[1] - pivot[1],
                    ),
                  ),
              ),
            );
            return {
              ...a,
              actor: undefined,
              actorReport: undefined,
              points: drag.group[a.id].map((p) =>
                transformPoint(
                  p,
                  pivot,
                  operation === "rotate" ? angle : 0,
                  operation === "scale" ? factor : 1,
                ),
              ),
              size:
                operation === "scale"
                  ? this.snapSize(
                      (this.draftBase?.steps
                        .flatMap((s) => s.annotations)
                        .find((m) => m.id === a.id)?.size ?? a.size) * factor,
                    )
                  : a.size,
            };
          }
          if (a.id !== drag.id || drag.handle === null)
            return {
              ...a,
              actor: undefined,
              actorReport: undefined,
              points: drag.group[a.id].map(
                (p) => p.map((n, i) => n + point[i] - drag.anchor[i]) as Point,
              ),
            };
          if (
            drag.handle !== null &&
            drag.handle >= 0 &&
            (drag.handle < drag.points.length ||
              (drag.handle === 1 && ["circle", "cone"].includes(a.type)))
          ) {
            const points = drag.points.map((p, i) =>
              i === drag.handle ? ([...point] as Point) : ([...p] as Point),
            );
            if (drag.handle === 1 && points.length === 1)
              points.push([...point]);
            const size =
              ["circle", "cone"].includes(a.type) && drag.handle === 1
                ? Math.max(
                    0.5,
                    Math.min(
                      100,
                      Math.hypot(
                        point[0] - points[0][0],
                        point[1] - points[0][1],
                      ),
                    ),
                  )
                : a.size;
            // The center handle translates a radial shape as a whole.
            if (["circle", "cone"].includes(a.type) && drag.handle === 0)
              return {
                ...a,
                points: drag.points.map(
                  (p) =>
                    p.map((n, i) => n + point[i] - drag.points[0][i]) as Point,
                ),
              };
            return { ...a, points, size: this.snapSize(size) };
          }
          return {
            ...a,
            points: drag.points.map(
              (p) => p.map((n, i) => n + point[i] - drag.anchor[i]) as Point,
            ),
          };
        }),
      }));
      this.planState(validatePlan({ ...plan, steps }));
      return;
    }
    if (tool === "explore") return;
    if (tool === "move") {
      const mark = plan.steps
        .flatMap((s) => s.annotations)
        .find((a) => a.id === this.state.selectedMark);
      if (mark && !mark.locked) {
        const displayed = new Map(
          this.displayMarks().map((a) => [a.id, a.points]),
        );
        const first = (displayed.get(mark.id) ?? mark.points)[0],
          ids = new Set(this.state.selectedMarks);
        this.editPlan({
          ...plan,
          steps: plan.steps.map((s) => ({
            ...s,
            annotations: s.annotations.map((a) =>
              ids.has(a.id) && !a.locked
                ? {
                    ...a,
                    actor: undefined,
                    actorReport: undefined,
                    points: (displayed.get(a.id) ?? a.points).map(
                      (p) => p.map((n, i) => n + point[i] - first[i]) as Point,
                    ),
                  }
                : a,
            ),
          })),
        });
      }
      this.setTool("explore");
      return;
    }
    if (tool === "marker" || tool === "label") {
      const mark = newAnnotation(tool, point, {
        ...markStyle,
        label: tool === "label" ? "Label" : "",
      });
      this.editPlan({
        ...plan,
        steps: plan.steps.map((s) =>
          s.id === activeStep
            ? { ...s, annotations: [...s.annotations, mark] }
            : s,
        ),
      });
      this.patch({ selectedMark: mark.id, selectedMarks: [mark.id] });
      this.sendAnnotations();
      return;
    }
    if (!this.draftBase) {
      this.draftBase = plan;
      this.draftMark = planId();
    }
    const next = validatePlan(plan),
      step = next.steps.find((s) => s.id === activeStep)!;
    let mark = step.annotations.find((a) => a.id === this.draftMark);
    const existing = !!mark;
    if (!mark) {
      mark = newAnnotation(tool, point, { ...markStyle, id: this.draftMark! });
      step.annotations.push(mark);
    } else {
      const last = mark.points.at(-1)!;
      if (
        ["drawing", "polygon", "route"].includes(tool) &&
        Math.hypot(...point.map((v, i) => v - last[i])) <
          (tool === "drawing" ? 0.35 : 0.05)
      )
        return;
      if (["circle", "cone", "arrow"].includes(tool) && mark.points.length >= 2)
        mark.points[1] = point;
      else mark.points.push(point);
      if (["circle", "cone"].includes(tool))
        mark.size = Math.max(
          0.5,
          Math.min(
            100,
            Math.hypot(
              point[0] - mark.points[0][0],
              point[1] - mark.points[0][1],
            ),
          ),
        );
    }
    if (["circle", "cone"].includes(tool)) mark.size = this.snapSize(mark.size);
    if (
      mark.points.length > 1 &&
      this.state.snap.angle &&
      !this.state.snapBypass
    ) {
      const p = mark.points[0],
        q = mark.points[1],
        d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const angle = snapValue(
        Math.atan2(q[1] - p[1], q[0] - p[0]),
        (this.state.snap.degrees * Math.PI) / 180,
      );
      mark.points[1] = [
        p[0] + Math.cos(angle) * d,
        p[1] + Math.sin(angle) * d,
        q[2],
      ];
    }
    const sized = this.dimensioned(mark);
    Object.assign(mark, sized);
    this.patch({
      drawing: true,
      selectedMark: mark.id,
      selectedMarks: [mark.id],
    });
    this.planState(validatePlan(next));
    if (
      !preview &&
      existing &&
      ["arrow", "circle", "cone"].includes(tool) &&
      mark.points.length === 2
    )
      this.finishDrawing();
  }

  private syncKeyboardCapture() {
    this.engine?.set_typing?.(
      this.typing ||
        !!this.state.dimensionInput ||
        this.shortcutCapture ||
        this.mapView ||
        !this.sceneFocused ||
        this.state.cameraMode === "orbit",
    );
  }
  setSceneFocused(on: boolean) {
    this.sceneFocused = on;
    if (!on) this.shortcutCapture = false;
    this.syncKeyboardCapture();
  }
  setShortcutCapture(on: boolean) {
    this.shortcutCapture = on;
    this.syncKeyboardCapture();
  }
  setMapView(on: boolean) {
    const changed = this.mapView !== on;
    this.mapView = on;
    if (on && this.state.cameraMode === "orbit") this.setCameraMode("free");
    this.syncKeyboardCapture();
    if (changed) this.patch({});
  }
  setTyping(on: boolean) {
    this.typing = on;
    this.syncKeyboardCapture();
  }
  setGameVersion(version: GameVersion) {
    gameVersion(version);
    if (version === this.state.gameVersion || this.state.busy) return;
    this.selectRaid(
      raidByMap(this.state.plan.mapId, version) ? this.state.plan.mapId : 409,
      true,
      version,
    );
    this.patch({ report: null });
  }
  selectRaid(
    map: number,
    clearReplay = true,
    version: GameVersion = this.state.gameVersion,
  ) {
    const raid = raidByMap(map, version);
    if (!raid) throw new Error("Unsupported raid map for this game version");
    if (this.state.plan.mapId === map && this.state.gameVersion === version)
      return;
    this.cancelPlayPreparation();
    if (
      this.projectStore &&
      !this.restoringProject &&
      clearReplay &&
      (this.activeProject || this.state.dirty)
    ) {
      const epoch = this.projectEpoch,
        request = ++this.projectSwitchRequest;
      this.patch({ busy: true });
      void this.flushProject().then(
        () => {
          if (
            epoch !== this.projectEpoch ||
            request !== this.projectSwitchRequest
          )
            return;
          this.restoringProject = true;
          try {
            this.resetProject(null);
            this.mapDrafts.clear();
            this.selectRaid(map, clearReplay, version);
          } finally {
            this.restoringProject = false;
          }
        },
        (error) => {
          if (epoch === this.projectEpoch) this.patch({ busy: false });
          this.notify(message(error));
        },
      );
      return;
    }
    if (this.projectStore && !this.restoringProject) {
      if (this.activeProject || this.state.dirty) void this.saveProject();
      this.resetProject(null);
      this.mapDrafts.clear();
    }
    if (clearReplay) {
      this.loadingBuffer?.close();
      this.loadingBuffer = null;
      this.importAbort?.abort();
      this.request++;
      this.patch({ busy: false });
    }
    try {
      this.storage?.setItem(ACTIVE_RAID_KEY, String(map));
      this.storage?.setItem("pullfiction.gameVersion.v1", version);
    } catch {}
    this.lastAnnotationPayload = null;
    this.cancelDrawing();
    this.mapDrafts.set(`${this.state.gameVersion}:${this.state.plan.mapId}`, {
      plan: this.state.plan,
      saved: this.saved,
      undo: this.undoStack,
      redo: this.redoStack,
    });
    let draft = this.mapDrafts.get(`${version}:${map}`);
    if (!draft) {
      let plan = emptyPlan(map, version);
      try {
        const stored = this.storage?.getItem(planStorageKey(map, version));
        if (stored) {
          const loaded = parsePlan(stored);
          if (loaded.mapId !== map || loaded.gameVersion !== version)
            throw new Error("Saved plan belongs to another raid");
          plan = loaded;
        }
      } catch {
        this.notify(
          "Saved raid plan could not be read. Its original data has been kept.",
        );
      }
      draft = { plan, saved: JSON.stringify(plan), undo: [], redo: [] };
    }
    this.saved = draft.saved;
    this.undoStack = draft.undo;
    this.redoStack = draft.redo;
    this.patch({ gameVersion: version });
    this.planState(draft.plan);
    this.patch({
      sceneReady: false,
      browserPlates: [],
      error: null,
      status: `Loading ${raid.name}`,
      playing: false,
      ...(clearReplay
        ? { replay: null, time: 0, selected: null, detail: null, loop: null }
        : {}),
    });
    this.frame = [];
    this.previousEventTime = null;
    this.resetEvents = true;
    this.lastNativeSelection = null;
    if (clearReplay) this.clockTime = 0;
    if (this.engine) {
      if (this.browserBridge)
        void this.prepareFloorGeometry(map)
          .then(() => {
            if (this.state.plan.mapId !== map) return;
            this.render();
            if (this.state.options.followPulls) this.focusCurrent();
          })
          .catch((error) =>
            this.notify(`Floor context unavailable: ${message(error)}`),
          );
      if (this.localFiles)
        void this.preparePlanAssets(this.state.plan, this.clientAbort?.signal)
          .then(() => {
            if (this.state.plan.mapId === map) this.render();
          })
          .catch((error) =>
            this.notify(`Raid models unavailable: ${message(error)}`),
          );
      this.engine.load_raid(map);
      this.frameTransport.reset();
      this.engine.set_replay_frame("[]");
      this.engine.replay_events("[]", true);
      this.waitForScene();
    }
  }
  private waitForScene() {
    clearTimeout(this.sceneTimer);
    const map = this.state.plan.mapId;
    this.sceneTimer = setTimeout(() => {
      this.sceneTimer = undefined;
      if (this.state.plan.mapId === map && !this.state.sceneReady)
        this.fail(`${raidByMap(map)?.name ?? "Raid"} did not finish loading`);
    }, 90000);
    this.sceneTimer.unref?.();
  }
  home() {
    this.engine?.home();
  }
  pick(x: number, y: number, constrain = false, preview = false) {
    if (this.markDrag) this.markDrag.constrain = constrain;
    if (this.actorDrag) this.actorDrag.constrain = constrain;
    if (
      this.state.ready &&
      (this.state.tool !== "explore" || !!this.markDrag || !!this.actorDrag)
    )
      if (this.engine?.pick_for_annotation) {
        this.pendingPicks++;
        if (preview && this.engine.preview_annotation)
          this.engine.preview_annotation(x, y, this.pickEpoch);
        else this.engine.pick_for_annotation(x, y, this.pickEpoch);
      } else this.engine?.pick(x, y);
  }
  pickMark(x: number, y: number) {
    this.engine?.pick_annotation?.(x, y);
  }
  pickMap(
    x: number,
    y: number,
    height: number,
    constrain = false,
    preview = false,
    grounded = false,
  ) {
    if (![x, y, height].every(Number.isFinite)) return;
    // A resolved local point must not overtake an earlier asynchronous native pick.
    if (this.pendingPicks) {
      this.mapPickQueue.push([x, y, height, constrain, preview, grounded]);
      return;
    }
    if (this.markDrag) this.markDrag.constrain = constrain;
    if (this.actorDrag) this.actorDrag.constrain = constrain;
    if (
      this.state.ready &&
      (this.state.tool !== "explore" || !!this.markDrag || !!this.actorDrag)
    ) {
      const shape = this.displayMarks().find((a) => a.id === this.draftMark);
      const planar =
        shape &&
        (this.markDrag
          ? this.markDrag.operation !== "move" ||
            (this.markDrag.handle !== null &&
              ["circle", "cone"].includes(shape.type))
          : ["circle", "cone", "arrow"].includes(shape.type));
      if (grounded || planar) {
        try {
          this.placePoint(
            [x, y, grounded ? height : shape!.points[0][2]],
            preview,
          );
        } catch (error) {
          this.notify(message(error));
        }
      } else if (this.engine?.pick_map_for_annotation) {
        this.pendingPicks++;
        if (preview && this.engine.preview_map_annotation)
          this.engine.preview_map_annotation(x, y, height, this.pickEpoch);
        else this.engine.pick_map_for_annotation(x, y, height, this.pickEpoch);
      } else this.engine?.pick_map(x, y, height);
    }
  }
  setOption(key: keyof Options, value: boolean) {
    if (key === "followRaid" && value && this.state.cameraMode === "orbit")
      this.setCameraMode("free");
    this.patch({ options: { ...this.state.options, [key]: value } });
    this.resetEvents = true;
    this.render();
  }
  setRangeCheck(change: Partial<RangeSettings>) {
    const radius = change.radius ?? this.state.rangeCheck.radius;
    if (!Number.isFinite(radius)) return;
    this.patch({
      rangeCheck: {
        ...this.state.rangeCheck,
        ...change,
        radius: Math.max(1, Math.min(100, radius)),
      },
    });
    this.render();
  }
  rangeCheckCircles() {
    if (
      this.state.workspaceMode !== "analyse" ||
      !this.state.options.actors ||
      this.state.buffering
    )
      return [];
    if (!this.state.replay || !this.state.rangeCheck.enabled) return [];
    return withReplayPoses((lookup) => {
      const floors = this.replayFloors(this.state.replay!, lookup);
      return rangeCircles(this.state.replay, this.state.rangeCheck, (actor) => {
        const pose = this.actorPose(actor, lookup);
        return pose
          ? {
              ...pose,
              pos: [
                pose.pos[0],
                pose.pos[1],
                pose.pos[2] ?? floors.get(actor.key) ?? null,
              ],
            }
          : null;
      });
    });
  }
  setCameraDistance(distance: number) {
    if (!Number.isFinite(distance)) return;
    this.patch({ cameraMaxDistance: Math.max(15, Math.min(60, distance)) });
    this.render();
  }
  setRate(rate: number) {
    if ([0.5, 1, 2, 4].includes(rate)) {
      this.patch({ rate });
      this.render();
    }
  }
  duration() {
    const duration = this.state.replay?.duration ?? 60000;
    return this.state.workspaceMode === "plan"
      ? Math.max(duration, ...this.state.plan.steps.map((s) => s.end ?? 0))
      : duration;
  }
  private cancelPlayPreparation() {
    this.playPreparationToken++;
    if (Object.hasOwn(this.engine ?? {}, "prepare_replay_playback"))
      this.engine?.prepare_replay_playback?.(0);
    if (this.state.playPreparing) this.patch({ playPreparing: false });
  }
  toggle() {
    if (!this.state.replay && this.state.workspaceMode !== "plan") return;
    if (this.clockTime >= this.duration())
      this.clockTime = this.state.loop?.[0] ?? 0;
    if (!this.state.playing) this.trajectoryCoverageBlocked = false;
    if (this.state.playPreparing) {
      this.cancelPlayPreparation();
      return;
    }
    const engine = this.engine;
    if (
      !this.state.playing &&
      this.state.replay &&
      Object.hasOwn(engine ?? {}, "prepare_replay_playback") &&
      engine?.prepare_replay_playback
    ) {
      const token = ++this.playPreparationToken;
      this.encounterWarmer.cancel();
      this.patch({ playPreparing: true, error: null });
      if (!this.state.sceneReady && !this.sceneTimer) this.waitForScene();
      this.render();
      if (
        !this.state.playPreparing ||
        token !== this.playPreparationToken ||
        this.engine !== engine
      )
        return;
      // Native readiness includes required scene collision. Optional model/spell
      // prefetch must never delay its acknowledgement or compete with demand reads.
      engine.prepare_replay_playback(token);
      return;
    }
    this.patch({ playing: !this.state.playing });
    this.render();
    if (this.activeProject && !this.state.playing) this.scheduleAutosave();
  }
  seek(time: number) {
    if (!Number.isFinite(time)) return;
    this.cancelPlayPreparation();
    this.clearTrajectoryRetries();
    if (this.state.downloadingReplay) this.cancelReplayDownload();
    this.trajectoryCoverageBlocked = false;
    this.encounterWarmer.cancel();
    this.warmedEncounter = "";
    this.clockTime = Math.max(0, Math.min(this.duration(), time));
    this.resetEvents = true;
    this.patch({ playing: false, time: this.clockTime });
    if (this.replayBuffer) void this.ensureBuffered(this.clockTime);
    this.warmEncounter();
    this.render();
    if (this.activeProject) this.scheduleAutosave();
  }
  toggleLoop() {
    const chapter =
      this.state.replay && chapterAt(this.state.replay, this.clockTime);
    this.patch({
      loop: this.state.loop
        ? null
        : chapter
          ? [chapter.start, chapter.end]
          : [0, this.state.replay?.duration ?? 0],
    });
  }
  jump(id: string) {
    const chapter = this.state.replay?.chapters.find(
      (c) => String(c.id) === id,
    );
    if (chapter) {
      this.seek(chapter.start);
      this.focusCurrent();
    }
  }
  stepChapter(direction: number) {
    const replay = this.state.replay;
    if (!replay) return;
    const chapter = chapterAt(replay, this.clockTime);
    const i = chapter
      ? replay.chapters.indexOf(chapter)
      : replay.chapters.findIndex((c) => c.start > this.clockTime) - 1;
    const next =
      replay.chapters[
        Math.max(0, Math.min(replay.chapters.length - 1, i + direction))
      ];
    if (next) this.jump(String(next.id));
    else this.seek(direction < 0 ? 0 : replay.duration);
  }
  select(key: string | null, focus = false) {
    this.patch({ selected: key, detail: null });
    if (this.state.cameraMode === "orbit") {
      const actor = this.sceneActors().find(
        (a) => a.key === key && a.type === "Player",
      );
      if (actor) this.patch({ orbitTarget: actor.key });
      else this.setCameraMode("free");
    }
    this.engine?.select_replay(key ?? "");
    if (focus && key) this.focus(key);
  }
  inspectCast(actorKey: string, index: number) {
    const actor = this.state.replay?.actors.find((a) => a.key === actorKey),
      cast = actor?.casts[index];
    if (!cast) return;
    this.seek(cast.start);
    this.patch({
      selected: actorKey,
      detail: { spell: cast.spell, actorKey, castIndex: index },
    });
    this.engine?.select_replay(actorKey);
  }
  inspectSpell(spell: number) {
    if (Number.isInteger(spell) && spell > 0) this.patch({ detail: { spell } });
  }
  closeDetail() {
    this.patch({ detail: null });
  }
  focusActorFromRaidFrame(key: string) {
    const actor = this.sceneActors().find(
      (a) => a.key === key && a.type === "Player",
    );
    if (!actor) return;
    this.selectActor(key);
    if (this.state.options.followRaid) this.setOption("lockCamera", true);
    this.focus(key, false);
    this.render();
  }
  focus(key: string, select = true) {
    const replay = this.state.replay;
    const actor = this.sceneActors().find((a) => a.key === key);
    if (!actor) return;
    if (select) {
      this.setOption("followRaid", false);
      this.select(key);
    }
    const pose = this.actorPose(actor);
    const pos = pose?.pos ?? actor.samples[0]?.slice(1);
    if (pos) {
      const hint = replay ? this.replayFloors(replay).get(key) : undefined;
      this.engine?.focus_replay(
        pos[0]!,
        pos[1]!,
        pos[2] ?? hint ?? raidByMap(this.state.plan.mapId)?.spawn[2] ?? 0,
      );
    } else this.notify("No recorded position");
  }
  focusCurrent() {
    const replay = this.state.replay;
    if (!replay) {
      const geometry = this.loadedFloors.get(this.state.plan.mapId);
      const actor = this.defaultRaidActors().find((candidate) => {
        if (!candidate.displayID) return false;
        const pose = this.actorPose(candidate);
        if (!pose) return false;
        return (
          candidate.spawn?.position[2] != null ||
          ("nearbyGround" in pose && pose.nearbyGround) ||
          geometry?.height(pose.pos[0], pose.pos[1], pose.pos[2] ?? 0, true) !==
            undefined
        );
      });
      if (actor) this.focus(actor.key, false);
      return !!actor;
    }
    if (this.state.options.followRaid) return false;
    const chapter = chapterAt(replay, this.clockTime),
      enemies = new Set(chapter?.enemyNPCs?.map((a) => a.id));
    const candidates = replay.actors.filter((a) => {
      const p = poseAt(a, this.clockTime, this.state.options.smoothGaps);
      return p && !p.dead && (!p.stale || p.estimated);
    });
    const actor =
      candidates.find((a) => enemies.has(a.id)) ??
      candidates.find((a) => a.type === "Player") ??
      candidates[0] ??
      replay.actors.find((a) => enemies.has(a.id) && a.samples.length > 0) ??
      replay.actors.find((a) => a.type === "NPC" && a.samples.length > 0) ??
      replay.actors.find((a) => a.samples.length > 0);
    if (actor) this.focus(actor.key, false);
    return !!actor;
  }
  appearance(actor: Actor) {
    return (
      this.appearances[
        `${this.state.gameVersion}:${this.state.reportCode}:${actor.id}`
      ] ??
      (this.state.gameVersion === "vanilla"
        ? this.appearances[`${this.state.reportCode}:${actor.id}`]
        : undefined) ??
      this.state.replay?.raw.appearanceOverrides?.[actor.id] ??
      {}
    );
  }
  async setAppearance(
    actor: Actor,
    key: keyof Appearance,
    value: number | undefined,
  ) {
    const id = `${this.state.gameVersion}:${this.state.reportCode}:${actor.id}`;
    const request = (this.appearanceRequests.get(id) ?? 0) + 1;
    this.appearanceRequests.set(id, request);
    const next = {
      ...(this.pendingAppearances.get(id) ?? this.appearance(actor)),
      [key]: value,
    };
    this.pendingAppearances.set(id, next);
    const files = this.localFiles;
    const bridge = this.browserBridge;
    if (files && bridge) {
      try {
        await prepareOriginalUnits(
          files,
          bridge,
          [
            {
              player: actor.type === "Player",
              race: next.race ?? actor.race,
              sex: next.sex ?? actor.sex,
              display: next.display ?? actor.displayID,
              look: next.look ?? [0, 0, 0, 0, 0],
              gear: actor.gear
                .filter((gear) => gear.model)
                .map((gear) => ({
                  slot: gear.slot,
                  display: gear.model?.display,
                })),
            },
          ],
          [],
          this.clientAbort?.signal,
        );
      } catch (error) {
        if (this.appearanceRequests.get(id) === request) {
          this.pendingAppearances.delete(id);
          if (!this.clientAbort?.signal.aborted)
            this.notify(
              `Could not prepare appearance: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        return;
      }
      if (files !== this.localFiles || bridge !== this.browserBridge) {
        if (this.appearanceRequests.get(id) === request)
          this.pendingAppearances.delete(id);
        return;
      }
    }
    if (
      this.appearanceRequests.get(id) !== request ||
      id !== `${this.state.gameVersion}:${this.state.reportCode}:${actor.id}`
    ) {
      if (this.appearanceRequests.get(id) === request)
        this.pendingAppearances.delete(id);
      return;
    }
    this.pendingAppearances.delete(id);
    // Publish only after the synchronous native texture reads can succeed.
    this.appearances[id] = next;
    try {
      this.storage?.setItem(APPEARANCE_KEY, JSON.stringify(this.appearances));
    } catch {
      this.notify("Could not save appearance");
    }
    this.render();
  }
  private async api(route: string) {
    const response = await fetch(
      API +
        route +
        (route.includes("?") ? "&" : "?") +
        `version=${this.state.gameVersion}`,
      {
        signal: AbortSignal.timeout(600000),
      },
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Import failed");
    return data;
  }
  private loadCatalogs() {
    if (this.state.browserAssets) {
      if (!this.browserBridge)
        return Promise.reject(new Error("Game assets are still loading."));
      return (this.catalogs ??= this.loadBrowserCatalogs().catch((error) => {
        this.catalogs = null;
        throw error;
      }));
    }
    return (this.catalogs ??= Promise.all([
      fetch("/creature-models.json")
        .then((r) => {
          if (!r.ok) throw new Error("Creature catalog unavailable");
          return r.json();
        })
        .then((x) => (this.models = x)),
      fetch("/spell-metadata.json")
        .then((r) => {
          if (!r.ok) throw new Error("Spell timing catalog unavailable");
          return r.json();
        })
        .then((x) => (this.spells = x)),
      resolveAssetRoot().then(async (root) => {
        if (!root.startsWith("/assets/classic-")) return;
        const response = await fetch(root + "/__classic/spell-timing.json");
        if (!response.ok) throw new Error("Modern spell catalog unavailable");
        this.modernSpells = await response.json();
        const items = await fetch(root + "/__classic/item-metadata.json");
        if (!items.ok) throw new Error("Modern item catalog unavailable");
        this.modernItems = await items.json();
      }),
      fetch("/item-models.json")
        .then((r) => {
          if (!r.ok) throw new Error("Item catalog unavailable");
          return r.json();
        })
        .then((x) => (this.items = x)),
    ])
      .then(() => {})
      .catch((e) => {
        this.catalogs = null;
        throw e;
      }));
  }
  private async loadBrowserCatalogs() {
    const bridge = this.browserBridge!;
    const [creatures, items, spells, npcIndex] = await Promise.all([
      bridge.catalog("creatures"),
      bridge.catalog("items"),
      bridge.catalog("spells"),
      (this.runtime.loadNpcIndex ?? loadNpcIndex)(this.clientAbort?.signal),
    ]);
    // The bundled numeric reference resolves NPC entry IDs; actual display/model
    // availability is checked against this selected client's modern catalog.
    if (
      !creatures.displays ||
      !creatures.models ||
      !items.items ||
      !spells.spells
    )
      throw new Error("The selected client returned incomplete catalogs.");
    this.browserCreatures = creatures;
    this.browserModels = resolveNpcModels(npcIndex, creatures);
    // Reference-only baseline models must not fill gaps in a SoD log catalog.
    this.referenceModels = {
      vanilla: {
        ...referenceNpcModels(creatures),
        ...this.browserModels.vanilla,
      },
      sod: {
        ...referenceNpcModels(creatures, "sod"),
        ...this.browserModels.sod,
      },
    };
    this.models = this.browserModels[this.state.gameVersion];
    this.items = items.items;
    this.modernItems = items.items;
    this.spells = spells.spells;
    this.modernSpells = spells.spells;
  }
  async connectWcl() {
    if (!this.wclSession) {
      this.notify(
        "This site has no public Warcraft Logs client configured. Import replay JSON instead.",
      );
      return;
    }
    try {
      const url = await this.wclSession.begin(
        location.pathname + location.search + location.hash,
      );
      location.assign(url.href);
    } catch (error) {
      this.notify(message(error));
    }
  }
  disconnectWcl() {
    this.cancelImport();
    this.wclSession?.disconnect();
    this.patch({ wclConnected: false, report: null });
  }
  cancelImport() {
    this.request++;
    this.importAbort?.abort();
    this.importAbort = null;
    this.loadingBuffer?.close();
    this.loadingBuffer = null;
    this.patch({ busy: false });
  }
  private async initializeWcl() {
    if (this.authStarted || typeof window === "undefined") return;
    this.authStarted = true;
    const callback = new URL(location.href);
    try {
      const config = publicWclConfig(location);
      if (!config) {
        if (isWclCallback(callback))
          throw new Error(
            "This site has no public Warcraft Logs client configured.",
          );
        return;
      }
      const { session, logs } = createBrowserLogs(
        config,
        window.sessionStorage,
        () => this.patch({ wclConnected: false }),
      );
      this.wclSession = session;
      this.browserLogs = logs;
      this.patch({ wclConfigured: true });
      if (isWclCallback(callback)) {
        try {
          const returnTo = await session.finish(callback);
          history.replaceState(null, "", returnTo);
          this.patch({ wclConnected: true });
          this.notify("Warcraft Logs connected. Loading game assets.");
        } finally {
          // Authorization codes and state never remain in the address bar.
          if (isWclCallback(new URL(location.href)))
            history.replaceState(null, "", clearWclCallback(callback));
        }
      }
    } catch (error) {
      if (isWclCallback(callback))
        history.replaceState(null, "", clearWclCallback(callback));
      this.notify(message(error));
    }
  }
  async loadReport(input: string) {
    if (this.state.busy) return;
    let source;
    try {
      source = reportSource(input, this.state.gameVersion);
    } catch (e) {
      this.notify(message(e));
      return;
    }
    if (!this.projectStore && source.gameVersion !== this.state.gameVersion)
      this.setGameVersion(source.gameVersion as GameVersion);
    const request = ++this.request;
    this.importAbort = new AbortController();
    this.patch({ busy: true, report: null });
    try {
      if (this.projectStore) {
        await this.flushProject();
        if (request !== this.request) return;
        if (source.gameVersion !== this.state.gameVersion) {
          this.restoringProject = true;
          try {
            this.resetProject(null);
            this.mapDrafts.clear();
            this.selectRaid(
              raidByMap(this.state.plan.mapId, source.gameVersion)
                ? this.state.plan.mapId
                : 409,
              false,
              source.gameVersion as GameVersion,
            );
            this.patch({ report: null });
          } finally {
            this.restoringProject = false;
          }
        }
      }
      const code = source.code;
      const result = this.state.browserAssets
        ? await this.requireBrowserLogs().report(code, source.gameVersion, {
            signal: this.importAbort?.signal,
          })
        : await this.api(`/report?code=${code}`);
      if (request === this.request)
        this.patch({ report: result.report ?? result, reportCode: code });
    } catch (e) {
      if (request === this.request) this.notify(message(e));
    } finally {
      if (request === this.request) this.patch({ busy: false });
    }
  }
  async loadReplay(
    fight: string,
    map?: number,
    mode: "analyse" | "plan" = "analyse",
  ) {
    if (this.state.busy || !this.state.report) return;
    const request = ++this.request;
    this.importAbort = new AbortController();
    this.patch({ busy: true, playing: false });
    try {
      await this.flushProject();
      if (request !== this.request) return;
      let buffered: ReplayBuffer | undefined;
      const raw = this.state.browserAssets
        ? await (async () => {
            const header = await this.requireBrowserLogs().replayHeader(
              this.state.reportCode,
              fight === "run" ? "run" : Number(fight),
              this.state.gameVersion,
              map,
              { signal: this.importAbort!.signal },
            );
            buffered = this.makeReplayBuffer(header, true);
            this.loadingBuffer = buffered;
            this.patch({ status: "Loading the first replay section…" });
            await buffered.ensure(0);
            return buffered.snapshot();
          })()
        : await this.api(
            fight === "run"
              ? `/run?code=${this.state.reportCode}${map == null ? "" : `&map=${map}`}`
              : `/replay?code=${this.state.reportCode}&fight=${encodeURIComponent(fight)}`,
          );
      await this.loadCatalogs();
      if (request === this.request) {
        const prepared = await this.prepareReplayForInstall(
          raw,
          this.importAbort?.signal,
        );
        if (request === this.request) {
          this.installReplay(raw, prepared, buffered);
          this.loadingBuffer = null;
          if (mode === "plan") {
            this.planFromMoment();
            this.editPlan({
              ...this.state.plan,
              steps: this.state.plan.steps.filter(
                (step) =>
                  step.snapshot ||
                  step.annotations.length ||
                  step.notes ||
                  step.start !== null,
              ),
            });
          } else this.setWorkspaceMode("analyse");
          if (this.projectStore) await this.saveProject();
        }
      }
    } catch (e) {
      if (request === this.request) this.notify(message(e));
    } finally {
      if (request === this.request) this.patch({ busy: false });
    }
  }
  private makeReplayBuffer(raw: RawReplay, fresh = false) {
    return new ReplayBuffer(
      raw,
      (start, end, state, signal) =>
        this.requireBrowserLogs().replayRange(raw, start, end, state, {
          signal,
        }),
      (signal) => this.requireBrowserLogs().verifyReplayRevision(raw, signal),
      this.replayParts,
      () => {},
      (error) =>
        this.notify(
          `Replay section could not be cached: ${message(error)}. Your edits can still be saved.`,
        ),
      fresh,
    );
  }
  private bufferedReady(time: number) {
    const replay = this.state.replay;
    if (!replay?.raw.stream) return true;
    const t = Math.max(0, Math.min(replay.duration - 0.001, time));
    return (
      !!this.replayBuffer?.ready(time) &&
      analysisAvailable(replay, t, Math.min(replay.duration, t + 0.001))
    );
  }
  private async refreshBuffered(buffer: ReplayBuffer) {
    const revision = buffer.revision;
    if (this.appliedBufferRevision === revision) return;
    const update = ++this.bufferUpdate;
    const raw = buffer.snapshot();
    const prepared = await this.prepareReplayForInstall(raw);
    if (this.replayBuffer !== buffer || update !== this.bufferUpdate) return;
    this.models = prepared.models;
    this.appliedBufferRevision = revision;
    this.resetEvents = true;
    this.previousEventTime = null;
    const detail = this.state.detail;
    let nextDetail = detail;
    if (detail?.castIndex != null) {
      const previous = this.state.replay?.actors.find(
        (a) => a.key === detail.actorKey,
      )?.casts[detail.castIndex];
      const index =
        prepared.replay.actors
          .find((a) => a.key === detail.actorKey)
          ?.casts.findIndex(
            (c) =>
              c.start === previous?.start &&
              c.spell === previous?.spell &&
              c.target === previous?.target,
          ) ?? -1;
      nextDetail = index < 0 ? null : { ...detail, castIndex: index };
    }
    this.patch({ replay: prepared.replay, detail: nextDetail });
    this.render();
    if (buffer.revision !== revision) await this.refreshBuffered(buffer);
  }
  private async ensureBuffered(time: number) {
    const buffer = this.replayBuffer;
    if (!buffer) return;
    this.bufferTarget = time;
    const request = ++this.bufferRequest;
    if (!this.bufferedReady(time)) {
      this.patch({ buffering: true, bufferError: null });
      this.engine?.replay_clock?.(this.clockTime, this.state.rate, false);
    }
    try {
      await this.bufferRestore;
      if (this.replayBuffer !== buffer || request !== this.bufferRequest)
        return;
      await buffer.ensure(time);
      if (this.replayBuffer !== buffer || request !== this.bufferRequest)
        return;
      await this.refreshBuffered(buffer);
      if (this.replayBuffer !== buffer || request !== this.bufferRequest)
        return;
      this.patch({ buffering: false, bufferError: null });
      this.render();
      this.prefetchBuffered();
    } catch (error) {
      if (this.replayBuffer === buffer && request === this.bufferRequest)
        this.patch({
          buffering: false,
          bufferError: message(error),
          playing: false,
        });
    }
  }
  private prefetchBuffered() {
    const buffer = this.replayBuffer;
    if (
      !buffer ||
      buffer.active ||
      this.state.buffering ||
      this.state.bufferError ||
      this.state.downloadingReplay ||
      Date.now() < this.prefetchAfter
    )
      return;
    const next = (Math.floor(this.clockTime / REPLAY_CHUNK) + 1) * REPLAY_CHUNK;
    if (next >= buffer.duration || buffer.ready(next)) return;
    void buffer
      .ensure(next)
      .then(async () => {
        if (this.replayBuffer === buffer && !this.state.buffering)
          await this.refreshBuffered(buffer);
      })
      .catch((error) => {
        if (error?.name !== "AbortError")
          this.prefetchAfter = Date.now() + 30000;
        /* Foreground playback retries and reports a needed section. */
      });
  }
  retryReplaySection() {
    void this.ensureBuffered(this.bufferTarget);
  }
  async downloadFullReplay() {
    await this.loadReplayRange(0, this.duration());
  }
  async loadReplayRange(start: number, end: number) {
    const buffer = this.replayBuffer;
    if (!buffer || this.state.downloadingReplay || this.state.buffering) return;
    const download = ++this.downloadEpoch;
    this.patch({ downloadingReplay: true, bufferError: null });
    try {
      await this.bufferRestore;
      for (
        let t = Math.max(0, Math.floor(start / REPLAY_CHUNK) * REPLAY_CHUNK);
        t < Math.min(end, buffer.duration);
        t += REPLAY_CHUNK
      ) {
        if (
          this.replayBuffer !== buffer ||
          download !== this.downloadEpoch ||
          !this.state.downloadingReplay
        )
          return;
        await buffer.ensure(t);
        if (this.replayBuffer !== buffer) return;
        await this.refreshBuffered(buffer);
      }
      await buffer.flush();
    } catch (error) {
      if (
        this.replayBuffer === buffer &&
        download === this.downloadEpoch &&
        this.state.downloadingReplay
      )
        this.patch({ bufferError: message(error) });
    } finally {
      if (this.replayBuffer === buffer && download === this.downloadEpoch) {
        this.patch({ downloadingReplay: false });
        this.render();
      }
    }
  }
  cancelReplayDownload() {
    this.trajectoryCoverageBlocked = true;
    this.downloadEpoch++;
    this.patch({ downloadingReplay: false });
    this.replayBuffer?.cancel();
  }
  private requireBrowserLogs() {
    if (!this.browserLogs)
      throw new Error("Connect Warcraft Logs or import a replay JSON file.");
    return this.browserLogs;
  }
  private replayForInstall(raw: RawReplay) {
    const context = raw.stream
      ? { ...raw, events: normalizationEvents(raw) }
      : raw;
    const input = this.state.browserAssets
      ? localSpellReplay(context, this.modernSpells)
      : context;
    const version = gameVersion(
      raw.gameVersion ?? raw.report?.gameVersion ?? "vanilla",
    ).id as GameVersion;
    const models = this.state.browserAssets
      ? this.browserModels[version]
      : this.models;
    const sod = raw.gameVersion === "sod" || raw.report?.gameVersion === "sod";
    let metadata = this.replayMetadata;
    if (
      !metadata ||
      metadata.models !== models ||
      metadata.rawModels !== raw.models ||
      metadata.creatures !== this.browserCreatures ||
      metadata.items !== this.items ||
      metadata.modernItems !== this.modernItems ||
      metadata.browser !== this.state.browserAssets ||
      metadata.sod !== sod
    ) {
      metadata = this.replayMetadata = {
        models,
        rawModels: raw.models,
        creatures: this.browserCreatures,
        items: this.items,
        modernItems: this.modernItems,
        browser: this.state.browserAssets,
        sod,
        renderModels: this.state.browserAssets
          ? replayNpcModels(models, raw.models, this.browserCreatures)
          : { ...models, ...raw.models },
        itemModels: sod ? { ...this.items, ...this.modernItems } : this.items,
      };
    }
    const replay = this.replayNormalizer.normalize(
      input,
      metadata.renderModels,
      metadata.itemModels,
      this.state.browserAssets || sod ? this.modernSpells : this.spells,
    );
    replay.raw = raw;
    if (raw.stream)
      for (const actor of replay.actors) actor.bufferedRanges = raw.stream.full;
    if (replay.actors.length > 5000)
      throw new Error("Too many actors in this report");
    return { replay, models };
  }
  private async prepareReplayForInstall(raw: RawReplay, signal?: AbortSignal) {
    const prepared = this.replayForInstall(raw);
    if (this.localFiles && this.browserBridge) {
      const { replay } = prepared;
      await this.prepareFloorGeometry(replay.map, signal);
      await prepareOriginalUnits(
        this.localFiles,
        this.browserBridge,
        replay.actors.map((actor) => {
          const appearance =
            this.appearances[
              `${replay.gameVersion}:${replay.report.code}:${actor.id}`
            ] ??
            (replay.gameVersion === "vanilla"
              ? this.appearances[`${replay.report.code}:${actor.id}`]
              : undefined) ??
            raw.appearanceOverrides?.[actor.id] ??
            {};
          return {
            player: actor.type === "Player",
            race: appearance.race ?? actor.race,
            sex: appearance.sex ?? actor.sex,
            look: appearance.look ?? [0, 0, 0, 0, 0],
            display: appearance.display ?? actor.displayID,
            gear: actor.gear
              .filter((gear) => gear.model)
              .map((gear) => ({
                slot: gear.slot,
                display: gear.model?.display,
              })),
          };
        }),
        [...replay.abilities.values()].flatMap((ability) =>
          ability.icon ? [ability.icon] : [],
        ),
        signal,
      );
      try {
        const spellGraph = await this.browserBridge.catalog("spells");
        await prepareOriginalSpellEffects(
          this.localFiles,
          this.browserBridge,
          [...replay.abilities.keys()].filter(
            (id) => spellGraph.spells?.[id]?.summonCue,
          ),
          signal,
        );
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof Error && error.name === "AbortError") throw error;
        // These illustrative cues are optional; unavailable effects must not block the run.
        this.notify(`Some spell effects are unavailable: ${message(error)}`);
      }
    }
    return prepared;
  }
  private async prepareFloorGeometry(map: number, signal?: AbortSignal) {
    const bridge = this.browserBridge,
      raid = raidByMap(map);
    if (!bridge || !raid) return;
    let pending = this.floorGeometry.get(map);
    if (!pending) {
      pending = bridge
        .map(map, raid.directory)
        .then((data) => {
          const geometry = new ReplayFloorGeometry(
            data.floors,
            data.areas,
            replayFloorAnchors(map),
          );
          if (this.browserBridge === bridge)
            this.loadedFloors.set(map, geometry);
          return geometry;
        })
        .catch((error) => {
          if (this.browserBridge === bridge)
            this.notify(`Floor context unavailable: ${message(error)}`);
          return undefined;
        });
      this.floorGeometry.set(map, pending);
    }
    await pending;
    signal?.throwIfAborted();
  }
  private replayFloors(replay: Replay, lookupPose: typeof poseAt = poseAt) {
    const geometry = this.loadedFloors.get(replay.map),
      cached = this.floorHintCache,
      filtered = !!this.state.replay && this.state.workspaceMode === "analyse";
    if (
      cached &&
      cached.replay === replay &&
      cached.time === this.clockTime &&
      cached.geometry === geometry &&
      cached.smooth === this.state.options.smoothGaps &&
      cached.filtered === filtered &&
      cached.models === this.models
    )
      return cached.hints;
    const seeds = new Map<string, number>();
    const candidates = this.presentReplayActors();
    const hints = replayFloorHints(
      replay,
      this.clockTime,
      geometry?.contextCatalog(replay.map, this.models) ?? this.models,
      seeds,
      candidates ?? undefined,
    );
    if (geometry) {
      const fallback = raidByMap(replay.map)?.spawn[2] ?? 0;
      for (const actor of replay.actors) {
        if (candidates && !candidates.has(actor.key)) continue;
        const pose = lookupPose(
          actor,
          this.clockTime,
          this.state.options.smoothGaps,
        );
        if (!pose || pose.pos[2] !== null) continue;
        const seed = hints.get(actor.key);
        const height = this.actorFloorHeights.height(
          actor,
          geometry,
          pose.pos[0],
          pose.pos[1],
          seed ?? fallback,
          !seeds.has(actor.key),
        );
        if (height !== undefined) hints.set(actor.key, height);
      }
    }
    this.floorHintCache = {
      replay,
      time: this.clockTime,
      geometry,
      models: this.models,
      smooth: this.state.options.smoothGaps,
      filtered,
      hints,
      seeds,
    };
    return hints;
  }
  private async preparePlanAssets(plan: Plan, signal?: AbortSignal) {
    if (!this.localFiles || !this.browserBridge) return;
    await this.prepareFloorGeometry(plan.mapId, signal);
    await prepareOriginalUnits(
      this.localFiles,
      this.browserBridge,
      [
        ...(plan.steps.some((step) => !step.snapshot?.report)
          ? referenceRaidActors(
              plan.mapId,
              plan.gameVersion,
              this.referenceModels[plan.gameVersion],
            )
          : []),
        ...plan.steps.flatMap((step) => step.snapshot?.actors ?? []),
      ].map((actor) => ({
        player: actor.type === "Player",
        race: actor.race,
        sex: actor.sex,
        display: actor.displayID,
        look: [0, 0, 0, 0, 0],
        gear: [],
      })),
      [],
      signal,
    );
  }
  installReplay(
    raw: RawReplay,
    prepared?: { replay: Replay; models: Record<string, unknown> },
    buffer?: ReplayBuffer,
  ) {
    this.cancelPlayPreparation();
    this.encounterWarmEpoch++;
    this.encounterWarmer.cancel();
    this.warmedEncounter = "";
    this.clearTrajectoryRetries();
    this.trajectoryEpoch++;
    this.trajectoryCoverageBlocked = false;
    if (this.state.cameraMode === "orbit") this.setCameraMode("free");
    const { replay, models } = prepared ?? this.replayForInstall(raw);
    // Project switching clears replay before install; selection identity must survive it.
    const rangeSource = `${replay.gameVersion}:${replay.report.code}`;
    const rangeSourceChanged = this.rangeSource !== rangeSource;
    this.rangeSource = rangeSource;
    if (this.state.browserAssets) this.models = models;
    this.selectRaid(replay.map, false, replay.gameVersion);
    if (this.projectStore && !this.restoringProject) {
      this.restoringProject = true;
      this.resetProject(null, replaySource(raw, replay.map));
      this.saved = "";
      this.undoStack = [];
      this.redoStack = [];
      const plan = emptyPlan(replay.map, replay.gameVersion);
      plan.name = `${raw.report.title} · ${raw.fight.name}`.slice(0, 100);
      this.planState(plan);
      this.patch({
        activeStep: initialStep(plan),
        selectedMark: null,
        selectedMarks: [],
        selectedActors: [],
      });
      this.restoringProject = false;
      this.cacheProjectReplay(raw);
      this.scheduleAutosave();
    }
    this.clockTime = 0;
    this.frame = [];
    this.previousEventTime = null;
    this.resetEvents = true;
    this.lastChapter = null;
    this.patch({
      replay,
      ...(rangeSourceChanged
        ? { rangeCheck: { ...this.state.rangeCheck, players: [] } }
        : {}),
      browserPlates: [],
      report:
        replay.report.code === this.state.reportCode &&
        (this.state.report?.gameVersion ?? "vanilla") === replay.gameVersion
          ? this.state.report
          : null,
      reportCode: replay.report.code,
      time: 0,
      playing: false,
      selected: null,
      detail: null,
      loop: null,
      buffering: !!raw.stream,
      bufferError: null,
      downloadingReplay: false,
    });
    this.replayBuffer?.close();
    this.replayBuffer = raw.stream
      ? (buffer ?? this.makeReplayBuffer(raw))
      : null;
    this.appliedBufferRevision = buffer?.revision ?? -1;
    this.bufferRequest++;
    this.prefetchAfter = 0;
    this.bufferRestore =
      this.replayBuffer && !buffer
        ? this.replayBuffer.restore()
        : Promise.resolve();
    if (this.replayBuffer) {
      if (buffer?.ready(0)) {
        this.patch({ buffering: false });
        this.prefetchBuffered();
      } else void this.ensureBuffered(0);
    }
    this.render();
    if (this.state.sceneReady) this.focusCurrent();
  }
  async importFile(file: File, kind: "plan" | "replay") {
    try {
      await this.flushProject();
      if (file.size > (kind === "plan" ? 400000 : 150000000))
        throw new Error("File exceeds import limit");
      const text = await file.text();
      if (kind === "plan") {
        const plan = parsePlan(text);
        await this.preparePlanAssets(plan, this.clientAbort?.signal);
        if (this.projectStore) {
          this.resetProject(null);
          this.saved = "";
        }
        this.selectRaid(plan.mapId, true, plan.gameVersion);
        this.editPlan(plan);
      } else {
        await this.loadCatalogs();
        const raw = JSON.parse(text) as RawReplay;
        const prepared = await this.prepareReplayForInstall(
          raw,
          this.clientAbort?.signal,
        );
        this.installReplay(raw, prepared);
      }
    } catch (e) {
      this.notify(message(e));
    }
  }
  exportFile(kind: "plan" | "replay") {
    const value =
      kind === "plan"
        ? this.state.plan
        : (this.replayBuffer?.snapshot() ?? this.state.replay?.raw);
    if (
      kind === "replay" &&
      this.state.replay?.raw.stream &&
      !streamComplete(this.state.replay.raw)
    )
      this.notify(
        "Export includes downloaded replay sections. Other sections still need Warcraft Logs.",
      );
    if (!value) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, kind === "plan" ? 2 : undefined)], {
        type: "application/json",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `pullfiction-${kind}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  attachEngine(engine: Engine) {
    this.cancelPlayPreparation();
    this.clearTrajectoryRetries();
    this.encounterWarmer.cancel();
    this.warmedEncounter = "";
    this.replayNormalizer.reset();
    this.replayMetadata = undefined;
    this.trajectoryEpoch++; // Late notifications from a previous installation are stale.
    this.trajectoryRetryStopped = false;
    this.engine = engine;
    try {
      const stored = JSON.parse(
        this.storage?.getItem("pullfiction.raidFrames.size.v1") ?? "null",
      );
      if (stored) this.setRaidFrameSize(stored.width, stored.height, false);
    } catch {}
    engine.set_raid_frame_size?.(
      this.state.raidFrameSize.width,
      this.state.raidFrameSize.height,
    );

    this.lastAnnotationPayload = null;
    engine.set_editor_mode?.(this.state.workspaceMode === "plan");
    this.syncKeyboardCapture();
    engine.set_editor_orbit_player?.(
      this.state.cameraMode === "orbit" ? (this.state.orbitTarget ?? "") : "",
    );
    if (this.state.plan.mapId !== 409) engine.load_raid(this.state.plan.mapId);
    this.patch({ ready: true, error: null });
    this.sendAnnotations();
    this.render();
  }
  portraitUrl(actor: Actor) {
    return actor.displayID ? this.portraits.get(actor.displayID) : undefined;
  }
  requestActorInspection(key: string, yaw = 0) {
    const unit = this.frame.find((a) => a.key === key && a.player);
    const requestId = ++this.inspectionRequest;
    const source = `${this.state.gameVersion}:${this.state.replay?.report.code ?? this.state.projectId ?? ""}`;
    const previous = this.state.inspectionModel;
    const url =
      previous?.key === key && previous.source === source ? previous.url : null;
    if (previous?.url && previous.url !== url)
      URL.revokeObjectURL(previous.url);
    const error = !Number.isFinite(yaw)
      ? "Invalid model rotation."
      : !this.engine?.request_actor_inspection
        ? this.state.ready
          ? "The loaded renderer does not support character inspection. Reload the preview."
          : "Loading character assets."
        : !unit
          ? "The character appearance is not ready yet."
          : null;
    this.patch({
      inspectionModel: { key, source, requestId, url, loading: !error, error },
    });
    if (!error && unit && Number.isFinite(yaw)) {
      try {
        this.engine!.request_actor_inspection!(
          JSON.stringify({
            key,
            requestId,
            yaw: Math.max(-Math.PI * 4, Math.min(Math.PI * 4, yaw)),
            unit: { ...unit, wisp: false, dead: false, estimated: false },
          }),
        );
      } catch (e) {
        this.patch({
          inspectionModel: {
            key,
            source,
            requestId,
            url,
            loading: false,
            error: message(e),
          },
        });
      }
    }
    return requestId;
  }
  closeActorInspection() {
    this.inspectionRequest++;
    const current = this.state.inspectionModel;
    if (current?.url) URL.revokeObjectURL(current.url);
    this.engine?.close_actor_inspection?.();
    this.patch({ inspectionModel: null });
  }
  spellReference(id: number) {
    const record = (this.modernSpells[id] ?? this.spells[id]) as
      Record<string, unknown> | undefined;
    return {
      name: typeof record?.name === "string" ? record.name : undefined,
      icon: Number.isInteger(record?.iconFile)
        ? `pf_${record?.iconFile}`
        : typeof record?.icon === "string"
          ? record.icon
          : undefined,
    };
  }
  requestMapPortraits() {
    const actors = this.state.replay?.actors ?? [];
    const displays = new Set<number>();
    const requests = actors
      .filter(
        (a) =>
          a.type !== "Player" &&
          a.displayID &&
          !this.portraits.has(a.displayID),
      )
      .sort((a, b) => Number(b.class === "Boss") - Number(a.class === "Boss"))
      .flatMap((a) => {
        if (displays.has(a.displayID!)) return [];
        displays.add(a.displayID!);
        return [{ key: a.key, display: a.displayID }];
      });
    for (let i = 0; i < requests.length; i += 256)
      this.engine?.request_portraits?.(
        JSON.stringify(requests.slice(i, i + 256)),
      );
  }
  receive = (kind: string, value: string) => {
    if (kind === "actor-inspection") {
      const data = JSON.parse(value);
      const current = this.state.inspectionModel;
      if (
        !current ||
        data.key !== current.key ||
        data.requestId !== current.requestId
      ) {
        if (typeof data.url === "string" && data.url.startsWith("blob:"))
          URL.revokeObjectURL(data.url);
        return;
      }
      if (typeof data.url === "string" && data.url.startsWith("blob:")) {
        if (current.url && current.url !== data.url)
          URL.revokeObjectURL(current.url);
        this.patch({
          inspectionModel: {
            ...current,
            url: data.url,
            loading: false,
            error: null,
          },
        });
      } else if (typeof data.error === "string") {
        this.patch({
          inspectionModel: {
            ...current,
            loading: false,
            error: data.error.slice(0, 500),
          },
        });
      }
    } else if (kind === "plates") {
      if (this.state.browserAssets)
        this.patch({ browserPlates: parseBrowserPlates(value) });
    } else if (kind === "marks") {
      const data = JSON.parse(value) as {
        ids: string[];
        actors?: string[];
        mode: number;
        epoch: number;
      };
      if (data.epoch === this.pickEpoch) {
        const mode =
          (["replace", "add", "toggle"] as const)[data.mode] ?? "replace";
        if (this.state.selectionFilter !== "actors")
          this.selectMarks(data.ids, mode);
        if (this.state.selectionFilter !== "drawings")
          this.selectActors(data.actors ?? [], mode);
      }
    } else if (kind === "plan-hover") {
      const basis = JSON.parse(value);
      if (
        Array.isArray(basis.right) &&
        Array.isArray(basis.up) &&
        [...basis.right, ...basis.up].every(Number.isFinite)
      )
        this.viewBasis = { right: basis.right, up: basis.up };
      this.patch({ sceneHover: JSON.parse(value) });
      const markerIndex = this.pendingMarkerClicks.findIndex(
        (click) =>
          basis.request === click.request &&
          Array.isArray(basis.pixel) &&
          Math.hypot(basis.pixel[0] - click.x, basis.pixel[1] - click.y) < 0.1,
      );
      if (markerIndex >= 0) {
        const [click] = this.pendingMarkerClicks.splice(markerIndex, 1);
        if (
          click.epoch !== this.pickEpoch ||
          click.projectEpoch !== this.projectEpoch ||
          this.state.tool !== "marker" ||
          basis.nativeUI
        )
          return;
        const actor = click.selectedActor ?? basis.actor;
        if (!actor || !this.startActorDrawing(actor)) {
          if (
            Array.isArray(basis.point) &&
            basis.point.length === 3 &&
            basis.point.every(Number.isFinite)
          )
            this.placePoint(basis.point as Point);
          else
            this.notify("No loaded ground here. Move the 3D view here first.");
        }
        return;
      }
      if (basis.nativeUI) {
        const pending = this.pendingSceneSelect;
        if (
          pending &&
          Array.isArray(basis.pixel) &&
          Math.hypot(basis.pixel[0] - pending.x, basis.pixel[1] - pending.y) <
            0.1
        )
          this.pendingSceneSelect = null;
        return;
      }
      const click = this.pendingSceneSelect;
      if (
        click &&
        Array.isArray(basis.pixel) &&
        Math.hypot(basis.pixel[0] - click.x, basis.pixel[1] - click.y) < 0.1
      ) {
        this.pendingSceneSelect = null;
        if (
          this.state.selectionFilter !== "drawings" &&
          basis.actor &&
          basis.handle == null
        )
          this.selectActor(basis.actor, click.toggle);
        else if (
          this.state.selectionFilter !== "actors" &&
          basis.id &&
          !String(basis.id).startsWith("actor-gizmo:")
        )
          this.selectMark(basis.id, click.toggle ? "toggle" : "replace");
        else if (this.state.selectionFilter !== "drawings" && basis.actor)
          this.selectActor(basis.actor, click.toggle);
        else if (!click.toggle) {
          this.selectMark(null);
          this.clearActorSelection();
          this.select(null);
        }
      }
    } else if (kind === "focus-actor") {
      this.focusActorFromRaidFrame(value);
    } else if (kind === "mark") {
      this.selectMark(value || null);
    } else if (kind === "plan-point") {
      const data = JSON.parse(value) as {
        token: number;
        point: Point | null;
        preview?: boolean;
      };
      if (data.token !== this.pickEpoch) return;
      this.pendingPicks = Math.max(0, this.pendingPicks - 1);
      try {
        if (data.point) this.placePoint(data.point, data.preview);
        else this.notify("No loaded ground here. Move the 3D view here first.");
      } catch (e) {
        this.notify(message(e));
      }
      while (!this.pendingPicks && this.mapPickQueue.length) {
        this.pickMap(...this.mapPickQueue.shift()!);
      }
      if (this.finishRequested && !this.pendingPicks) this.finishDrawing();
      if (!this.pendingPicks && this.saveWhenReady) {
        this.saveWhenReady = false;
        this.save();
      }
    } else if (kind === "portrait") {
      const data = JSON.parse(value) as { display: number; url: string };
      if (
        Number.isInteger(data.display) &&
        data.display > 0 &&
        typeof data.url === "string" &&
        data.url.startsWith("blob:")
      ) {
        const old = this.portraits.get(data.display);
        if (old && old !== data.url) URL.revokeObjectURL(old);
        this.portraits.set(data.display, data.url);
        this.patch({ portraitVersion: this.state.portraitVersion + 1 });
      }
    } else if (kind === "point") {
      if (this.state.tool !== "explore" || this.markDrag || this.actorDrag) {
        try {
          this.placePoint(JSON.parse(value));
        } catch (e) {
          this.notify(message(e));
        }
      }
    } else if (kind === "scene") {
      if (
        value !== String(this.state.plan.mapId) &&
        !(value === "ready" && this.state.plan.mapId === 409)
      )
        return;
      clearTimeout(this.sceneTimer);
      this.sceneTimer = undefined;
      const first = !this.state.sceneReady;
      this.patch({
        sceneReady: true,
        status: raidByMap(this.state.plan.mapId)?.name ?? "Raid",
      });
      if (first && this.state.cameraMode !== "orbit") this.focusCurrent();
      this.startClientPrefetch();
    } else if (kind === "status") {
      this.patch({ status: value });
    } else if (kind === "visualDiagnostics")
      console.debug("Spell visual coverage", value);
    else if (kind === "movementDiagnostics") {
      try {
        this.movementDiagnostics = JSON.parse(value);
      } catch {
        this.movementDiagnostics = null;
      }
    } else if (kind === "playbackPrepared") {
      try {
        const result = JSON.parse(value);
        if (
          this.state.playPreparing &&
          result.token === this.playPreparationToken
        ) {
          this.patch({ playPreparing: false, playing: true });
          this.render();
        }
      } catch {}
    } else if (kind === "movementPreparation") {
      try {
        const status = JSON.parse(value);
        if (
          ![status.ready, status.pending, status.conflict].every(
            (count) => Number.isInteger(count) && count >= 0 && count <= 8192,
          )
        )
          return;
        const movementPreparing = status.pending > 0;
        const movementConflicted = status.conflict > 0;
        if (
          movementPreparing !== !!this.state.movementPreparing ||
          movementConflicted !== !!this.state.movementConflicted
        )
          this.patch({ movementPreparing, movementConflicted });
      } catch {
        /* Ignore malformed optional renderer status. */
      }
    } else if (kind === "trajectoryMissing") {
      if (this.trajectoryRetryStopped) return;
      try {
        const rows = JSON.parse(value);
        if (!Array.isArray(rows) || rows.length > 256) return;
        let resend = false;
        for (const row of rows) {
          if (
            row.source !== this.trajectorySource ||
            ![row.source, row.actor, row.component, row.content].every(
              (part) => typeof part === "string" && part.length <= 512,
            )
          )
            continue;
          const key = this.trajectoryPacketKey(
            row.source,
            row.actor,
            row.component,
            row.content,
          );
          if (
            this.trajectoryDemands.has(key) &&
            !this.trajectoryRejected.has(key)
          ) {
            this.trajectorySent.delete(key);
            resend = true;
          }
        }
        if (resend) {
          const epoch = this.trajectoryRetryEpoch;
          const engine = this.engine;
          queueMicrotask(() => {
            if (
              !this.trajectoryRetryStopped &&
              epoch === this.trajectoryRetryEpoch &&
              engine === this.engine
            )
              this.sendPositions();
          });
        }
      } catch {
        /* A missing optional cache entry is retried on the next source update. */
      }
    } else if (kind === "trajectoryError") {
      if (this.trajectoryRetryStopped) return;
      try {
        const row = JSON.parse(value);
        if (
          row.source !== this.trajectorySource ||
          ![row.source, row.actor, row.component, row.content].every(
            (part) => typeof part === "string",
          )
        )
          return;
        const key = this.trajectoryPacketKey(
          row.source,
          row.actor,
          row.component,
          row.content,
        );
        if (row.message === "Canonical active cache capacity exceeded") {
          this.retryTrajectoryCapacity(key);
        } else if (!this.trajectoryRejected.has(key)) {
          this.trajectoryRetries.delete(key);
          this.armTrajectoryRetry();
          this.trajectoryRejected.set(key, String(row.message).slice(0, 240));
          this.notify(
            `Movement could not be prepared: ${String(row.message).slice(0, 240)}`,
          );
          if (this.state.playPreparing) this.sendPositions();
        }
      } catch {
        /* Optional diagnostics cannot interrupt playback. */
      }
    } else if (kind === "trajectoryCache") {
      try {
        this.trajectoryDiagnostics = JSON.parse(value);
      } catch {}
    } else if (kind === "trajectoryProbe") {
      try {
        this.trajectoryDiagnostics = JSON.parse(value);
      } catch {
        this.trajectoryDiagnostics = null;
      }
    } else if (kind === "notice") this.notify(value);
    else if (kind === "actors") {
      const data = JSON.parse(value);
      const selected = data.selected ?? null;
      const changed = selected !== this.lastNativeSelection;
      this.lastNativeSelection = selected;
      this.patch({
        visualEvents: data.visualEvents,
        unsupported: data.unsupported,
        ...(changed
          ? {
              selected,
              ...(selected && selected !== this.state.selected
                ? {
                    selectedMark: null,
                    selectedMarks: [],
                    selectedActors: [selected],
                  }
                : {}),
              ...(selected !== this.state.selected ? { detail: null } : {}),
            }
          : {}),
      });
    }
  };
  private async restoreClientFolder() {
    if (this.clientRestoreStarted || this.engine) return;
    this.clientRestoreStarted = true;
    if (!this.runtime.openClient) {
      await this.openClient([], false);
      return;
    }
    const epoch = ++this.clientAccessEpoch;
    if (this.clientCache) {
      try {
        const prepared = await this.clientCache.restore(this.needClientSource);
        if (epoch !== this.clientAccessEpoch) {
          prepared?.close();
          return;
        }
        if (prepared) {
          await this.openClient([], false, prepared);
          return;
        }
      } catch {
        if (epoch !== this.clientAccessEpoch) return;
        this.patch({ clientCacheStatus: "unavailable" });
      }
    }
    if (!this.clientFolders?.supported) return;
    try {
      const handle = await this.clientFolders.load();
      if (epoch !== this.clientAccessEpoch || !handle) return;
      this.rememberedClientFolder = handle;
      this.patch({ clientFolderName: handle.name, clientRemembered: true });
      const permission = await this.clientFolders.permission(handle);
      if (epoch !== this.clientAccessEpoch) return;
      if (permission === "granted") await this.openClient(handle, false);
      else
        this.patch({
          clientReconnect: true,
          clientProgress: "Reconnect your saved client folder",
        });
    } catch {
      if (epoch === this.clientAccessEpoch)
        this.patch({
          clientReconnect: !!this.rememberedClientFolder,
          clientProgress:
            "Saved folder access is unavailable. Choose or reconnect your client folder.",
        });
    }
  }
  async chooseClientFolder() {
    if (
      !this.state.browserAssets ||
      (this.engine && !this.preparedClient?.needsSource) ||
      !this.clientFolders?.supported
    )
      return;
    const epoch = ++this.clientAccessEpoch;
    this.clientRestoreStarted = true;
    try {
      const handle = await this.clientFolders.pick(
        this.rememberedClientFolder ?? undefined,
      );
      if (epoch === this.clientAccessEpoch) await this.openClient(handle);
    } catch (error) {
      if (
        epoch !== this.clientAccessEpoch ||
        (error instanceof Error && error.name === "AbortError")
      )
        return;
      this.patch({
        error: null,
        clientProgress:
          "The browser could not open the folder picker. Use the folder upload below instead.",
      });
    }
  }
  async reconnectClientFolder() {
    const handle = this.rememberedClientFolder;
    if (!handle || !this.clientFolders || this.engine) return;
    const epoch = ++this.clientAccessEpoch;
    this.clientRestoreStarted = true;
    try {
      // No storage lookup or other await before the native permission request.
      const permissionRequest = this.clientFolders.permission(handle, true);
      this.patch({
        clientStatus: "opening",
        clientProgress: "Requesting access to your saved client folder",
        error: null,
      });
      const permission = await permissionRequest;
      if (epoch !== this.clientAccessEpoch) return;
      if (permission === "granted") await this.openClient(handle, false);
      else
        this.patch({
          clientStatus: "select",
          clientReconnect: true,
          clientProgress:
            "Folder access was not granted. Reconnect or choose a different folder.",
        });
    } catch (error) {
      if (epoch !== this.clientAccessEpoch) return;
      this.patch({
        clientStatus: "select",
        clientReconnect: true,
        error: null,
        clientProgress:
          "Could not reconnect the saved folder. Choose a different folder or use folder upload.",
      });
    }
  }
  async forgetClientFolder() {
    ++this.clientAccessEpoch;
    this.clientRestoreStarted = true;
    try {
      await this.clientFolders?.forget();
      this.rememberedClientFolder = null;
      this.patch({
        clientFolderName: null,
        clientRemembered: false,
        clientReconnect: false,
        clientFolderError: null,
      });
    } catch {
      this.notify("Could not forget the saved folder in this browser.");
    }
  }
  private needClientSource = () => {
    this.patch({
      clientNeedsFiles: true,
      clientPromptHidden: false,
      clientProgress:
        "More game assets are needed. Select your client folder to continue.",
    });
  };
  showClientSource() {
    this.patch({ clientPromptHidden: false });
  }
  dismissClientSource() {
    if (this.state.busy) this.cancelImport();
    this.patch({ clientPromptHidden: true });
  }
  /** Start one background pass once the active scene and attached client source are ready. */
  private startClientPrefetch() {
    const client = this.preparedClient;
    if (
      !client?.hasSource ||
      !this.state.sceneReady ||
      this.prefetchAbort ||
      this.runtime.rendererLab
    )
      return;
    const abort = new AbortController();
    this.prefetchAbort = abort;
    void client
      .prefetch({
        raids: RAIDS.map((raid) => ({
          map: raid.map,
          directory: raid.directory,
        })),
        signal: abort.signal,
        ready: () =>
          this.state.sceneReady && !this.state.busy && !this.state.buffering,
        progress: (clientPrefetchProgress) => {
          if (!abort.signal.aborted) this.patch({ clientPrefetchProgress });
        },
      })
      .catch((error) => {
        if (!abort.signal.aborted)
          this.patch({
            clientPrefetchProgress: `Background caching stopped: ${message(error)}`,
          });
      });
  }
  async clearClientCache() {
    this.prefetchAbort?.abort();
    this.patch({ clientPrefetchProgress: "" });
    try {
      await this.clientCache?.forget();
      resetLocalMaps();
      this.patch({ clientCacheStatus: "none" });
      this.notify(
        "Local game asset cache cleared. Your plans and logs are unchanged.",
      );
    } catch (error) {
      this.notify(`Could not clear the asset cache: ${message(error)}`);
    }
  }
  async restartClientCache() {
    try {
      if (this.state.dirty && this.projectStore) await this.saveProject();
      if (this.state.dirty)
        throw new Error("Save or export your plan before restarting");
      await this.clientCache?.forget();
      // A native Bevy runtime owns one page lifetime. Restart it cleanly for a new build.
      window.location.reload();
    } catch (error) {
      this.notify(message(error));
    }
  }
  private async attachClientSource(files: ClientSelection) {
    const prepared = this.preparedClient;
    if (
      !prepared ||
      (!prepared.needsSource &&
        !(this.runtime.rendererLab && !prepared.hasSource))
    )
      return;
    this.clientAttachAbort?.abort();
    const abort = new AbortController();
    this.clientAttachAbort = abort;
    this.patch({
      clientAttaching: true,
      error: null,
      clientNeedsRestart: false,
      clientProgress: "Opening your client folder",
    });
    let source: ClientReader | null = null;
    try {
      source = await (this.runtime.openClient ?? openHostedClient)(
        files,
        (value) => {
          if (!abort.signal.aborted)
            this.patch({ clientProgress: progressText(value) });
        },
        { signal: abort.signal },
      );
      abort.signal.throwIfAborted();
      if (this.preparedClient !== prepared)
        throw new DOMException("Client access was cancelled", "AbortError");
      prepared.attach(source);
      this.startClientPrefetch();
      source = null;
      this.patch({
        clientNeedsFiles: false,
        clientPromptHidden: false,
        clientAttaching: false,
        error: null,
        clientProgress: "Loading local assets",
      });
    } catch (error) {
      source?.close();
      if (abort.signal.aborted || this.preparedClient !== prepared) return;
      this.patch({
        clientAttaching: false,
        error: message(error),
        clientNeedsRestart:
          error instanceof Error && error.name === "ClientBuildChangedError",
      });
    }
  }
  async openClient(
    files: ClientSelection,
    remember = true,
    restored?: PreparedClient,
  ) {
    if (!this.runtime.openClient && (!Array.isArray(files) || files.length))
      throw new Error("Game assets are supplied by Pull Fiction");
    if (
      !restored &&
      this.preparedClient &&
      (this.preparedClient.needsSource ||
        (this.runtime.rendererLab && !this.preparedClient.hasSource))
    )
      return this.attachClientSource(files);
    if (!this.state.browserAssets || this.engine) return;
    const clientEpoch = ++this.clientAccessEpoch;
    this.clientRestoreStarted = true;
    this.clientAbort?.abort();
    const abort = new AbortController();
    this.clientAbort = abort;
    this.patch({
      clientStatus: "opening",
      clientProgress: restored
        ? "Opening saved game assets"
        : "Downloading game assets",
      error: null,
      clientNeedsFiles: false,
      clientPromptHidden: false,
      clientNeedsRestart: false,
      clientAttaching: false,
    });
    let reader: ClientReader | null = null;
    let preparedFiles: LocalClientFiles | null = null;
    let releasePreparedFiles: (() => void) | null = null;
    let releasePreparedArt: (() => void) | null = null;
    try {
      reader =
        restored ??
        (await (this.runtime.openClient ?? openHostedClient)(
          files,
          (value) => {
            if (!abort.signal.aborted)
              this.patch({ clientProgress: progressText(value) });
          },
          { signal: abort.signal },
        ));
      abort.signal.throwIfAborted();
      if (!restored && this.clientCache) {
        try {
          reader = await this.clientCache.wrap(reader, this.needClientSource);
          this.patch({ clientCacheStatus: "recording" });
        } catch {
          this.patch({ clientCacheStatus: "unavailable" });
        }
      }
      abort.signal.throwIfAborted();
      this.preparedClient =
        restored ??
        (reader && "activate" in reader ? (reader as PreparedClient) : null);
      this.clientReader = reader;
      this.patch({ clientBuild: reader.build.version });
      const bridge = assetBridge(reader);
      this.browserBridge = bridge;
      setLocalTalentsProvider(
        () => bridge.catalog("talents") as Promise<TalentCatalog>,
      );
      this.floorGeometry.clear();
      this.loadedFloors.clear();
      this.floorHintCache = null;
      this.catalogs = null;
      installAssetBridge(bridge);
      this.patch({
        clientProgress: "Loading creature, item and spell data",
      });
      await this.loadCatalogs();
      abort.signal.throwIfAborted();
      this.patch({
        clientProgress: "Loading scene assets",
      });
      const localFiles = originalClientFiles(bridge);
      preparedFiles = localFiles;
      this.localFiles = localFiles;
      await prepareOriginalClient(localFiles, abort.signal);
      await this.preparePlanAssets(this.state.plan, abort.signal);
      abort.signal.throwIfAborted();
      if (typeof document !== "undefined") {
        releasePreparedArt = await installLocalUiArt(localFiles);
        this.releaseLocalArt = releasePreparedArt;
      }
      abort.signal.throwIfAborted();
      releasePreparedFiles = installLocalClientFiles(localFiles);
      this.releaseLocalFiles = releasePreparedFiles;
      if (this.preparedClient) {
        const cached = await this.preparedClient.activate();
        abort.signal.throwIfAborted();
        this.patch({ clientCacheStatus: cached ? "ready" : "unavailable" });
      }
      if (
        this.clientFolders?.supported &&
        remember &&
        clientEpoch === this.clientAccessEpoch
      ) {
        try {
          if (Array.isArray(files)) {
            await this.clientFolders.forget();
            abort.signal.throwIfAborted();
            if (clientEpoch === this.clientAccessEpoch) {
              this.rememberedClientFolder = null;
              this.patch({
                clientRemembered: false,
                clientFolderName: null,
                clientFolderError: null,
              });
            }
          } else {
            await this.clientFolders.save(files);
            abort.signal.throwIfAborted();
            if (clientEpoch === this.clientAccessEpoch) {
              this.rememberedClientFolder = files;
              this.patch({
                clientRemembered: true,
                clientFolderName: files.name,
                clientFolderError: null,
              });
            }
          }
        } catch (error) {
          if (abort.signal.aborted) throw error;
          this.patch({ clientFolderError: message(error) });
          this.notify(
            "Client opened, but this browser could not save the folder choice.",
          );
        }
      }
      abort.signal.throwIfAborted();
      this.patch({
        clientStatus: "ready",
        clientReconnect: false,
        clientBuild: reader.build.version,
        clientProgress: "Game assets ready",
      });
      await this.boot();
      abort.signal.throwIfAborted();
      try {
        const pending = this.pendingProjectReplay;
        if (pending) {
          const prepared = await this.prepareReplayForInstall(
            pending.raw,
            abort.signal,
          );
          this.restoringProject = true;
          try {
            this.installReplay(pending.raw, prepared);
            this.seek(pending.time);
            this.setWorkspaceMode(pending.mode);
            this.pendingProjectReplay = null;
          } finally {
            this.restoringProject = false;
          }
        }
      } catch (error) {
        this.restoringProject = false;
        this.patch({
          libraryError: `Could not resume the saved source replay: ${message(error)}`,
        });
        this.notify(`Could not resume source replay: ${message(error)}`);
      }
    } catch (error) {
      reader?.close();
      if (this.clientReader === reader) setLocalTalentsProvider(null);
      releasePreparedFiles?.();
      releasePreparedArt?.();
      preparedFiles?.close();
      if (this.localFiles === preparedFiles) {
        this.releaseLocalFiles = null;
        this.releaseLocalArt = null;
        this.localFiles = null;
      }
      if (this.clientAbort !== abort) return;
      if (this.browserBridge) removeAssetBridge(this.browserBridge);
      this.browserBridge = null;
      this.clientReader = null;
      this.preparedClient = null;
      this.catalogs = null;
      this.patch({
        clientStatus: abort.signal.aborted ? "select" : "error",
        clientReconnect: !!this.rememberedClientFolder,
        error: abort.signal.aborted ? null : message(error),
        clientProgress: abort.signal.aborted
          ? "Game asset download cancelled"
          : message(error),
      });
    }
  }
  cancelClient() {
    ++this.clientAccessEpoch;
    this.clientAttachAbort?.abort();
    this.clientAbort?.abort();
    if (!this.engine) this.preparedClient?.close();
    if (!this.engine)
      this.patch({
        clientStatus: "select",
        clientAttaching: false,
        clientNeedsFiles: false,
        error: null,
      });
  }
  async boot(): Promise<void> {
    const clientEpoch = this.clientAccessEpoch;
    if (!this.runtime.rendererLab) await this.initializeLibrary();
    if (clientEpoch !== this.clientAccessEpoch) return;
    if (this.state.browserAssets) {
      if (!this.runtime.rendererLab) await this.initializeWcl();
      if (clientEpoch !== this.clientAccessEpoch) return;
      if (this.state.clientStatus === "select")
        await this.restoreClientFolder();
      if (this.state.clientStatus !== "ready") return;
    }
    if (this.engine) return;
    if (this.bootPromise) {
      await this.bootPromise;
      if (
        this.state.browserAssets &&
        !this.engine &&
        this.state.clientStatus === "ready" &&
        !this.state.error
      )
        return this.boot();
      return;
    }
    this.bootPromise = this.bootEngine(
      this.state.browserAssets ? this.clientAbort?.signal : undefined,
    ).finally(() => {
      this.bootPromise = null;
    });
    return this.bootPromise;
  }
  rendererLabResources() {
    if (!this.runtime.rendererLab)
      throw new Error("Renderer diagnostics are not enabled");
    return {
      engine: this.engine,
      bridge: this.browserBridge,
      files: this.localFiles,
      npcModels: this.browserModels,
      needsSource: Boolean(
        this.preparedClient && !this.preparedClient.hasSource,
      ),
    };
  }
  rendererLabConnectSource() {
    if (!this.runtime.rendererLab)
      throw new Error("Renderer diagnostics are not enabled");
    this.needClientSource();
  }
  private async bootEngine(signal?: AbortSignal) {
    try {
      signal?.throwIfAborted();
      if (!navigator.gpu) throw new Error("WebGPU is unavailable");
      if (!this.state.browserAssets) {
        const dataRoot = await resolveAssetRoot();
        (
          window as unknown as { __pullfiction_data_root: string }
        ).__pullfiction_data_root = dataRoot;
        const response = await fetch(
          dataRoot + "/" + encodeURIComponent("DBFilesClient\\Map.dbc"),
        );
        if (!response.ok) throw new Error("Local game data unavailable");
        if (
          new TextDecoder().decode(
            (await response.arrayBuffer()).slice(0, 4),
          ) !== "WDBC"
        )
          throw new Error("Invalid local game data");
      }
      const modulePath = "/pullfiction_viewer.js";
      const engine = this.runtime.loadEngine
        ? await this.runtime.loadEngine()
        : ((await import(/* @vite-ignore */ modulePath)) as Engine);
      await engine.default();
      signal?.throwIfAborted();
      engine.start();
      this.attachEngine(engine);
      if (!this.state.sceneReady) this.waitForScene();
    } catch (e) {
      if (!signal?.aborted) this.fail(message(e));
    }
  }
  fail(error: string) {
    clearTimeout(this.sceneTimer);
    this.sceneTimer = undefined;
    this.cancelPlayPreparation();
    this.patch({ error, playing: false });
  }
  start() {
    this.trajectoryRetryStopped = false;
    if (this.raf) return;
    const tick = (now: number) => {
      if (this.previousTick) {
        const delta = Math.min(250, now - this.previousTick);
        this.advance(delta);
      }
      this.previousTick = now;
      if (now - this.lastFrame >= 50) {
        const rendered = this.renderedInputs;
        if (
          this.state.playing ||
          !rendered ||
          rendered.state !== this.state ||
          rendered.time !== this.clockTime ||
          rendered.models !== this.models ||
          rendered.engine !== this.engine ||
          rendered.geometry !== this.loadedFloors.get(this.state.plan.mapId)
        )
          this.render();
        this.lastFrame = now;
      } else if (
        this.state.playing &&
        !this.state.buffering &&
        this.bufferedReady(this.clockTime)
      ) {
        this.sendPositions();
        this.sendActions();
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  stop() {
    this.cancelPlayPreparation();
    this.encounterWarmEpoch++;
    this.encounterWarmer.cancel();
    this.warmedEncounter = "";
    this.replayNormalizer.reset();
    this.replayMetadata = undefined;
    this.clearTrajectoryRetries();
    this.trajectoryRetryStopped = true;
    this.prefetchAbort?.abort();
    ++this.clientAccessEpoch;
    this.clientAttachAbort?.abort();
    this.closeActorInspection();
    setLocalTalentsProvider(null);
    this.replayBuffer?.close();
    this.loadingBuffer?.close();
    this.bufferRequest++;
    clearTimeout(this.autosaveTimer);
    if (
      this.projectStore &&
      this.state.dirty &&
      !this.state.drawing &&
      !this.pendingPicks
    )
      void this.saveProject();
    this.importAbort?.abort();
    if (!this.engine) {
      this.clientAbort?.abort();
      this.clientReader?.close();
      this.releaseLocalFiles?.();
      this.releaseLocalFiles = null;
      this.releaseLocalArt?.();
      this.releaseLocalArt = null;
      this.localFiles?.close();
      this.localFiles = null;
      if (this.browserBridge) removeAssetBridge(this.browserBridge);
    }
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.previousTick = 0;
    clearTimeout(this.noticeTimer);
    clearTimeout(this.sceneTimer);
    this.sceneTimer = undefined;
  }
  advance(delta: number) {
    if (!this.state.playing) return;
    if (this.state.clientNeedsFiles && !this.state.clientPromptHidden) return;
    if (this.state.buffering) return;
    const previous = this.clockTime;
    this.clockTime = this.clockTime + delta * this.state.rate;
    const loop = this.state.loop;
    if (loop && this.clockTime >= loop[1]) {
      this.clockTime =
        loop[0] + ((this.clockTime - loop[0]) % Math.max(1, loop[1] - loop[0]));
      this.resetEvents = true;
    } else if (this.clockTime >= this.duration()) {
      this.clockTime = this.duration();
      if (this.bufferedReady(this.clockTime)) this.patch({ playing: false });
    }
    if (this.replayBuffer && !this.bufferedReady(this.clockTime)) {
      const target = this.clockTime;
      this.clockTime = previous;
      void this.ensureBuffered(target);
    } else this.prefetchBuffered();
  }
  render() {
    // Native calls may synchronously publish selection/state callbacks. Capture
    // the inputs first so those changes still invalidate the next paused update.
    const inputs = {
      state: this.state,
      time: this.clockTime,
      models: this.models,
      geometry: this.loadedFloors.get(this.state.plan.mapId),
      engine: this.engine,
    };
    this.renderFrame();
    this.renderedInputs = inputs;
  }
  private renderFrame() {
    // The diagnostic runner owns actors, annotations and scene presentation.
    // Async editor bootstrap/floor callbacks must not inject reference spawns
    // between a fixture's clear and install operations.
    if (this.runtime.rendererLab) return;
    const { replay, options } = this.state;
    this.sendAnnotations();
    if (
      replay?.raw.stream &&
      (this.state.buffering || !this.bufferedReady(this.clockTime))
    ) {
      this.engine?.replay_clock?.(this.clockTime, this.state.rate, false);
      this.patch({ time: this.clockTime });
      return;
    }
    if (this.engine?.set_replay_nameplate_filters)
      this.engine.set_replay_nameplate_filters(
        options.nameplates && options.friendlyNameplates,
        options.nameplates && options.enemyNameplates,
      );
    else this.engine?.set_replay_nameplates?.(options.nameplates);
    this.engine?.set_replay_raid_frames?.(options.raidFrames);
    if (!replay) {
      this.sendPositions();
      this.patch({ time: this.clockTime });
      return;
    }
    const chapter = chapterAt(replay, this.clockTime);
    if (chapter?.id !== this.lastChapter) {
      this.lastChapter = chapter?.id ?? null;
      if (
        chapter &&
        options.followPulls &&
        this.state.sceneReady &&
        this.state.cameraMode !== "orbit"
      )
        this.focusCurrent();
    }
    const friendly = new Set(replay.fight.friendlyPlayers);
    this.warmEncounter();
    // Keep actors entering before the next possible full update. advance() caps
    // a delayed frame at 250ms and supported playback rates at four times.
    const candidates = this.presentReplayActors(1000);
    this.frame = this.sceneActors()
      .filter((actor) => !candidates || candidates.has(actor.key))
      .map((actor) => {
        const state = combatStateAt(actor, this.clockTime),
          appearance = this.appearance(actor);
        return {
          key: actor.key,
          name: actor.name,
          player: actor.type === "Player",
          raid:
            actor.type === "Player" &&
            ((!!this.snapshot() && this.state.workspaceMode === "plan") ||
              friendly.has(actor.id)),
          class: classIDs[actor.class] ?? 1,
          entry: actor.gameID || 0,
          display: appearance.display ?? actor.displayID,
          scale: actor.scale,
          position: null,
          ground: true,
          facing: 0,
          speed: 0,
          dead: false,
          estimated: false,
          friendly: actor.type === "Pet",
          nameplate: actorNameplateEnabled(actor, options),
          race: appearance.race ?? actor.race,
          sex: appearance.sex ?? actor.sex,
          look: appearance.look ?? [0, 0, 0, 0, 0],
          gear: actor.gear
            .filter((g) => g.model)
            .map((g) => ({
              id: g.id,
              slot: g.slot,
              ...g.model,
              name: g.name ?? g.model?.name ?? `Item ${g.id}`,
              quality: g.quality ?? g.model?.quality ?? 0,
              enchant: g.permanentEnchant ?? 0,
              temporary: g.temporaryEnchant ?? 0,
            })),
          health: state.health?.current ?? null,
          max_health: state.health?.max ?? null,
          power: state.power?.current ?? null,
          max_power: state.power?.max ?? null,
          power_type: state.power?.type ?? 0,
          plate_cast:
            state.cast && !state.cast.instant
              ? {
                  name: state.cast.name,
                  icon: state.cast.icon ?? "",
                  progress: state.cast.progress ?? 0,
                  remaining: (state.cast.end - this.clockTime) / 1000,
                }
              : null,
          plate_auras: state.auras.slice(0, 48).map((a) => ({
            spell: a.spell,
            name:
              replay.abilities.get(a.spell)?.name ??
              a.name ??
              `Spell ${a.spell}`,
            icon: replay.abilities.get(a.spell)?.icon ?? a.icon ?? "",
            stack: a.stack ?? 1,
            debuff: !!a.debuff,
          })),
          channel: !!state.cast?.channel,
          channel_target: state.cast?.channel
            ? (state.cast.target ?? null)
            : null,
          cast: state.cast && !state.cast.instant ? state.cast.spell : 0,
          auras: state.auras.slice(0, 48).map((a) => a.spell),
        };
      });
    this.sendPositions();
    this.sendActions();
    this.patch({ time: this.clockTime });
  }
  private sendActions() {
    const { replay, options } = this.state;
    if (!this.engine || !replay) return;
    const reset =
      this.resetEvents ||
      this.previousEventTime === null ||
      this.clockTime < this.previousEventTime;
    // Include the final frame's events when playback reaches its end. Explicit
    // seeks set resetEvents and deliberately do not replay the skipped interval.
    const edges =
      !reset && options.actors && options.spells
        ? visualEventsBetween(
            replay,
            this.previousEventTime!,
            this.clockTime,
          ).map((e) => ({
            ...e,
            amount: Math.max(0, Math.round(e.amount ?? 0)),
          }))
        : [];
    this.engine.replay_clock?.(
      this.clockTime,
      this.state.rate,
      this.state.playing,
    );
    if (reset) this.engine.replay_events("[]", true);
    // Bound both count and encoded bytes. Busy AoE casts may contain many
    // targets, and UTF-8 names can occupy more bytes than JS string length.
    let batch: typeof edges = [],
      bytes = 2;
    const encoder = new TextEncoder();
    const flush = () => {
      if (batch.length)
        this.engine!.replay_events(JSON.stringify(batch), false);
      batch = [];
      bytes = 2;
    };
    for (const event of edges) {
      const size = encoder.encode(JSON.stringify(event)).byteLength + 1;
      if (batch.length && (batch.length >= 100 || bytes + size > 180000))
        flush();
      batch.push(event);
      bytes += size;
    }
    flush();
    this.previousEventTime = this.clockTime;
    this.resetEvents = false;
  }
  private trajectoryPacketKey(
    source: string,
    actor: string,
    component: string,
    content: string,
  ) {
    return JSON.stringify([source, actor, component, content]);
  }
  private clearTrajectoryRetries() {
    if (this.trajectoryRetryTimer !== null)
      clearTimeout(this.trajectoryRetryTimer);
    this.trajectoryRetryTimer = null;
    this.trajectoryRetryEpoch++;
    this.trajectoryRetries.clear();
    this.trajectoryDemands.clear();
  }
  private retryTrajectoryCapacity(key: string) {
    if (
      this.trajectoryRetryStopped ||
      !this.trajectoryDemands.has(key) ||
      this.trajectoryRejected.has(key)
    )
      return;
    this.trajectorySent.delete(key);
    const retry = this.trajectoryRetries.get(key) ?? { failures: 0, due: null };
    if (retry.due !== null) return; // Duplicate failure while already waiting.
    retry.failures++;
    if (retry.failures >= 8) {
      retry.due = Infinity;
      this.notify("Movement could not be prepared yet. Seek again to retry.");
    } else
      retry.due =
        performance.now() + Math.min(2000, 100 * 2 ** (retry.failures - 1));
    this.trajectoryRetries.set(key, retry);
    this.armTrajectoryRetry();
  }
  private armTrajectoryRetry() {
    if (this.trajectoryRetryTimer !== null)
      clearTimeout(this.trajectoryRetryTimer);
    this.trajectoryRetryTimer = null;
    const ticket = ++this.trajectoryRetryTicket;
    if (this.trajectoryRetryStopped) return;
    let due = Infinity;
    for (const [key, retry] of this.trajectoryRetries) {
      if (this.trajectoryDemands.has(key) && retry.due !== null)
        due = Math.min(due, retry.due);
    }
    if (!Number.isFinite(due)) return;
    const epoch = this.trajectoryRetryEpoch,
      source = this.trajectorySource,
      engine = this.engine;
    this.trajectoryRetryTimer = setTimeout(
      () => {
        if (
          !this.trajectoryRetryStopped &&
          ticket === this.trajectoryRetryTicket &&
          epoch === this.trajectoryRetryEpoch &&
          source === this.trajectorySource &&
          engine === this.engine
        ) {
          this.trajectoryRetryTimer = null;
          this.sendPositions();
        }
      },
      Math.max(1, Math.ceil(due - performance.now())),
    );
  }
  private activateTrajectorySource() {
    const engine = this.engine;
    const replay = this.state.replay;
    const source =
      replay &&
      engine?.submit_replay_trajectory &&
      engine.set_replay_trajectory_source
        ? `${replayIdentity(replay)}:installation-${this.trajectoryEpoch}`
        : "";
    if (source === this.trajectorySource && engine === this.trajectoryEngine)
      return;
    this.clearTrajectoryRetries();
    this.trajectorySource = source;
    this.trajectoryEngine = engine;
    this.trajectorySent.clear();
    this.trajectoryRejected.clear();
    engine?.set_replay_trajectory_source?.(source);
  }
  private requestTrajectoryCoverage(start: number, end: number) {
    if (
      !this.replayBuffer ||
      this.trajectoryCoverageBlocked ||
      this.state.bufferError
    )
      return;
    end = Math.max(end, start + 1);
    const queued = this.trajectoryCoverage;
    this.trajectoryCoverage =
      queued?.source === this.trajectorySource
        ? {
            source: queued.source,
            start: Math.min(start, queued.start),
            end: Math.max(end, queued.end),
          }
        : { source: this.trajectorySource, start, end };
    if (queued) return;
    queueMicrotask(() => {
      const range = this.trajectoryCoverage;
      this.trajectoryCoverage = null;
      if (
        !range ||
        range.source !== this.trajectorySource ||
        this.trajectoryCoverageBlocked ||
        this.state.downloadingReplay ||
        this.state.buffering ||
        this.replayBuffer?.active
      )
        return;
      void this.loadReplayRange(range.start, range.end);
    });
  }
  private trajectoryBinding(
    actor: Actor | undefined,
    pose: Pick<
      NonNullable<ReturnType<typeof poseAt>>,
      "pos" | "dead" | "movement"
    > | null,
  ): {
    trajectory?: NativeTrajectoryReference;
    trajectory_prepare?: NativeTrajectoryReference;
    trajectory_bridge?: {
      from: NativeTrajectoryReference;
      to: NativeTrajectoryReference;
    };
  } {
    const replay = this.state.replay;
    if (
      !this.trajectorySource ||
      !replay ||
      !actor ||
      actor.type !== "Player" ||
      !pose ||
      pose.dead ||
      !actor.samples.length ||
      (this.state.workspaceMode === "plan" && this.displaySnapshot())
    )
      return {};
    const geometry = this.loadedFloors.get(replay.map);
    let transferMap = this.trajectoryTransfers.get(replay);
    if (!transferMap) {
      transferMap = recordedTransferEvidence(replay.actors, replay.combat);
      this.trajectoryTransfers.set(replay, transferMap);
    }
    const transferEvidence = transferMap.get(actor.key);
    const transfers = transferEvidence?.complete ?? [];
    const unresolvedTransfers = transferEvidence?.unresolved ?? [];
    let cached = this.trajectoryInputs.get(actor);
    if (
      !cached ||
      cached.replay !== replay ||
      cached.source !== this.trajectorySource ||
      cached.geometry !== geometry ||
      cached.models !== this.models
    ) {
      const index = buildTrajectorySource(actor);
      cached = {
        replay,
        source: this.trajectorySource,
        geometry,
        models: this.models,
        index,
        components: new Map(
          index.components.map((component) => [component.id, component]),
        ),
        packets: new Map(),
      };
      this.trajectoryInputs.set(actor, cached);
    }
    const lookup = lookupTrajectorySource(cached.index, this.clockTime);
    if (!lookup) return {};
    const reference = (
      id: string,
      at?: number,
      hold = false,
    ): NativeTrajectoryReference => {
      const component = cached!.components.get(id)!;
      let packet = cached!.packets.get(id);
      if (!packet) {
        const first = actor.samples[component.firstSampleIndex];
        let heights: number[] = [];
        if (first[3] === null && geometry) {
          // Context belongs to the source origin, never the currently sought room.
          const context =
            replayFloorHints(
              replay,
              component.firstTime,
              geometry.contextCatalog(replay.map, this.models),
            ).get(actor.key) ??
            raidByMap(replay.map)?.spawn[2] ??
            0;
          const primary = geometry.height(first[1], first[2], context, true);
          if (primary !== undefined) {
            // These are alternative origins, not a permitted vertical movement.
            // Widely stacked rooms may be farther apart than a local drop budget.
            const candidates = [
              ...geometry.heightCandidates(first[1], first[2]),
            ].sort(
              (a, b) => Math.abs(a - primary) - Math.abs(b - primary) || a - b,
            );
            heights = [primary, ...candidates];
          }
        }
        packet =
          buildTrajectoryPacket({
            source: this.trajectorySource,
            map: replay.map,
            actor,
            index: cached!.index,
            component,
            initialHeights: heights,
            transfers,
            unresolvedTransfers,
            coverageEnd: replay.duration,
          }) ?? undefined;
        if (packet) cached!.packets.set(id, packet);
      }
      if (packet) {
        const key = this.trajectoryPacketKey(
          packet.source,
          actor.key,
          id,
          packet.content,
        );
        this.trajectoryDemands.add(key);
        const retry = this.trajectoryRetries.get(key);
        if (
          packet.coverage_complete &&
          (retry?.due == null || retry.due <= performance.now()) &&
          !this.trajectorySent.has(key) &&
          !this.trajectoryRejected.has(key)
        ) {
          this.trajectorySent.add(key);
          if (retry) retry.due = null;
          try {
            this.engine!.submit_replay_trajectory!(JSON.stringify(packet));
          } catch (error) {
            const text = message(error);
            if (text === "Too many queued trajectory components") {
              this.retryTrajectoryCapacity(key);
            } else {
              this.trajectoryRetries.delete(key);
              this.trajectoryRejected.set(key, text);
              this.notify(`Movement could not be prepared: ${text}`);
            }
          }
        }
      }
      if (packet?.unresolved_transfers?.length) {
        const horizon =
          component.firstTime +
          Math.max(
            1,
            Math.ceil(
              Math.max(0, (at ?? this.clockTime) - component.firstTime) / 8000,
            ),
          ) *
            8000 +
          2000;
        for (const [start, loaded] of packet.unresolved_transfers) {
          if (!loaded && start <= horizon)
            this.requestTrajectoryCoverage(
              component.firstTime,
              Math.min(replay.duration, start + 6000),
            );
        }
      }
      if (packet && component.missingCoverage.length) {
        const commit =
          component.firstTime +
          Math.max(
            1,
            Math.ceil(
              Math.max(0, (at ?? this.clockTime) - component.firstTime) / 8000,
            ),
          ) *
            8000;
        let target = Math.min(component.lastTime, commit + 2000);
        const crossing = transfers.find(
          ([start, end]) => start < commit && commit < end,
        );
        if (crossing)
          target = Math.min(component.lastTime, Math.max(target, crossing[1]));
        let left = component.firstSampleIndex,
          right = component.lastSampleIndex;
        while (left < right) {
          const mid = (left + right) >>> 1;
          if (actor.samples[mid][0] < target) left = mid + 1;
          else right = mid;
        }
        const through = actor.samples[left][0];
        if (!packet.coverage_complete || packet.samples.at(-1)![0] < through) {
          this.requestTrajectoryCoverage(component.firstTime, through);
          return {
            source: this.trajectorySource,
            component: id,
            content: "coverage-pending",
            ...(at === undefined ? {} : { at }),
            ...(hold ? { hold: true } : {}),
          };
        }
      }
      return {
        source: this.trajectorySource,
        component: id,
        content: packet?.content ?? "geometry-pending",
        ...(at === undefined ? {} : { at }),
        ...(hold ? { hold: true } : {}),
      };
    };
    // Prepare the next chronological component before crossing its boundary.
    // It remains a background demand; native selected poses always take priority.
    const upcoming =
      Object.hasOwn(this.engine!, "set_replay_frame_delta") &&
      !pose.movement?.unrestricted
        ? cached.index.components.find(
            (component) =>
              component.firstTime > this.clockTime &&
              component.firstTime <= this.clockTime + 8000,
          )
        : undefined;
    const trajectory_prepare = upcoming
      ? reference(upcoming.id, upcoming.firstTime)
      : undefined;
    const interval = lookup.interval;
    if (interval && interval.fromComponentId !== interval.toComponentId) {
      const from = actor.samples[interval.fromIndex],
        to = actor.samples[interval.toIndex];
      // Long wisp travel is an estimate between observations. Its bounded
      // ground route must not wait for reconstruction of a previous fight.
      if (pose.movement?.unrestricted) return {};
      // Blink uses its recorded completion; life/zone/cutoff holds retain poseAt's endpoint choice.
      const atDestination =
        interval.boundaries.some(
          (boundary) =>
            boundary.kind === "blink" && boundary.time <= this.clockTime,
        ) ||
        (Math.hypot(pose.pos[0] - to[1], pose.pos[1] - to[2]) < 0.00001 &&
          Math.hypot(pose.pos[0] - from[1], pose.pos[1] - from[2]) >= 0.00001);
      return {
        trajectory_prepare,
        trajectory: atDestination
          ? reference(interval.toComponentId, to[0], true)
          : reference(interval.fromComponentId, from[0], true),
      };
    }
    return {
      trajectory_prepare,
      trajectory: reference(
        lookup.observation.componentId,
        interval ? undefined : lookup.observation.raw[0],
        !interval,
      ),
    };
  }
  private sendPositions() {
    if (this.runtime.rendererLab) return;
    if (!this.engine) return;
    this.activateTrajectorySource();
    this.trajectoryDemands.clear();
    if (!this.state.replay) {
      const actors = this.state.options.actors
        ? this.sceneActors().flatMap((actor) => {
            const pose = this.actorPose(actor);
            if (!pose || pose.dead) return [];
            return [
              {
                ...actor,
                position: pose.pos,
                facing: pose.facing,
                ground: !("nearbyGround" in pose && pose.nearbyGround),
              },
            ];
          })
        : [];
      if (!actors.length && !this.standaloneFrame) return;
      this.standaloneFrame = actors.length > 0;
      this.frameTransport.reset();
      this.engine.set_replay_frame(
        JSON.stringify(
          actors.map((a) => ({
            key: a.key,
            name: a.name,
            player: a.type === "Player",
            raid: a.type === "Player",
            class: classIDs[a.class] ?? 1,
            entry: a.gameID ?? 0,
            display: a.displayID ?? null,
            scale: a.scale ?? 1,
            position: a.position,
            ground: a.ground,
            floor_hint: a.position[2],
            facing: a.facing,
            speed: 0,
            dead: false,
            estimated: false,
            friendly: a.type !== "NPC",
            nameplate: actorNameplateEnabled(a, this.state.options),
            race: a.race ?? 1,
            sex: a.sex ?? 0,
            look: [0, 0, 0, 0, 0],
            gear: [],
            health: null,
            max_health: null,
            power: null,
            max_power: null,
            power_type: 0,
            plate_cast: null,
            plate_auras: [],
            channel: false,
            cast: 0,
            auras: [],
          })),
        ),
      );
      return;
    }
    const { replay, options } = this.state;
    withReplayPoses((lookupPose) => {
      const floorHints = this.replayFloors(replay, lookupPose);
      const actors = this.indexActors(this.sceneActors());
      const loggedActors = this.indexActors(replay.actors);
      const present = this.presentReplayActors();
      const frame = this.frame
        .filter((unit) => !present || present.has(unit.key))
        .map((unit) => {
          const actor = actors.get(unit.key);
          const pose =
            options.actors && actor ? this.actorPose(actor, lookupPose) : null;
          const movement = pose?.movement;
          const hint = floorHints.get(unit.key);
          const geometry = this.loadedFloors.get(replay.map);
          const seed = this.floorHintCache?.seeds.get(unit.key);
          const endpointHeight = (
            point: number[] | undefined,
            cache: ReplayHeightCache,
          ) =>
            point?.[2] ??
            (actor && geometry && point
              ? (cache.height(
                  actor,
                  geometry,
                  point[0],
                  point[1],
                  seed ?? hint ?? raidByMap(replay.map)?.spawn[2] ?? 0,
                  seed === undefined,
                ) ?? hint)
              : hint);
          const fromHeight = endpointHeight(
            movement?.from as number[] | undefined,
            this.fromFloorHeights,
          );
          const toHeight = endpointHeight(
            movement?.to as number[] | undefined,
            this.toFloorHeights,
          );
          const nativeMovement =
            movement &&
            typeof fromHeight === "number" &&
            Number.isFinite(fromHeight) &&
            typeof toHeight === "number" &&
            Number.isFinite(toHeight)
              ? {
                  ...movement,
                  from: [movement.from[0], movement.from[1], fromHeight],
                  to: [movement.to[0], movement.to[1], toHeight],
                  from_inferred: movement.from[2] == null && seed === undefined,
                  to_inferred: movement.to[2] == null && seed === undefined,
                  floor_candidates: geometry
                    ? movementFloorCandidates(
                        geometry,
                        movement.from as number[],
                        movement.to as number[],
                        fromHeight,
                        toHeight,
                        movement.from[2] == null && seed === undefined,
                        movement.to[2] == null && seed === undefined,
                      )
                    : [],
                }
              : null;
          // Unknown route endpoints are not permission to draw a line through walls.
          const holding = !!movement && !nativeMovement;
          const trajectory = this.trajectoryBinding(
            loggedActors.get(unit.key),
            pose,
          );
          return {
            ...unit,
            ...trajectory,
            position:
              pose && !pose.dead
                ? holding
                  ? [
                      movement!.from[0],
                      movement!.from[1],
                      fromHeight ?? movement!.from[2] ?? 0,
                    ]
                  : [pose.pos[0], pose.pos[1], pose.pos[2] ?? 0]
                : null,
            ground:
              !!(
                this.state.workspaceMode === "plan" && this.displaySnapshot()
              ) || pose?.pos[2] == null,
            floor_hint:
              (holding ? fromHeight : undefined) ??
              (this.state.workspaceMode === "plan" && this.displaySnapshot()
                ? pose?.pos[2]
                : undefined) ??
              floorHints.get(unit.key) ??
              null,
            movement: nativeMovement,
            facing: pose?.facing ?? 0,
            speed: this.state.playing && !holding ? (pose?.speed ?? 0) : 0,
            dead: pose?.dead ?? false,
            estimated: !!pose?.estimated || holding,
            wisp: !!pose?.wisp,
            plate_auras: options.auras ? unit.plate_auras : [],
            auras: options.auras ? unit.auras : [],
          };
        });
      this.engine!.configure_replay_camera?.(
        this.state.cameraMaxDistance,
        options.lockCamera ? (this.state.selected ?? "") : "",
      );
      const subjects =
        options.followRaid && !this.mapView
          ? raidCameraSubjects(
              replay,
              this.clockTime,
              options.smoothGaps,
              lookupPose,
            )
          : [];
      const center = raidCameraCenter(subjects);
      if (center) {
        const previous = this.followCenter;
        if (
          !previous ||
          (previous.replay !== replay &&
            previous.replay.report.code !== replay.report.code) ||
          Math.hypot(
            center[0] - previous.point[0],
            center[1] - previous.point[1],
          ) >
            this.state.cameraMaxDistance * 2
        ) {
          // Seed streaming at the destination before native grounded bodies exist there.
          const representative = [...subjects]
            .filter((s) => s.actor.type === "Player")
            .sort(
              (a, b) =>
                Math.hypot(a.pos[0] - center[0], a.pos[1] - center[1]) -
                Math.hypot(b.pos[0] - center[0], b.pos[1] - center[1]),
            )[0];
          this.engine!.focus_replay(
            representative.pos[0],
            representative.pos[1],
            floorHints.get(representative.actor.key) ??
              raidByMap(replay.map)?.spawn[2] ??
              0,
          );
        }
        this.followCenter = { replay, point: center };
      } else this.followCenter = null;
      const cameraKeys =
        options.followRaid && !this.mapView
          ? subjects.map((p) => p.actor.key)
          : [];
      if (
        options.followRaid &&
        options.lockCamera &&
        !this.mapView &&
        this.state.selected
      ) {
        const locked = actors.get(this.state.selected);
        const pose = locked ? this.actorPose(locked, lookupPose) : null;
        if (
          locked?.type === "Player" &&
          pose &&
          !pose.dead &&
          !cameraKeys.includes(locked.key)
        )
          cameraKeys.push(locked.key);
      }
      this.engine!.set_replay_camera?.(JSON.stringify(cameraKeys));
      this.publishReplayFrame(frame.filter((a) => a.player || a.position));
    });
    for (const key of this.trajectoryRetries.keys()) {
      if (!this.trajectoryDemands.has(key)) this.trajectoryRetries.delete(key);
    }
    this.armTrajectoryRetry();
  }
}
function message(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
