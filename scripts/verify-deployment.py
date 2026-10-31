#!/usr/bin/env python3
"""Check that the production app and browser runtime are served correctly."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
import importlib.util
from pathlib import Path
import time
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, newurl):
        return None


def fetch(url: str, *, encoding: str = "identity", limit: int = 4096) -> tuple[bytes, object]:
    request = urllib.request.Request(url, headers={
        "User-Agent": "Pull-Fiction-release-verification",
        "Accept-Encoding": encoding,
    })
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=45) as response:
        if response.status != 200:
            raise ValueError(f"Unexpected status {response.status}: {url}")
        return response.read(limit), response.headers


class AppEntry(HTMLParser):
    def __init__(self, body: bytes):
        super().__init__()
        self.has_root = False
        self.assets = set()
        self.feed(body.decode(errors="replace"))

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == "div" and attrs.get("id") == "root":
            self.has_root = True
        if tag == "script" and attrs.get("type") == "module" and attrs.get("src"):
            self.assets.add(attrs["src"])
        if tag == "link" and attrs.get("rel") == "stylesheet" and attrs.get("href"):
            self.assets.add(attrs["href"])


def audit_release(release: Path) -> dict:
    spec = importlib.util.spec_from_file_location("static_package", Path(__file__).with_name("static-package.py"))
    package = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(package)
    return package.audit(release)


def verify(origin: str, release: Path) -> int:
    parsed = urllib.parse.urlsplit(origin)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username
            or parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise ValueError("Use a plain HTTPS production origin, without credentials or a path")
    origin = origin.rstrip("/")
    inventory = audit_release(release)
    expected_entry = AppEntry((release / "index.html").read_bytes())
    if not expected_entry.has_root or not expected_entry.assets:
        raise ValueError("The local application entry is incomplete")

    def check_entry(body: bytes, headers: object) -> None:
        entry = AppEntry(body)
        if (headers.get_content_type() != "text/html" or not entry.has_root
                or not expected_entry.assets.issubset(entry.assets)):
            raise ValueError("The hosted application entry is missing or references a different release")

    body, headers = fetch(origin + "/", limit=65536)
    check_entry(body, headers)
    # Inspect small prefixes of executable assets, not every file or its hash.
    public_files = [item for item in inventory["files"]
                    if item["path"].endswith((".js", ".mjs", ".css", ".wasm", ".wasm.gz"))
                    or item["path"] in ("archive/converter-files.json", "archive/python/pyodide-lock.json",
                                            "archive/python/python_stdlib.zip", "metadata/npc-models.json")]

    def check(item: dict) -> None:
        name = item["path"]
        path = urllib.parse.quote(name, safe="/")
        body, headers = fetch(f"{origin}/{path}")
        if not body:
            raise ValueError(f"Empty runtime response: {name}")
        if headers.get("X-Content-Type-Options") != "nosniff":
            raise ValueError(f"Missing nosniff response header: {name}")
        mime = headers.get_content_type()
        if name.endswith(".wasm") and mime != "application/wasm":
            raise ValueError(f"Incorrect WebAssembly content type: {name}: {mime}")
        if name.endswith(".wasm") and not body.startswith(b"\0asm"):
            raise ValueError(f"Invalid WebAssembly response: {name}")
        if name.endswith((".js", ".mjs")) and mime not in ("text/javascript", "application/javascript"):
            raise ValueError(f"Incorrect JavaScript content type: {name}: {mime}")
        if name.endswith(".css") and mime != "text/css":
            raise ValueError(f"Incorrect stylesheet content type: {name}: {mime}")
        if name.endswith(".json") and mime != "application/json":
            raise ValueError(f"Incorrect JSON content type: {name}: {mime}")
        if name.endswith(".zip") and not body.startswith(b"PK\x03\x04"):
            raise ValueError(f"Invalid runtime archive response: {name}")
        if name.endswith(".wasm.gz"):
            _, browser_headers = fetch(f"{origin}/{path}", encoding="gzip, br")
            if (mime != "application/gzip" or not body.startswith(b"\x1f\x8b")
                    or browser_headers.get("Content-Encoding")):
                raise ValueError("The viewer gzip must remain explicitly compressed for its browser loader")

    with ThreadPoolExecutor(max_workers=6) as executor:
        list(executor.map(check, public_files))
    for path in ("/.env", "/.agent/", "/src/main.tsx", "/web/archive/proof.html", "/archive/proof.html"):
        try:
            body, headers = fetch(origin + path, limit=65536)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                error.close()
                continue
            raise
        # An SPA fallback is acceptable; publishing source or proof files is not.
        try:
            check_entry(body, headers)
        except ValueError:
            raise ValueError(f"A development-only path exposes unexpected content: {path}")
    return len(public_files) + 1


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("origin")
    parser.add_argument("release", type=Path)
    parser.add_argument("--attempts", type=int, default=1)
    parser.add_argument("--delay", type=float, default=5)
    args = parser.parse_args()
    if not 1 <= args.attempts <= 30 or not 0 <= args.delay <= 30:
        parser.error("Use 1–30 attempts and a delay of 0–30 seconds")
    try:
        # Local package failures must fail immediately, before network retries.
        audit_release(args.release.resolve())
    except (OSError, ValueError) as error:
        parser.exit(1, f"Deployment verification failed: {error}\n")
    for attempt in range(1, args.attempts + 1):
        try:
            count = verify(args.origin, args.release.resolve())
            break
        except (OSError, ValueError) as error:
            if attempt == args.attempts:
                parser.exit(1, f"Deployment verification failed: {error}\n")
            print(f"Delivery check {attempt}/{args.attempts}: {error}; retrying in {args.delay:g}s", flush=True)
            time.sleep(args.delay)
    print(f"Production health check passed: app entry and {count - 1} runtime assets, response types, viewer compression and development-path exclusions.")


if __name__ == "__main__":
    main()
