import type { GameVersion } from "./types";
import { createContext } from "react";
export const GameVersionContext = createContext<GameVersion>("vanilla");
export interface WowheadMetadata {
  name: string;
  icon?: string;
  quality?: number;
}
const cache = new Map<string, Promise<WowheadMetadata>>();
export function wowheadUrl(
  kind: "spell" | "item" | "npc",
  id: number,
  version: GameVersion = "vanilla",
) {
  return `https://www.wowhead.com/classic/${kind}=${id}${version === "sod" ? "?env=4" : ""}`;
}
export function loadWowheadMetadata(
  kind: "spell" | "item",
  id: number,
  version: GameVersion = "vanilla",
) {
  if (!Number.isInteger(id) || id <= 0)
    return Promise.reject(new Error("Invalid reference"));
  const key = `${version}:${kind}:${id}`;
  let request = cache.get(key);
  if (!request) {
    request = fetch(
      `https://nether.wowhead.com/classic/tooltip/${kind}/${id}${version === "sod" ? "?dataEnv=4" : ""}`,
      { signal: AbortSignal.timeout(10000), referrerPolicy: "no-referrer" },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error("Reference unavailable");
        const data = await response.json();
        if (typeof data.name !== "string")
          throw new Error("Reference unavailable");
        return {
          name: data.name,
          icon: typeof data.icon === "string" ? data.icon : undefined,
          quality: typeof data.quality === "number" ? data.quality : undefined,
        } satisfies WowheadMetadata;
      })
      .catch((error) => {
        cache.delete(key);
        throw error;
      });
    if (cache.size >= 200) cache.delete(cache.keys().next().value!);
    cache.set(key, request);
  }
  return request;
}
