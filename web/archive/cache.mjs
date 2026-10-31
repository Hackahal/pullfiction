import { cacheIdentity, resourceName } from "./policy.mjs";

const MAX_ENTRY = 128 * 1024 * 1024;
const MAX_SESSION_WRITE = 512 * 1024 * 1024;

export async function cachedAsset(cache, resource, prepare) {
  let bytes;
  try {
    bytes = await cache?.get(resource);
  } catch {
    bytes = null;
  }
  if (bytes) return { bytes, cached: true };
  bytes = await prepare();
  try {
    await cache?.put(resource, bytes);
  } catch {}
  return { bytes, cached: false };
}

export async function assetCache(
  build,
  converter,
  storage = navigator.storage,
) {
  if (!storage?.getDirectory) return null;
  const root = await storage.getDirectory();
  const parent = await root.getDirectoryHandle("pullfiction-assets", {
    create: true,
  });
  const directory = await parent.getDirectoryHandle(
    cacheIdentity(build, converter),
    { create: true },
  );
  let written = 0;
  async function key(resource) {
    const normalized = resourceName(resource).key;
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(normalized),
    );
    return Array.from(new Uint8Array(hash), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  }
  return {
    async get(resource) {
      try {
        const file = await (
          await directory.getFileHandle(await key(resource))
        ).getFile();
        if (file.size < 36 || file.size > MAX_ENTRY + 36) return null;
        const entry = new Uint8Array(await file.arrayBuffer());
        if (new TextDecoder().decode(entry.subarray(0, 4)) !== "PFC1")
          return null;
        const bytes = entry.slice(36),
          hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        if (!hash.every((value, i) => value === entry[i + 4])) return null;
        return bytes;
      } catch (error) {
        if (error?.name === "NotFoundError") return null;
        throw error;
      }
    },
    async put(resource, bytes) {
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength > MAX_ENTRY ||
        written + bytes.byteLength > MAX_SESSION_WRITE
      )
        return false;
      const name = await key(resource);
      const temporary = `${name}.pending`;
      let writable;
      try {
        const handle = await directory.getFileHandle(temporary, {
          create: true,
        });
        writable = await handle.createWritable();
        const entry = new Uint8Array(bytes.byteLength + 36);
        entry.set(new TextEncoder().encode("PFC1"));
        entry.set(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          4,
        );
        entry.set(bytes, 36);
        await writable.write(entry);
        await writable.close();
        writable = undefined;
        // Move is atomic within the origin-private filesystem. No incomplete entry
        // becomes a cache hit when the tab closes or storage is exhausted.
        await handle.move(name);
        written += bytes.byteLength;
        return true;
      } catch (error) {
        if (writable) await writable.abort().catch(() => {});
        await directory.removeEntry(temporary).catch(() => {});
        if (
          error?.name === "QuotaExceededError" ||
          error?.name === "NotSupportedError" ||
          error instanceof TypeError
        )
          return false;
        throw error;
      }
    },
    async clear() {
      for await (const [name] of directory.entries())
        await directory.removeEntry(name, { recursive: true });
      written = 0;
    },
  };
}
