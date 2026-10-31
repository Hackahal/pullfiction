export interface LabelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export function hitMapLabel(
  labels: readonly (LabelRect & { id: string })[],
  point: readonly number[],
) {
  return [...labels]
    .reverse()
    .find(
      (r) =>
        point[0] >= r.x &&
        point[0] <= r.x + r.width &&
        point[1] >= r.y &&
        point[1] <= r.y + r.height,
    )?.id;
}
const overlaps = (a: LabelRect, b: LabelRect) =>
  a.x < b.x + b.width &&
  a.x + a.width > b.x &&
  a.y < b.y + b.height &&
  a.y + a.height > b.y;

/** Screen-space only: actor positions and authored geometry never move. */
export function mapLabelLayout(width: number, height: number) {
  const cells = new Map<string, LabelRect[]>();
  function keys(r: LabelRect) {
    const result: string[] = [];
    for (
      let y = Math.floor(r.y / 64);
      y <= Math.floor((r.y + r.height) / 64);
      y++
    )
      for (
        let x = Math.floor(r.x / 64);
        x <= Math.floor((r.x + r.width) / 64);
        x++
      )
        result.push(`${x}:${y}`);
    return result;
  }
  function block(r: LabelRect) {
    for (const key of keys(r)) cells.set(key, [...(cells.get(key) ?? []), r]);
  }
  function place(
    preferred: LabelRect,
    required = false,
    anchor?: readonly number[],
  ): LabelRect | null {
    if (
      anchor &&
      (anchor[0] < 0 ||
        anchor[1] < 0 ||
        anchor[0] > width ||
        anchor[1] > height)
    )
      return null;
    const w = Math.min(preferred.width, Math.max(0, width - 12)),
      h = preferred.height;
    const offsets = [
      [0, 0],
      [0, -28],
      [0, 28],
      [-w - 12, 0],
      [w + 12, 0],
      [-w - 12, -28],
      [w + 12, -28],
      [0, -56],
      [0, 56],
    ];
    const candidates = offsets.map(([dx, dy]) => ({
      x: Math.max(6, Math.min(width - w - 6, preferred.x + dx)),
      y: Math.max(6, Math.min(height - h - 6, preferred.y + dy)),
      width: w,
      height: h,
    }));
    const free = candidates.find((r) =>
      keys(r).every(
        (key) => !(cells.get(key) ?? []).some((b) => overlaps(r, b)),
      ),
    );
    const result = free ?? (required ? candidates[0] : null);
    if (result)
      block({
        x: result.x - 3,
        y: result.y - 3,
        width: result.width + 6,
        height: result.height + 6,
      });
    return result;
  }
  return { block, place };
}
