type MotionRow = Pick<HTMLTableRowElement, "offsetTop" | "dataset" | "animate">;

/** Animate keyed rows from their previous layout positions after a rank change. */
export function animateChartRows(
  rows: MotionRow[],
  previous: Map<string, number>,
  reduced: boolean,
) {
  const positions = new Map<string, number>();
  const animations: Animation[] = [];
  for (const row of rows) {
    const key = row.dataset.series!;
    const top = row.offsetTop;
    const before = previous.get(key);
    positions.set(key, top);
    if (reduced || typeof row.animate !== "function") continue;
    if (before !== undefined && before !== top) {
      animations.push(
        row.animate(
          [
            { transform: `translateY(${before - top}px)` },
            { transform: "translateY(0)" },
          ],
          { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" },
        ),
      );
    } else if (before === undefined) {
      animations.push(
        row.animate(
          [
            { opacity: 0, transform: "translateY(5px)" },
            { opacity: 1, transform: "translateY(0)" },
          ],
          { duration: 220, easing: "ease-out" },
        ),
      );
    }
  }
  return { positions, animations };
}
