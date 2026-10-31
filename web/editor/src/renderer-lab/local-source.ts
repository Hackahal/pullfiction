import type { ClientReader } from "../browser-assets";

/** Development-only file transport. All scene/rendering code remains in the web client. */
export async function localRendererSource(
  endpoint: string,
  signal: AbortSignal,
): Promise<ClientReader> {
  const url = new URL(endpoint);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.origin !== endpoint
  )
    throw new Error("Renderer source must be an exact loopback HTTP origin");
  const base = url.origin;
  const response = await fetch(`${base}/meta`, { signal });
  if (!response.ok) throw new Error("Local renderer source unavailable");
  const { build } = await response.json();
  async function call(method: string, ...args: unknown[]) {
    const response = await fetch(`${base}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, args }),
      signal,
    });
    if (!response.ok) {
      const failure = await response.json();
      throw Object.assign(new Error(failure.message), { name: failure.name });
    }
    if (["read", "model", "world"].includes(method))
      return { bytes: await response.arrayBuffer() };
    return JSON.parse(await response.text(), (_key, value) => {
      if (
        value &&
        typeof value.rendererBytes === "string" &&
        Object.keys(value).length === 1
      ) {
        const binary = atob(value.rendererBytes);
        return Uint8Array.from(binary, (c) => c.charCodeAt(0)).buffer;
      }
      return value;
    });
  }
  return {
    build,
    read: (resource) => call("read", resource),
    model: (resource) => call("model", resource),
    world: (resource) => call("world", resource),
    catalog: (kind) => call("catalog", kind),
    map: (id, directory) => call("map", id, directory),
    appearance: (request) => call("appearance", request),
    close() {},
  };
}
