/** Declarative renderer fixtures. Coordinates are native world XYZ; angles are radians.
 * Fixtures describe diagnostic samples, never server spell timing or trusted goldens.
 */
export type Vec3 = [number, number, number];
export type RendererCategory =
  "synthetic" | "spell" | "boss" | "model" | "gear" | "world" | "lighting";
export type RendererStage =
  | "cast"
  | "flight"
  | "impact"
  | "channel"
  | "aura"
  | "summon"
  | "end"
  | "model";
export interface RendererCamera {
  yaw: number;
  pitch: number;
  distance: number;
  target: Vec3;
}
export interface RendererActor {
  id: string;
  kind: "synthetic" | "creature" | "character" | "model";
  position: Vec3;
  facing: number;
  scale: number;
  modelPath?: string;
  modelFileId?: number;
  displayId?: number;
  npcId?: number;
  race?: number;
  sex?: number;
  /** Native skin, face, hair style, hair colour and facial hair dials. */
  look?: [number, number, number, number, number];
  equipment?: { slot: number; itemId?: number; displayId?: number }[];
  animation?: number;
}
export interface RendererEffect {
  id: string;
  spellId?: number;
  visualId?: number;
  kitId?: number;
  effectId?: number;
  modelFileId?: number;
  stage: RendererStage;
  casterId?: string;
  targetId?: string;
  position?: Vec3;
  attachmentTarget?: string;
  authored?: Record<string, unknown>;
  startMs: number;
  durationMs: number;
}
export interface RendererCase {
  id: string;
  label: string;
  category: RendererCategory;
  /** Content context is separate from installed client product/build. */
  content: "sod" | "era" | "synthetic";
  /** null means an isolated diagnostic scene, not a fictional map ID. */
  mapId: number | null;
  position: Vec3;
  camera: RendererCamera;
  actors: RendererActor[];
  effects: RendererEffect[];
  timesMs: number[];
  seed: number;
  /** Diagnostic A/B of the existing production group-PVS toggle. */
  portalCull?: boolean;
  expectedReadableFeatures: string[];
  coverageIds: string[];
  readiness?: {
    status: "ready" | "unverified" | "unsupported" | "unavailable";
    reason: string;
  };
}
export interface RendererClientProfile {
  id: string;
  product: string;
  version: string;
  buildKey: string;
  content: "sod" | "era";
  layouts: Record<string, string>;
  capabilities: Record<string, "supported" | "unsupported" | "unverified">;
}
export const DEFAULT_CAMERA: RendererCamera = {
  yaw: 0.65,
  pitch: 0.35,
  distance: 16,
  target: [0, 0, 1.5],
};
export function syntheticActor(
  id: string,
  position: Vec3 = [0, 0, 0],
): RendererActor {
  return { id, kind: "synthetic", position, facing: 0, scale: 1 };
}
const base = (id: string, label: string): RendererCase => ({
  id,
  label,
  category: "synthetic",
  content: "synthetic",
  mapId: null,
  position: [0, 0, 0],
  camera: { ...DEFAULT_CAMERA, target: [...DEFAULT_CAMERA.target] },
  actors: [syntheticActor("subject")],
  effects: [],
  timesMs: [0, 500, 1500],
  seed: 1,
  expectedReadableFeatures: [
    "subject silhouette",
    "stable camera and animation sample",
  ],
  coverageIds: [],
});
/** Asset-free control, plus explicit numeric NPC/spell requests resolved by local catalogs. */
export const SMOKE_CASES: RendererCase[] = [
  base("synthetic-subject", "Synthetic subject and camera control"),
  {
    ...base("sod-model-11502", "SoD Molten Core: Ragnaros appearance"),
    category: "boss",
    content: "sod",
    actors: [
      {
        id: "subject",
        kind: "creature",
        npcId: 11502,
        position: [0, 0, 0],
        facing: 0,
        scale: 1,
      },
    ],
    camera: { ...DEFAULT_CAMERA, target: [0, 0, 5], distance: 45 },
    expectedReadableFeatures: [
      "boss silhouette",
      "authored textures",
      "catalog display scale; server scale remains unverified",
    ],
    coverageIds: ["npc:sod:11502"],
    readiness: {
      status: "unverified",
      reason: "Requires numeric NPC metadata and local model assets.",
    },
  },
  {
    ...base("sod-fireball-flight", "SoD Fireball: isolated flight sample"),
    category: "spell",
    content: "sod",
    actors: [
      {
        ...syntheticActor("caster", [-4, 0, 0]),
        kind: "character",
        race: 1,
        sex: 0,
      },
      {
        ...syntheticActor("target", [4, 0, 0]),
        kind: "character",
        race: 1,
        sex: 0,
      },
    ],
    effects: [
      {
        id: "flight",
        spellId: 133,
        stage: "flight",
        casterId: "caster",
        targetId: "target",
        startMs: 0,
        durationMs: 1500,
      },
    ],
    timesMs: [250, 750, 1250],
    coverageIds: ["spell:133"],
    expectedReadableFeatures: [
      "authored projectile, when present",
      "caster and target separation",
    ],
    readiness: {
      status: "unverified",
      reason:
        "Catalog must resolve the authored flight visual; timing is diagnostic.",
    },
  },
  {
    ...base("sod-mc-world", "SoD Molten Core: world readiness probe"),
    category: "world",
    content: "sod",
    mapId: 409,
    actors: [],
    expectedReadableFeatures: [
      "visible world geometry at a verified floor or portal viewpoint",
    ],
    coverageIds: ["map:409"],
    readiness: {
      status: "unverified",
      reason:
        "Origin is a placeholder. Resolve a visible floor/portal viewpoint before earning room coverage.",
    },
  },
];

