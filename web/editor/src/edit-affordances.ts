import type { Annotation, Point } from "./types";
export type HandleKind = "move" | "resize" | "rotate" | "scale" | "point";
export function editControls(edit: Annotation): {
  handles: Point[];
  handleKinds: HandleKind[];
} {
  const p = edit.points[0];
  if (edit.locked || !p) return { handles: [], handleKinds: [] };
  if (edit.type === "circle") {
    const handles: Point[] = Array.from({ length: 8 }, (_, i) => [
      p[0] + Math.cos((i * Math.PI) / 4) * edit.size,
      p[1] + Math.sin((i * Math.PI) / 4) * edit.size,
      p[2],
    ]);
    return edit.actor
      ? { handles, handleKinds: handles.map(() => "resize") }
      : {
          handles: [p, ...handles],
          handleKinds: ["move", ...handles.map(() => "resize" as const)],
        };
  }
  if (edit.actor && edit.type !== "cone")
    return { handles: [], handleKinds: [] };
  let handles = edit.points.map((p) => [...p] as Point),
    handleKinds: HandleKind[] = handles.map(() =>
      edit.points.length === 1 ? "move" : "point",
    );
  if (edit.type === "cone") {
    const q = edit.points[1] ?? [p[0] + 1, p[1], p[2]],
      angle = Math.atan2(q[1] - p[1], q[0] - p[0]);
    handles = [
      p,
      [
        p[0] + Math.cos(angle) * edit.size,
        p[1] + Math.sin(angle) * edit.size,
        p[2],
      ],
    ];
    handleKinds = ["move", "resize"];
    if (edit.actor) {
      handles.shift();
      handleKinds.shift();
    }
  }
  if (
    edit.points.length > 1 &&
    !["marker", "label", "drawing"].includes(edit.type)
  ) {
    const extent = Math.max(
      edit.type === "cone" ? edit.size : 0,
      ...edit.points.map((q) => Math.hypot(q[0] - p[0], q[1] - p[1])),
    );
    handles.push([p[0], p[1] + Math.max(4, extent + 3), p[2]]);
    handleKinds.push("rotate");
    if (edit.type !== "cone") {
      handles.push([
        p[0] + Math.max(4, extent + 2),
        p[1] - Math.max(4, extent + 2),
        p[2],
      ]);
      handleKinds.push("scale");
    }
  }
  return { handles, handleKinds };
}
export function handleLabel(kind: string) {
  return (
    (
      {
        move: "Move",
        resize: "Resize",
        rotate: "Rotate",
        scale: "Resize",
        point: "Move point",
      } as Record<string, string>
    )[kind] ?? "Move"
  );
}
export function handleCursor(kind: string, dx = 1, dy = 1): string {
  if (kind === "rotate") return "rotate";
  if (kind === "move" || kind === "point") return "move";
  const direction =
    ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 4) + 4) % 4;
  return ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"][direction];
}
export const rotateCursor = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M19 8A8 8 0 1 0 20 15M19 3v6h-6" fill="none" stroke="white" stroke-width="4"/><path d="M19 8A8 8 0 1 0 20 15M19 3v6h-6" fill="none" stroke="#202629" stroke-width="2"/></svg>')}") 12 12, crosshair`;
