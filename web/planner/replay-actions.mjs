// Recorded timestamps always win. DBC/observed timing hints only bound missing ends.
const spellOf = (e) => {
  const id = e.abilityGameID ?? e.ability?.guid ?? 0;
  return id === -4 ? 1 : Math.max(0, id);
};
export function reconstructCasts(replay, metadata = {}) {
  const actors = new Map(replay.actors.map((a) => [a.key, a]));
  const events = replay.raw.events
    .map((e, id) => ({
      event: e,
      id,
      t: e.timestamp - replay.raw.fight.startTime,
    }))
    .filter((e) => e.t >= 0 && e.t <= replay.duration)
    .sort((a, b) => a.t - b.t || a.id - b.id);
  const pending = new Map(),
    channels = new Map(),
    observed = new Map();
  const key = (e, side) => `${e[side + "ID"]}:${e[side + "Instance"] || 1}`;
  const ability = (spell) =>
    replay.abilities?.get(spell) ?? { name: `Spell ${spell}` };
  // First pass measures this actor's successfully paired casts. A missing end must
  // never inherit the next encounter's completion, nor a different spell's proc.
  const starts = new Map();
  for (const { event: e, id, t } of events) {
    const k = key(e, "source"),
      spell = spellOf(e);
    if (e.type === "begincast") starts.set(k, { spell, t });
    else if (e.type === "cast") {
      const begin = starts.get(k);
      if (begin && begin.spell === spell) {
        const elapsed = t - begin.t;
        if (elapsed > 0 && elapsed <= 60000) {
          const id = k + "/" + spell;
          const values = observed.get(id) ?? [];
          values.push(elapsed);
          observed.set(id, values);
        }
        starts.delete(k);
      }
    } else if (["death", "interrupt"].includes(e.type))
      starts.delete(key(e, "target"));
    else if (e.type === "combatantinfo") starts.delete(k);
    else if (e.type === "encounterend" || e.type === "encounterstart")
      starts.clear();
  }
  for (const values of observed.values()) values.sort((a, b) => a - b);
  const hint = (k, spell, channel) => {
    if (!channel) {
      const values = observed.get(k + "/" + spell);
      if (values?.length) {
        return {
          ms: values[Math.floor(values.length / 2)],
          source: "observed casts",
        };
      }
    }
    const ms = metadata[spell]?.[channel ? "durationMs" : "castMs"];
    return {
      ms: Number.isFinite(ms) && ms > 0 ? ms : 0,
      source: ms > 0 ? "client spell data" : "unknown",
    };
  };
  const close = (map, k, t, outcome, recorded = false) => {
    const c = map.get(k);
    if (!c) return;
    // Never stretch an estimated timeout until the next unrelated action.
    if (recorded || c.end >= t || c.timingSource === "unknown") {
      c.end = Math.max(c.start, recorded ? t : Math.min(c.end || t, t));
      c.outcome = outcome;
      c.interrupted = outcome === "interrupted";
      c.inferredEnd = !recorded;
      if (recorded) c.timingSource = "recorded";
    }
    map.delete(k);
  };
  for (const a of actors.values()) a.casts = [];
  for (const { event: e, id, t } of events) {
    const k = key(e, "source"),
      tk = key(e, "target"),
      a = actors.get(k),
      spell = spellOf(e);
    if (e.type === "encounterend" || e.type === "encounterstart") {
      for (const map of [pending, channels])
        for (const id of map.keys()) close(map, id, t, "encounter boundary");
    }
    if (e.type === "combatantinfo") {
      close(pending, k, t, "snapshot boundary");
      close(channels, k, t, "snapshot boundary");
    }
    if (e.type === "death") {
      close(pending, tk, t, "death");
      close(channels, tk, t, "death");
    }
    if (e.type === "interrupt") {
      const extra = e.extraAbilityGameID ?? e.extraAbility?.guid;
      for (const map of [pending, channels])
        if (!extra || map.get(tk)?.spell === extra)
          close(map, tk, t, "interrupted", true);
    }
    if (!a) continue;
    if (e.type === "begincast") {
      close(pending, k, t, "superseded");
      close(channels, k, t, "superseded");
      const h = hint(k, spell, false);
      const c = {
        id,
        spell,
        ...ability(spell),
        start: t,
        end: Math.min(replay.duration, t + h.ms),
        target: actors.has(tk) ? tk : null,
        inferredEnd: true,
        timingSource: h.source,
        outcome: "unresolved",
      };
      a.casts.push(c);
      pending.set(k, c);
    }
    if (e.type === "cast") {
      const c = pending.get(k);
      if (c?.spell === spell && t - c.start <= 60000) {
        c.end = t;
        c.inferredEnd = false;
        c.timingSource = "recorded";
        c.outcome = "completed";
        c.target = actors.has(tk) ? tk : c.target;
        pending.delete(k);
      } else
        a.casts.push({
          id,
          spell,
          ...ability(spell),
          start: t,
          end: t,
          instant: true,
          target: actors.has(tk) ? tk : null,
          timingSource: e.fake ? "WCL inferred cast" : "recorded",
          outcome: "completed",
        });
      if (metadata[spell]?.channel) {
        close(channels, k, t, "superseded");
        const h = hint(k, spell, true);
        const channel = {
          id,
          spell,
          ...ability(spell),
          start: t,
          end: Math.min(replay.duration, t + h.ms),
          channel: true,
          target: actors.has(tk) ? tk : null,
          inferredEnd: true,
          timingSource: h.source,
          outcome: "unresolved",
        };
        // One channel entry replaces the instantaneous activation glyph. A preceding
        // recorded wind-up, if any, remains a separate cast phase.
        const last = a.casts.at(-1);
        if (last?.instant && last.id === id) a.casts.pop();
        a.casts.push(channel);
        channels.set(k, channel);
      } else if (spell !== 1 && !e.melee && metadata[spell]?.castMs > 0)
        close(channels, k, t, "superseded");
    }
  }
  for (const a of actors.values())
    a.casts.sort((a, b) => a.start - b.start || a.id - b.id);
}

