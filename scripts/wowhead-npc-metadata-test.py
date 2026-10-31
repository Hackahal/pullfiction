#!/usr/bin/env python3
import copy
import importlib.util
import gzip
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from email.message import Message

spec = importlib.util.spec_from_file_location("wowhead_npc_metadata", Path(__file__).with_name("wowhead-npc-metadata.py"))
metadata = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metadata)


class NumericNpcMetadata(unittest.TestCase):
    def test_page_uses_requested_npc_identity_not_unrelated_references(self):
        page = '''WH.Gatherer.addData(1, 4, {"2":{"name_enus":"Other","model":999}});
WH.Gatherer.addData(1, 4, {"12118":{"name_enus":"Lucifron","model":13031}});
linksButton.dataset.displayId = 13031;'''
        self.assertEqual(metadata.npc_reference(page, 12118), {"name": "Lucifron", "displayID": 13031, "displayIDs": [13031], "templateScale": 0})
        with self.assertRaises(metadata.MetadataError):
            metadata.npc_reference(page, 3)

    def test_authored_variants_remain_numeric_and_default_is_explicit(self):
        row = metadata.npc_reference('WH.Gatherer.addData(1, 4, {"1":{"name_enus":"Example","model":[2,3]}}); displayId = 3;', 1)
        self.assertEqual(row["displayID"], 3)
        self.assertEqual(row["displayIDs"], [2, 3])
        with self.assertRaises(metadata.MetadataError):
            metadata.npc_reference('WH.Gatherer.addData(1, 4, {"1":{"name_enus":"Example","model":"https://art.example/model.m2"}});', 1)

    def test_zone_discovery_ignores_links_guides_and_non_npc_tables(self):
        text = '''<a href="/classic/npc=999">Not a zone NPC row</a>
new Listview({template: 'item', id: 'items', data: [{"id":888}]});
new Listview({template: 'npc', id: 'npcs', data: [{"id":12118,"name":"Lucifron"},{"id":11658,"name":"Molten Giant"}]});'''
        self.assertEqual(metadata.zone_npc_ids(text), [11658, 12118])
        with self.assertRaises(metadata.MetadataError):
            metadata.zone_npc_ids('<a href="/classic/npc=12118">Lucifron</a>')

    def test_zone_references_use_exact_numeric_gatherer_rows(self):
        text = 'WH.Gatherer.addData(1, 4, {"12118":{"name_enus":"Lucifron","model":13031}}); displayId = 999;'
        self.assertEqual(metadata.zone_references(text)[12118]["displayIDs"], [13031])

    def test_local_report_input_returns_only_npc_ids_and_rulesets(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "sod").mkdir()
            report = {"title": "Private report", "masterData": {"actors": [
                {"type": "Player", "gameID": 100, "name": "Private player"},
                {"type": "NPC", "gameID": 12118, "name": "Name must come from Wowhead"},
            ]}}
            (root / "example-report.json").write_text(json.dumps(report))
            (root / "sod/example-report.json").write_text(json.dumps({**report, "gameVersion": "sod"}))
            self.assertEqual(metadata.report_npc_ids(root), {"vanilla": {12118}, "sod": {12118}})

    def test_package_schema_rejects_assets_spawns_and_cross_namespace_sources(self):
        row = {"name": "Lucifron", "displayID": 13031, "displayIDs": [13031], "templateScale": 0,
               "sourceURL": metadata.source_url(12118, "vanilla"), "sourceSHA256": "a" * 64,
               "retrievedAt": "2026-10-27T12:00:00+00:00"}
        index = {"schema": 1, "provider": "Wowhead", "versions": {"vanilla": {"creatures": {"12118": row}}, "sod": {"creatures": {}}}}
        metadata.validate_index(index)
        zone_index = copy.deepcopy(index)
        zone_index["versions"]["vanilla"]["creatures"]["12118"]["sourceDocumentURL"] = "https://www.wowhead.com/classic/zone=2717"
        metadata.validate_index(zone_index)
        zone_index["versions"]["vanilla"]["creatures"]["12118"]["sourceDocumentURL"] = []
        with self.assertRaises(metadata.MetadataError):
            metadata.validate_index(zone_index)
        for key, value in (("spawns", []), ("texture", "texture.blp"), ("bytes", "base64"),
                           ("templateScale", 2.5), ("sourceURL", metadata.source_url(12118, "sod")),
                           ("displayID", True), ("displayIDs", [13031, "art.m2"])):
            with self.subTest(key=key):
                invalid = copy.deepcopy(index)
                invalid["versions"]["vanilla"]["creatures"]["12118"][key] = value
                with self.assertRaises(metadata.MetadataError):
                    metadata.validate_index(invalid)

    def test_cache_rejects_asset_endpoints_before_network_access(self):
        with tempfile.TemporaryDirectory() as folder:
            cache = metadata.PageCache(Path(folder), transport="urllib")
            for url in ("https://wow.zamimg.com/modelviewer/model.m2", "http://www.wowhead.com/classic/npc=1",
                        "https://www.wowhead.com/classic/icon=1", "https://www.wowhead.com/classic/npc=1?secret=1"):
                with self.subTest(url=url), self.assertRaises(metadata.MetadataError):
                    cache.get(url)

    def test_retries_are_bounded_and_cached_pages_are_checksum_verified(self):
        class Response:
            headers = type("Headers", (), {"get_content_type": lambda self: "text/html", "get": lambda self, key, default=None: default})()
            def __enter__(self): return self
            def __exit__(self, *args): return None
            def read(self, limit): return b"numeric metadata source page"

        url = metadata.source_url(1, "vanilla")
        with tempfile.TemporaryDirectory() as folder:
            cache = metadata.PageCache(Path(folder), transport="urllib")
            with patch.object(metadata, "build_opener") as opener, patch.object(metadata.time, "sleep"):
                opener.return_value.open.side_effect = [HTTPError(url, 503, "Unavailable", {}, None)] * 3
                with self.assertRaisesRegex(metadata.MetadataError, "HTTP 503"):
                    cache.get(url)
                self.assertEqual(opener.return_value.open.call_count, 3)
                opener.return_value.open.side_effect = None
                opener.return_value.open.return_value = Response()
                text, provenance = cache.get(url)
                self.assertEqual(text, "numeric metadata source page")
                count = opener.return_value.open.call_count
                self.assertEqual(cache.get(url), (text, provenance))
                self.assertEqual(opener.return_value.open.call_count, count)
                next(Path(folder).glob("*.html")).write_text("changed source")
                with self.assertRaisesRegex(metadata.MetadataError, "checksum mismatch"):
                    cache.get(url)

    def test_gzip_pages_are_decoded_with_a_bound_and_source_hash(self):
        class Response(io.BytesIO):
            def __init__(self, body):
                super().__init__(gzip.compress(body))
                self.headers = Message()
                self.headers["Content-Type"] = "text/html"
                self.headers["Content-Encoding"] = "gzip"

        with tempfile.TemporaryDirectory() as folder:
            cache = metadata.PageCache(Path(folder), transport="urllib")
            with patch.object(metadata, "build_opener") as opener, patch.object(metadata.time, "sleep"):
                body = b"small numeric metadata source"
                opener.return_value.open.return_value = Response(body)
                text, provenance = cache.get(metadata.source_url(1, "vanilla"))
                self.assertEqual(text.encode(), body)
                self.assertEqual(provenance["sha256"], hashlib.sha256(body).hexdigest())
                opener.return_value.open.return_value = Response(b"x" * (metadata.MAX_PAGE_BYTES + 1))
                with self.assertRaisesRegex(metadata.MetadataError, "size bound"):
                    cache.get(metadata.source_url(2, "vanilla"))

    def test_offline_misses_never_request_network_and_403_stops_later_requests(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(metadata, "build_opener") as opener, patch.object(metadata, "subprocess") as child:
                with self.assertRaisesRegex(metadata.MetadataError, "offline mode"):
                    metadata.PageCache(Path(folder), offline=True).get(metadata.source_url(1, "vanilla"))
                opener.assert_not_called()
                child.run.assert_not_called()
            cache = metadata.PageCache(Path(folder), transport="urllib")
            with patch.object(metadata, "build_opener") as opener:
                opener.return_value.open.side_effect = HTTPError(metadata.source_url(1, "vanilla"), 403, "Denied", {}, None)
                with self.assertRaises(metadata.SourceDenied):
                    cache.get(metadata.source_url(1, "vanilla"))
                with self.assertRaises(metadata.SourceDenied):
                    cache.get(metadata.source_url(2, "vanilla"))
                self.assertEqual(opener.return_value.open.call_count, 1)


if __name__ == "__main__":
    unittest.main()
