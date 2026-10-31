import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import {
  IndexedClientFolder,
  createClientFolderAccess,
  type ClientDirectory,
} from "./client-folder";

test("A remembered directory survives reopening IndexedDB and can be forgotten", async () => {
  const factory = new IDBFactory(),
    first = new IndexedClientFolder(factory);
  // fake-indexeddb cannot clone native browser handles; this cloneable value
  // exercises the real database adapter. Permission/reader tests use handles.
  const directory = {
    kind: "directory",
    name: "World of Warcraft",
  } as ClientDirectory;
  await first.save(directory);
  await first.close();
  const second = new IndexedClientFolder(factory);
  assert.equal((await second.load())?.name, directory.name);
  await second.forget();
  assert.equal(await second.load(), null);
  await second.close();
});
test("The picker and permission request run immediately and request read access only", async (t) => {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const name of ["indexedDB", "showDirectoryPicker"])
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  const calls: any[] = [];
  const handle = {
    kind: "directory",
    name: "WoW",
    queryPermission: (o: any) => {
      calls.push(["query", o]);
      return Promise.resolve("prompt");
    },
    requestPermission: (o: any) => {
      calls.push(["request", o]);
      return Promise.resolve("granted");
    },
  } as unknown as ClientDirectory;
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: new IDBFactory(),
  });
  Object.defineProperty(globalThis, "showDirectoryPicker", {
    configurable: true,
    value: (o: any) => {
      calls.push(["picker", o]);
      return Promise.resolve(handle);
    },
  });
  t.after(() => {
    for (const [name, d] of previous)
      if (d) Object.defineProperty(globalThis, name, d);
      else Reflect.deleteProperty(globalThis, name);
  });
  const access = createClientFolderAccess()!;
  assert.equal(access.supported, true);
  const picking = access.pick(handle);
  assert.deepEqual(calls, [
    ["picker", { id: "pullfiction-client", mode: "read", startIn: handle }],
  ]);
  assert.equal(await picking, handle);
  calls.length = 0;
  const request = access.permission(handle, true);
  assert.deepEqual(calls, [["request", { mode: "read" }]]);
  assert.equal(await request, "granted");
  calls.length = 0;
  assert.equal(await access.permission(handle), "prompt");
  assert.deepEqual(calls, [["query", { mode: "read" }]]);
});
test("Browsers without the picker keep the ordinary folder-input path", (t) => {
  const d = Object.getOwnPropertyDescriptor(globalThis, "showDirectoryPicker");
  Object.defineProperty(globalThis, "showDirectoryPicker", {
    configurable: true,
    value: undefined,
  });
  t.after(() => {
    if (d) Object.defineProperty(globalThis, "showDirectoryPicker", d);
    else Reflect.deleteProperty(globalThis, "showDirectoryPicker");
  });
  assert.equal(createClientFolderAccess()?.supported ?? false, false);
});
