#!/usr/bin/env python3
"""Serve an audited static release on loopback. Never serves game files or proxies WCL."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
from pathlib import Path


class Preview(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript", ".wasm": "application/wasm", ".gz": "application/gzip"}

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--port", type=int, default=8096)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("static_package", Path(__file__).with_name("static-package.py"))
    package = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(package)
    directory = args.directory.resolve()
    package.audit(directory)
    with ThreadingHTTPServer(("127.0.0.1", args.port), partial(Preview, directory=str(directory))) as server:
        print(f"Pull Fiction static preview: http://127.0.0.1:{server.server_port}/", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
