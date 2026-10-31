#!/usr/bin/env python3
"""Prefetch numeric NPC display references. Never downloads model, texture, or icon files."""
from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROOT = Path(__file__).resolve().parent.parent
RAID_ZONES = {"mc": 2717, "onyxia": 2159, "bwl": 2677, "zg": 1977,
              "aq20": 3429, "aq40": 3428, "naxxramas": 3456}
# Wowhead's Onyxia zone omits the NPC Listview. The raid strategy names the
# boss, warder trash, and whelp adds. These are identifiers only; every name
# and display value still comes from its own live NPC page.
ONYXIA_IDS = (10184, 11262, 12129)
MAX_PAGE_BYTES = 3 * 1024 * 1024
NPC_FIELDS = {"name", "displayID", "displayIDs", "templateScale", "sourceURL", "sourceSHA256", "retrievedAt"}


class MetadataError(ValueError):
    pass


class SourceDenied(MetadataError):
    pass


def source_url(entry: int, version: str) -> str:
    return f"https://www.wowhead.com/classic/npc={entry}" + ("?env=4" if version == "sod" else "")


def positive_id(value) -> bool:
    return type(value) is int and 0 < value < 1_000_000


def json_after(text: str, pattern: str):
    decoder = json.JSONDecoder()
    for match in re.finditer(pattern, text):
        try:
            yield decoder.raw_decode(text, match.end())[0]
        except json.JSONDecodeError as error:
            raise MetadataError("Source page contains malformed metadata JSON") from error


def zone_npc_ids(text: str) -> list[int]:
    # Read only the NPC Listview, not NPC links in ads, comments or guides.
    ids = set()
    pattern = r"template:\s*['\"]npc['\"],\s*id:\s*['\"]npcs['\"].*?\bdata:\s*"
    for rows in json_after(text, pattern):
        if not isinstance(rows, list):
            raise MetadataError("Zone NPC list is not an array")
        for row in rows:
            if not isinstance(row, dict) or not positive_id(row.get("id")):
                raise MetadataError("Zone NPC list has an invalid identifier")
            ids.add(row["id"])
    if not ids:
        raise MetadataError("Zone page contains no complete NPC Listview")
    return sorted(ids)


def npc_reference(text: str, entry: int) -> dict:
    own = []
    for data in json_after(text, r"WH\.Gatherer\.addData\(1,\s*4,\s*"):
        if isinstance(data, dict) and isinstance(data.get(str(entry)), dict):
            own.append(data[str(entry)])
    names = {row["name_enus"] for row in own if isinstance(row.get("name_enus"), str)}
    if len(names) != 1:
        raise MetadataError("NPC page does not identify the requested NPC unambiguously")
    name = names.pop()
    if not 0 < len(name) <= 200 or any(ord(c) < 32 for c in name):
        raise MetadataError("Invalid NPC name metadata")
    displays = []
    for row in own:
        models = row.get("model", [])
        if type(models) is int:
            models = [models]
        if not isinstance(models, list) or any(not positive_id(value) for value in models):
            raise MetadataError("NPC page has invalid model references")
        for value in models:
            if value not in displays:
                displays.append(value)
    # Older and current page versions put the default display on the model
    # viewer button. Read it only after confirming the page's own NPC identity.
    primary = {int(value) for value in re.findall(r"\bdisplayId\s*=\s*(\d+)\s*;", text)}
    if len(primary) > 1 or any(not positive_id(value) for value in primary):
        raise MetadataError("NPC page has ambiguous default display references")
    if primary:
        display = primary.pop()
        if display not in displays:
            displays.insert(0, display)
    elif displays:
        display = displays[0]
    else:
        raise MetadataError("NPC page contains no numeric display reference")
    return {"name": name, "displayID": display, "displayIDs": displays, "templateScale": 0}


def zone_references(text: str) -> dict[int, dict]:
    result = {}
    for data in json_after(text, r"WH\.Gatherer\.addData\(1,\s*4,\s*"):
        if not isinstance(data, dict):
            continue
        for key, row in data.items():
            if not isinstance(key, str) or not re.fullmatch(r"[1-9][0-9]{0,5}", key) or not isinstance(row, dict):
                continue
            # A zone page may mention other model viewers. Parse only this
            # exact Gatherer record, never its unrelated default display button.
            try:
                reference = npc_reference("WH.Gatherer.addData(1, 4, " + json.dumps({key: row}) + ");", int(key))
                result.setdefault(int(key), reference)
            except MetadataError:
                pass
    return result


