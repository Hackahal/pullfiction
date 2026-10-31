import type { CatalogKind, ModernCatalog } from "./browser-assets";

export type AssetTask =
  | { method: "catalog"; args: [CatalogKind] }
  | { method: "map"; args: [number, string] }
  | { method: "read" | "model" | "world"; args: [string] };
export const PREFETCH_CATALOGS: CatalogKind[] = [
  "world",
  "creatures",
  "items",
  "spells",
  "characters",
  "lighting",
  "talents",
];

function resource(name: string): AssetTask {
  name = name.replaceAll("\\", "/").toLowerCase();
  const method = /\.(wdt|adt|wmo)$/.test(name)
    ? "world"
    : /\.(m2|mdx)$/.test(name)
      ? "model"
      : "read";
  const alias = /^__classic\/([1-9]\d*)\.(?:m2|blp)$/.exec(name);
  return { method, args: [alias ? `id:${alias[1]}` : name] };
}

/** Only file identifiers are collected, never record IDs or appearance permutations. */
export function catalogAssets(
  kind: CatalogKind,
  catalog: ModernCatalog,
): AssetTask[] {
  const tasks: AssetTask[] = [];
  const add = (id: unknown, model = false) => {
    if (Number.isInteger(id) && Number(id) > 0)
      tasks.push({ method: model ? "model" : "read", args: [`id:${id}`] });
  };
  if (kind === "creatures") {
    for (const row of Object.values<any>(catalog.models ?? {})) {
      add(row.fileDataID, true);
      if (typeof row.pathAlias === "string")
        tasks.push(resource(row.pathAlias));
    }
    for (const row of Object.values<any>(catalog.displays ?? {}))
      for (const id of row.textures ?? []) add(id);
    for (const row of Object.values<any>(catalog.extras ?? {}))
      add(row.bakeFileDataID);
  } else if (kind === "spells") {
    for (const row of Object.values<any>(catalog.effects ?? {}))
      add(row.fileDataID, true);
    for (const row of Object.values<any>(catalog.spells ?? {}))
      add(row.iconFile);
  } else if (kind === "talents") {
    for (const tree of catalog.trees ?? [])
      if (typeof tree.icon === "string" && tree.icon)
        tasks.push(resource(tree.icon));
  } else if (kind === "lighting") {
    for (const row of catalog.skyboxes ?? [])
      if (typeof row.path === "string" && row.path)
        tasks.push(resource(row.path));
  } else if (kind === "items") {
    for (const row of Object.values<any>(catalog.items ?? {}))
      add(row.iconFile);
    for (const row of Object.values<any>(catalog.displays ?? {})) {
      for (const group of row.models ?? [])
        for (const part of group) add(part.file, true);
      for (const group of [
        ...(row.textures ?? []),
        ...Object.values<any>(row.regions ?? {}),
      ])
        for (const part of group) add(part.file);
    }
  }
  return tasks;
}

/** Discover original-format references after conversion, while retaining no source buffers. */
export function assetDependencies(task: AssetTask, value: any): AssetTask[] {
  if (task.method === "map")
    return (value.tiles ?? []).map((tile: any) => resource(tile.resource));
  if (task.method !== "model" && task.method !== "world") return [];
  if (!(value.bytes instanceof ArrayBuffer)) return [];
  const bytes = new Uint8Array(value.bytes),
    view = new DataView(value.bytes);
  const tasks: AssetTask[] = [];
  // Converted M2, ADT and WMO string blocks contain null-terminated resource paths.
  const strings = new TextDecoder("latin1").decode(bytes);
  for (const match of strings.matchAll(
    /(?:^|(?<=\0))((?:[a-z0-9_ -]+[\\/])+[a-z0-9_. -]+\.(?:blp|m2|mdx|wmo))(?=\0)/gi,
  ))
    tasks.push(resource(match[1]));
  if (task.method !== "world") return tasks;
  const name = task.args[0];
  // World chunk tags are stored in reverse byte order.
  for (let offset = 0; offset + 8 <= bytes.length;) {
    const tag = String.fromCharCode(...bytes.subarray(offset, offset + 4))
      .split("")
      .reverse()
      .join("");
    const size = view.getUint32(offset + 4, true),
      start = offset + 8;
    if (size > bytes.length - start) break;
    if (tag === "MAIN" && /\.wdt$/i.test(name) && size === 64 * 64 * 8) {
      for (let y = 0; y < 64; y++)
        for (let x = 0; x < 64; x++)
          if (view.getUint32(start + (y * 64 + x) * 8, true) & 1)
            tasks.push(resource(name.replace(/\.wdt$/i, `_${x}_${y}.adt`)));
    }
    if (tag === "MOHD" && /\.wmo$/i.test(name) && size >= 8) {
      const count = view.getUint32(start + 4, true);
      if (count > 2048) throw new Error("Invalid WMO group count");
      for (let group = 0; group < count; group++)
        tasks.push(
          resource(
            name.replace(/\.wmo$/i, `_${String(group).padStart(3, "0")}.wmo`),
          ),
        );
    }
    offset = start + size;
  }
  return tasks;
}
