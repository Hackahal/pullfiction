# Browser converter runtime

The browser worker reuses Pull Fiction's pure Python format adapters through
[Pyodide 314.0.7](https://github.com/pyodide/pyodide/tree/314.0.7), distributed as the
`pyodide@314.0.7` npm package. It embeds Python 3.14.2. The package's loader,
interpreter and standard library are application code, not game data.

The build copies five runtime files explicitly. It does not install Python on
the user's computer or load packages from a public Python package index.

Pyodide is distributed under MPL-2.0. Its unmodified corresponding source is
available at the link above. Python's source and license are available at
[CPython v3.14.2](https://github.com/python/cpython/tree/v3.14.2).
See `Pyodide-LICENSE.txt` and `Python-LICENSE.txt` in this directory.

Community database format definitions retain their separate attribution and
license in `third_party/wowdbdefs`. No Blizzard client assets are included.