def report_npc_ids(directory: Path) -> dict[str, set[int]]:
    result = {"vanilla": set(), "sod": set()}
    for path in sorted(directory.rglob("*-report.json")):
        report = json.loads(path.read_text())
        version = report.get("gameVersion") or ("sod" if "sod" in path.relative_to(directory).parts else "vanilla")
        if version not in result:
            continue
        for actor in report.get("masterData", {}).get("actors", []):
            if actor.get("type") in ("NPC", "Pet") and positive_id(actor.get("gameID")):
                result[version].add(actor["gameID"])
    # Player identities, report codes, combat samples and locally imported model
    # mappings are never returned or copied into the published index.
    return result


def seed_npc_ids(path: Path) -> dict[str, set[int]]:
    if not path.is_file():
        return {"vanilla": set(), "sod": set()}
    value = json.loads(path.read_text())
    if not isinstance(value, dict) or set(value) != {"vanilla", "sod"} or any(
            not isinstance(ids, list) or any(not positive_id(entry) for entry in ids)
            for ids in value.values()):
        raise MetadataError("NPC seed file must contain only version-separated numeric identifiers")
    return {version: set(ids) for version, ids in value.items()}


class SameHostRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        if urlparse(newurl).scheme != "https" or urlparse(newurl).hostname != "www.wowhead.com":
            raise MetadataError("Unexpected metadata source redirect")
        return super().redirect_request(request, fp, code, message, headers, newurl)


class PageCache:
    def __init__(self, root: Path, refresh: bool = False, transport: str = "node", offline: bool = False):
        self.root, self.refresh, self.transport, self.offline = root, refresh, transport, offline
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.next_request = 0.0
        self.denied = threading.Event()

    def get(self, url: str) -> tuple[str, dict]:
        parsed = urlparse(url)
        detail_page = re.fullmatch(r"/classic/(?:npc|zone)=\d+", parsed.path) and parsed.query in ("", "env=4")
        if parsed.scheme != "https" or parsed.hostname != "www.wowhead.com" or not detail_page:
            raise MetadataError("Only numeric Wowhead Classic NPC and zone pages are allowed")
        key = hashlib.sha256(url.encode()).hexdigest()
        metadata_path, body_path = self.root / f"{key}.json", self.root / f"{key}.html"
        if not self.refresh and metadata_path.is_file():
            metadata = json.loads(metadata_path.read_text())
            if metadata.get("url") != url:
                raise MetadataError("Cached page URL does not match its key")
            if metadata.get("status") == 404:
                raise MetadataError("Source page returned HTTP 404, cached")
            if body_path.is_file():
                body = body_path.read_bytes()
                if len(body) > MAX_PAGE_BYTES or hashlib.sha256(body).hexdigest() != metadata.get("sha256"):
                    raise MetadataError("Cached source page checksum mismatch")
                return body.decode("utf-8"), metadata
        if self.offline:
            raise MetadataError("No validated cached page; offline mode makes no network requests")
        if self.denied.is_set():
            raise SourceDenied("Source denied access; no further network requests")
        for attempt in range(3):
            if self.denied.is_set():
                raise SourceDenied("Source denied access; no further network requests")
            with self.lock:
                delay = max(0, self.next_request - time.monotonic())
                self.next_request = time.monotonic() + delay + 0.25
            if delay:
                time.sleep(delay)
            if self.denied.is_set():
                raise SourceDenied("Source denied access; no further network requests")
            try:
                if self.transport == "node":
                    try:
                        result = subprocess.run(["node", str(ROOT / "scripts/wowhead-page-fetch.mjs"), url],
                                                capture_output=True, timeout=20, check=False)
                    except subprocess.TimeoutExpired as error:
                        raise URLError("Metadata page exceeded its total time bound") from error
                    if result.returncode:
                        raise URLError(result.stderr.decode().strip() or "Metadata request failed")
                    value = json.loads(result.stdout)
                    if value.get("status") != 200:
                        raise HTTPError(url, value.get("status", 500), "Metadata source response", {}, None)
                    body = base64.b64decode(value["body"], validate=True)
                    if len(body) > MAX_PAGE_BYTES:
                        raise MetadataError("Source page exceeds the metadata size bound")
                else:
                    request = Request(url, headers={"User-Agent": "PullFiction-Metadata-Prefetch/1.0", "Accept-Encoding": "gzip"})
                    with build_opener(SameHostRedirect()).open(request, timeout=15) as response:
                        if response.headers.get_content_type() != "text/html":
                            raise MetadataError("Source is not an HTML metadata page")
                        encoding = response.headers.get("Content-Encoding", "identity").lower()
                        if encoding not in ("identity", "gzip"):
                            raise MetadataError("Unexpected metadata response encoding")
                        stream = gzip.GzipFile(fileobj=response) if encoding == "gzip" else response
                        body = stream.read(MAX_PAGE_BYTES + 1)
                        if len(body) > MAX_PAGE_BYTES:
                            raise MetadataError("Source page exceeds the metadata size bound")
                metadata = {"url": url, "status": 200, "sha256": hashlib.sha256(body).hexdigest(),
                            "retrievedAt": datetime.now(timezone.utc).isoformat(timespec="seconds")}
                temporary_body, temporary_metadata = body_path.with_suffix(".html.tmp"), metadata_path.with_suffix(".json.tmp")
                temporary_body.write_bytes(body)
                temporary_body.replace(body_path)
                temporary_metadata.write_text(json.dumps(metadata, sort_keys=True) + "\n")
                temporary_metadata.replace(metadata_path)
                return body.decode("utf-8"), metadata
            except HTTPError as error:
                if error.code in (401, 403):
                    self.denied.set()
                    raise SourceDenied(f"Source returned HTTP {error.code}; stopped all further network requests") from error
                if error.code == 404:
                    metadata_path.write_text(json.dumps({"url": url, "status": 404}) + "\n")
                if error.code not in (429, 500, 502, 503, 504) or attempt == 2:
                    raise MetadataError(f"Source page returned HTTP {error.code}") from error
            except (TimeoutError, URLError) as error:
                if attempt == 2:
                    raise MetadataError("Source page timed out or could not be reached") from error
            time.sleep(1 + attempt * 2)
        raise MetadataError("Source page retrieval failed")


