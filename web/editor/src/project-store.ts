import { parsePlan, planId, validatePlan } from "./domain";
import type { GameVersion, Plan, RawReplay } from "./types";
import {
  summarizeRun,
  validRunSummary,
  type RunSummary,
} from "./library-model";
import { validateReplayStream } from "./replay-buffer";

export interface ProjectSource {
  code: string;
  title: string;
  gameVersion: GameVersion;
  fight: number | "run";
  map: number;
  cacheKey: string;
  buffered?: boolean;
  summary?: RunSummary;
}
export interface LocalProject {
  schema: 1;
  lastViewedAt?: number;
  pinned?: boolean;
  savedRun?: boolean;
  id: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  plan: Plan;
  source: ProjectSource | null;
  time: number;
  mode: "analyse" | "plan";
  kind: "plan" | "replay";
}
export interface ProjectStore {
  list(): Promise<LocalProject[]>;
  put(project: LocalProject): Promise<void>;
  get(id: string): Promise<LocalProject | null>;
  putReplay(key: string, replay: RawReplay): Promise<void>;
  getReplay(key: string): Promise<RawReplay | null>;
  hasReplay(key: string): Promise<boolean>;
}
export function replaySource(raw: RawReplay, map: number): ProjectSource {
  const gameVersion = raw.gameVersion ?? raw.report.gameVersion ?? "vanilla";
  const fight = raw.fight.id === "run" ? "run" : Number(raw.fight.id);
  if (!Number.isSafeInteger(fight) && fight !== "run")
    throw new Error("Invalid source encounter");
  return {
    summary: summarizeRun(raw, map),
    code: raw.report.code,
    title: raw.report.title,
    gameVersion,
    fight,
    map,
    cacheKey: `${gameVersion}:${raw.report.code}:${fight}:${map}:${planId()}`,
    ...(raw.stream ? { buffered: true } : {}),
  };
}
export function newProject(
  plan: Plan,
  source: ProjectSource | null = null,
): LocalProject {
  const now = Date.now();
  return {
    schema: 1,
    id: planId(),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    plan: validatePlan(plan),
    source,
    time: 0,
    mode: "plan",
    kind: "plan",
  };
}
export function validateProject(value: unknown): LocalProject {
  const p = value as LocalProject;
  if (
    !p ||
    p.schema !== 1 ||
    typeof p.id !== "string" ||
    !/^[\w-]{1,100}$/.test(p.id) ||
    !Number.isFinite(p.createdAt) ||
    !Number.isFinite(p.updatedAt) ||
    p.createdAt < 0 ||
    p.updatedAt < p.createdAt ||
    (p.deletedAt !== null &&
      (!Number.isFinite(p.deletedAt) || p.deletedAt < 0)) ||
    !Number.isFinite(p.time) ||
    p.time < 0 ||
    !["analyse", "plan"].includes(p.mode)
  )
    throw new Error("Invalid local project");
  const plan = validatePlan(p.plan);
  let source: ProjectSource | null = null;
  if (p.source) {
    const s = p.source;
    if (
      !/^[A-Za-z0-9]{16}$/.test(s.code) ||
      typeof s.title !== "string" ||
      s.title.length > 1000 ||
      s.gameVersion !== plan.gameVersion ||
      s.map !== plan.mapId ||
      (s.fight !== "run" && (!Number.isSafeInteger(s.fight) || s.fight < 1)) ||
      !s.cacheKey.startsWith(
        `${s.gameVersion}:${s.code}:${s.fight}:${s.map}:`,
      ) ||
      (s.buffered !== undefined && typeof s.buffered !== "boolean") ||
      !/^[A-Za-z0-9:-]{1,200}$/.test(s.cacheKey)
    )
      throw new Error("Invalid project source");
    if (s.summary !== undefined && !validRunSummary(s.summary))
      throw new Error("Invalid run summary");
    source = { ...s };
  }
  if (
    (p.lastViewedAt !== undefined &&
      (!Number.isFinite(p.lastViewedAt) || p.lastViewedAt < 0)) ||
    (p.pinned !== undefined && typeof p.pinned !== "boolean") ||
    (p.savedRun !== undefined && typeof p.savedRun !== "boolean")
  )
    throw new Error("Invalid project library metadata");
  const kind = p.kind ?? (p.source && p.mode === "analyse" ? "replay" : "plan");
  if (kind !== "plan" && kind !== "replay")
    throw new Error("Invalid project kind");
  return { ...p, plan, source, kind };
}
export function parseProjectBackup(text: string) {
  const value = JSON.parse(text);
  if (value.format !== "pullfiction.project") {
    // Existing exported .json plans remain valid imports into the library.
    return { project: newProject(parsePlan(text)), replay: null };
  }
  if (value.version !== 1)
    throw new Error("Unsupported project backup version");
  const original = validateProject(value.project);
  const project = {
    ...original,
    id: planId(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    deletedAt: null,
  };
  let replay = (value.replay ?? null) as RawReplay | null;
  if (replay?.stream)
    replay = { ...replay, stream: { ...replay.stream, id: planId() } };
  if (replay) {
    validateReplayStream(replay);
    const source = replaySource(replay, project.plan.mapId);
    if (
      !project.source ||
      source.code !== project.source.code ||
      source.fight !== project.source.fight ||
      source.gameVersion !== project.source.gameVersion ||
      !Array.isArray(replay.events) ||
      !Array.isArray(replay.actors)
    )
      throw new Error("Project backup has a mismatched source replay");
    project.source = replaySource(replay, project.plan.mapId);
  }
  return { project, replay };
}

export function encodeProjectBackup(
  project: LocalProject,
  replay: RawReplay | null,
  limit = 150000000,
) {
  let value = { format: "pullfiction.project", version: 1, project, replay };
  let text = JSON.stringify(value);
  if (replay && new Blob([text]).size > limit) {
    value = { ...value, replay: null };
    text = JSON.stringify(value);
  }
  if (new Blob([text]).size > limit)
    throw new Error("Project edits exceed the backup import limit");
  return { value, text, includesReplay: value.replay !== null };
}

export class IndexedProjectStore implements ProjectStore {
  private connection: Promise<IDBDatabase> | null = null;
  constructor(private factory: IDBFactory = indexedDB) {}
  private db() {
    return (this.connection ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open("pullfiction-projects", 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("projects", { keyPath: "id" });
        db.createObjectStore("replays");
      };
      request.onblocked = () =>
        reject(
          new Error("Close older Pull Fiction tabs to open local projects"),
        );
      request.onerror = () => {
        this.connection = null;
        reject(request.error);
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          this.connection = null;
        };
        resolve(db);
      };
    }));
  }
  private async transaction<T>(
    store: string,
    mode: IDBTransactionMode,
    execute: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      let request: IDBRequest<T>;
      try {
        request = execute(tx.objectStore(store));
      } catch (error) {
        tx.abort();
        reject(error);
        return;
      }
      // A request success precedes transaction durability. Never report saved
      // until the entire transaction has committed.
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () =>
        reject(tx.error ?? new Error("Local save failed"));
    });
  }
  async list() {
    const rows = await this.transaction<LocalProject[]>(
      "projects",
      "readonly",
      (s) => s.getAll(),
    );
    return rows.map(validateProject).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async put(project: LocalProject) {
    await this.transaction("projects", "readwrite", (s) =>
      s.put(validateProject(project)),
    );
  }
  async get(id: string) {
    const row = await this.transaction<LocalProject | undefined>(
      "projects",
      "readonly",
      (s) => s.get(id),
    );
    return row ? validateProject(row) : null;
  }
  async putReplay(key: string, replay: RawReplay) {
    const existing = await this.transaction<Blob | undefined>(
      "replays",
      "readonly",
      (s) => s.get(key),
    );
    if (existing) return;
    const blob = new Blob([JSON.stringify(replay)], {
      type: "application/json",
    });
    await this.transaction("replays", "readwrite", (s) => s.put(blob, key));
  }
  async getReplay(key: string) {
    const blob = await this.transaction<Blob | undefined>(
      "replays",
      "readonly",
      (s) => s.get(key),
    );
    return blob ? (JSON.parse(await blob.text()) as RawReplay) : null;
  }
  async hasReplay(key: string) {
    return (
      (await this.transaction<number>("replays", "readonly", (s) =>
        s.count(key),
      )) > 0
    );
  }
}
