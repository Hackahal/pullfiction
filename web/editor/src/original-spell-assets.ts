import type { BrowserAssetBridge } from "./browser-assets";
import { localFileKey, type LocalClientFiles } from "./local-client-files";
import { prepareOriginalUnits } from "./original-client-assets";

/** Dependencies from the adapted MD20 input consumed by the production loader. */
export function preparedModelDependencies(bytes: Uint8Array) {
  if (
    bytes.length < 0x144 ||
    new TextDecoder().decode(bytes.subarray(0, 4)) !== "MD20"
  )
    throw new Error("Spell preparation needs an adapted MD20 model");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== 256)
    throw new Error(
      "Spell preparation needs an adapted MD20 version 256 model",
    );
  const array = (field: number, stride: number, max: number) => {
    const count = view.getUint32(field, true),
      offset = view.getUint32(field + 4, true);
    if (
      count > max ||
      offset > bytes.length ||
      count * stride > bytes.length - offset
    )
      throw new Error("Invalid prepared model dependency array");
    return Array.from({ length: count }, (_, i) => offset + i * stride);
  };
  const name = (field: number) => {
    const count = view.getUint32(field, true),
      offset = view.getUint32(field + 4, true);
    if (!count) return null;
    if (count > 1024 || offset > bytes.length || count > bytes.length - offset)
      throw new Error("Invalid prepared model dependency name");
    return (
      new TextDecoder("utf-8", { fatal: true })
        .decode(bytes.subarray(offset, offset + count))
        .replace(/\0+$/, "") || null
    );
  };
  const textures = new Set<string>(),
    models = new Set<string>();
  for (const at of array(0x5c, 16, 4096)) {
    if (view.getUint32(at, true) === 0) {
      const path = name(at + 8);
      if (path) textures.add(localFileKey(path));
    }
  }
  for (const at of array(0x13c, 504, 256)) {
    for (const field of [at + 24, at + 32]) {
      const path = name(field);
      if (path) models.add(localFileKey(path));
    }
  }
  return { textures: [...textures], models: [...models] };
}

/** Static WMO spell hosts reuse the world loader and its base-group naming convention. */
export function preparedWmoDependencies(bytes: Uint8Array, path: string) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = new Map<string, Uint8Array>();
  for (let at = 0; at < bytes.length;) {
    if (at + 8 > bytes.length || chunks.size >= 4096)
      throw new Error("Invalid prepared WMO chunk header");
    const tag = new TextDecoder()
      .decode(bytes.subarray(at, at + 4))
      .split("")
      .reverse()
      .join("");
    const size = view.getUint32(at + 4, true);
    if (size > bytes.length - at - 8 || chunks.has(tag))
      throw new Error("Invalid prepared WMO chunk range");
    chunks.set(tag, bytes.subarray(at + 8, at + 8 + size));
    at += 8 + size;
  }
  const version = chunks.get("MVER");
  if (
    !version ||
    version.length !== 4 ||
    new DataView(version.buffer, version.byteOffset, 4).getUint32(0, true) !==
      17
  )
    throw new Error("Spell preparation needs an adapted WMO version17");
  const root = chunks.get("MOHD");
  if (!root) {
    if (!chunks.has("MOGP"))
      throw new Error("Prepared WMO has no root or group");
    return { textures: [] as string[], models: [] as string[] };
  }
  if (root.length !== 64) throw new Error("Invalid prepared WMO root header");
  // The effect display path supplies static parts. Placed-world child doodads/lights have
  // their own owning systems and are not silently credited to this consumer.
  if ((chunks.get("MODD")?.length ?? 0) || (chunks.get("MOLT")?.length ?? 0))
    throw new Error(
      "WMO spell-host child doodads or lights need their owning world context",
    );
  const count = new DataView(
    root.buffer,
    root.byteOffset,
    root.byteLength,
  ).getUint32(4, true);
  if (count > 2048 || !/\.wmo$/i.test(path))
    throw new Error("Invalid prepared WMO group count or path");
  const materials = chunks.get("MOMT") ?? new Uint8Array();
  const names = chunks.get("MOTX") ?? new Uint8Array();
  if (materials.length % 64) throw new Error("Invalid prepared WMO materials");
  const materialView = new DataView(
    materials.buffer,
    materials.byteOffset,
    materials.byteLength,
  );
  const textures = new Set<string>();
  for (let at = 0; at < materials.length; at += 64) {
    for (const field of [12, 24, 36]) {
      const start = materialView.getUint32(at + field, true);
      if (start >= names.length)
        throw new Error("Invalid prepared WMO texture name");
      const end = names.indexOf(0, start);
      if (end < start || end - start > 1024)
        throw new Error("Invalid prepared WMO texture name");
      const name = new TextDecoder("utf-8", { fatal: true }).decode(
        names.subarray(start, end),
      );
      if (name) textures.add(localFileKey(name));
    }
  }
  return {
    textures: [...textures],
    models: Array.from({ length: count }, (_, i) =>
      path.replace(/\.wmo$/i, `_${String(i).padStart(3, "0")}.wmo`),
    ),
  };
}