def validate_index(index: dict) -> None:
    if not isinstance(index, dict) or set(index) != {"schema", "provider", "versions"} or type(index["schema"]) is not int or index["schema"] != 1 or index["provider"] != "Wowhead":
        raise MetadataError("Invalid NPC metadata envelope")
    if not isinstance(index["versions"], dict) or set(index["versions"]) != {"vanilla", "sod"}:
        raise MetadataError("NPC metadata must keep vanilla and SoD namespaces separate")
    for version, section in index["versions"].items():
        if not isinstance(section, dict) or set(section) != {"creatures"} or not isinstance(section["creatures"], dict):
            raise MetadataError("Invalid NPC metadata section")
        for key, row in section["creatures"].items():
            if not re.fullmatch(r"[1-9][0-9]{0,5}", key) or not isinstance(row, dict) or set(row) not in (NPC_FIELDS, NPC_FIELDS | {"sourceDocumentURL"}):
                raise MetadataError("NPC metadata contains unexpected fields or identifiers")
            if not isinstance(row["name"], str) or not 0 < len(row["name"]) <= 200 or any(ord(c) < 32 for c in row["name"]):
                raise MetadataError("Invalid NPC metadata name")
            ids = row["displayIDs"]
            if not isinstance(ids, list) or not ids or len(ids) > 16 or any(not positive_id(value) for value in ids) or len(ids) != len(set(ids)) or not positive_id(row["displayID"]) or row["displayID"] not in ids:
                raise MetadataError("Invalid NPC display references")
            if type(row["templateScale"]) is not int or row["templateScale"] != 0 or row["sourceURL"] != source_url(int(key), version):
                raise MetadataError("NPC source or unknown-scale contract does not match its namespace")
            if "sourceDocumentURL" in row and (not isinstance(row["sourceDocumentURL"], str) or row["sourceDocumentURL"] not in {
                    f"https://www.wowhead.com/classic/zone={zone}" for zone in RAID_ZONES.values()}):
                raise MetadataError("NPC reference source document must be an approved Wowhead raid zone page")
            if not isinstance(row["sourceSHA256"], str) or not re.fullmatch(r"[0-9a-f]{64}", row["sourceSHA256"]):
                raise MetadataError("NPC metadata lacks a source checksum")
            try:
                timestamp = datetime.fromisoformat(row["retrievedAt"])
                if timestamp.tzinfo is None:
                    raise ValueError("Timestamp has no timezone")
            except (TypeError, ValueError) as error:
                raise MetadataError("NPC metadata lacks its retrieval time") from error


