import type { LocalClientFiles } from "./local-client-files";
import { decodeLocalIcon } from "./local-icons";

const resources = [
  [
    "/game-ui/class-icons.png",
    "Interface/GLUES/CHARACTERCREATE/UI-CHARACTERCREATE-CLASSES.blp",
  ],
  [
    "/game-ui/raid-icons.png",
    "Interface/TargetingFrame/UI-RaidTargetingIcons.blp",
  ],
] as const;

export type LocalUiArt = ReadonlyMap<string, string>;
export type LocalUiArtPorts = {
  font(bytes: Uint8Array): FontFace;
  addFont(face: FontFace): void;
  removeFont(face: FontFace): void;
  decode(bytes: Uint8Array): Promise<Blob>;
  create(blob: Blob): string;
  revoke(url: string): void;
  raidAtlas(url?: string): void;
};
const browserPorts: LocalUiArtPorts = {
  font: (bytes) => new FontFace("Friz", new Uint8Array(bytes)),
  addFont: (face) => document.fonts.add(face),
  removeFont: (face) => void document.fonts.delete(face),
  decode: decodeLocalIcon,
  create: (blob) => URL.createObjectURL(blob),
  revoke: (url) => URL.revokeObjectURL(url),
  raidAtlas: (url) => {
    if (url)
      document.documentElement.style.setProperty(
        "--local-raid-icon-atlas",
        `url("${url}")`,
      );
    else
      document.documentElement.style.removeProperty("--local-raid-icon-atlas");
  },
};
let generation = 0;
let current: { aliases: LocalUiArt; release(): void } | undefined;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

export const getLocalUiArt = () => current?.aliases;
export const subscribeLocalUiArt = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

// Original editor keys and styles stay fixed; selected-client bytes supply their images.
export async function installLocalUiArt(
  files: Pick<LocalClientFiles, "readSync">,
  ports: LocalUiArtPorts = browserPorts,
): Promise<() => void> {
  const ownGeneration = ++generation;
  const face = ports.font(files.readSync("Fonts/FRIZQT__.TTF"));
  await face.load();
  if (ownGeneration !== generation) return () => {};
  const blobs = await Promise.all(
    resources.map(([, resource]) => ports.decode(files.readSync(resource))),
  );
  if (ownGeneration !== generation) return () => {};
  const aliases = new Map<string, string>();
  let addedFont = false;
  let released = false;
  const instance = {
    aliases,
    release() {
      if (released) return;
      released = true;
      if (current === instance) {
        current = undefined;
        ports.raidAtlas();
        notify();
      }
      if (addedFont) ports.removeFont(face);
      for (const url of aliases.values()) ports.revoke(url);
    },
  };
  try {
    resources.forEach(([alias], index) =>
      aliases.set(alias, ports.create(blobs[index])),
    );
    ports.addFont(face);
    addedFont = true;
    const previous = current;
    current = instance;
    ports.raidAtlas(aliases.get("/game-ui/raid-icons.png"));
    notify();
    previous?.release();
    return instance.release;
  } catch (error) {
    instance.release();
    throw error;
  }
}
