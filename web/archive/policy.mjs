// Only storage metadata and archive files are exposed to the offline reader.
export function archivePath(value) {
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    value.includes("\\") ||
    value.includes("\0")
  )
    throw new Error("Invalid client file path");
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    throw new Error("Invalid client file path");
  return value;
}

export function isStorageFile(value) {
  const path = archivePath(value);
  return (
    path === ".build.info" ||
    /^Data\/(?:config\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{32}|data\/(?:[a-f0-9]{10}\.idx|data\.\d{3}))$/i.test(
      path,
    )
  );
}

export const CLIENT_PROFILES = Object.freeze({
  wow_classic_era: Object.freeze({
    label: "Classic Era/SoD",
    version: /^1\.15\.9\.\d+$/,
  }),
  wowf: Object.freeze({ label: "WoW Forever", version: /^1\.60\.1\.\d+$/ }),
});

export function clientBuild(text, selectedProduct = "wow_classic_era") {
  const profile = CLIENT_PROFILES[selectedProduct];
  if (!Object.hasOwn(CLIENT_PROFILES, selectedProduct))
    throw new Error("Unsupported client product");
  const lines = text
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n/);
  const columns = lines
    .shift()
    ?.split("|")
    .map((s) => s.split("!")[0]);
  const index = (name) => {
    const at = columns?.indexOf(name) ?? -1;
    if (at < 0) throw new Error(`Client metadata is missing ${name}`);
    return at;
  };
  const product = index("Product"),
    active = index("Active"),
    version = index("Version"),
    key = index("Build Key");
  const rows = lines
    .map((line) => line.split("|"))
    .filter((row) => row[active] === "1" && row[product] === selectedProduct);
  if (rows.length !== 1)
    throw new Error(
      `Select a folder containing one active official ${profile.label} installation`,
    );
  const row = rows[0];
  if (!profile.version.test(row[version]))
    throw new Error(`Unsupported client ${row[version]} for ${profile.label}`);
  if (!/^[a-f0-9]{32}$/i.test(row[key]))
    throw new Error("Invalid client build key");
  return {
    product: row[product],
    version: row[version],
    buildKey: row[key].toLowerCase(),
  };
}

export function resourceName(value) {
  if (typeof value !== "string") throw new Error("Invalid resource name");
  const id = /^id:([1-9]\d*)$/.exec(value);
  if (id) {
    const number = Number(id[1]);
    if (Number.isSafeInteger(number) && number < 0xffffffff)
      return { name: "", fileId: number, key: `id:${number}` };
    throw new Error("Invalid resource ID");
  }
  const path = archivePath(value.replaceAll("\\", "/").toLowerCase());
  const virtual = /^__classic\/([1-9]\d*)(?:_(\d{3}))?\.(m2|blp|wmo)$/.exec(
    path,
  );
  if (virtual) {
    const number = Number(virtual[1]);
    if (
      !Number.isSafeInteger(number) ||
      number >= 0xffffffff ||
      (virtual[2] && virtual[3] !== "wmo")
    )
      throw new Error("Invalid virtual resource ID");
    // WMO groups resolve through their root's GFID table in the world adapter.
    return {
      name: virtual[2] ? path.replaceAll("/", "\\") : "",
      fileId: virtual[2] ? 0 : number,
      key: path,
    };
  }
  // The existing native overlay needs its fonts and a few UI textures locally.
  // Decorative world-map artwork and unused stock interface code stay excluded.
  const nativeUi = /^interface\/(?!worldmap\/).+\.blp$/;
  const font = /^fonts\/(?:frizqt__|arialn|morpheus|skurri)\.ttf$/;
  // Native actors, selection rings and spell chains share this texture root.
  // Only requested image resources are read; this does not scan the directory.
  const sharedTexture = /^textures\/.+\.blp$/;
  if (
    !nativeUi.test(path) &&
    !font.test(path) &&
    !sharedTexture.test(path) &&
    !/^(?:dbfilesclient\/[^/]+\.db2|(?:character|creature|item|spells|particles|interface\/icons)\/.+\.(?:m2|skin|skel|anim|blp)|world\/(?:maps|wmo|generic|expansion\d+)\/.+\.(?:wdt|wdl|adt|wmo|m2|blp)|environments\/stars\/.+\.(?:m2|blp)|textures\/(?:suncenter|sunglare|moon|moonglare|moon02)\.blp|(?:tileset|xtextures|textures\/minimap)\/.+\.blp|textures\/minimap\/md5translate\.trs|interface\/targetingframe\/ui-raidtargetingicons\.blp)$/.test(
      path,
    )
  )
    throw new Error("Resource is outside the replay asset scope");
  return { name: path.replaceAll("/", "\\"), fileId: 0, key: path };
}

export function cacheIdentity(build, converter) {
  if (!/^[a-z0-9-]{1,64}$/.test(converter))
    throw new Error("Invalid converter revision");
  if (
    !/^[a-f0-9]{32}$/.test(build.buildKey) ||
    !Object.hasOwn(CLIENT_PROFILES, build.product) ||
    !CLIENT_PROFILES[build.product].version.test(build.version)
  )
    throw new Error("Invalid client build identity");
  return `${build.product}-${build.version}-${build.buildKey}-${converter}`;
}