def build(cache: PageCache, reports: Path, checkpoint: Path | None = None) -> tuple[dict, dict]:
    inputs = report_npc_ids(reports)
    for version, ids in seed_npc_ids(ROOT / "third_party/wowhead-npcs/ids.json").items():
        inputs[version].update(ids)
    coverage = {"zones": [], "unresolved": [], "inputs": {}}
    references = {}
    for name, zone in RAID_ZONES.items():
        url = f"https://www.wowhead.com/classic/zone={zone}"
        text, metadata = cache.get(url)
        try:
            ids = zone_npc_ids(text)
        except MetadataError:
            if name != "onyxia":
                raise
            ids = list(ONYXIA_IDS)
            metadata = {**metadata, "npcDiscovery": "Wowhead raid strategy checklist",
                        "checklistURL": "https://www.wowhead.com/classic/guide/onyxia-onyxias-lair-strategy-wow-classic"}
        inputs["vanilla"].update(ids)
        coverage["zones"].append({"name": name, "zone": zone, "npcCount": len(ids), **metadata})
        for entry, row in zone_references(text).items():
            references.setdefault(entry, (row, metadata))
    index = {"schema": 1, "provider": "Wowhead", "versions": {version: {"creatures": {}} for version in inputs}}
    tasks = [(version, entry) for version, entries in inputs.items() for entry in sorted(entries)]
    coverage["inputs"] = {version: len(entries) for version, entries in inputs.items()}

    def fetch(task):
        version, entry = task
        url = source_url(entry, version)
        try:
            text, metadata = cache.get(url)
            row = {**npc_reference(text, entry), "sourceURL": url,
                   "sourceSHA256": metadata["sha256"], "retrievedAt": metadata["retrievedAt"]}
            return version, entry, row, None
        except (MetadataError, OSError, UnicodeError, json.JSONDecodeError) as error:
            if entry in references:
                reference, metadata = references[entry]
                row = {**reference, "sourceURL": url, "sourceDocumentURL": metadata["url"],
                       "sourceSHA256": metadata["sha256"], "retrievedAt": metadata["retrievedAt"]}
                return version, entry, row, None
            return version, entry, None, str(error)

    # The request pool is deliberately fixed at two. Cached metadata is reused;
    # source pages and their full bodies never enter the application package.
    with ThreadPoolExecutor(max_workers=2) as executor:
        for completed, (version, entry, row, error) in enumerate(executor.map(fetch, tasks), 1):
            if row is None:
                coverage["unresolved"].append({"version": version, "entry": entry,
                                               "sourceURL": source_url(entry, version), "reason": error})
            else:
                index["versions"][version]["creatures"][str(entry)] = row
            if completed % 25 == 0 or completed == len(tasks):
                if checkpoint:
                    checkpoint.parent.mkdir(parents=True, exist_ok=True)
                    temporary = checkpoint.with_suffix(".json.tmp")
                    temporary.write_text(json.dumps(index, sort_keys=True, separators=(",", ":")) + "\n")
                    temporary.replace(checkpoint)
                print(f"NPC metadata {completed}/{len(tasks)}; unresolved {len(coverage['unresolved'])}", flush=True)
    validate_index(index)
    coverage["resolved"] = {version: len(section["creatures"]) for version, section in index["versions"].items()}
    coverage["offline"] = cache.offline
    coverage["sourceDenied"] = cache.denied.is_set()
    return index, coverage


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=ROOT / ".agent/work/npc-metadata/wowhead-cache")
    parser.add_argument("--reports", type=Path, default=ROOT / ".agent/work/wcl")
    parser.add_argument("--output", type=Path, default=ROOT / "third_party/wowhead-npcs/npc-models.json")
    parser.add_argument("--coverage", type=Path, default=ROOT / ".agent/work/npc-metadata/coverage.json")
    parser.add_argument("--checkpoint", type=Path, default=ROOT / ".agent/work/npc-metadata/progress-index.json")
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--transport", choices=("node", "urllib"), default="node")
    parser.add_argument("--offline", action="store_true", help="Use validated cached pages only; never request a network resource")
    args = parser.parse_args()
    if not args.offline and args.transport == "node" and not shutil.which("node"):
        parser.error("Node is required for metadata prefetch; use --transport urllib for diagnostics")
    try:
        index, coverage = build(PageCache(args.cache, args.refresh, args.transport, args.offline), args.reports, args.checkpoint)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.coverage.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(index, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n")
        args.coverage.write_text(json.dumps(coverage, indent=2, sort_keys=True) + "\n")
        state = "PARTIAL" if coverage["unresolved"] else "Complete for the requested input checklist"
        print(f"{state}: saved Wowhead numeric NPC metadata {coverage['resolved']}; unresolved {len(coverage['unresolved'])}. No client assets or page bodies.")
    except (MetadataError, OSError, ValueError) as error:
        parser.exit(1, f"NPC metadata preparation failed: {error}\n")


if __name__ == "__main__":
    main()