/** Prepare a selected spell closure, including explicitly mapped presentation hosts. */
export async function prepareOriginalSpellEffects(
  files: LocalClientFiles,
  bridge: BrowserAssetBridge,
  spellIds: readonly number[],
  signal?: AbortSignal,
): Promise<void> {
  if (!spellIds.length) return;
  const graph = await bridge.catalog("spells");
  const spells = new Set(spellIds),
    models = new Set<string>(),
    textures = new Set<string>();
  const displays = new Set<number>();
  const file = (id: unknown, extension: "m2" | "blp" | "wmo") =>
    typeof id === "number" && Number.isSafeInteger(id) && id > 0
      ? `__classic/${id}.${extension}`
      : null;
  const model = (effect: unknown) => {
    const row = graph.effects?.[String(effect)];
    if (
      row?.type === 0 &&
      row.fileDataID &&
      row.assetFormat !== undefined &&
      row.assetFormat !== "m2" &&
      row.assetFormat !== "wmo"
    )
      throw new Error(
        "Spell model format is unavailable in the selected client",
      );
    const path =
      row?.type === 0
        ? file(row.fileDataID, row.assetFormat === "wmo" ? "wmo" : "m2")
        : null;
    if (path) models.add(path);
  };
  for (const spellId of spells) {
    signal?.throwIfAborted();
    if (spells.size > 256)
      throw new Error("Spell dependency closure exceeds 256 spells");
    const spell = graph.spells?.[spellId];
    if (!spell) continue;
    const cue = spell.summonCue;
    if (cue) {
      if (!graph.spells?.[cue.visualSpellID])
        throw new Error(
          "Presentation cue visual is unavailable in the local graph",
        );
      spells.add(cue.visualSpellID);
      displays.add(cue.displayID);
    }
    for (const choice of spell.visuals ?? []) {
      const visual = graph.visuals?.[choice.id];
      for (const missile of visual?.missiles ?? []) model(missile.effect);
      for (const event of visual?.events ?? []) {
        const kit = graph.kits?.[event.kit];
        for (const attachment of kit?.effects ?? []) model(attachment.effect);
        for (const proc of kit?.proceduralEffects ?? []) {
          if (proc.type !== 0 && proc.type !== 12) continue;
          const chain = graph.chainEffects?.[proc.values?.[0]];
          if (!chain?.rendererCompatible) continue;
          for (const id of chain.textureFileDataIDs ?? []) {
            const path = file(id, "blp");
            if (path) textures.add(path);
          }
        }
      }
    }
  }
  if (displays.size) {
    const creatures = await bridge.catalog("creatures");
    for (const display of displays) {
      const row = creatures.displays?.[display];
      const path = file(creatures.models?.[row?.modelID]?.fileDataID, "m2");
      if (!path)
        throw new Error("Presentation cue host model is unavailable locally");
      models.add(path);
    }
    await prepareOriginalUnits(
      files,
      bridge,
      [...displays].map((display) => ({ player: false, display })),
      [],
      signal,
    );
  }
  for (const path of models) {
    signal?.throwIfAborted();
    if (models.size > 256)
      throw new Error("Spell dependency closure exceeds 256 models");
    await files.prepare([path], signal);
    const dependencies = /\.wmo$/i.test(path)
      ? preparedWmoDependencies(files.readSync(path), path)
      : preparedModelDependencies(files.readSync(path));
    dependencies.textures.forEach((texture) => textures.add(texture));
    dependencies.models.forEach((model) => models.add(model));
  }
  await files.prepare([...textures], signal);
}
