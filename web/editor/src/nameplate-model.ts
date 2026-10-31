import type { Options } from "./types";

export function actorNameplateEnabled(
  actor: { class: string; icon?: string | null },
  options: Options,
): boolean {
  return actor.class === "Boss" || actor.icon?.toLowerCase() === "boss"
    ? options.bossNameplates
    : options.trashNameplates;
}

// Typing fields and dialogs are excluded by the document keyboard handler.
export function nameplateShortcut(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): "friendlyNameplates" | "enemyNameplates" | null {
  if (
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.key.toLowerCase() !== "v"
  )
    return null;
  return event.shiftKey ? "friendlyNameplates" : "enemyNameplates";
}
