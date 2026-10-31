import type { RawReplay, Replay } from "./types";

export type Range = [number, number];
export const REPLAY_CHUNK = 60000;
const CONTEXT = 5000;
export function validateReplayStream(raw: RawReplay) {
  const s = raw.stream,
    duration = raw.fight.endTime - raw.fight.startTime;
  if (!s) return;
  if (
    s.version !== 1 ||
    !/^[-\w]{1,100}$/.test(s.id) ||
    !Number.isFinite(s.revision) ||
    s.revision < 0 ||
    !Number.isFinite(s.segments) ||
    s.segments < 0 ||
    !Number.isFinite(s.reportEnd) ||
    !Array.isArray(s.stateEvents) ||
    !Array.isArray(s.contextEvents) ||
    !Array.isArray(s.foreign)
  )
    throw new Error("Invalid buffered replay manifest");
  for (const list of [s.full, s.history])
    if (
      !Array.isArray(list) ||
      list.length > 10000 ||
      list.some(
        (r) =>
          !Array.isArray(r) ||
          r.length !== 2 ||
          !Number.isFinite(r[0]) ||
          !Number.isFinite(r[1]) ||
          r[0] < 0 ||
          r[1] > duration ||
          r[1] <= r[0],
      )
    )
      throw new Error("Invalid buffered replay coverage");
}
export interface ReplayPart {
  kind: "full" | "state";
  start: number;
  end: number;
  from: number;
  to: number;
  events: any[];
}
export function ranges(input: Range[]): Range[] {
  const result: Range[] = [];
  for (const [a, b] of [...input].sort((a, b) => a[0] - b[0])) {
    if (!(b > a)) continue;
    const last = result.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else result.push([a, b]);
  }
  return result;
}
export function covered(input: Range[], start: number, end: number) {
  return end <= start || ranges(input).some(([a, b]) => a <= start && b >= end);
}
export function missing(input: Range[], start: number, end: number): Range[] {
  const result: Range[] = [];
  let cursor = start;
  for (const [a, b] of ranges(input)) {
    if (b <= cursor) continue;
    if (a > cursor) result.push([cursor, Math.min(a, end)]);
    cursor = Math.max(cursor, b);
    if (cursor >= end) break;
  }
  if (cursor < end) result.push([cursor, end]);
  return result.filter(([a, b]) => b > a);
}
export function replayIdentity(replay: Replay | null) {
  return replay
    ? `${replay.gameVersion}:${replay.report?.code ?? ""}:${replay.fight?.id ?? ""}:${replay.raw?.stream?.id ?? "file"}`
    : "none";
}
export function analysisAvailable(replay: Replay, start: number, end: number) {
  return !replay.raw.stream || covered(replay.raw.stream.full, start, end);
}
/** Convert a closed metric interval to the downloader's half-open interval. */
export function analysisLoadRange(
  replay: Replay,
  start: number,
  end: number,
): [number, number] {
  return [
    Math.max(0, Math.min(start, replay.duration - 0.001)),
    Math.min(replay.duration, Math.max(start, end) + 0.001),
  ];
}
export function analysisIntervalsAvailable(
  replay: Replay,
  start: number,
  end: number,
  intervals?: [number, number][],
) {
  if (end < start) return true;
  // Queries include cutoff events. A half-open downloaded chunk ending exactly
  // at that cutoff does not establish that its endpoint event is available.
  const available = (a: number, b: number) =>
    analysisAvailable(replay, ...analysisLoadRange(replay, a, b));
  return intervals
    ? intervals.every(([a, b]) => {
        const lo = Math.max(start, a),
          hi = Math.min(end, b);
        return hi < lo || available(lo, hi);
      })
    : available(start, end);
}
export function streamComplete(raw: RawReplay) {
  return (
    !raw.stream ||
    covered(raw.stream.full, 0, raw.fight.endTime - raw.fight.startTime)
  );
}
const owns = (
  t: number,
  part: { start: number; end: number },
  duration: number,
) => t >= part.start && (t < part.end || (t === duration && t === part.end));

