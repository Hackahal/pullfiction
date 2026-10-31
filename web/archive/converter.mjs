export function validateConverterManifest(manifest) {
  if (
    !Array.isArray(manifest) ||
    manifest.some(
      (path) =>
        !/^(?:scripts\/classic_(?:compat|db2|items|spells|spell_presentations|characters|character_catalog|creatures|terrain|world|world_catalog|table_strings|lighting|sections|talents)\.py|third_party\/(?:wowdbdefs|wowexport|whiteoutflakes|noclip)\/[A-Za-z0-9_.-]+)$/.test(
          path,
        ),
    )
  )
    throw new Error("Invalid converter file manifest");
}

// Reuse the verified pure Python format adapters inside the browser worker.
// The interpreter and adapters are application code. Client bytes stay in memory/local cache.
export async function modernConverter(
  read,
  onProgress = () => {},
  readRange = null,
) {
  onProgress({ stage: "converter" });
  const { loadPyodide } = await import("./python/pyodide.mjs");
  const pythonURL = new URL("./python/", import.meta.url);
  const py = await loadPyodide({
    // Pyodide's native Node loader expects a filesystem directory, while the
    // browser worker uses a URL. The format adapters below are shared unchanged.
    indexURL:
      pythonURL.protocol === "file:"
        ? decodeURIComponent(pythonURL.pathname)
        : pythonURL.href,
    enableRunUntilComplete: false,
  });
  const manifest = await (
    await fetch(new URL("./converter-files.json", import.meta.url))
  ).json();
  validateConverterManifest(manifest);
  for (const path of manifest) {
    const response = await fetch(
      new URL(`./converter/${path}`, import.meta.url),
    );
    if (!response.ok) throw new Error("Converter code is unavailable");
    py.FS.mkdirTree(`/app/${path.slice(0, path.lastIndexOf("/"))}`);
    py.FS.writeFile(`/app/${path}`, await response.text());
  }
  py.registerJsModule("pullfiction_archive", { read, readRange });
  py.runPython(`
import sys, json, struct, hashlib
sys.path.insert(0, '/app/scripts')
from pullfiction_archive import read as _read_js, readRange as _range_js
from classic_sections import readable_table, EncryptedSectionError
from classic_table_strings import named_table
from classic_compat import adapt_model, CompatError, UnsupportedFeatureError, read, span
from classic_creatures import creature_catalog
from classic_spells import spell_catalog
from classic_items import item_catalog
from classic_characters import Characters
from classic_world import World
from classic_world_catalog import world_catalog
from classic_lighting import lighting_catalog
from classic_character_catalog import character_catalog
from classic_talents import talent_catalog

def local_read(name):
    return bytes(_read_js(name).to_py())

def prepare_model(name):
    data = local_read(name)
    parts, cursor = {}, 0
    while cursor < len(data):
        tag, size = read(data, '<4sI', cursor)
        if tag in parts:
            raise CompatError('Duplicate modern model chunk')
        parts[tag] = span(data, cursor + 8, size)
        cursor += 8 + size
    if b'MD21' not in parts:
        raise CompatError('Expected an official modern MD21 model')
    ids = parts.get(b'SFID', b'')
    if len(ids) < 4:
        raise CompatError('Modern model has no skin profile')
    # The viewer uses the first skin profile. Do not prepare unused LOD profiles.
    skin = local_read('id:' + str(read(ids, '<I', 0)[0]))
    try:
        return adapt_model(data, [skin])
    except UnsupportedFeatureError as error:
        return str(error)

_TABLE_IDS = {'Map': 1349477, 'AreaTable': 1353545,
    'WMOAreaTable': 1355528, 'CreatureDisplayInfo': 1108759,
    'CreatureModelData': 1365368, 'ChrRaces': 1305311,
    'SpellName': 1990283, 'Item': 841626,
    'ChrCustomizationConversion': 3463337,
    'WMOMinimapTexture': 1323241, 'LiquidType': 1371380,
    'Talent': 1369062, 'TalentTab': 2178102, 'ChrClasses': 1361031}

def world_read(name):
    table = {('dbfilesclient/' + table.lower() + '.db2'): file_id
             for table, file_id in _TABLE_IDS.items()}.get(name.lower())
    return local_read('id:' + str(table) if table else name)

def inspect_table(name):
    if name not in _TABLE_IDS:
        raise ValueError('Unsupported client table')
    def at(offset, size):
        value = _range_js('id:' + str(_TABLE_IDS[name]), offset, size)
        if value is False:
            raise EncryptedSectionError('Local section key unavailable')
        return bytes(value.to_py())
    data, coverage = readable_table(at, name)
    rows, layout = named_table(data, name)
    if name == 'Map':
        _world.set_maps(list(rows.values()))
        _world.raw = world_read
    return {'fileDataID': _TABLE_IDS[name], 'layout': layout, 'sha256': hashlib.sha256(data).hexdigest(),
            'coverage': coverage, 'rows': list(rows.values())}

_source = None
_characters = None
_world = World(local_read)
`);
  return {
    table(name) {
      if (typeof readRange !== "function")
        throw new Error("Range reader unavailable");
      py.globals.set("_table_name", name);
      return JSON.parse(
        py.runPython(
          "json.dumps(inspect_table(_table_name), separators=(',', ':'), allow_nan=False)",
        ),
      );
    },
    world(resource) {
      py.globals.set("_resource", resource);
      const output = py.runPython("_world.resource(_resource)");
      try {
        return Uint8Array.from(output.toJs());
      } finally {
        output.destroy();
      }
    },
    map(mapId, directory) {
      py.globals.set("_map_json", JSON.stringify({ mapId, directory }));
      return JSON.parse(
        py.runPython(`
_map_request = json.loads(_map_json)
json.dumps(_world.map(_map_request['mapId'], _map_request['directory']), separators=(',', ':'), allow_nan=False)
`),
      );
    },
    appearance(request, build) {
      py.globals.set("_source_json", JSON.stringify(build));
      py.globals.set("_appearance_json", JSON.stringify(request));
      return JSON.parse(
        py.runPython(`
if _characters is None:
    _characters = Characters(local_read, json.loads(_source_json))
json.dumps(_characters.appearance(json.loads(_appearance_json)), separators=(',', ':'))
`),
      );
    },
    model(resource) {
      py.globals.set("_resource", resource);
      const output = py.runPython("prepare_model(_resource)");
      if (typeof output === "string") {
        const error = new Error(output);
        error.name = "ClientUnsupportedError";
        throw error;
      }
      try {
        return Uint8Array.from(output.toJs());
      } finally {
        output.destroy();
      }
    },
    catalog(kind, build) {
      py.globals.set("_source_json", JSON.stringify(build));
      const expression = {
        creatures: "creature_catalog(local_read, json.loads(_source_json))",
        spells: "spell_catalog(local_read, json.loads(_source_json))",
        items: "item_catalog(local_read, json.loads(_source_json))",
        world: "world_catalog(local_read, json.loads(_source_json))",
        lighting: "lighting_catalog(local_read, json.loads(_source_json))",
        characters: "character_catalog(local_read, json.loads(_source_json))",
        talents:
          "talent_catalog(local_read, json.loads(_source_json), inspect_table)",
      }[kind];
      if (!expression) throw new Error("Unknown modern catalog");
      return JSON.parse(
        py.runPython(`json.dumps(${expression}, separators=(',', ':'))`),
      );
    },
  };
}
