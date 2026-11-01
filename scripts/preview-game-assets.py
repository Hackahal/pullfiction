#!/usr/bin/env python3
"""Serve an audited local asset generation on loopback for Vite development."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from hosted_assets import audit


class Assets(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, '.gz': 'application/gzip'}

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--port', type=int, default=8312)
    args = parser.parse_args()
    directory = args.directory.resolve()
    print(audit(directory), flush=True)
    with ThreadingHTTPServer(('127.0.0.1', args.port), partial(Assets, directory=str(directory))) as server:
        print(f'Asset preview: http://127.0.0.1:{server.server_port}/', flush=True)
        server.serve_forever()
