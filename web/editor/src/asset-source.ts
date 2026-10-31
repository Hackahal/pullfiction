// Resolve the immutable asset generation before the native runtime starts.
// A missing endpoint supports an older local host; other failures remain visible.
export async function resolveAssetRoot(
  request: typeof fetch = fetch,
): Promise<string> {
  const response = await request("/data/__source", { cache: "no-store" });
  if (response.status === 404) return "/data";
  if (!response.ok) throw new Error("Local asset source unavailable");
  const source: unknown = await response.json();
  if (
    !source ||
    typeof source !== "object" ||
    !("revision" in source) ||
    !("dataRoot" in source) ||
    typeof source.revision !== "string" ||
    !/^[a-z0-9-]{1,96}$/.test(source.revision) ||
    source.dataRoot !== `/assets/${source.revision}`
  ) {
    throw new Error("Invalid local asset source");
  }
  return source.dataRoot;
}