/** Validate local JSON before admitting it to a batch. Returns all detected problems. */
export function validateRendererCase(value: unknown): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== "object") return ["case must be an object"];
  const c = value as RendererCase;
  const nonempty = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  const vector = (v: unknown) =>
    Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  if (!nonempty(c.id)) errors.push("id must be nonempty");
  if (!nonempty(c.label)) errors.push("label must be nonempty");
  if (
    ![
      "synthetic",
      "spell",
      "boss",
      "model",
      "gear",
      "world",
      "lighting",
    ].includes(c.category)
  )
    errors.push("invalid category");
  if (!["sod", "era", "synthetic"].includes(c.content))
    errors.push("invalid content");
  if (c.mapId !== null && (!Number.isSafeInteger(c.mapId) || c.mapId < 0))
    errors.push("invalid mapId");
  if (!vector(c.position)) errors.push("invalid position");
  if (
    !c.camera ||
    !vector(c.camera.target) ||
    ![c.camera.yaw, c.camera.pitch, c.camera.distance].every(Number.isFinite) ||
    c.camera.distance <= 0
  )
    errors.push("invalid camera");
  if (!Number.isSafeInteger(c.seed) || c.seed < 0) errors.push("invalid seed");
  if (c.portalCull !== undefined && typeof c.portalCull !== "boolean")
    errors.push("invalid portalCull");
  if (
    !Array.isArray(c.timesMs) ||
    !c.timesMs.length ||
    c.timesMs.some(
      (t, i) =>
        !Number.isFinite(t) || t < 0 || (i > 0 && t <= c.timesMs[i - 1]),
    )
  )
    errors.push("timesMs must be nonnegative and strictly increasing");
  for (const key of ["coverageIds", "expectedReadableFeatures"] as const) {
    if (!Array.isArray(c[key]) || !c[key].every(nonempty))
      errors.push(`invalid ${key}`);
  }
  const ids = new Set<string>();
  if (!Array.isArray(c.actors)) errors.push("actors must be an array");
  else
    for (const a of c.actors) {
      if (!a || !nonempty(a.id) || ids.has(a.id)) {
        errors.push("invalid or duplicate actor id");
        continue;
      }
      ids.add(a.id);
      if (
        !["synthetic", "creature", "character", "model"].includes(a.kind) ||
        !vector(a.position) ||
        !Number.isFinite(a.facing) ||
        !Number.isFinite(a.scale) ||
        a.scale <= 0
      )
        errors.push(`invalid actor ${a.id}`);
      if (
        a.look !== undefined &&
        (!Array.isArray(a.look) ||
          a.look.length !== 5 ||
          a.look.some((v) => !Number.isSafeInteger(v) || v < 0 || v > 255))
      )
        errors.push(`invalid appearance dials ${a.id}`);
    }
  if (!Array.isArray(c.effects)) errors.push("effects must be an array");
  else {
    const effectIds = new Set<string>();
    for (const e of c.effects) {
      if (!e || !nonempty(e.id) || effectIds.has(e.id)) {
        errors.push("invalid or duplicate effect id");
        continue;
      }
      effectIds.add(e.id);
      if (
        ![
          "cast",
          "flight",
          "impact",
          "channel",
          "aura",
          "summon",
          "end",
          "model",
        ].includes(e.stage)
      )
        errors.push(`invalid stage ${e.id}`);
      if (
        ![e.startMs, e.durationMs].every(Number.isFinite) ||
        e.startMs < 0 ||
        e.durationMs < 0
      )
        errors.push(`invalid timing ${e.id}`);
      if (
        (e.casterId && !ids.has(e.casterId)) ||
        (e.targetId && !ids.has(e.targetId))
      )
        errors.push(`unknown effect actor ${e.id}`);
      if (e.position !== undefined && !vector(e.position))
        errors.push(`invalid effect position ${e.id}`);
    }
  }
  return errors;
}
/** Sorting avoids catalog insertion order changing batch membership. Never mutates input. */
export function deterministicBatches(
  cases: readonly RendererCase[],
  size = 32,
): RendererCase[][] {
  if (!Number.isSafeInteger(size) || size < 1)
    throw new Error("batch size must be a positive integer");
  const sorted = [...cases].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  if (new Set(sorted.map((c) => c.id)).size !== sorted.length)
    throw new Error("duplicate case id");
  const result: RendererCase[][] = [];
  for (let i = 0; i < sorted.length; i += size)
    result.push(sorted.slice(i, i + size));
  return result;
}
