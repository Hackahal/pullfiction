#!/usr/bin/env python3
"""Allowlisted browser release packaging and local audit. Does not deploy."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import sys

REPO = Path(__file__).resolve().parent.parent
MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_FILES = 20_000
MAX_VIEWER_BYTES = 256 * 1024 * 1024
EDITOR_ASSET = re.compile(r"assets/[A-Za-z0-9_-]+-[A-Za-z0-9_-]+\.(?:js|css)")
RENDERER_SNIPPET = re.compile(r"snippets/[A-Za-z0-9_-]+/inline[0-9]+\.js")
ARCHIVE_FILES = {
    "CascLib-LICENSE.txt", "cache.mjs", "casc.mjs", "casc.wasm", "client.mjs",
    "converter-files.json", "converter.mjs", "policy.mjs", "revision.mjs", "worker.mjs",
    "pullfiction_asset_codec.js", "pullfiction_asset_codec_bg.wasm",
    "python/pyodide.mjs", "python/pyodide.asm.mjs", "python/pyodide.asm.wasm",
    "python/python_stdlib.zip", "python/pyodide-lock.json", "python/Pyodide-LICENSE.txt",
    "python/Python-LICENSE.txt", "python/SOURCE.md",
}
CONVERTER_SCRIPTS = {f"scripts/classic_{name}.py" for name in ("compat", "db2", "items", "spells", "characters", "character_catalog", "creatures", "terrain", "world", "world_catalog", "table_strings", "lighting", "sections", "talents")}
METADATA_FILES = {
    "metadata/npc-models.json": "third_party/wowhead-npcs/npc-models.json",
    "metadata/Wowhead-SOURCE.md": "third_party/wowhead-npcs/SOURCE.md",
    "metadata/Wowhead-NOTICE.md": "third_party/wowhead-npcs/NOTICE.md",
}
SECRET_PATTERNS = (
    rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    rb"\b(?:WCL_CLIENT_SECRET|WARCRAFTLOGS_CLIENT_SECRET|AWS_SECRET_ACCESS_KEY)\b",
    rb"\bclient_secret[\"']?\s*[:=]\s*[\"'][^\"']+[\"']",
    rb"\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16})\b",
    rb"(?:https?:|wss?:)//(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?=[:/\"'\s]|$)",
    rb"(?:/Users/|/home/)[A-Za-z0-9_.-]+/(?:Projects|Documents|\.codex|\.ssh)/",
)


class PackageError(ValueError):
    pass


def converter_files(repo: Path) -> set[str]:
    # These are format definitions and our code, not extracted tables. Derive
    # the set from the repository instead of trusting a supplied manifest.
    definitions = repo / "third_party/wowdbdefs"
    result = set(CONVERTER_SCRIPTS)
    result.update(f"third_party/wowdbdefs/{p.name}" for p in definitions.iterdir()
                  if p.suffix in (".dbd", ".dbde") or p.name in ("SOURCE.md", "LICENSE.md"))
    result.update(("third_party/wowexport/LICENSE", "third_party/wowexport/SOURCE.md"))
    return result


def regular_file(root: Path, relative: str) -> Path:
    path = root / relative
    if PurePosixPath(relative).is_absolute() or ".." in PurePosixPath(relative).parts:
        raise PackageError(f"Unsafe path: {relative}")
    cursor = path
    while cursor != root.parent:
        if cursor.is_symlink():
            raise PackageError(f"Symlink is forbidden: {relative}")
        if cursor == root:
            break
        cursor = cursor.parent
    if not path.is_file():
        raise PackageError(f"Missing regular file: {relative}")
    return path


def copy_file(source: Path, relative: str, output: Path, target: str | None = None) -> None:
    path = regular_file(source, relative)
    destination = output / (target or relative)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(path, destination)


def validate_manifest(archive: Path, expected: set[str]) -> None:
    try:
        actual = json.loads(regular_file(archive, "converter-files.json").read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise PackageError(f"Invalid converter manifest: {error}") from error
    if not isinstance(actual, list) or any(not isinstance(name, str) for name in actual):
        raise PackageError("Converter manifest must contain only path strings")
    if len(actual) != len(set(actual)) or set(actual) != expected:
        raise PackageError("Converter manifest differs from the approved application source files")


def validate_npc_metadata(path: Path, repo: Path) -> None:
    spec = importlib.util.spec_from_file_location("wowhead_npc_metadata", repo / "scripts/wowhead-npc-metadata.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    try:
        module.validate_index(json.loads(path.read_text()))
    except (module.MetadataError, json.JSONDecodeError) as error:
        raise PackageError(f"Invalid approved NPC metadata: {error}") from error


def editor_files(editor: Path) -> list[str]:
    regular_file(editor, "index.html")
    # Follow the new Vite entry graph. Merely looking for hashed filenames also
    # copies stale JavaScript left in a contaminated input directory.
    try:
        manifest = json.loads(regular_file(editor, ".vite/manifest.json").read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise PackageError(f"Invalid Vite manifest: {error}") from error
    if not isinstance(manifest, dict):
        raise PackageError("Vite manifest must be an object")
    pending = [key for key, value in manifest.items() if isinstance(value, dict) and value.get("isEntry") is True]
    if len(pending) != 1:
        raise PackageError("Expected exactly one Vite application entry")
    selected, visited = {"index.html"}, set()
    while pending:
        key = pending.pop()
        if key in visited:
            continue
        visited.add(key)
        entry = manifest.get(key)
        if not isinstance(entry, dict):
            raise PackageError(f"Invalid Vite chunk: {key}")
        files = [entry.get("file")]
        for field in ("css", "assets"):
            values = entry.get(field, [])
            if not isinstance(values, list):
                raise PackageError(f"Invalid Vite {field} list: {key}")
            files.extend(values)
        for relative in files:
            if not isinstance(relative, str) or not EDITOR_ASSET.fullmatch(relative):
                raise PackageError(f"Unapproved Vite output: {relative}")
            regular_file(editor, relative)
            selected.add(relative)
        for field in ("imports", "dynamicImports"):
            values = entry.get(field, [])
            if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
                raise PackageError(f"Invalid Vite {field} list: {key}")
            pending.extend(values)
    return sorted(selected)


def renderer_snippets(renderer: Path, glue_name: str) -> set[str]:
    glue = regular_file(renderer, glue_name).read_text()
    imports = re.findall(r"^import\s+.+?\s+from\s+['\"]([^'\"]+)['\"];?", glue, re.MULTILINE)
    snippets = set()
    for name in imports:
        if not name.startswith("./") or not RENDERER_SNIPPET.fullmatch(name[2:]):
            raise PackageError(f"Unapproved wasm-bindgen module import: {name}")
        relative = name[2:]
        code = regular_file(renderer, relative).read_text()
        if re.search(r"^\s*(?:import|export\s+.+?\s+from)\b", code, re.MULTILINE) and re.search(r"\bfrom\s*['\"]|\bimport\s*['\"]", code):
            raise PackageError(f"Unexpected nested import in wasm-bindgen snippet: {relative}")
        snippets.add(relative)
    return snippets


def pack(editor: Path, renderer: Path, archive: Path, output: Path, repo: Path = REPO) -> dict:
    if output.exists() or output.is_symlink():
        raise PackageError("Output must not exist. Packaging requires a fresh directory.")
    expected = converter_files(repo)
    validate_manifest(archive, expected)
    output.mkdir(parents=True)
    for relative in editor_files(editor):
        copy_file(editor, relative, output)
    copy_file(renderer, "pullfiction_viewer.js", output, "pullfiction_viewer.bindgen.js")
    for relative in sorted(renderer_snippets(renderer, "pullfiction_viewer.js")):
        copy_file(renderer, relative, output)
    wasm = regular_file(renderer, "pullfiction_viewer_bg.wasm").read_bytes()
    if not wasm.startswith(b"\0asm\x01\0\0\0"):
        raise PackageError("Viewer is not a WebAssembly module")
    (output / "pullfiction_viewer_bg.wasm.gz").write_bytes(gzip.compress(wasm, compresslevel=9, mtime=0))
    copy_file(repo, "scripts/static-viewer-loader.mjs", output, "pullfiction_viewer.js")
    copy_file(repo, "cloudflare/static-headers", output, "_headers")
    for target, source in METADATA_FILES.items():
        copy_file(repo, source, output, target)
    for relative in sorted(ARCHIVE_FILES):
        copy_file(archive, relative, output, f"archive/{relative}")
    for relative in sorted(expected):
        # Assert that the runtime copy is exactly the approved code/schema.
        source = regular_file(archive, f"converter/{relative}")
        if source.read_bytes() != regular_file(repo, relative).read_bytes():
            raise PackageError(f"Converter source differs from repository: {relative}")
        copy_file(archive, f"converter/{relative}", output, f"archive/converter/{relative}")
    return audit(output, repo)


def audit(output: Path, repo: Path = REPO) -> dict:
    expected_converter = converter_files(repo)
    allowed = {"index.html", "_headers", "pullfiction_viewer.js", "pullfiction_viewer.bindgen.js", "pullfiction_viewer_bg.wasm.gz"}
    allowed.update(f"archive/{name}" for name in ARCHIVE_FILES)
    allowed.update(f"archive/converter/{name}" for name in expected_converter)
    allowed.update(renderer_snippets(output, "pullfiction_viewer.bindgen.js"))
    allowed.update(METADATA_FILES)
    allowed_directories = {"assets"}
    for name in allowed:
        allowed_directories.update(str(parent) for parent in PurePosixPath(name).parents if str(parent) != ".")
    if output.is_symlink() or not output.is_dir():
        raise PackageError("Release must be a regular directory")
    records = []
    actual = set()
    for path in sorted(output.rglob("*")):
        relative = path.relative_to(output).as_posix()
        if path.is_symlink():
            raise PackageError(f"Symlink is forbidden: {relative}")
        if path.is_dir():
            if relative not in allowed_directories:
                raise PackageError(f"Directory is not approved: {relative}")
            continue
        if not path.is_file():
            raise PackageError(f"Non-regular file is forbidden: {relative}")
        if relative not in allowed and not EDITOR_ASSET.fullmatch(relative):
            raise PackageError(f"File is not approved application code: {relative}")
        size = path.stat().st_size
        # Keep every uploaded file strictly below the documented 25 MiB cap.
        if size >= MAX_FILE_BYTES:
            raise PackageError(f"File reaches/exceeds 25 MiB: {relative} ({size} bytes)")
        data = path.read_bytes()
        scan_data = data
        if relative == "pullfiction_viewer_bg.wasm.gz":
            with gzip.GzipFile(fileobj=io.BytesIO(data)) as compressed:
                scan_data = compressed.read(MAX_VIEWER_BYTES + 1)
            if len(scan_data) > MAX_VIEWER_BYTES or not scan_data.startswith(b"\0asm\x01\0\0\0"):
                raise PackageError("Invalid or unexpectedly large compressed viewer WebAssembly")
        for pattern in SECRET_PATTERNS:
            if re.search(pattern, scan_data, re.IGNORECASE):
                raise PackageError(f"Secret or local endpoint/path signature in: {relative}")
        records.append({"path": relative, "bytes": size, "sha256": hashlib.sha256(data).hexdigest()})
        actual.add(relative)
    if len(records) > MAX_FILES:
        raise PackageError("Release exceeds the 20,000-file free-plan ceiling")
    if missing := allowed - actual:
        raise PackageError(f"Missing application files: {', '.join(sorted(missing))}")
    if not any(EDITOR_ASSET.fullmatch(name) for name in actual):
        raise PackageError("Release contains no editor bundle")
    validate_manifest(output / "archive", expected_converter)
    validate_npc_metadata(output / "metadata/npc-models.json", repo)
    for target, source in METADATA_FILES.items():
        if (output / target).read_bytes() != regular_file(repo, source).read_bytes():
            raise PackageError(f"NPC metadata or notice differs from repository: {target}")
    for relative in expected_converter:
        if (output / "archive/converter" / relative).read_bytes() != regular_file(repo, relative).read_bytes():
            raise PackageError(f"Converter source differs from repository: {relative}")
    if (output / "_headers").read_bytes() != regular_file(repo, "cloudflare/static-headers").read_bytes():
        raise PackageError("Release headers differ from the reviewed Cloudflare headers")
    if (output / "pullfiction_viewer.js").read_bytes() != regular_file(repo, "scripts/static-viewer-loader.mjs").read_bytes():
        raise PackageError("Release viewer loader differs from the reviewed loader")
    return {"file_count": len(records), "total_bytes": sum(item["bytes"] for item in records),
            "max_file_bytes_exclusive": MAX_FILE_BYTES, "files": records}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    package = subparsers.add_parser("pack")
    for name in ("editor", "renderer", "archive", "output"):
        package.add_argument(f"--{name}", type=Path, required=True)
    package.add_argument("--report", type=Path)
    check = subparsers.add_parser("audit")
    check.add_argument("output", type=Path)
    check.add_argument("--report", type=Path)
    args = parser.parse_args()
    try:
        result = (pack(args.editor, args.renderer, args.archive, args.output) if args.command == "pack"
                  else audit(args.output))
        if args.report:
            # Reports are developer evidence, never part of the public release.
            if args.report.resolve().is_relative_to(args.output.resolve()):
                raise PackageError("Audit report must be outside the release directory")
            args.report.write_text(json.dumps(result, indent=2) + "\n")
        print(f"Static audit passed: {result['file_count']} files, {result['total_bytes']} bytes; every file below 25 MiB.")
    except (PackageError, OSError, gzip.BadGzipFile) as error:
        parser.exit(1, f"Static package rejected: {error}\n")


if __name__ == "__main__":
    main()
