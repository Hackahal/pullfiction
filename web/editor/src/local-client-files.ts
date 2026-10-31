// The original client has both synchronous Chain readers and asynchronous Bevy readers.
// Preparation fills this cache before synchronous consumers run; a cache miss is never 404.
export interface LocalFileSource {
  read(name: string): Promise<Uint8Array>;
}

export class LocalFileNotReady extends Error {
  override name = "InvalidStateError";
  constructor(resource: string) {
    super(`Local client resource needs preparation: ${resource}`);
  }
}

export class LocalFileMissing extends Error {
  override name = "NotFoundError";
  constructor(resource: string) {
    super(`File not in local client: ${resource}`);
  }
}

export function localFileKey(name: string): string {
  if (
    typeof name !== "string" ||
    !name ||
    name.length > 1024 ||
    /[\0?#:]/.test(name)
  )
    throw new Error("Invalid local client resource name");
  const key = name.replaceAll("\\", "/").toLowerCase();
  if (key.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("Invalid local client resource name");
  return key;
}

export class LocalClientFiles {
  private readonly bytes = new Map<string, Uint8Array>();
  private readonly missing = new Set<string>();
  private readonly pending = new Map<string, Promise<Uint8Array>>();
  private readonly unprepared = new Set<string>();
  private closed = false;
  private size = 0;

  constructor(
    private readonly source: LocalFileSource,
    readonly identity: string,
    private readonly maxBytes = 256 * 1024 * 1024,
  ) {
    if (!identity || !Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new Error("Invalid local client cache configuration");
  }

  private assertOpen() {
    if (this.closed) throw new Error("Local client files are closed");
  }

  get preparedBytes() {
    return this.size;
  }

  // Diagnostic inventory is deliberately separate from a complete archive list.
  get preparationMisses() {
    return [...this.unprepared];
  }

  readSync(name: string): Uint8Array {
    this.assertOpen();
    const key = localFileKey(name);
    const bytes = this.bytes.get(key);
    if (bytes) return bytes.slice();
    if (this.missing.has(key)) throw new LocalFileMissing(name);
    this.unprepared.add(key);
    throw new LocalFileNotReady(name);
  }

  containsSync(name: string): boolean {
    this.assertOpen();
    const key = localFileKey(name);
    if (this.bytes.has(key)) return true;
    if (this.missing.has(key)) return false;
    this.unprepared.add(key);
    throw new LocalFileNotReady(name);
  }

  // The selected-resource cache cannot impersonate the client's complete name index.
  listSync(): string[] {
    this.assertOpen();
    throw new Error("A complete local client name index has not been prepared");
  }

  async read(name: string): Promise<Uint8Array> {
    this.assertOpen();
    const key = localFileKey(name);
    const prepared = this.bytes.get(key);
    if (prepared) return prepared.slice();
    if (this.missing.has(key)) throw new LocalFileMissing(name);
    const bytes = await this.load(name, key);
    this.assertOpen();
    const existing = this.bytes.get(key);
    if (existing) return existing.slice();
    if (bytes.byteLength > this.maxBytes - this.size)
      throw new Error("Local client preparation exceeds its memory budget");
    const copy = bytes.slice();
    this.bytes.set(key, copy);
    this.size += copy.byteLength;
    this.unprepared.delete(key);
    return copy.slice();
  }

  // Bevy owns the decoded asset after an async load. Retaining every source buffer here
  // duplicates that ownership and eventually exhausts the synchronous preparation budget.
  async readStreaming(name: string): Promise<Uint8Array> {
    this.assertOpen();
    const key = localFileKey(name),
      prepared = this.bytes.get(key);
    if (prepared) return prepared.slice();
    if (this.missing.has(key)) throw new LocalFileMissing(name);
    const bytes = await this.load(name, key);
    this.assertOpen();
    return bytes.slice();
  }

  private load(name: string, key: string): Promise<Uint8Array> {
    let request = this.pending.get(key);
    if (!request) {
      request = Promise.resolve().then(async () => {
        try {
          const bytes = await this.source.read(key);
          this.assertOpen();
          if (!(bytes instanceof Uint8Array))
            throw new Error(`Invalid local client bytes: ${name}`);
          return bytes;
        } catch (error) {
          // Incomplete downloads, conversion errors and cancellation are retryable failures.
          if (
            !this.closed &&
            error instanceof Error &&
            error.name === "NotFoundError"
          ) {
            this.missing.add(key);
            this.unprepared.delete(key);
          }
          throw error;
        } finally {
          this.pending.delete(key);
        }
      });
      this.pending.set(key, request);
    }
    return request;
  }

  async prepare(names: readonly string[], signal?: AbortSignal): Promise<void> {
    for (const name of names) {
      signal?.throwIfAborted();
      await this.read(name);
    }
    signal?.throwIfAborted();
  }

  close() {
    this.closed = true;
    this.bytes.clear();
    this.missing.clear();
    this.unprepared.clear();
    this.size = 0;
  }
}

type LocalFileGlobal = typeof globalThis & {
  __pullfiction_local_files?: LocalClientFiles;
};

export function installLocalClientFiles(files: LocalClientFiles): () => void {
  const target = globalThis as LocalFileGlobal;
  if (target.__pullfiction_local_files)
    throw new Error("A local client file provider is already installed");
  target.__pullfiction_local_files = files;
  return () => {
    if (target.__pullfiction_local_files === files)
      delete target.__pullfiction_local_files;
    files.close();
  };
}
