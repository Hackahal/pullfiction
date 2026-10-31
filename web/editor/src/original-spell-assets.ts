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
  const file = (id: unknown, extension: "m2" | "blp") =>
    typeof id === "number" && Number.isSafeInteger(id) && id > 0
      ? `__classic/${id}.${extension}`
      : null;
  const model = (effect: unknown) => {
    const row = graph.effects?.[String(effect)];
    const path = row?.type === 0 ? file(row.fileDataID, "m2") : null;
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
    const dependencies = preparedModelDependencies(files.readSync(path));
    dependencies.textures.forEach((texture) => textures.add(texture));
    dependencies.models.forEach((model) => models.add(model));
  }
  await files.prepare([...textures], signal);
}