// Build once per import, not once per rendered frame. Each recorded direct result
// is emitted once; periodic ticks remain available to charts without replaying a missile.
export function buildVisualEvents(replay) {
  const visual = [],
    launches = new Map();
  for (const e of replay.combat) {
    if (e.kind === "summon-cue") {
      visual.push(e);
    } else if (e.kind === "go") {
      const go = { ...e, impacts: [] };
      visual.push(go);
      if (!e.melee && e.spell > 1) {
        const key = `${e.source}/${e.spell}`;
        const queue = launches.get(key) ?? [];
        queue.push(go);
        launches.set(
          key,
          queue.filter((x) => e.t - x.t <= 30000),
        );
      }
    } else if ((e.kind === "damage" || e.kind === "heal") && e.target) {
      if (e.melee) {
        visual.push(e);
        continue;
      }
      if (e.tick || e.spell <= 1) continue;
      const impact = { ...e, kind: "impact" };
      visual.push(impact);
      const candidates =
        launches
          .get(`${e.source}/${e.spell}`)
          ?.filter(
            (x) =>
              e.t >= x.t &&
              e.t - x.t <= 30000 &&
              !x.impacts.some((p) => p.target === e.target),
          ) ?? [];
      const launch =
        candidates.find((x) => x.target === e.target) ??
        candidates.find((x) => !x.target) ??
        candidates[0];
      // Association controls cosmetic travel only. Impact timing is always the
      // actual result timestamp, including results with no matching cast.
      if (launch && e.t >= launch.t && e.t - launch.t <= 30000) {
        if (!launch.impacts.some((x) => x.target === e.target))
          launch.impacts.push({ target: e.target, t: e.t });
      }
    }
  }
  return visual;
}
export function visualEventsBetween(replay, from, to) {
  if (to < from) return [];
  const events = replay.visualEvents ?? [];
  const after = (t) => {
    let lo = 0,
      hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (events[mid].t <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return events.slice(after(from), after(to));
}
