// Presentation rules for Classic movement. Unknown spells retain the observed profile.
const SPEED = new Map([[2983, 1.5], [8696, 1.6], [11305, 1.7], [1850, 1.5], [9821, 1.6], [2379, 1.5]]);
const BLINK = 1953;
const upper = (rows, time) => {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const m = (lo + hi) >>> 1; if (rows[m][0] <= time) lo = m + 1; else hi = m; }
  return lo;
};

// Build once after combat enrichment, rather than scanning auras for every render frame.
export function prepareMovement(actor) {
  const active = new Set(actor.initialAuras ?? []);
  const weight = () => Math.max(1, ...[...active].map(id => SPEED.get(id) ?? 1));
  const profile = [[0, weight(), 0]];
  for (const [t, aura] of actor.auras ?? []) {
    if (aura.reset) { active.clear(); for (const id of aura.reset) active.add(id); }
    else if (SPEED.has(aura.spell)) { if (aura.remove) active.delete(aura.spell); else active.add(aura.spell); }
    else continue;
    const last = profile.at(-1), integral = last[2] + (t - last[0]) * last[1];
    if (t === last[0]) { last[1] = weight(); } else profile.push([t, weight(), integral]);
  }
  actor.movement = {
    profile,
    blinks: (actor.casts ?? []).filter(c => c.spell === BLINK && c.outcome === 'completed' && c.timingSource === 'recorded').map(c => [c.end]),
  };
}

export function movementBetween(actor, a, b, time) {
  const gap = b[0] - a[0];
  const blinks = actor.movement?.blinks ?? [];
  const next = blinks[upper(blinks, a[0])];
  // A destination sampled later is only an estimate of the landing. Never animate a walk
  // across the jump, including when the observed displacement is below the teleport cutoff.
  if (next && next[0] <= b[0]) return { blink: true, after: time >= next[0] };
  const profile = actor.movement?.profile ?? [[0, 1, 0]];
  const at = t => {
    const p = profile[Math.max(0, upper(profile, t) - 1)];
    return [p[2] + (t - p[0]) * p[1], p[1]];
  };
  const start = at(a[0])[0], end = at(b[0])[0], current = at(time);
  const total = end - start;
  return {
    blink: false,
    fraction: Math.max(0, Math.min(1, (current[0] - start) / total)),
    rate: current[1] * 1000 / total,
    weighted: (total !== gap || current[1] !== 1) && gap <= 2000,
  };
}
