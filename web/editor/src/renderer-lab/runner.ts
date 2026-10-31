import { prepareOriginalUnits } from "../original-client-assets";
import { prepareOriginalSpellEffects } from "../original-spell-assets";
import type { EditorController } from "../controller";
import type { Engine } from "../types";
import { SMOKE_CASES, validateRendererCase, type RendererCase } from "./cases";
import { applySpellActions, spellTimeline } from "./spell-timeline";
export interface LabEngine extends Engine {
  rendererArtifactIdentity?(): { schema: number; wasmSha256: string } | null;
  renderer_lab_configure(json: string): void;
  renderer_lab_status(token: string): void;
  renderer_lab_capture(token: string): void;
  renderer_lab_advance(frames: number): void;
}
export interface LabSample {
  resolvedCase?: RendererCase;
  caseId: string;
  label: string;
  category: string;
  timeMs: number;
  status: "captured" | "unsupported" | "unavailable" | "unverified" | "failed";
  error?: string;
  image?: string;
  hash?: string;
  repeatHash?: string;
  changedRepeatImage?: string;
  identical?: boolean;
  native?: Record<string, any>;
  repeatNative?: Record<string, any>;
  preparationMs?: number;
}
export const DEFAULT_STAGE = {
  mapId: 409,
  origin: [1080, -481, -108] as [number, number, number],
};
/** Native units need a presentable world to finish the ordinary appearance fade. */
export function resolveStage(
  input: RendererCase,
  stage = DEFAULT_STAGE,
): RendererCase {
  const c = structuredClone(input);
  if (c.mapId !== null) return c;
  const move = (p: [number, number, number]): [number, number, number] =>
    p.map((v, i) => v + stage.origin[i]) as [number, number, number];
  c.mapId = stage.mapId;
  c.position = move(c.position);
  c.camera.target = move(c.camera.target);
  for (const a of c.actors) a.position = move(a.position);
  for (const e of c.effects) if (e.position) e.position = move(e.position);
  return c;
}
const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", abort, { once: true });
  });
