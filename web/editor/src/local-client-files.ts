// The original client has both synchronous Chain readers and asynchronous Bevy readers.
// Preparation fills this cache before synchronous consumers run; a cache miss is never 404.
export interface LocalFileSource {
  read(name: string, signal?: AbortSignal): Promise<Uint8Array>;
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
  private readonly pending = new Map<
    string,
    { promise: Promise<Uint8Array>; abort: AbortController; users: number }
  >();
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

  async read(name: string, signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted();
    this.assertOpen();
    const key = localFileKey(name);
    const prepared = this.bytes.get(key);
    if (prepared) return prepared.slice();
    if (this.missing.has(key)) throw new LocalFileMissing(name);
    const bytes = await this.load(name, key, signal);
    signal?.throwIfAborted();
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
  async readStreaming(name: string, signal?: AbortSignal): Promise<Uint8Array> {
    signal?.throwIfAborted();
    this.assertOpen();
    const key = localFileKey(name),
      prepared = this.bytes.get(key);
    if (prepared) return prepared.slice();
    if (this.missing.has(key)) throw new LocalFileMissing(name);
    const bytes = await this.load(name, key, signal);
    signal?.throwIfAborted();
    this.assertOpen();
    return bytes.slice();
  }

  private load(
    name: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    signal?.throwIfAborted();
    let request = this.pending.get(key);
    if (!request) {
      const abort = new AbortController();
      const job = { abort, users: 0, promise: null! as Promise<Uint8Array> };
      job.promise = Promise.resolve().then(async () => {
        try {
          this.assertOpen();
          abort.signal.throwIfAborted();
          const bytes = await this.source.read(key, abort.signal);
          this.assertOpen();
          abort.signal.throwIfAborted();
          if (!(bytes instanceof Uint8Array))
            throw new Error(`Invalid local client bytes: ${name}`);
          return bytes;
        } catch (error) {
          if (
            !this.closed &&
            !abort.signal.aborted &&
            error instanceof Error &&
            error.name === "NotFoundError"
          ) {
            this.missing.add(key);
            this.unprepared.delete(key);
          }
          throw error;
        } finally {
          if (this.pending.get(key) === job) this.pending.delete(key);
        }
      });
      request = job;
      this.pending.set(key, job);
    }
    const job = request;
    job.users++;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = () => {
        if (done) return false;
        done = true;
        signal?.removeEventListener("abort", cancel);
        job.abort.signal.removeEventListener("abort", sourceCancelled);
        if (--job.users === 0 && this.pending.get(key) === job) {
          this.pending.delete(key);
          job.abort.abort();
        }
        return true;
      };
      const cancel = () => {
        if (finish()) reject(signal!.reason);
      };
      const sourceCancelled = () => {
        if (finish())
          reject(
            this.closed
              ? new Error("Local client files are closed")
              : job.abort.signal.reason,
          );
      };
      signal?.addEventListener("abort", cancel, { once: true });
      job.abort.signal.addEventListener("abort", sourceCancelled, {
        once: true,
      });
      job.promise.then(
        (bytes) => {
          if (finish()) resolve(bytes);
        },
        (error) => {
          if (finish()) reject(error);
        },
      );
    });
  }

  async prepare(names: readonly string[], signal?: AbortSignal): Promise<void> {
    for (const name of names) {
      signal?.throwIfAborted();
      await this.read(name, signal);
    }
    signal?.throwIfAborted();
  }

  close() {
    this.closed = true;
    for (const job of this.pending.values()) job.abort.abort();
    this.pending.clear();
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
