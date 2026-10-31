export interface ClientDirectory extends FileSystemDirectoryHandle {
  queryPermission?(options: { mode: "read" }): Promise<PermissionState>;
  requestPermission?(options: { mode: "read" }): Promise<PermissionState>;
}
export type ClientSelection = File[] | ClientDirectory;
export interface ClientFolderAccess {
  supported: boolean;
  load(): Promise<ClientDirectory | null>;
  save(handle: ClientDirectory): Promise<void>;
  forget(): Promise<void>;
  pick(startIn?: ClientDirectory): Promise<ClientDirectory>;
  permission(
    handle: ClientDirectory,
    request?: boolean,
  ): Promise<PermissionState>;
}
/** Saves the browser capability, not a path or copies of game archives. */
export class IndexedClientFolder {
  private db: Promise<IDBDatabase> | null = null;
  constructor(
    private factory: IDBFactory,
    private name = "pullfiction-client-folder-v1",
  ) {}
  private open() {
    if (!this.db)
      this.db = new Promise<IDBDatabase>((resolve, reject) => {
        const request = this.factory.open(this.name, 1);
        let failed = false;
        request.onupgradeneeded = () =>
          request.result.createObjectStore("folders");
        request.onerror = () => {
          failed = true;
          reject(request.error);
        };
        request.onblocked = () => {
          failed = true;
          reject(new Error("Saved client folder storage is blocked"));
        };
        request.onsuccess = () => {
          const db = request.result;
          if (failed) {
            db.close();
            return;
          }
          db.onversionchange = () => {
            db.close();
            this.db = null;
          };
          resolve(db);
        };
      }).catch((error) => {
        this.db = null;
        throw error;
      });
    return this.db;
  }
  private async transaction(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest,
  ) {
    const db = await this.open();
    return new Promise<any>((resolve, reject) => {
      const tx = db.transaction("folders", mode),
        request = action(tx.objectStore("folders"));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () =>
        reject(
          tx.error ??
            request.error ??
            new Error("Saved client folder storage failed"),
        );
    });
  }
  async load(): Promise<ClientDirectory | null> {
    const value = await this.transaction("readonly", (store) =>
      store.get("last"),
    );
    return value?.kind === "directory" && typeof value.name === "string"
      ? value
      : null;
  }
  async save(handle: ClientDirectory) {
    await this.transaction("readwrite", (store) => store.put(handle, "last"));
  }
  async forget() {
    await this.transaction("readwrite", (store) => store.delete("last"));
  }
  async close() {
    const db = this.db;
    this.db = null;
    (await db)?.close();
  }
}
type FolderWindow = typeof globalThis & {
  showDirectoryPicker?: (options: {
    id: string;
    mode: "read";
    startIn?: ClientDirectory;
  }) => Promise<ClientDirectory>;
};
export function createClientFolderAccess(): ClientFolderAccess | null {
  const environment = globalThis as FolderWindow;
  let factory: IDBFactory;
  try {
    if (typeof environment.indexedDB === "undefined") return null;
    factory = environment.indexedDB;
  } catch {
    return null;
  }
  const store = new IndexedClientFolder(factory);
  return {
    supported: typeof environment.showDirectoryPicker === "function",
    load: () => store.load(),
    save: (handle) => store.save(handle),
    forget: () => store.forget(),
    pick(startIn) {
      if (!environment.showDirectoryPicker)
        return Promise.reject(
          new Error("This browser cannot remember folder access"),
        );
      // Call the picker before an await can consume the click's activation.
      return environment.showDirectoryPicker({
        id: "pullfiction-client",
        mode: "read",
        ...(startIn ? { startIn } : {}),
      });
    },
    permission(handle, request = false) {
      // A reconnect must request permission directly from the user's gesture.
      if (request && handle.requestPermission)
        return handle.requestPermission({ mode: "read" });
      return (
        handle.queryPermission?.({ mode: "read" }) ?? Promise.resolve("prompt")
      );
    },
  };
}