export function cameraEye(c: RendererCase): [number, number, number] {
  const { yaw, pitch, distance, target } = c.camera;
  return [
    target[0] + Math.cos(yaw) * Math.cos(pitch) * distance,
    target[1] + Math.sin(yaw) * Math.cos(pitch) * distance,
    target[2] + Math.sin(pitch) * distance,
  ];
}
/** Assembly readiness includes authored emitter-only and intentionally empty models. */
export function readyReplayBodyCount(status: any): number {
  const count =
    status.resources?.replayBodiesWithReadyVisuals ??
    status.resources?.replayBodiesWithLoadedMeshes ??
    0;
  return Number.isInteger(count) && count >= 0 ? count : 0;
}
export function labError(error: unknown): LabSample["status"] {
  if (error instanceof Error && error.name === "RendererFixtureUnsupported")
    return "unverified";
  return error instanceof Error && error.name === "ClientUnsupportedError"
    ? "unsupported"
    : error instanceof Error &&
        /NotFound|Unavailable|Encrypted/.test(error.name)
      ? "unavailable"
      : "failed";
}
export function validateBatch(value: unknown): RendererCase[] {
  const batch = Array.isArray(value) ? value : (value as any)?.cases;
  if (!Array.isArray(batch) || batch.length > 256 || !batch.length)
    throw new Error("Choose 1–256 renderer cases");
  const ids = new Set<string>();
  for (const c of batch) {
    const errors = validateRendererCase(c);
    if (errors.length)
      throw new Error(`${c?.id ?? "Case"}: ${errors.join(", ")}`);
    if (ids.has(c.id)) throw new Error(`Duplicate case: ${c.id}`);
    ids.add(c.id);
  }
  return batch;
}
export class RendererRunner {
  private expectedMap: number | null = null;
  private pending = new Map<
    string,
    { resolve(value: any): void; reject(error: Error): void }
  >();
  private serial = 0;
  private previous: unknown;
  private callback = (json: string) => {
    let data: any;
    try {
      data = JSON.parse(json);
    } catch {
      return;
    }
    const pending = this.pending.get(data.token);
    if (!pending) return;
    this.pending.delete(data.token);
    if (data.type === "error") pending.reject(new Error(data.error));
    else pending.resolve(data);
  };
  constructor(private controller: EditorController) {
    const host = window as any;
    this.previous = host.__pullfictionRendererLab;
    host.__pullfictionRendererLab = this.callback;
  }
  dispose() {
    try {
      this.engine().renderer_lab_advance(0);
    } catch {}
    const host = window as any;
    if (host.__pullfictionRendererLab === this.callback)
      host.__pullfictionRendererLab = this.previous;
    for (const p of this.pending.values())
      p.reject(new Error("Renderer runner closed"));
    this.pending.clear();
  }
  private engine(): LabEngine {
    const engine = this.controller.rendererLabResources()
      .engine as LabEngine | null;
    if (!engine?.renderer_lab_configure)
      throw new Error("This renderer has no diagnostic API");
    return engine;
  }
  private request(
    kind: "status" | "capture",
    signal: AbortSignal,
  ): Promise<any> {
    signal.throwIfAborted();
    const token = `lab-${++this.serial}`;
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.pending.delete(token);
      };
      const abort = () => {
        done();
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`Native ${kind} timed out`));
      }, 20000);
      signal.addEventListener("abort", abort, { once: true });
      this.pending.set(token, {
        resolve: (v) => {
          done();
          resolve(v);
        },
        reject: (e) => {
          done();
          reject(e);
        },
      });
      try {
        kind === "capture"
          ? this.engine().renderer_lab_capture(token)
          : this.engine().renderer_lab_status(token);
      } catch (e) {
        done();
        reject(e);
      }
    });
  }
  private async ready(
    signal: AbortSignal,
    needsModels: boolean,
    needsWorld: boolean,
    minimumBodies = 0,
  ) {
    let end = performance.now() + 20000;
    let previous = "",
      stable = 0,
      status: any;
    while (performance.now() < end) {
      if (this.controller.getSnapshot().clientNeedsFiles) {
        await wait(150, signal);
        end = performance.now() + 20000;
        continue;
      }
      status = await this.request("status", signal);
      const identity = JSON.stringify(status.resources);
      stable = identity === previous ? stable + 1 : 0;
      previous = identity;
      const fixtures = status.models ?? [];
      const failed = fixtures.find((m: any) => m.error);
      if (failed) throw new Error(`Model ${failed.key}: ${failed.error}`);
      const modelReady =
        !needsModels ||
        (fixtures.length
          ? fixtures.every(
              (m: any) => m.loaded && m.dependenciesReady && m.attached,
            )
          : readyReplayBodyCount(status) > 0);
      const bodiesReady = readyReplayBodyCount(status) >= minimumBodies;
      const worldReady =
        !needsWorld ||
        (status.readiness?.worldPresentable &&
          status.mapId === this.expectedMap &&
          status.readiness?.worldReady > 0 &&
          status.readiness?.gxPending === 0 &&
          status.readiness?.placementsPending === 0);
      if (stable >= 3 && modelReady && worldReady && bodiesReady) return status;
      await wait(150, signal);
    }
    throw Object.assign(
      new Error(
        `Scene readiness timeout: ${JSON.stringify({ resources: status?.resources, readiness: status?.readiness, viewer: status?.viewer, errors: status?.errors })}`,
      ),
      { rendererStatus: status },
    );
  }
  private async advance(frames: number, signal: AbortSignal) {
    do {
      const chunk = Math.min(600, frames);
      this.engine().renderer_lab_advance(chunk);
      const end = performance.now() + 20000;
      while ((await this.request("status", signal)).remainingFrames > 0) {
        if (performance.now() > end)
          throw new Error("Fixed-step advance timed out");
        await wait(30, signal);
      }
      frames -= chunk;
    } while (frames > 0);
  }
  async run(
    cases: RendererCase[],
    signal: AbortSignal,
    emit: (sample: LabSample) => void,
    repeat = true,
  ) {
    const resources = this.controller.rendererLabResources();
    if (!resources.bridge || !resources.files)
      throw new Error("Choose the local client first");
    const { bridge, files } = resources;
    const [creatures, items] = await Promise.all([
      bridge.catalog("creatures"),
      bridge.catalog("items"),
    ]);
    let preparedSpellGraph: any;
    let preparedSpellGraphHash: string | undefined;
    if (cases.some((c) => c.effects.some((e) => e.spellId))) {
      const bytes = files.readSync("__classic/spell-effects.json");
      if (!bytes) throw new Error("Prepared spell graph is unavailable");
      preparedSpellGraph = JSON.parse(new TextDecoder().decode(bytes));
      preparedSpellGraphHash = Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer),
        ),
      )
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
    const engine = this.engine();
    engine.set_replay_nameplates(false);
    engine.set_replay_raid_frames(false);
    engine.set_annotations('{"marks":[]}');
    for (const original of cases) {
      const c = resolveStage(original);
      await prepareOriginalSpellEffects(
        files,
        bridge,
        c.effects.flatMap((effect) => (effect.spellId ? [effect.spellId] : [])),
        signal,
      );
      this.expectedMap = c.mapId;
      const isolateWorld = original.mapId === null;
      signal.throwIfAborted();
      const start = performance.now();
      const setupPhases: any[] = [];
      try {
        if (
          c.seed !== 1 ||
          c.actors.some((a) => a.animation !== undefined && a.kind !== "model")
        )
          throw Object.assign(
            new Error(
              "This fixture requests an unimplemented seed or direct actor-animation override",
            ),
            { name: "RendererFixtureUnsupported" },
          );
        const models: {
          key: string;
          path: string;
          position: number[];
          scale: number;
          animation?: number;
        }[] = [];
        const units: any[] = [];
        for (const a of c.actors) {
          if (a.kind === "synthetic") continue;
          if (a.kind === "model" || a.modelFileId || a.modelPath) {
            const path = a.modelFileId
              ? `__classic/${a.modelFileId}.m2`
              : a.modelPath!;
            await files.prepare([path], signal);
            models.push({
              key: a.id,
              path,
              position: a.position,
              scale: a.scale,
              animation: a.animation,
            });
            continue;
          }
          const npc = (resources.npcModels[
            c.content === "sod" ? "sod" : "vanilla"
          ]?.[a.npcId ?? 0] ??
            resources.npcModels.vanilla?.[a.npcId ?? 0]) as any;
          const display = a.displayId ?? npc?.displayID ?? npc?.display ?? null;
          if (a.kind === "creature" && !display)
            throw Object.assign(
              new Error(`No authored display for NPC ${a.npcId}`),
              { name: "RendererFixtureUnsupported" },
            );
          const gear = (a.equipment ?? []).map((g) => {
            const info = items.items?.[g.itemId ?? 0];
            if (!(g.displayId ?? info?.display))
              throw Object.assign(
                new Error(
                  `No local item/display join for ${g.itemId ?? g.displayId}`,
                ),
                { name: "RendererFixtureUnsupported" },
              );
            return {
              id: g.itemId ?? 0,
              slot: g.slot,
              ...info,
              display: g.displayId ?? info?.display ?? 0,
              name: `Item ${g.itemId ?? g.displayId}`,
              quality: 0,
              enchant: 0,
              temporary: 0,
            };
          });
          const race = a.race ?? 1,
            sex = a.sex ?? 0;
          const look = a.look ?? [0, 0, 0, 0, 0];
          await prepareOriginalUnits(
            files,
            bridge,
            [
              {
                player: a.kind === "character",
                race,
                sex,
                display,
                gear,
                look,
              },
            ],
            [],
            signal,
          );
          units.push({
            key: a.id,
            name: a.id,
            player: a.kind === "character",
            raid: false,
            class: 8,
            entry: a.npcId ?? 0,
            display,
            scale: a.scale,
            position: a.position,
            ground: false,
            facing: a.facing,
            speed: 0,
            dead: false,
            estimated: false,
            friendly: true,
            race,
            sex,
            look,
            gear,
            health: 100,
            max_health: 100,
            power: 100,
            max_power: 100,
            power_type: 0,
            plate_cast: null,
            plate_auras: [],
            channel: false,
            cast: 0,
            auras: [],
          });
        }
        const timeline = spellTimeline(c);
        for (const fx of c.effects) {
          if (fx.modelFileId) {
            const path = `__classic/${fx.modelFileId}.m2`;
            await files.prepare([path], signal);
            models.push({
              key: fx.id,
              path,
              position: fx.position ?? c.position,
              scale: Number(fx.authored?.scale ?? 1),
            });
          } else if (fx.spellId && !units.length) {
            // An event needs real caster/target bodies. Do not credit a missing synthetic host.
            throw Object.assign(
              new Error(
                `Spell ${fx.spellId} needs a character fixture or an authored effect model`,
              ),
              { name: "RendererFixtureUnsupported" },
            );
          }
        }
        if (c.mapId !== null) {
          if (c.readiness?.reason.includes("placeholder"))
            throw Object.assign(
              new Error(
                "Unverified world camera: resolve a floor/portal viewpoint first",
              ),
              { name: "RendererFixtureUnsupported" },
            );
          this.controller.selectRaid(
            c.mapId,
            false,
            c.content === "sod" ? "sod" : "vanilla",
          );
        }
        const camera = { eye: cameraEye(c), target: c.camera.target };
        engine.set_replay_frame("[]");
        engine.replay_events("[]", true);
        engine.renderer_lab_configure(
          JSON.stringify({
            enabled: true,
            camera,
            frozen: true,
            stepSeconds: 0.1,
            models: [],
            synthetic: false,
            isolateWorld,
            portalCull: c.portalCull,
          }),
        );
        const clearEnd = performance.now() + 10000;
        while (
          (await this.request("status", signal)).resources?.replayBodies > 0
        ) {
          if (performance.now() > clearEnd)
            throw new Error("Previous actors did not clear");
          await wait(30, signal);
        }
        await this.advance(30, signal); // Finish the production two-second teardown fade.
        setupPhases.push({
          ...(await this.request("status", signal)),
          localPreparedBytes: files.preparedBytes,
        });
        engine.renderer_lab_configure(
          JSON.stringify({
            enabled: true,
            camera,
            frozen: true,
            stepSeconds: 0.1,
            models: [],
            synthetic: false,
            seed: 1,
            isolateWorld,
            portalCull: c.portalCull,
          }),
        );
        await this.request("status", signal);
        engine.set_replay_frame(JSON.stringify(units));
        await this.ready(signal, units.length > 0, true, units.length);
        await this.advance(30, signal); // Finish ordinary world/unit appearance fades before sampling.
        const settled = await this.request("status", signal);
        setupPhases.push(settled);
        if (
          units.length &&
          settled.subjects?.some(
            (s: any) =>
              s.state?.modelAlpha !== null && s.state?.modelAlpha < 0.95,
          )
        )
          throw new Error(
            `Fixture bodies remain hidden: ${JSON.stringify(settled.subjects)}`,
          );
        engine.renderer_lab_configure(
          JSON.stringify({
            enabled: true,
            camera,
            frozen: true,
            stepSeconds: 1 / 60,
            replayTimeMs: 0,
            advanceFrames: 0,
            seed: 1,
            synthetic: c.category === "synthetic",
            models,
            isolateWorld,
            portalCull: c.portalCull,
          }),
        );
        await this.ready(
          signal,
          units.length + models.length > 0,
          c.mapId !== null,
        );
        let previousFrames = 0,
          actionIndex = 0;
        const advanceTo = async (timeMs: number) => {
          const frame = Math.round((timeMs / 1000) * 60);
          await this.advance(frame - previousFrames, signal);
          previousFrames = frame;
        };
        for (const timeMs of [...c.timesMs].sort((a, b) => a - b)) {
          signal.throwIfAborted();
          while (
            actionIndex < timeline.length &&
            timeline[actionIndex].atMs <= timeMs
          ) {
            const at = timeline[actionIndex].atMs;
            await advanceTo(at);
            const actions = [];
            do {
              actions.push(timeline[actionIndex++]);
            } while (
              actionIndex < timeline.length &&
              timeline[actionIndex].atMs === at
            );
            const { changed, events } = applySpellActions(units, actions);
            if (changed) engine.set_replay_frame(JSON.stringify(units));
            if (events.length)
              engine.replay_events(JSON.stringify(events), false);
            await this.advance(0, signal); // Apply at this frozen age before advancing past it.
          }
          await advanceTo(timeMs);
          // Advancing can spawn model-particle children and their asynchronous assets.
          // Let those draws settle at the requested frozen age before the first readback.
          await this.ready(
            signal,
            units.length + models.length > 0,
            c.mapId !== null,
            units.length,
          );
          const native = await this.request("capture", signal);
          const image = native.image?.dataUrl;
          if (!image?.startsWith("data:image/png;base64,"))
            throw new Error("GPU capture returned no PNG");
          const hash = await captureHash(image);
          const sample: LabSample = {
            caseId: c.id,
            resolvedCase: c,
            label: c.label,
            category: c.category,
            timeMs,
            status: "captured",
            image,
            hash,
            native: {
              preparedSpellGraph: preparedSpellGraph
                ? {
                    sha256: preparedSpellGraphHash,
                    source: preparedSpellGraph.source,
                    spells: c.effects
                      .filter((e) => e.spellId)
                      .map((e) => ({
                        id: e.spellId,
                        choices:
                          preparedSpellGraph.spells?.[e.spellId!]?.visuals,
                        visuals: (
                          preparedSpellGraph.spells?.[e.spellId!]?.visuals ?? []
                        ).map((v: any) => ({
                          id: v.id,
                          events: preparedSpellGraph.visuals?.[v.id]?.events,
                          channelKits: (
                            preparedSpellGraph.visuals?.[v.id]?.events ?? []
                          )
                            .filter((event: any) =>
                              event.start?.includes("Channel"),
                            )
                            .map((event: any) => ({
                              id: event.kit,
                              present: !!preparedSpellGraph.kits?.[event.kit],
                            })),
                        })),
                      })),
                  }
                : undefined,
              ...native,
              localPreparedBytes: files.preparedBytes,
              synchronousPreparationMisses: files.preparationMisses,
              setupPhases,
            },
            preparationMs: performance.now() - start,
          };
          if (repeat) {
            const second = await this.request("capture", signal);
            const { image: repeatImage, ...repeatNative } = second;
            sample.repeatNative = repeatNative;
            sample.repeatHash = await captureHash(second.image?.dataUrl ?? "");
            sample.identical = hash === sample.repeatHash;
            if (!sample.identical)
              sample.changedRepeatImage = second.image?.dataUrl;
          }
          emit(sample);
        }
      } catch (error) {
        if (signal.aborted) throw error;
        emit({
          caseId: c.id,
          label: c.label,
          category: c.category,
          timeMs: 0,
          status: labError(error),
          error: String(error),
          native: {
            ...(error as any)?.rendererStatus,
            localPreparedBytes: files.preparedBytes,
            setupPhases,
          },
          preparationMs: performance.now() - start,
        });
      }
    }
  }
}
export async function captureHash(dataUrl: string) {
  if (!dataUrl.startsWith("data:image/png;base64,"))
    throw new Error("Invalid capture");
  const bytes = Uint8Array.from(atob(dataUrl.split(",")[1]), (c) =>
    c.charCodeAt(0),
  );
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export function smokeCases(): RendererCase[] {
  return structuredClone(SMOKE_CASES);
}
