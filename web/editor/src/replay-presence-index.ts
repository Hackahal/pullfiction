import type { Actor } from "./types";

interface Interval {
  start: number;
  end: number;
  actor: Actor;
}
interface Node {
  center: number;
  starts: Interval[];
  ends: Interval[];
  left?: Node;
  right?: Node;
}
function tree(rows: Interval[]): Node | undefined {
  if (!rows.length) return;
  const finite = rows
    .flatMap((r) => [r.start, r.end])
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const center = finite.length ? finite[finite.length >>> 1] : 0;
  const left: Interval[] = [],
    right: Interval[] = [],
    crossing: Interval[] = [];
  for (const row of rows) {
    if (row.end < center) left.push(row);
    else if (row.start > center) right.push(row);
    else crossing.push(row);
  }
  return {
    center,
    starts: crossing.sort((a, b) => a.start - b.start),
    ends: [...crossing].sort((a, b) => b.end - a.end),
    left: tree(left),
    right: tree(right),
  };
}
/** Conservative pose candidates; excludes only known absence/death, never uncertain positions. */
export class ReplayPresenceIndex {
  private root?: Node;
  private players: Actor[];
  constructor(actors: Actor[]) {
    this.players = actors.filter((a) => a.type === "Player");
    const rows: Interval[] = [];
    for (const actor of actors) {
      if (actor.type === "Player") continue;
      const samples = actor.samples ?? [];
      if (!samples.length && !actor.spawn) continue;
      let start = actor.runLifetime ? actor.firstSeen : -Infinity;
      const end = actor.runLifetime ? actor.lastSeen + 3000 : Infinity;
      if (actor.spawn) start = Math.max(start, actor.spawn.visibleFrom);
      else if (actor.type !== "NPC") start = Math.max(start, samples[0][0]);
      let dead = false;
      for (const [at, nextDead] of actor.deaths ?? []) {
        if (at < start) {
          dead = nextDead;
          continue;
        }
        if (at > end) break;
        if (!dead && at > start) rows.push({ actor, start, end: at });
        start = at;
        dead = nextDead;
      }
      if (!dead && start <= end)
        rows.push({
          actor,
          start,
          end: end === Infinity ? end : end + 0.000001,
        });
    }
    this.root = tree(rows);
  }
  at(time: number): Set<string> {
    return this.between(time, time);
  }
  between(start: number, end: number): Set<string> {
    const result = new Set(this.players.map((a) => a.key));
    const visit = (node?: Node) => {
      if (!node) return;
      for (const row of node.starts) {
        if (row.start > end) break;
        if (row.end > start) result.add(row.actor.key);
      }
      if (start < node.center) visit(node.left);
      if (end >= node.center) visit(node.right);
    };
    visit(this.root);
    return result;
  }
}
