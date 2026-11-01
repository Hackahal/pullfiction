import {
  DELETE_TOKEN,
  MAX_SHARE_BYTES,
  SHARE_ID,
  validateShare,
} from "../../../cloudflare/share-schema.mjs";
import type { LocalProject, ProjectSource } from "./project-store";
import type { Plan } from "./types";

export interface SharedSnapshot {
  version: 1;
  plan: Plan;
  source: Omit<ProjectSource, "cacheKey" | "buffered"> | null;
  time: number;
  mode: LocalProject["mode"];
  kind: LocalProject["kind"];
}
export interface OwnedShare {
  id: string;
  deleteToken: string;
  name: string;
}
const OWNED_KEY = "pullfiction.shares.v1";
export function shareSnapshot(project: LocalProject): SharedSnapshot {
  return validateShare({
    version: 1,
    plan: project.plan,
    source: project.source,
    time: project.time,
    mode: project.mode,
    kind: project.kind,
  }) as SharedSnapshot;
}
export function readSharedSnapshot(value: unknown): SharedSnapshot {
  return validateShare(value) as SharedSnapshot;
}
export function shareId(hash: string) {
  const value = new URLSearchParams(hash.replace(/^#/, "")).get("share");
  return value === null ? null : SHARE_ID.test(value) ? value : "";
}
export function shareLink(id: string, href = location.href) {
  if (!SHARE_ID.test(id)) throw new Error("Invalid share ID");
  const url = new URL(href);
  url.search = "";
  url.hash = `share=${id}`;
  return url.href;
}
export function ownedShares(storage?: Pick<Storage, "getItem">): OwnedShare[] {
  try {
    const values: unknown = JSON.parse(storage?.getItem(OWNED_KEY) ?? "[]");
    if (!Array.isArray(values)) return [];
    return values.filter((v): v is OwnedShare =>
      Boolean(
        v &&
        SHARE_ID.test(v.id) &&
        DELETE_TOKEN.test(v.deleteToken) &&
        typeof v.name === "string",
      ),
    );
  } catch {
    return [];
  }
}
export function saveOwnedShares(
  values: OwnedShare[],
  storage: Pick<Storage, "setItem">,
) {
  storage.setItem(OWNED_KEY, JSON.stringify(values));
}
export class ShareClient {
  constructor(private request: typeof fetch = (...args) => fetch(...args)) {}
  private async json(path: string, init?: RequestInit) {
    const response = await this.request(`/api/shares${path}`, {
      ...init,
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_SHARE_BYTES + 4096)
      throw new Error("Sharing response is too large.");
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error("Sharing is unavailable on this deployment.");
    }
    if (!response.ok)
      throw new Error(
        typeof value.error === "string"
          ? value.error
          : "Sharing request failed.",
      );
    return value;
  }
  async config(): Promise<{ enabled: boolean; siteKey?: string }> {
    return this.json("/config");
  }
  async publish(
    snapshot: SharedSnapshot,
    turnstileToken: string,
  ): Promise<{ id: string; deleteToken: string }> {
    const result = await this.json("", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        snapshot: readSharedSnapshot(snapshot),
        turnstileToken,
      }),
    });
    if (!SHARE_ID.test(result.id) || !DELETE_TOKEN.test(result.deleteToken))
      throw new Error("Invalid sharing response.");
    return result;
  }
  async read(id: string) {
    if (!SHARE_ID.test(id)) throw new Error("Invalid sharing link.");
    return readSharedSnapshot((await this.json(`/${id}`)).snapshot);
  }
  async remove(id: string, token: string) {
    if (!SHARE_ID.test(id) || !DELETE_TOKEN.test(token))
      throw new Error("Invalid deletion token.");
    await this.json(`/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
  }
}
