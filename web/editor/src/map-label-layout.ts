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
  const [x, y] = point;
  for (let i = labels.length - 1; i >= 0; i--) {
    const r = labels[i];
    if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height)
      return r.id;
  }
}
const overlaps = (a: LabelRect, b: LabelRect) =>
  a.x < b.x + b.width &&
  a.x + a.width > b.x &&
  a.y < b.y + b.height &&
  a.y + a.height > b.y;

const CELL_SIZE = 64;
const LABEL_OFFSETS = [
  [0, 0],
  [0, -28],
  [0, 28],
  [-1, 0],
  [1, 0],
  [-1, -28],
  [1, -28],
  [0, -56],
  [0, 56],
] as const;

/** Screen-space only: actor positions and authored geometry never move. */
export function mapLabelLayout(width: number, height: number) {
  const rows = new Map<number, Map<number, LabelRect[]>>();
  function block(r: LabelRect) {
    const left = Math.floor(r.x / CELL_SIZE),
      right = Math.floor((r.x + r.width) / CELL_SIZE);
    const top = Math.floor(r.y / CELL_SIZE),
      bottom = Math.floor((r.y + r.height) / CELL_SIZE);
    for (let y = top; y <= bottom; y++) {
      let row = rows.get(y);
      if (!row) rows.set(y, (row = new Map()));
      for (let x = left; x <= right; x++) {
        const cell = row.get(x);
        if (cell) cell.push(r);
        else row.set(x, [r]);
      }
    }
  }
  function isFree(r: LabelRect) {
    const left = Math.floor(r.x / CELL_SIZE),
      right = Math.floor((r.x + r.width) / CELL_SIZE);
    const top = Math.floor(r.y / CELL_SIZE),
      bottom = Math.floor((r.y + r.height) / CELL_SIZE);
    for (let y = top; y <= bottom; y++) {
      const row = rows.get(y);
      if (!row) continue;
      for (let x = left; x <= right; x++) {
        const cell = row.get(x);
        if (!cell) continue;
        for (const blocked of cell) if (overlaps(r, blocked)) return false;
      }
    }
    return true;
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
    let result: LabelRect | null = null;
    for (const [side, dy] of LABEL_OFFSETS) {
      const candidate = {
        x: Math.max(6, Math.min(width - w - 6, preferred.x + side * (w + 12))),
        y: Math.max(6, Math.min(height - h - 6, preferred.y + dy)),
        width: w,
        height: h,
      };
      if (isFree(candidate)) {
        result = candidate;
        break;
      }
      if (required && !result) result = candidate;
    }
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
