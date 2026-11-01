#!/usr/bin/env node
/** Exercise retained encounter observations through the actual replay functions.
 * This is CPU state evidence, separate from native dispatch and browser pixels.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { resolveEncounterBounds } from "../web/planner/encounter-bounds.mjs";
import {
  normalizeReplay,
  enrichCombat,
  poseAt,
  combatStateAt,
} from "../web/planner/replay.mjs";

const { values } = parseArgs({
  options: { audit: { type: "string" }, output: { type: "string" } },
});
if (!values.audit || !values.output)
  throw new Error("Use --audit REPORT_JSON --output NEW_JSON_FILE");
const sha = (data) => createHash("sha256").update(data).digest("hex");
const auditBytes = await readFile(values.audit),
  audit = JSON.parse(auditBytes);
// Refuse stale or altered inputs and producer/consumer code. An audit from a
// different checkout cannot silently earn current-code verification credit.
for (const [path, hash] of Object.entries(audit.inputs)) {
  if (sha(await readFile(path)) !== hash)
    throw new Error(`Audit input changed: ${path}`);
}
const root = fileURLToPath(new URL("../", import.meta.url));
for (const [path, hash] of Object.entries(audit.sourceFiles)) {
  if (sha(await readFile(resolve(root, path))) !== hash)
    throw new Error(`Audited code changed: ${path}`);
}
const load = async (role) =>
  JSON.parse(await readFile(audit.inputRoles[role], "utf8"));
let raw;
if (audit.inputRoles.replay) raw = await load("replay");
else {
  const report = await load("report"),
    events = await load("events"),
    detail = await load("details");
  raw = {
    report,
    events,
    gameVersion: report.gameVersion,
    actors: detail.masterData.actors,
    abilities: detail.masterData.abilities ?? [],
  };
}
const graph = await load("graph"),
  encounters = [];
const key = (e, side) => `${e[`${side}ID`]}:${e[`${side}Instance`] || 1}`;
for (const encounter of audit.encounters) {
  // Selected replay metadata outranks report metadata, including its bounds.
  // Empty collections do not constitute a selection.
  const fights = [raw.fights, raw.fight?.chapters].find(
    (rows) => Array.isArray(rows) && rows.length > 0,
  ) ?? (raw.fight != null ? [raw.fight] : raw.report.fights ?? []);
  const selected = fights.find((f) => String(f.id) === String(encounter.id));
  if (!selected)
    throw new Error(`Encounter ${encounter.id} is absent from the input`);
  const fight=resolveEncounterBounds({...raw.report,gameVersion:raw.gameVersion},selected,
    raw.events.filter(e=>e.type==='encounterstart'||e.type==='encounterend'));
  if(encounter.recordedBounds&&(encounter.recordedBounds.startTime!==fight.startTime||encounter.recordedBounds.endTime!==fight.endTime))
    throw new Error(`Encounter ${encounter.id} recorded bounds disagree with the audit`);
  const events = raw.events
    .filter(
      (e) =>
        e.timestamp >= fight.startTime &&
        e.timestamp <= fight.endTime &&
        (fight.recordedPrelude || e.fight == null || String(e.fight) === String(fight.id)),
    )
    .sort((a, b) => a.timestamp - b.timestamp);
  const replay = enrichCombat(
    normalizeReplay({ ...raw, fight, events }),
    {},
    graph.spells,
  );
  const actors = new Map(replay.actors.map((a) => [a.key, a]));
  let assertions = 0;
  const failures = [], unpositionedLifecycle = [];
  const check = (ok, message) => {
    assertions++;
    if (!ok) failures.push(message);
  };
  for (const entity of encounter.actors) {
    const actor = actors.get(entity.key);
    if (!actor) continue;
    const births = entity.lifecycle.filter(
      (e) => e.type === "summon" || e.type === "create",
    );
    if (
      births.length &&
      entity.firstObservedMs >= births[0].atMs &&
      births[0].atMs > 0
    ) {
      for (const at of [births[0].atMs - 1, 0, births[0].atMs - 1])
        check(
          poseAt(actor, at) === null,
          `${entity.key} visible before recorded creation at ${at}`,
        );
    }
    const lifecycle = entity.lifecycle.filter((e) =>
      ["summon", "create", "destroy"].includes(e.type),
    );
    for (const event of lifecycle) {
      // Check final state of simultaneous events rather than requiring an
      // intermediate state that no rendered frame could observe.
      const last = lifecycle.filter((e) => e.atMs === event.atMs).at(-1);
      if (last !== event) continue;
      const pose = poseAt(actor, event.atMs);
      if (event.type === "destroy")
        check(pose === null, `${entity.key} present after destruction`);
      else if (actor.samples.some(s => s[0] <= event.atMs) ||
        actor.spawn && actor.spawn.visibleFrom <= event.atMs)
        check(pose !== null, `${entity.key} absent after creation`);
      else unpositionedLifecycle.push({actor:entity.key,atMs:event.atMs,type:event.type,
        reason:"Creation is recorded; no position is established at this timestamp."});
    }
  }
  // Independent forward event fold. Sample final timestamp state, then query
  // the production indexed state in reverse order and again in forward order.
  const expected = new Map(),
    seen = new Map(),
    snapshots = [];
  for (let i = 0; i < events.length;) {
    const at = events[i].timestamp;
    const affected = new Set();
    while (i < events.length && events[i].timestamp === at) {
      const e = events[i++],
        k = key(e, "target");
      if (e.type === "combatantinfo" && actors.has(key(e, "source"))) {
        const source = key(e, "source"), previous = seen.get(source) ?? new Set();
        const state = new Map();
        for (const aura of e.auras ?? []) {
          const sid = aura.ability ?? aura.abilityGameID;
          if (!Number.isInteger(sid)) continue;
          state.set(sid, { stack: 1, selfCast: undefined });
          previous.add(sid);
        }
        expected.set(source, state);
        seen.set(source, previous);
        affected.add(source);
      }
      if (
        !actors.has(k) ||
        !/^(apply|remove|refresh)(buff|debuff)/.test(e.type)
      )
        continue;
      const sid = e.abilityGameID ?? e.ability?.guid ?? 0;
      let state = expected.get(k);
      if (!state) expected.set(k, (state = new Map()));
      if (!seen.has(k)) seen.set(k, new Set());
      seen.get(k).add(sid);
      if (e.type.startsWith("remove") && !e.type.endsWith("stack"))
        state.delete(sid);
      else
        state.set(sid, {
          stack: e.stack ?? 1,
          selfCast: actors.has(key(e, "source"))
            ? key(e, "source") === k
            : e.type.startsWith("refresh") || e.type.endsWith("stack")
              ? (state.get(sid)?.selfCast ?? false)
              : false,
        });
      affected.add(k);
    }
    for (const k of affected) {
      // Bounded retained snapshots; every 47th event timestamp plus mechanic
      // starts gives varied checkpoint/seek distances without quadratic memory.
      if (snapshots.length < 24 || i % 47 === 0)
        snapshots.push({
          k,
          at: at - fight.startTime,
          expected: new Map(expected.get(k)),
          seen: new Set(seen.get(k)),
        });
    }
  }
  for (const sample of [...snapshots].reverse().concat(snapshots)) {
    const actual = new Map(
      combatStateAt(actors.get(sample.k), sample.at).auras.map((a) => [
        a.spell,
        a,
      ]),
    );
    for (const sid of sample.seen) {
      const expectedAura = sample.expected.get(sid);
      const a = actual.get(sid);
      if (!expectedAura) {
        check(!a, `${sample.k} removed aura ${sid} remains at ${sample.at}`);
        continue;
      }
      check(
        a?.stack === expectedAura.stack &&
          a?.selfCast === expectedAura.selfCast,
        `${sample.k} aura ${sid} differs at ${sample.at}`,
      );
    }
  }
  const expectedCasts = events.filter(
    (e) => e.type === "cast" && actors.has(key(e, "source")),
  ).length;
  check(
    replay.combat.filter((e) => e.kind === "go").length === expectedCasts,
    "recorded casts lost in normalization",
  );
  encounters.push({
    id: encounter.id,
    name: encounter.name,
    eventCount: events.length,
    actorCount: actors.size,
    assertions,
    failures,
    unpositionedLifecycle,
    status: failures.length ? "fail" : "pass",
  });
}
const result = {
  schema: 1,
  auditSha256: sha(auditBytes),
  checkerSha256: sha(await readFile(fileURLToPath(import.meta.url))),
  encounters,
  proofBoundary:
    "Actual normalization, pose and indexed aura-state functions on retained inputs. No browser, native effect rendering, ground placement or official-client visual acceptance.",
};
await writeFile(values.output, JSON.stringify(result, null, 2) + "\n", {
  flag: "wx",
});
console.log(JSON.stringify(result, null, 2));
if (encounters.some((e) => e.status === "fail")) process.exitCode = 1;
