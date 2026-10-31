import type { Tool } from "./types";
export type SceneGesture =
  "camera" | "pan" | "select" | "draw" | "transform" | "native";
export function sceneGesture(
  button: number,
  selectModifier: boolean,
  tool: Tool,
  handle: boolean,
): SceneGesture {
  if (button === 2) return "camera";
  if (button === 1) return "pan";
  if (button !== 0) return "native";
  if (selectModifier) return "select";
  if (handle) return "transform";
  if (!["explore", "move"].includes(tool)) return "draw";
  return "select";
}
// A press is always a selection until it crosses the shared drag threshold.
export const DRAG_THRESHOLD = 4;
export function startsDrag(start: readonly number[], end: readonly number[]) {
  return Math.hypot(end[0] - start[0], end[1] - start[1]) >= DRAG_THRESHOLD;
}

export function usesNativeMouseLook(
  gesture: SceneGesture,
  cameraMode: "free" | "orbit",
  _browserAssets: boolean,
) {
  return gesture === "camera" && cameraMode === "free";
}
