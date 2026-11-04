// Presentation rules for Classic movement. Unknown spells retain the observed profile.
const SPEED = new Map([[2983, 1.5], [8696, 1.6], [11305, 1.7], [1850, 1.5], [9821, 1.6], [2379, 1.5]]);
const BLINK = 1953;
const DEFAULT_PROFILE = [[0, 1, 0]];
const NO_BLINKS = [];
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
  const blinks = actor.movement?.blinks ?? NO_BLINKS;
  if (blinks.length) {
    const index=upper(blinks,a[0]),atDeparture=actor.movement?.departureJumps?.includes(a[0]);
    const next = atDeparture&&blinks[index-1]?.[0]===a[0]?blinks[index-1]:blinks[index];
    // A destination sampled later is only an estimate of the landing. Never animate a walk
    // across the jump, including when the observed displacement is below the teleport cutoff.
    if (next && next[0] <= b[0]) return { blink: true, after: time >= next[0] };
  }
  const profile = actor.movement?.profile ?? DEFAULT_PROFILE;
  const first = profile.length === 1 ? profile[0] : null;
  const startRow = first ?? profile[Math.max(0, upper(profile, a[0]) - 1)];
  const endRow = first ?? profile[Math.max(0, upper(profile, b[0]) - 1)];
  const currentRow = first ?? profile[Math.max(0, upper(profile, time) - 1)];
  const start = startRow[2] + (a[0] - startRow[0]) * startRow[1];
  const end = endRow[2] + (b[0] - endRow[0]) * endRow[1];
  const current = currentRow[2] + (time - currentRow[0]) * currentRow[1];
  const weight = currentRow[1], total = end - start;
  return {
    blink: false,
    fraction: Math.max(0, Math.min(1, (current - start) / total)),
    rate: weight * 1000 / total,
    weighted: (total !== gap || weight !== 1) && gap <= 2000,
    travel_budget: total * 7 / 1000,
    run_speed: weight * 7,
  };
}

// A normal run can fit between the fixed observations with a hold at either end.
// If anchors demand faster travel, preserve their timestamps and normalized profile.
export function runProgress(length, fraction, rate, budget) {
  if (!(length > 0) || !(budget >= length)) return { fraction, rate };
  const travelled = fraction * budget - (budget - length) / 2;
  return {
    fraction: Math.max(0, Math.min(1, travelled / length)),
    rate: travelled >= 0 && travelled < length ? rate * budget / length : 0,
  };
}
