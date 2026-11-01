import type { RendererCase, RendererEffect } from "./cases";

export type FixtureActionKind =
  | "cast-start"
  | "go"
  | "channel-start"
  | "channel-end"
  | "aura-start"
  | "aura-end"
  | "summon-cue";
export interface FixtureAction {
  atMs: number;
  kind: FixtureActionKind;
  effect: RendererEffect;
}

/** Drive the ordinary native unit/event inputs, rather than substituting raw FX models. */
export function spellTimeline(c: RendererCase): FixtureAction[] {
  const result: FixtureAction[] = [];
  const unsupported = (reason: string): never => {
    throw Object.assign(new Error(reason), {
      name: "RendererFixtureUnsupported",
    });
  };
  for (const effect of c.effects) {
    if (effect.modelFileId) {
      if (effect.spellId || effect.stage !== "model" || effect.startMs !== 0)
        unsupported(
          `Fixture ${effect.id}: raw model lifecycle routing is not implemented; no rendering credit`,
        );
      continue;
    }
    if (
      !Number.isSafeInteger(effect.spellId) ||
      !effect.spellId ||
      !["cast", "flight", "channel", "aura", "summon"].includes(effect.stage)
    )
      unsupported(
        `Fixture ${effect.id}: this stage/kit routing is not implemented; no rendering credit`,
      );
    const hostId =
      effect.stage === "aura"
        ? (effect.targetId ?? effect.casterId)
        : effect.casterId;
    const host = c.actors.find((a) => a.id === hostId);
    if (!host || !["character", "creature"].includes(host.kind))
      unsupported(
        `Fixture ${effect.id}: spell stage needs a native character or creature host`,
      );
    const add = (kind: FixtureActionKind, atMs = effect.startMs) =>
      result.push({ atMs, kind, effect });
    switch (effect.stage) {
      case "cast":
        if (effect.durationMs > 0) add("cast-start");
        add("go", effect.startMs + effect.durationMs);
        break;
      case "flight":
        add("go");
        break;
      case "summon":
        add("summon-cue");
        break;
      case "aura":
      case "channel":
        add(effect.stage === "aura" ? "aura-start" : "channel-start");
        if (effect.durationMs > 0)
          add(
            effect.stage === "aura" ? "aura-end" : "channel-end",
            effect.startMs + effect.durationMs,
          );
        break;
    }
  }
  // Stable ordering preserves authored order for simultaneous lifecycle changes.
  return result.sort((a, b) => a.atMs - b.atMs);
}

interface FixtureUnit {
  key: string;
  cast: number;
  channel: boolean;
  channel_target?: string | null;
  auras: number[];
  self_auras?: number[];
}
/** Changes are delivered together with Go, so ending a successful cast cannot emit Fail. */
export function applySpellActions(
  units: FixtureUnit[],
  actions: readonly FixtureAction[],
) {
  const events: {
    kind: "go" | "summon-cue";
    spell: number;
    source?: string;
    target?: string;
    t: number;
    amount: number;
  }[] = [];
  let changed = false;
  for (const { kind, effect, atMs } of actions) {
    const spell = effect.spellId!;
    const unit = units.find(
      (u) =>
        u.key ===
        (kind.startsWith("aura-")
          ? (effect.targetId ?? effect.casterId)
          : effect.casterId),
    )!;
    if (kind === "go" || kind === "summon-cue") {
      if (kind === "go" && unit.cast === spell) {
        unit.cast = 0;
        changed = true;
      }
      events.push({
        kind,
        spell,
        source: effect.casterId,
        target: effect.targetId,
        t: atMs,
        amount: 0,
      });
    } else if (kind === "aura-start") {
      if (!unit.auras.includes(spell)) unit.auras.push(spell);
      unit.self_auras = (unit.self_auras ?? []).filter((id) => id !== spell);
      if (effect.casterId === (effect.targetId ?? effect.casterId))
        unit.self_auras.push(spell);
      changed = true;
    } else if (kind === "aura-end") {
      unit.auras = unit.auras.filter((id) => id !== spell);
      unit.self_auras = (unit.self_auras ?? []).filter((id) => id !== spell);
      changed = true;
    } else {
      unit.cast = kind === "channel-end" ? 0 : spell;
      unit.channel = kind === "channel-start";
      unit.channel_target =
        kind === "channel-start" ? (effect.targetId ?? null) : null;
      changed = true;
    }
  }
  return { changed, events };
}
