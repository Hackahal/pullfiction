#!/usr/bin/env python3
"""Compare hosted production assets with an audited local release. No game files."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, newurl):
        return None


def fetch(url: str, *, encoding: str = "identity") -> tuple[bytes, object]:
    request = urllib.request.Request(url, headers={
        "User-Agent": "Pull-Fiction-release-verification",
        "Accept-Encoding": encoding,
    })
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=45) as response:
        if response.status != 200:
            raise ValueError(f"Unexpected status {response.status}: {url}")
        return response.read(), response.headers


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
    public_files = [item for item in inventory["files"] if item["path"] != "_headers"]

    def check(item: dict) -> None:
        name = item["path"]
        path = "" if name == "index.html" else urllib.parse.quote(name, safe="/")
        body, headers = fetch(f"{origin}/{path}")
        if hashlib.sha256(body).hexdigest() != item["sha256"]:
            raise ValueError(f"Deployed bytes differ from the release: {name}")
        if headers.get("X-Content-Type-Options") != "nosniff":
            raise ValueError(f"Missing nosniff response header: {name}")
        mime = headers.get_content_type()
        if name.endswith(".wasm") and mime != "application/wasm":
            raise ValueError(f"Incorrect WebAssembly content type: {name}: {mime}")
        if name.endswith((".js", ".mjs")) and mime not in ("text/javascript", "application/javascript"):
            raise ValueError(f"Incorrect JavaScript content type: {name}: {mime}")
        if name.endswith(".wasm.gz"):
            _, browser_headers = fetch(f"{origin}/{path}", encoding="gzip, br")
            if mime != "application/gzip" or browser_headers.get("Content-Encoding"):
                raise ValueError("The viewer gzip must remain explicitly compressed for its browser loader")

    with ThreadPoolExecutor(max_workers=6) as executor:
        list(executor.map(check, public_files))
    root_hash = hashlib.sha256((release / "index.html").read_bytes()).hexdigest()
    for path in ("/.env", "/.agent/", "/src/main.tsx", "/web/archive/proof.html", "/archive/proof.html"):
        try:
            body, _ = fetch(origin + path)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                error.close()
                continue
            raise
        # An SPA fallback is acceptable; publishing source or proof files is not.
        if hashlib.sha256(body).hexdigest() != root_hash:
            raise ValueError(f"A development-only path exposes unexpected content: {path}")
    return len(public_files)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("origin")
    parser.add_argument("release", type=Path)
    args = parser.parse_args()
    try:
        count = verify(args.origin, args.release.resolve())
    except (OSError, ValueError) as error:
        parser.exit(1, f"Deployment verification failed: {error}\n")
    print(f"Verified {count} production files, response types, viewer compression and development-path exclusions.")


if __name__ == "__main__":
    main()
