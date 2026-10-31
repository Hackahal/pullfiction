#!/usr/bin/env python3
"""Artifact-level tests. Fixtures contain application text and synthetic WASM."""
import importlib.util
import json
import io
from contextlib import redirect_stdout
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch
from email.message import Message
from urllib.error import HTTPError
from urllib.parse import urlsplit

spec = importlib.util.spec_from_file_location("static_package", Path(__file__).with_name("static-package.py"))
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)
deploy_spec = importlib.util.spec_from_file_location("verify_deployment", Path(__file__).with_name("verify-deployment.py"))
deployment = importlib.util.module_from_spec(deploy_spec)
deploy_spec.loader.exec_module(deployment)


class StaticPackageTests(unittest.TestCase):
    def setUp(self):
        work = package.REPO / ".agent/work"
        work.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=work, prefix="static-package-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        metadata = {"schema": 1, "provider": "Wowhead", "versions": {
            "vanilla": {"creatures": {"12118": {"name": "Lucifron", "displayID": 13031,
                "displayIDs": [13031], "templateScale": 0,
                "sourceURL": "https://www.wowhead.com/classic/npc=12118",
                "sourceSHA256": "a" * 64, "retrievedAt": "2026-10-27T12:00:00+00:00"}}},
            "sod": {"creatures": {}}}}
        metadata_path = self.root / "npc-metadata-fixture.json"
        metadata_path.write_text(json.dumps(metadata))
        patcher = patch.dict(package.METADATA_FILES, {"metadata/npc-models.json": metadata_path.relative_to(package.REPO).as_posix()})
        patcher.start()
        self.addCleanup(patcher.stop)
        auditor = patch.object(deployment, "audit_release", side_effect=package.audit)
        auditor.start()
        self.addCleanup(auditor.stop)
        self.editor, self.renderer, self.archive, self.output = (self.root / name for name in ("editor", "renderer", "archive", "release"))
        for root in (self.editor, self.renderer, self.archive):
            root.mkdir()
        self.write(self.editor, "index.html", '<div id="root"></div><script type="module" src="/assets/index-fixture.js"></script>')
        self.write(self.editor, "assets/index-fixture.js", 'console.log("application");')
        self.write(self.editor, ".vite/manifest.json", json.dumps({"index.html": {"file": "assets/index-fixture.js", "isEntry": True}}))
        self.write(self.renderer, "pullfiction_viewer.js", "import { report } from './snippets/viewer-fixture/inline0.js';\nexport default async function init() {}")
        self.write(self.renderer, "snippets/viewer-fixture/inline0.js", "export function report() {}")
        self.write(self.renderer, "snippets/stale-fixture/inline0.js", "must never publish")
        self.write(self.renderer, "pullfiction_viewer_bg.wasm", b"\0asm\x01\0\0\0")
        for name in package.ARCHIVE_FILES:
            self.write(self.archive, name, b"\0asm\x01\0\0\0" if name.endswith(".wasm") else
                       b"PK\x03\x04fixture" if name.endswith(".zip") else "application runtime")
        names = package.converter_files(package.REPO)
        self.write(self.archive, "converter-files.json", json.dumps(sorted(names)))
        for name in names:
            self.write(self.archive, f"converter/{name}", (package.REPO / name).read_bytes())

    @staticmethod
    def write(root, name, data):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data if isinstance(data, bytes) else data.encode())
        return path

    def pack(self):
        return package.pack(self.editor, self.renderer, self.archive, self.output)

    def test_contaminated_inputs_only_publish_application_allowlist(self):
        contaminants = ("expected.json", "expected-models.json", "proof/index.html", ".env",
                        "game-ui/icon.blp", "data/client.m2", "catalogs/spells.json", "maps/raid.png")
        for root in (self.editor, self.renderer, self.archive):
            for name in contaminants:
                self.write(root, name, "must never publish")
        self.write(self.editor, "assets/old-game-icon.png", "must never publish")
        self.write(self.editor, "assets/stale-application.js", "must never publish")
        result = self.pack()
        self.assertGreater(result["file_count"], 10)
        output_names = {p.relative_to(self.output).as_posix() for p in self.output.rglob("*") if p.is_file()}
        for name in contaminants:
            self.assertNotIn(name, output_names)
            self.assertNotIn(f"archive/{name}", output_names)
        self.assertNotIn("pullfiction_viewer_bg.wasm", output_names)
        self.assertNotIn("assets/old-game-icon.png", output_names)
        self.assertNotIn("assets/stale-application.js", output_names)
        self.assertIn("snippets/viewer-fixture/inline0.js", output_names)
        self.assertNotIn("snippets/stale-fixture/inline0.js", output_names)
        self.assertEqual(package.audit(self.output), result)
        self.assertTrue((self.output / "metadata/npc-models.json").is_file())
        for notice in ("SOURCE", "LICENSE", "COPYRIGHT"):
            self.assertEqual((self.output / f"metadata/RaidSpawns-{notice}.md").read_bytes(),
                             (package.REPO / f"third_party/raid-spawns/{notice}.md").read_bytes())

    def test_development_entry_is_rejected_even_when_reachable_from_the_app(self):
        self.write(self.editor, ".vite/manifest.json", json.dumps({
            "index.html": {"file": "assets/index-fixture.js", "isEntry": True,
                           "dynamicImports": ["src/renderer-lab/RendererLab.tsx"]},
            "src/renderer-lab/RendererLab.tsx": {"file": "assets/RendererLab-fixture.js"},
        }))
        self.write(self.editor, "assets/RendererLab-fixture.js", "development harness")
        with self.assertRaisesRegex(package.PackageError, "development entry"):
            self.pack()

    def test_development_wasm_exports_are_rejected(self):
        self.write(self.renderer, "pullfiction_viewer_bg.wasm",
                   b"\0asm\x01\0\0\0renderer_lab_configure")
        with self.assertRaisesRegex(package.PackageError, "Development renderer-lab exports"):
            self.pack()

    def hosted_file(self, url, *, encoding="identity", limit=4096):
        name = urlsplit(url).path.lstrip("/") or "index.html"
        path = self.output / name
        if not path.is_file():
            raise HTTPError(url, 404, "Not found", {}, None)
        headers = Message()
        headers["X-Content-Type-Options"] = "nosniff"
        headers["Content-Type"] = ("application/gzip" if name.endswith(".wasm.gz") else
            "application/wasm" if name.endswith(".wasm") else
            "text/javascript" if name.endswith((".js", ".mjs")) else
            "text/html" if name.endswith(".html") else
            "text/css" if name.endswith(".css") else
            "application/json" if name.endswith(".json") else "text/plain")
        return path.read_bytes()[:limit], headers

    def test_hosted_health_accepts_provider_markup_and_different_binary_bytes(self):
        self.pack()

        def changed(url, **options):
            body, headers = self.hosted_file(url, **options)
            if url.endswith("/"):
                body += b'<script src="https://analytics.example/beacon.js"></script>'
            if url.endswith(".wasm"):
                body += b"different compiler output"
            return body, headers

        with patch.object(deployment, "fetch", changed):
            self.assertGreater(deployment.verify("https://pullfiction.example", self.output), 5)

    def test_hosted_health_rejects_missing_app_or_runtime_fallback(self):
        self.pack()

        def missing_app(url, **options):
            body, headers = self.hosted_file(url, **options)
            return (b"Not the application" if url.endswith("/") else body), headers

        with patch.object(deployment, "fetch", missing_app):
            with self.assertRaisesRegex(ValueError, "hosted application entry"):
                deployment.verify("https://pullfiction.example", self.output)

        for missing, message in (("casc.wasm", "WebAssembly content type"),
                                 ("python_stdlib.zip", "Invalid runtime archive")):
            with self.subTest(missing=missing):
                def runtime_fallback(url, **options):
                    if url.endswith(missing):
                        return self.hosted_file("https://pullfiction.example/", **options)
                    return self.hosted_file(url, **options)

                with patch.object(deployment, "fetch", runtime_fallback):
                    with self.assertRaisesRegex(ValueError, message):
                        deployment.verify("https://pullfiction.example", self.output)

    def test_hosted_release_rejects_implicit_gzip_decoding(self):
        self.pack()

        def double_decoded(url, **options):
            body, headers = self.hosted_file(url, **options)
            if url.endswith(".wasm.gz") and options.get("encoding") == "gzip, br":
                headers["Content-Encoding"] = "gzip"
            return body, headers

        with patch.object(deployment, "fetch", double_decoded):
            with self.assertRaisesRegex(ValueError, "explicitly compressed"):
                deployment.verify("https://pullfiction.example", self.output)

    def test_delivery_retry_waits_for_the_application_entry(self):
        self.pack()
        requests = [0]

        def becoming_ready(url, **options):
            body, headers = self.hosted_file(url, **options)
            if url == "https://pullfiction.example/":
                requests[0] += 1
                if requests[0] == 1:
                    return b"Previous entry", headers
            return body, headers

        arguments = ["verify-deployment.py", "https://pullfiction.example", str(self.output),
                     "--attempts", "2", "--delay", "0"]
        output = io.StringIO()
        with patch.object(deployment, "fetch", becoming_ready), patch.object(sys, "argv", arguments), redirect_stdout(output):
            deployment.main()
        self.assertEqual(requests[0], 2)
        self.assertIn("hosted application entry", output.getvalue())
        self.assertIn("Production health check passed", output.getvalue())

    def test_metadata_rejects_art_spawns_and_unreviewed_source_changes(self):
        self.pack()
        path = self.output / "metadata/npc-models.json"
        original = json.loads(path.read_text())
        for field in ("spawns", "bytes", "texture", "map"):
            with self.subTest(field=field):
                invalid = json.loads(json.dumps(original))
                records = invalid["versions"]["vanilla"]["creatures"]
                next(iter(records.values()))[field] = "unapproved payload"
                path.write_text(json.dumps(invalid))
                with self.assertRaisesRegex(package.PackageError, "Invalid approved NPC metadata"):
                    package.audit(self.output)
        changed = json.loads(json.dumps(original))
        next(iter(changed["versions"]["vanilla"]["creatures"].values()))["name"] = "Unreviewed name"
        path.write_text(json.dumps(changed))
        with self.assertRaisesRegex(package.PackageError, "differs from repository"):
            package.audit(self.output)

    def test_existing_output_is_preserved(self):
        self.output.mkdir()
        sentinel = self.write(self.output, "sentinel", "preserve")
        with self.assertRaisesRegex(package.PackageError, "must not exist"):
            self.pack()
        self.assertEqual(sentinel.read_text(), "preserve")

    def test_vite_manifest_follows_dynamic_chunks_and_styles(self):
        self.write(self.editor, "assets/worker-fixture.js", "export const worker = true;")
        self.write(self.editor, "assets/index-fixture.css", "body { color: white; }")
        self.write(self.editor, ".vite/manifest.json", json.dumps({
            "index.html": {"file": "assets/index-fixture.js", "isEntry": True,
                           "dynamicImports": ["worker"], "css": ["assets/index-fixture.css"]},
            "worker": {"file": "assets/worker-fixture.js"},
        }))
        self.pack()
        self.assertTrue((self.output / "assets/worker-fixture.js").is_file())
        self.assertTrue((self.output / "assets/index-fixture.css").is_file())

    def test_vite_manifest_rejects_game_art_and_traversal(self):
        for file in ("assets/raid-fixture.png", "../outside.js"):
            with self.subTest(file=file):
                self.write(self.editor, ".vite/manifest.json", json.dumps({
                    "index.html": {"file": file, "isEntry": True},
                }))
                with self.assertRaisesRegex(package.PackageError, "Unapproved Vite"):
                    self.pack()
                # A rejected pack can leave a partial output in its disposable stage.
                if self.output.exists():
                    self.output.rmdir()

    def test_allowed_source_symlink_is_rejected(self):
        name = self.archive / "worker.mjs"
        name.unlink()
        name.symlink_to(self.renderer / "pullfiction_viewer.js")
        with self.assertRaisesRegex(package.PackageError, "Symlink"):
            self.pack()

    def test_parent_directory_symlink_is_rejected(self):
        source = self.root / "other"
        (self.archive / "python").rename(source)
        (self.archive / "python").symlink_to(source, target_is_directory=True)
        with self.assertRaisesRegex(package.PackageError, "Symlink"):
            self.pack()

    def test_manifest_cannot_add_extracted_data_or_traversal(self):
        for extra in ("scripts/client.blp", "../client.m2", "third_party/wowdbdefs/extracted.db2"):
            with self.subTest(extra=extra):
                names = sorted(package.converter_files(package.REPO)) + [extra]
                self.write(self.archive, "converter-files.json", json.dumps(names))
                with self.assertRaisesRegex(package.PackageError, "manifest differs"):
                    self.pack()

    def test_converter_source_must_match_repository(self):
        self.write(self.archive, "converter/scripts/classic_characters.py", "unreviewed")
        with self.assertRaisesRegex(package.PackageError, "differs from repository"):
            self.pack()

    def test_world_adapter_is_code_only_and_exactly_manifested(self):
        self.pack()
        for module in ('world', 'terrain'):
            relative = f'archive/converter/scripts/classic_{module}.py'
            self.assertEqual((self.output / relative).read_bytes(),
                             (package.REPO / f'scripts/classic_{module}.py').read_bytes())
        path = self.output / 'archive/converter/scripts/classic_world.py'
        path.write_text('unreviewed converter code')
        with self.assertRaisesRegex(package.PackageError, 'differs from repository'):
            package.audit(self.output)

    def test_missing_renderer_snippet_is_rejected(self):
        (self.renderer / "snippets/viewer-fixture/inline0.js").unlink()
        with self.assertRaisesRegex(package.PackageError, "Missing regular file"):
            self.pack()

    def test_unapproved_renderer_module_is_rejected(self):
        self.write(self.renderer, "pullfiction_viewer.js", "import { data } from './data/client.m2';")
        with self.assertRaisesRegex(package.PackageError, "Unapproved wasm-bindgen module"):
            self.pack()

    def test_artifact_rejects_forbidden_files_and_symlinks(self):
        self.pack()
        for name in ("expected.json", "data/client.blp", ".env", "assets/stale-game.png"):
            with self.subTest(name=name):
                path = self.write(self.output, name, "forbidden")
                with self.assertRaises(package.PackageError):
                    package.audit(self.output)
                path.unlink()
                if path.parent != self.output and not any(path.parent.iterdir()):
                    path.parent.rmdir()
        link = self.output / "assets/index-symlink.js"
        link.symlink_to(self.editor / "assets/index-fixture.js")
        with self.assertRaisesRegex(package.PackageError, "Symlink"):
            package.audit(self.output)

    def test_rejects_each_file_at_or_above_cloudflare_limit(self):
        self.pack()
        path = self.output / "assets/index-oversize.js"
        for size in (package.MAX_FILE_BYTES, package.MAX_FILE_BYTES + 1):
            with self.subTest(size=size):
                with path.open("wb") as stream:
                    stream.truncate(size)
                with self.assertRaisesRegex(package.PackageError, "25 MiB"):
                    package.audit(self.output)

    def test_rejects_secrets_local_endpoints_and_local_paths(self):
        self.pack()
        for content in ('fetch("http://127.0.0.1:8091/import")', 'fetch("http://localhost:8090/data")',
                        'const client_secret = "do-not-publish";',
                        'const WCL_CLIENT_SECRET = "secret";',
                        '"/Users/developer/Projects/private"', '"-----BEGIN PRIVATE KEY-----"'):
            with self.subTest(content=content):
                self.write(self.output, "assets/index-fixture.js", content)
                with self.assertRaisesRegex(package.PackageError, "Secret or local"):
                    package.audit(self.output)


if __name__ == "__main__":
    unittest.main()
