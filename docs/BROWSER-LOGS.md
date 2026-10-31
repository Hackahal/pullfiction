# Browser log adapter

The browser adapter imports Warcraft Logs reports directly through its
user API. It requires no local Node server or bundled client secret. The static
editor uses this adapter when built with `VITE_BROWSER_ASSETS=1`. Live PKCE login,
token exchange, report lookup, and replay import have been verified from the
local static preview for Classic Era and Season of Discovery.

## Authentication boundary

`web/editor/src/wcl-auth.ts` uses pinned `oauth4webapi` 3.8.8 for the
[PKCE flow documented by Warcraft Logs](https://www.warcraftlogs.com/api/docs).
`WclSession` accepts a public client ID and its registered callback URL. A client
secret has no place in this configuration.

`begin()` returns the authorization URL. It stores the random verifier, state,
client identity, callback URL, return path, and creation time in session storage.
It fails before navigation if that storage is unavailable. The return path must
stay on the application's origin.

`finish()` accepts a callback on the configured origin and path. It validates the
state, rejects pending requests older than ten minutes, and consumes the verifier
once. Token exchange uses HTTPS without cookies. Access and refresh tokens stay
in memory. Reloading the application requires a new authorization flow.

Refresh requests are serialized. Cancelling one caller stops its wait without
starting a second refresh for other callers. Disconnecting invalidates any
in-flight token response and clears the pending authorization.

The callback UI removes authorization parameters from browser history before
loading other application content. It provides connect, disconnect, report
selection, import progress and cancellation. The registered public client is
"Pull Fiction browser replay and planning". It has no client secret.
`web/editor/.env` supplies its public `VITE_WCL_CLIENT_ID` for the local preview.
Its registered callback is `http://127.0.0.1:8096/`.

Before deployment, register the actual site's callback with Warcraft Logs and set
`VITE_WCL_REDIRECT_URI` if the default origin and pathname differ from it. Other
localhost ports and hostnames are different callbacks. Without a public client
configuration, the editor offers local replay JSON import.

To import a report, open **Logs** or **Library → Find logs**, then select
**Connect Warcraft Logs**. Find a guild by its full name, realm and region,
or paste a run link. Guilds can be saved locally for quick access to recent runs.
Raid and date filters apply to the server query across all pages. Choose a run,
then a full instance or encounter. Select your local client folder when prompted.
The redirect starts a new page, so local folder selection must be repeated.
Reloading also requires reconnecting because tokens remain in memory.
See [local projects](LOCAL-PROJECTS.md) for saving and backup instructions.

The realm dropdown uses the regional Warcraft Logs server catalogue. Requests
page through 100 servers at a time and cache successful lists for each region
and game version. The adapter identifies SoD realms using the returned season
ID of 3; other Classic seasons stay in the Era list. Changing region clears the
realm selection, and failed lists can be retried.

Guild lookup normalizes the API's region slug to lowercase before saving.
Era and SoD return a shared world-zone catalogue, including identically named
raids. The adapter uses returned partition names containing `Discovery` to
identify SoD zone entries. It sends their WCL zone IDs to report filtering;
client map IDs are not used as ranking-zone IDs.

## Report boundary

`web/editor/src/wcl-browser.ts` provides `browserQuery()` and `BrowserLogs`.
Requests use the supported Era or SoD host and `/api/v2/user`. Authentication
failures disconnect the session. Redirects are rejected, and tokens are never
sent to an input URL.

`BrowserLogs.report()` loads the current report envelope. The normal browser
flow uses `replayHeader()` for metadata and `replayRange()` for detailed sections
and filtered state history. `replay()` retains full-file import compatibility.
Both paths preserve resource snapshots, player details, equipment, pet ownership
and ability metadata. See [buffered replay](BUFFERED-REPLAY.md). The raw
result follows the existing replay normalization contract. A full run keeps
events between pulls and excludes intervals belonging to another raid in a mixed
report.

Pagination accepts cancellation and reports page count, event count, and cursor
position. It rejects a cursor that fails to advance, more than 250 pages, or more
than 2.5 million events. These are the existing importer limits.

`web/planner/wcl-report.mjs` owns the report query, pagination, and full-run
selection shared by the browser and local adapters. The browser does not scrape
NPC display references or request game art from a proxy. Missing NPC-entry to
display associations use the separate prefetched numeric Wowhead index when
available and valid in the selected local client. Index coverage is incomplete;
unresolved entries remain unresolved. There is no runtime NPC-page scraping.

## Verification boundary

Fixture tests cover PKCE state, redirect validation, one-time verifiers,
refresh, cancellation, supported hosts, resource preservation, pets, equipment,
pagination, mixed-raid selection, and the browser fetch receiver for token exchange
and refresh. A live test found that calling `fetch` with the session as its
receiver fails in the browser; both token paths now use the global receiver.

Browser verification covers actual token endpoint CORS, registered callback
acceptance, reconnect, disconnect, a Classic Era Lucifron import, and the complete
SoD AQ40 report `bZX7VqdwpcmyrGzN`. The full run contains 352,653 events, 185 actors,
768 abilities, and 23 chapters. Its exported event content matches the earlier
downloaded report exactly. Playback and seeking use the existing native renderer.
This verifies report transport, not exhaustive NPC display-index or spell fidelity.

Replay exports use compact JSON so the verified full AQ40 run remains below the
existing 150 MB file-import limit. Formatting that same run with indentation
increases its size from about 97 MB to 159 MB. Plan exports remain indented.

The [browser asset provider](BROWSER-ASSETS.md) and log adapter are connected in
the separate [static release](STATIC-HOSTING.md). This does not replace the
existing local development site. No deployment has been performed.