export interface ReplayPartCache {
  list(id: string): Promise<ReplayPart[]>;
  put(id: string, part: ReplayPart): Promise<void>;
}
export class IndexedReplayPartCache implements ReplayPartCache {
  constructor(
    private factory: IDBFactory = indexedDB,
    private keyRange: typeof IDBKeyRange = IDBKeyRange,
  ) {}
  private connection?: Promise<IDBDatabase>;
  private db() {
    return (this.connection ??= new Promise((resolve, reject) => {
      const request = this.factory.open("pullfiction-replay-chunks", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("chunks");
      request.onerror = () => {
        this.connection = undefined;
        reject(request.error);
      };
      request.onblocked = () =>
        reject(new Error("Replay cache is blocked by another tab."));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          this.connection = undefined;
        };
        resolve(db);
      };
    }));
  }
  async list(id: string) {
    const db = await this.db();
    return new Promise<ReplayPart[]>((resolve, reject) => {
      const tx = db.transaction("chunks", "readonly");
      const req = tx
        .objectStore("chunks")
        .getAll(this.keyRange.bound(`${id}:`, `${id}:\uffff`));
      tx.oncomplete = () => resolve(req.result);
      tx.onabort = tx.onerror = () =>
        reject(tx.error ?? new Error("Replay cache read failed"));
    });
  }
  async put(id: string, part: ReplayPart) {
    const db = await this.db();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction("chunks", "readwrite");
      tx.objectStore("chunks").put(
        part,
        `${id}:${part.kind}:${part.start}:${part.end}`,
      );
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(tx.error ?? new Error("Replay cache write failed"));
    });
  }
}

