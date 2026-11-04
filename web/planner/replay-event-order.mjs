// Large whole-file imports share one stable index order without blocking on
// a single sort. The raw events and their indices stay in input order.
const RUN_SIZE = 4096;

export function* replayEventOrderSteps(events) {
  const length = events.length;
  let previous = -Infinity, ordered = true;
  for (let i = 0; i < length; i++) {
    if ((i & 1023) === 0) yield;
    const time = events[i].timestamp;
    // Keep the existing comparator semantics on malformed input.
    if (!Number.isFinite(time)) return undefined;
    if (time < previous) ordered = false;
    previous = time;
  }
  if (ordered) return undefined;

  let order = new Uint32Array(length), merged = new Uint32Array(length);
  const compare = (a, b) => events[a].timestamp - events[b].timestamp || a - b;
  for (let lo = 0; lo < length; lo += RUN_SIZE) {
    yield;
    const hi = Math.min(lo + RUN_SIZE, length);
    for (let i = lo; i < hi; i++) order[i] = i;
    order.subarray(lo, hi).sort(compare);
  }
  for (let size = RUN_SIZE; size < length; size *= 2) {
    for (let lo = 0; lo < length; lo += size * 2) {
      const mid = Math.min(lo + size, length), hi = Math.min(mid + size, length);
      let a = lo, b = mid;
      for (let i = lo; i < hi; i++) {
        if ((i & 1023) === 0) yield;
        merged[i] = b >= hi || (a < mid && compare(order[a], order[b]) <= 0)
          ? order[a++] : order[b++];
      }
    }
    [order, merged] = [merged, order];
  }
  return order;
}
