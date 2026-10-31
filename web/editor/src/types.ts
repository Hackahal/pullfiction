export type GameVersion = "vanilla" | "sod";
import type { SnapSettings, Transform } from "./editor-controls";
export type Point = [number, number, number];
export type AnnotationType =
  | "marker"
  | "route"
  | "arrow"
  | "circle"
  | "cone"
  | "polygon"
  | "drawing"
  | "label";
export type Tool = "explore" | "move" | AnnotationType;
export interface PlanComment {
  id: string;
  text: string;
  createdAt: string;
}
export interface Annotation {
  name: string;
  actor?: string;
  actorReport?: string;
  id: string;
  type: AnnotationType;
  points: Point[];
  color: string;
  icon: string;
  size: number;
  width: number;
  label: string;
  notes: string;
  hidden: boolean;
  locked: boolean;
  comments: PlanComment[];
}
export interface PlannedActor {
  displayID?: number | null;
  gameID?: number;
  scale?: number;
  race?: number | null;
  sex?: number | null;
  recordedFacing?: number;
  key: string;
  name: string;
  class: string;
  icon?: string | null;
  type: string;
  position: Point;
  recorded?: Point;
  facing: number;
}
export interface PlanSnapshot {
  report: string;
  time: number;
  actors: PlannedActor[];
}
export interface PlanLayer {
  id: string;
  name: string;
  hidden: boolean;
}
export interface PlanStep {
  layerId: string;
  snapshot?: PlanSnapshot;
  id: string;
  name: string;
  kind: "pull" | "boss" | "phase" | "route" | "note";
  start: number | null;
  end: number | null;
  notes: string;
  annotations: Annotation[];
}
export interface MarkStyle {
  color: string;
  icon: string;
  size: number;
  width: number;
}
export interface Plan {
  gameVersion: GameVersion;
  version: 2;
  client: string;
  mapId: number;
  name: string;
  layers: PlanLayer[];
  steps: PlanStep[];
  markers: Point[];
  route: Point[];
}
export interface Health {
  current: number;
  max: number;
  percent: number;
  initial?: boolean;
}
export interface Aura {
  spell: number;
  name?: string;
  icon?: string;
  stack: number;
  debuff: boolean;
  remove?: boolean;
}
export interface Cast {
  spell: number;
  name: string;
  icon?: string;
  start: number;
  end: number;
  instant?: boolean;
  inferredEnd?: boolean;
  id?: number;
  channel?: boolean;
  timingSource?: string;
  outcome?: string;
  progress?: number;
  interrupted?: boolean;
  target?: string | null;
}
export interface ResourceChange {
  type: number;
  gain: number;
  waste: number;
  max: number | null;
  spell: number;
  name: string;
  icon?: string;
  at?: number;
}
export interface Gear {
  icon?: string;
  quality?: number;
  id: number;
  slot: number;
  name?: string;
  permanentEnchant?: number;
  temporaryEnchant?: number;
  temporaryEnchantName?: string;
  permanentEnchantName?: string;
  model?: Record<string, unknown>;
}
export interface SpawnPlacement {
  key: string;
  position: [number, number, number | null];
  floorHint?: number;
  referenceKind?:
    | "sod-reference"
    | "classic-baseline"
    | "classic-reference"
    | "guide-reference"
    | "portal-registered-reference"
    | "map-registered-reference";
  facing: number;
  distance: number | null;
  confidence: "near" | "approximate" | "unobserved";
  visibleFrom: number;
  synthetic: boolean;
}
export interface Actor {
  bufferedRanges?: [number, number][];
  spawn?: SpawnPlacement;
  key: string;
  id: number;
  instance: number;
  name: string;
  type: string;
  class: string;
  gameID: number;
  displayID: number | null;
  scale: number;
  activity?: number[];
  activityWindows?: [number, number][];
  samples: [number, number, number, number | null][];
  deaths: [number, boolean][];
  firstSeen: number;
  lastSeen: number;
  runLifetime: boolean;
  facings: [number, number][];
  headings: number[];
  icon?: string | null;
  owner?: number;
  ownerName?: string;
  race?: number | null;
  raceSource?: string;
  sex?: number | null;
  gear: Gear[];
  health: [number, Health][];
  power: [number, { current: number | null; max: number; type: number }][];
  resourceChanges: [number, ResourceChange][];
  casts: Cast[];
  auras: [number, Aura | { reset: number[] }][];
  initialAuras: number[];
}
export interface Chapter {
  id: number;
  name: string;
  start: number;
  end: number;
  kill?: boolean;
  encounterID?: number;
  enemyNPCs?: { id: number }[];
}
export interface Fight {
  categoryMixed?: boolean;
  difficulty?: number;
  size?: number;
  id: number | string;
  name: string;
  startTime: number;
  endTime: number;
  gameZone: { name: string; id?: number };
  completeRaid?: boolean;
  friendlyPlayers: number[];
  encounterID?: number;
  kill?: boolean;
}
export interface CombatEvent {
  id: number;
  t: number;
  kind: string;
  source?: string;
  target?: string;
  spell: number;
  name: string;
  amount?: number;
  melee?: boolean;
  tick?: boolean;
  impacts?: { target: string; t: number }[];
}
export interface Replay {
  gameVersion: GameVersion;
  map: number;
  report: { code: string; title: string; gameVersion?: GameVersion };
  fight: Fight;
  duration: number;
  actors: Actor[];
  chapters: Chapter[];
  gaps: { start: number; end: number; hasEvents: boolean }[];
  abilities: Map<number, { name: string; icon?: string }>;
  combat: CombatEvent[];
  visualEvents: CombatEvent[];
  raw: RawReplay;
}
export interface RawReplay {
  stream?: {
    version: 1;
    id: string;
    revision: number;
    segments: number;
    reportEnd: number;
    full: [number, number][];
    history: [number, number][];
    stateEvents: any[];
    contextEvents: any[];
    foreign: [number, number][];
  };
  models?: Record<string, unknown>;
  gameVersion?: GameVersion;
  report: { code: string; title: string; gameVersion?: GameVersion };
  fight: Fight;
  actors: unknown[];
  abilities?: { gameID: number; name?: string; icon?: string }[];
  playerDetails?: any;
  events: unknown[];
  appearanceOverrides?: Record<string, Appearance>;
}
export interface Appearance {
  race?: number;
  sex?: number;
  display?: number;
  look?: number[];
}
export interface Report {
  gameVersion?: GameVersion;
  title: string;
  fights: Fight[];
}
export interface NativeFrame {
  key: string;
  name: string;
  player: boolean;
  class: number;
  entry: number;
  display: number | null;
  scale: number;
  position: Point | null;
  ground: boolean;
  facing: number;
  speed: number;
  dead: boolean;
  estimated: boolean;
  wisp?: boolean;
  friendly: boolean;
  nameplate?: boolean;
  raid: boolean;
  health: number | null;
  max_health: number | null;
  power: number | null;
  max_power: number | null;
  power_type: number;
  race: number | null | undefined;
  sex: number | null | undefined;
  look: number[];
  gear: unknown[];
  plate_cast: {
    name: string;
    icon: string;
    progress: number;
    remaining: number;
  } | null;
  plate_auras: {
    spell: number;
    name?: string;
    icon: string;
    stack: number;
    debuff: boolean;
  }[];
  cast: number;
  channel?: boolean;
  auras: number[];
}
export interface Engine {
  request_actor_inspection?(json: string): void;
  close_actor_inspection?(): void;
  default(): Promise<void>;
  start(): void;
  load_raid(map: number): void;
  set_annotations(json: string): void;
  zoom_editor?(distance: number): void;
  set_editor_orbit_player?(key: string): void;
  navigate_editor?(pan: boolean, dx: number, dy: number): void;
  set_editor_mode?(on: boolean): void;
  set_typing(on: boolean): void;
  home(): void;
  pick(x: number, y: number): void;
  pick_annotation?(x: number, y: number): void;
  select_annotations_rect?(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    mode: number,
    epoch: number,
  ): void;
  hover_annotation?(
    x: number,
    y: number,
    placing: boolean,
    request?: number,
  ): void;
  preview_annotation?(x: number, y: number, token: number): void;
  preview_map_annotation?(x: number, y: number, z: number, token: number): void;
  pick_for_annotation?(x: number, y: number, token: number): void;
  pick_map_for_annotation?(
    x: number,
    y: number,
    height: number,
    token: number,
  ): void;
  pick_map(x: number, y: number, height: number): void;
  set_replay_frame(json: string): void;
  request_portraits?(json: string): void;
  replay_clock?(time: number, rate: number, playing: boolean): void;
  replay_events(json: string, reset: boolean): void;
  set_replay_nameplates(on: boolean): void;
  set_replay_nameplate_filters?(friendly: boolean, enemy: boolean): void;
  set_replay_raid_frames(on: boolean): void;
  set_raid_frame_size?(width: number, height: number): void;
  select_replay(key: string): void;
  focus_replay(x: number, y: number, z: number): void;
  set_replay_camera?(json: string): void;
  configure_replay_camera?(maxDistance: number, lockedPlayer: string): void;
}
export interface Options {
  nameplates: boolean;
  friendlyNameplates: boolean;
  enemyNameplates: boolean;
  trashNameplates: boolean;
  bossNameplates: boolean;
  raidFrames: boolean;
  auras: boolean;
  spells: boolean;
  smoothGaps: boolean;
  followPulls: boolean;
  followRaid: boolean;
  lockCamera: boolean;
  actors: boolean;
}
export interface Snapshot {
  rangeCheck: import("./range-check").RangeSettings;
  projects: import("./project-store").LocalProject[];
  cachedSources: string[];
  projectId: string | null;
  libraryReady: boolean;
  libraryError: string | null;
  saveStatus: "saved" | "pending" | "saving" | "error" | "unsaved";
  savedAt: number | null;
  sourceStatus: "none" | "saving" | "cached" | "missing";
  buffering?: boolean;
  bufferError?: string | null;
  downloadingReplay?: boolean;
  browserPlates: import("./browser-plates").BrowserPlate[];
  browserAssets: boolean;
  clientStatus: "select" | "opening" | "ready" | "error";
  clientProgress: string;
  clientCanRemember: boolean;
  clientFolderName: string | null;
  clientRemembered: boolean;
  clientReconnect: boolean;
  clientFolderError: string | null;
  clientCacheStatus: "none" | "recording" | "ready" | "unavailable";
  clientPrefetchProgress?: string;
  clientNeedsFiles: boolean;
  clientPromptHidden: boolean;
  clientAttaching: boolean;
  clientNeedsRestart: boolean;
  clientBuild: string;
  wclConfigured: boolean;
  wclConnected: boolean;
  gameVersion: GameVersion;
  ready: boolean;
  sceneReady: boolean;
  error: string | null;
  notice: string;
  status: string;
  busy: boolean;
  plan: Plan;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  tool: Tool;
  planning: boolean;
  snap: SnapSettings;
  transform: Transform;
  transformActive: boolean;
  selectionFilter: "both" | "drawings" | "actors";
  selectedActors: string[];
  compareRecorded: boolean;
  frameRequest: number;
  spacePan: boolean;
  navigationTool: "select" | "pan" | "orbit";
  cameraMode: "free" | "orbit";
  orbitTarget: string | null;
  snapBypass: boolean;
  workspaceMode: "plan" | "analyse";
  sceneHover: {
    nativeUI?: boolean;
    hits?: string[];
    pixel?: [number, number];
    anchorPixel?: [number, number] | null;
    actor?: string | null;
    id: string | null;
    handle: number | null;
    point: Point | null;
    locked: boolean;
  } | null;
  activeStep: string;
  selectedMark: string | null;
  selectedMarks: string[];
  markStyle: MarkStyle;
  followSteps: boolean;
  showAllSteps: boolean;
  drawing: boolean;
  dimensionInput: string;
  raidFrameSize: { width: number; height: number };
  report: Report | null;
  reportCode: string;
  replay: Replay | null;
  time: number;
  playing: boolean;
  rate: number;
  selected: string | null;
  detail: { spell: number; actorKey?: string; castIndex?: number } | null;
  options: Options;
  cameraMaxDistance: number;
  portraitVersion: number;
  inspectionModel: {
    key: string;
    source: string;
    requestId: number;
    url: string | null;
    loading: boolean;
    error: string | null;
  } | null;
  visualEvents: number;
  unsupported: number;
  loop: [number, number] | null;
}
