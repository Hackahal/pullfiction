import type { GameVersion } from "./types";
import type { ModernCatalog } from "./browser-assets";

export const NPC_MODELS_URL = "/metadata/npc-models.json";
export interface NpcDisplayModel {
  name: string;
  displayID: number;
  scale: number;
  displaySource: string;
}
export type NpcModels = Record<GameVersion, Record<string, NpcDisplayModel>>;
const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) > 0 && Number(value) <= 0xffffffff;
const positiveScale = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

// Original OBJECT_FIELD_SCALE_X already includes the authored model/display fold.
// The native body renderer consumes it directly, as it does a server object scale.
function clientObjectScale(
  creatures: ModernCatalog,
  displayID: number,
): number | undefined {
  const display = creatures.displays?.[displayID];
  const model = creatures.models?.[display?.modelID];
  if (!positiveScale(display?.scale) || !positiveScale(model?.scale)) return;
  const scale = display.scale * model.scale;
  return positiveScale(scale) ? scale : undefined;
}

export async function loadNpcIndex(
  signal?: AbortSignal,
  request: typeof fetch = fetch,
): Promise<unknown> {
  const response = await request(NPC_MODELS_URL, {
    signal,
    credentials: "omit",
    cache: "no-cache",
  });
  if (!response.ok)
    throw new Error("Bundled NPC display metadata is unavailable.");
  const text = await response.text();
  if (text.length > 8 * 1024 * 1024)
    throw new Error("Bundled NPC metadata exceeds the import limit.");
  return JSON.parse(text);
}

// This index contains names and numeric display references only. Renderable
// geometry, textures and intrinsic scale always come from the selected client.
export function resolveNpcModels(
  index: unknown,
  creatures: ModernCatalog,
): NpcModels {
  if (
    !object(index) ||
    index.schema !== 1 ||
    index.provider !== "Wowhead" ||
    !object(index.versions)
  )
    throw new Error("Invalid bundled NPC display metadata.");
  if (!object(creatures.displays) || !object(creatures.models))
    throw new Error("Invalid local creature catalog.");
  const result: NpcModels = { vanilla: {}, sod: {} };
  for (const version of ["vanilla", "sod"] as const) {
    const entries = index.versions[version]?.creatures;
    if (entries === undefined) continue;
    if (!object(entries) || Object.keys(entries).length > 100000)
      throw new Error("Invalid bundled NPC display entries.");
    for (const [entry, value] of Object.entries(entries)) {
      if (
        !/^[1-9]\d*$/.test(entry) ||
        !id(Number(entry)) ||
        !object(value) ||
        typeof value.name !== "string" ||
        value.name.length > 300 ||
        !id(value.displayID) ||
        !Array.isArray(value.displayIDs) ||
        value.displayIDs.length > 64 ||
        !value.displayIDs.every(id) ||
        !value.displayIDs.includes(value.displayID) ||
        value.templateScale !== 0 ||
        typeof value.sourceURL !== "string" ||
        typeof value.sourceSHA256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.sourceSHA256)
      )
        continue;
      let source: URL;
      try {
        source = new URL(value.sourceURL);
      } catch {
        continue;
      }
      if (
        source.origin !== "https://www.wowhead.com" ||
        source.pathname !== `/classic/npc=${entry}` ||
        source.username ||
        source.password ||
        source.hash
      )
        continue;
      let documentSource = source;
      if (value.sourceDocumentURL !== undefined) {
        if (typeof value.sourceDocumentURL !== "string") continue;
        try {
          documentSource = new URL(value.sourceDocumentURL);
        } catch {
          continue;
        }
        if (
          documentSource.origin !== "https://www.wowhead.com" ||
          !/^\/classic\/zone=(?:2717|2159|2677|1977|3429|3428|3456)$/.test(
            documentSource.pathname,
          ) ||
          documentSource.search ||
          documentSource.hash ||
          documentSource.username ||
          documentSource.password
        )
          continue;
      }
      // Try only authored variants. Never borrow a display from another NPC or ruleset.
      const candidates = [...new Set([value.displayID, ...value.displayIDs])];
      const displayID = candidates.find((candidate) => {
        const display = creatures.displays[String(candidate)];
        const model =
          object(display) && creatures.models[String(display.modelID)];
        return (
          object(model) &&
          id(model.fileDataID) &&
          clientObjectScale(creatures, candidate) !== undefined
        );
      });
      if (displayID === undefined) continue;
      result[version][entry] = {
        name: value.name,
        displayID,
        scale: clientObjectScale(creatures, displayID)!,
        displaySource: documentSource.href,
      };
    }
  }
  return result;
}

export function replayNpcModels(
  base: Record<string, unknown>,
  raw: Record<string, unknown> | undefined,
  creatures: ModernCatalog,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [entry, supplied] of Object.entries(raw ?? {})) {
    if (!/^[1-9]\d*$/.test(entry) || !object(supplied)) continue;
    const merged = { ...(object(base[entry]) ? base[entry] : {}), ...supplied };
    // Existing exports already contain final object scale. Keep it unchanged.
    // A display override without a scale instead uses that display's own data.
    if (supplied.scale === undefined) {
      const scale = clientObjectScale(creatures, merged.displayID);
      if (scale !== undefined) merged.scale = scale;
    }
    result[entry] = merged;
  }
  return result;
}