export class ReplayBuffer {
  private dataRevision = 0;
  get revision() {
    return this.dataRevision;
  }
  private parts: ReplayPart[] = [];
  private job: {
    index: number;
    abort: AbortController;
    promise: Promise<void>;
  } | null = null;
  private verified: boolean;
  private closed = false;
  private writes: Promise<void>[] = [];
  readonly duration: number;
  constructor(
    readonly header: RawReplay,
    private fetch: (
      start: number,
      end: number,
      state: boolean,
      signal: AbortSignal,
    ) => Promise<any[]>,
    private verify: (signal: AbortSignal) => Promise<void>,
    private cache?: ReplayPartCache,
    private changed: () => void = () => {},
    private cacheError: (e: unknown) => void = () => {},
    fresh = false,
  ) {
    validateReplayStream(header);
    if (
      !header.stream ||
      header.stream.version !== 1 ||
      !/^[\w-]{1,100}$/.test(header.stream.id)
    )
      throw new Error("Invalid buffered replay manifest");
    this.duration = header.fight.endTime - header.fight.startTime;
    if (!(this.duration > 0))
      throw new Error("Invalid buffered replay duration");
    this.verified = fresh;
    // Portable partial backups carry their coverage and state, independently of IndexedDB.
    for (const [start, end] of header.stream.full)
      this.parts.push({
        kind: "full",
        start,
        end,
        from: start,
        to: end,
        events: (header.events as any[]).filter((e) =>
          owns(
            e.timestamp - header.fight.startTime,
            { start, end },
            this.duration,
          ),
        ),
      });
    for (const [start, end] of header.stream.history)
      this.parts.push({
        kind: "state",
        start,
        end,
        from: start,
        to: end,
        events: header.stream.stateEvents.filter((e) =>
          owns(
            e.timestamp - header.fight.startTime,
            { start, end },
            this.duration,
          ),
        ),
      });
  }
  async restore() {
    if (!this.cache) return;
    try {
      for (const part of await this.cache.list(this.header.stream!.id)) {
        if (
          (part.kind !== "full" && part.kind !== "state") ||
          !Number.isFinite(part.start) ||
          !Number.isFinite(part.end) ||
          part.start < 0 ||
          part.end > this.duration ||
          part.end <= part.start ||
          !Array.isArray(part.events) ||
          !Number.isFinite(part.from) ||
          !Number.isFinite(part.to) ||
          part.from < 0 ||
          part.from > part.start ||
          part.to < part.end ||
          part.to > this.duration
        )
          throw new Error("Invalid cached replay section");
        this.add(part, false);
      }
    } catch (e) {
      this.cacheError(e);
    }
  }
  private add(part: ReplayPart, persist: boolean) {
    this.dataRevision++;
    this.parts = this.parts.filter(
      (p) =>
        p.kind !== part.kind || p.start !== part.start || p.end !== part.end,
    );
    this.parts.push(part);
    if (persist && this.cache) {
      const write = this.cache
        .put(this.header.stream!.id, part)
        .catch((e) => this.cacheError(e));
      this.writes.push(write);
      void write.finally(() => {
        this.writes = this.writes.filter((w) => w !== write);
      });
    }
  }
  async flush() {
    await Promise.all(this.writes);
  }
  private index(t: number) {
    return Math.floor(
      Math.max(0, Math.min(this.duration - 1, t)) / REPLAY_CHUNK,
    );
  }
  private interval(t: number): Range {
    const start = this.index(t) * REPLAY_CHUNK;
    return [start, Math.min(this.duration, start + REPLAY_CHUNK)];
  }
  private full() {
    return ranges(
      this.parts.filter((p) => p.kind === "full").map((p) => [p.start, p.end]),
    );
  }
  private history() {
    return ranges(this.parts.map((p) => [p.start, p.end]));
  }
  ready(t: number) {
    const [a, b] = this.interval(t);
    return covered(this.full(), a, b) && covered(this.history(), 0, a);
  }
  get active() {
    return !!this.job;
  }
  cancel() {
    this.job?.abort.abort();
    this.job = null;
  }
  close() {
    this.closed = true;
    this.cancel();
  }
  async ensure(time: number) {
    if (this.closed) throw new Error("Replay was closed");
    if (this.ready(time)) return;
    const index = this.index(time);
    if (this.job?.index === index) return this.job.promise;
    this.cancel();
    const abort = new AbortController();
    const promise = (async () => {
      if (!this.verified) {
        await this.verify(abort.signal);
        abort.signal.throwIfAborted();
        this.verified = true;
      }
      this.verified = false;
      const [start, end] = this.interval(time);
      const tasks: Promise<void>[] = [];
      const staged: ReplayPart[] = [];
      const load = async (kind: ReplayPart["kind"], a: number, b: number) => {
        const from = kind === "full" ? Math.max(0, a - CONTEXT) : a;
        const to = kind === "full" ? Math.min(this.duration, b + CONTEXT) : b;
        const events = await this.fetch(
          from,
          to,
          kind === "state",
          abort.signal,
        );
        abort.signal.throwIfAborted();
        staged.push({ kind, start: a, end: b, from, to, events });
      };
      if (!covered(this.full(), start, end))
        tasks.push(load("full", start, end));
      for (const [a, b] of missing(this.history(), 0, start))
        tasks.push(load("state", a, b));
      await Promise.all(tasks);
      abort.signal.throwIfAborted();
      await this.verify(abort.signal);
      abort.signal.throwIfAborted();
      if (
        staged.reduce((sum, p) => sum + p.events.length, 0) +
          this.parts.reduce((sum, p) => sum + p.events.length, 0) >
        3000000
      )
        throw new Error(
          "Replay memory limit reached. Open a shorter encounter to continue.",
        );
      for (const part of staged) this.add(part, true);
      this.changed();
    })();
    const job = { index, abort, promise };
    this.job = job;
    try {
      await promise;
    } finally {
      if (this.job === job) this.job = null;
    }
  }
  snapshot(): RawReplay {
    const duration = this.duration,
      origin = this.header.fight.startTime;
    const full = this.parts
      .filter((p) => p.kind === "full")
      .sort((a, b) => a.start - b.start);
    const state = this.parts
      .filter((p) => p.kind === "state")
      .sort((a, b) => a.start - b.start);
    const fullRanges = this.full();
    const events = full.flatMap((p, i) =>
      p.events.filter(
        (e) =>
          owns(e.timestamp - origin, p, duration) &&
          !full
            .slice(0, i)
            .some((q) => owns(e.timestamp - origin, q, duration)),
      ),
    );
    const outsideFull = (t: number) => !full.some((p) => owns(t, p, duration));
    const contextEvents = full.flatMap((p, i) =>
      p.events.filter((e) => {
        const t = e.timestamp - origin;
        return (
          outsideFull(t) &&
          !full.slice(0, i).some((q) => t >= q.from && t <= q.to)
        );
      }),
    );
    contextEvents.push(
      ...this.header.stream!.contextEvents.filter((e) => {
        const t = e.timestamp - origin;
        return outsideFull(t) && !full.some((p) => t >= p.from && t <= p.to);
      }),
    );
    const stateEvents = state.flatMap((p, i) =>
      p.events.filter((e) => {
        const t = e.timestamp - origin;
        return (
          owns(t, p, duration) &&
          outsideFull(t) &&
          !state.slice(0, i).some((q) => owns(t, q, duration))
        );
      }),
    );
    return {
      ...this.header,
      events: events.sort((a, b) => a.timestamp - b.timestamp),
      stream: {
        ...this.header.stream!,
        full: fullRanges,
        history: ranges(state.map((p) => [p.start, p.end])),
        stateEvents,
        contextEvents,
      },
    };
  }
}

export function normalizationEvents(raw: RawReplay) {
  if (!raw.stream) return raw.events;
  const context = raw.stream.contextEvents;
  const times = new Set(context.map((e) => e.timestamp));
  // Context is a complete event timestamp group; prefer it to the filtered
  // history at those timestamps without deduplicating legitimate identical hits.
  return [
    ...raw.events,
    ...context,
    ...raw.stream.stateEvents.filter((e) => !times.has(e.timestamp)),
  ].sort((a: any, b: any) => a.timestamp - b.timestamp);
}
