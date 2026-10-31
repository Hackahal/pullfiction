#!/usr/bin/env python3
"""Package only application converter code and pinned community format definitions."""
import hashlib
import json
from pathlib import Path
import shutil
import sys


def converter_files(root: Path) -> list[str]:
    files = [f'scripts/classic_{name}.py' for name in ('compat', 'db2', 'items', 'spells', 'spell_presentations', 'characters', 'character_catalog', 'creatures', 'terrain', 'world', 'world_catalog', 'table_strings', 'lighting', 'sections', 'talents')]
    files += [str(p.relative_to(root)) for p in sorted((root/'third_party/wowdbdefs').iterdir()) if p.suffix in ('.dbd','.dbde') or p.name in ('SOURCE.md','LICENSE.md')]
    files += ['third_party/wowexport/LICENSE', 'third_party/wowexport/SOURCE.md']
    files += ['third_party/whiteoutflakes/LICENSE', 'third_party/whiteoutflakes/SOURCE.md']
    files += ['third_party/noclip/LICENSE', 'third_party/noclip/SOURCE.md']
    return files


def main(output: Path):
    root = Path(__file__).resolve().parent.parent
    runtime = root / 'tools/release/node_modules/pyodide'
    package = json.loads((runtime / 'package.json').read_text())
    if package['version'] != '314.0.7':
        raise SystemExit('Install the pinned release tools: npm ci --prefix tools/release')
    files = converter_files(root)
    for name in files:
        path = output / 'converter' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root/name, path)
    (output/'converter-files.json').write_text(json.dumps(files))
    revision = hashlib.sha256(b''.join((root/name).read_bytes() for name in files)).hexdigest()[:24]
    (output/'revision.mjs').write_text(f'export const CONVERTER_REVISION = "modern-{revision}";\n')
    (output/'python').mkdir(exist_ok=True)
    for name in ('pyodide.mjs','pyodide.asm.mjs','pyodide.asm.wasm','python_stdlib.zip','pyodide-lock.json'):
        shutil.copyfile(runtime/name,output/'python'/name)
    for path in (root/'third_party/browser-converter').iterdir():
        if path.suffix in ('.md', '.txt'):
            shutil.copyfile(path, output/'python'/path.name)
    print(f'Packaged {len(files)} converter/format source files; revision {revision}. No client assets.')


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve())
