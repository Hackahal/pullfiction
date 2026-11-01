# Share plans and runs through links

Select **Share** in the editor, or beside a plan or run in the Library. Review
what the snapshot includes, complete the verification, and select **Create share
link**. Copy the link into your guild chat.

A link contains a fixed version of the plan's pages, drawings, notes, actor
placements, workspace mode, playback time, and Warcraft Logs reference. It does
not include replay events, credentials, game files, or local project identities.
Later changes need a new link. Anyone who receives or is forwarded the link can
read the snapshot. There is no public directory or search endpoint.

The recipient sees a preview and selects **Open a local copy**. This creates an
independent project without replacing existing plans. To load its replay, connect
Warcraft Logs and select **Reload source**. The recipient needs access to the
source report. Sharing never grants access to a private Warcraft Logs report,
but notes and saved actor placements can themselves disclose report information.

## Delete a shared link

Open **Share** and find the link under **Your shared links**. Select **Delete
link**, then **Confirm delete**. Existing downloaded copies remain available.

Deletion access is saved in the creator's browser, separately from the viewing
link. The **Keep deletion access** disclosure shows a token you can save privately.
Clearing site data removes saved deletion access. If local saving fails, the
created link and its deletion token remain visible so you can copy them before
closing the dialog. A deletion token authorizes deletion, so never publish it.
To use a saved token on another device, open the viewing link and expand **Delete
with a saved token**. An operator can also remove reported abusive shares directly
from D1.

## Configure a deployment

Workers Free and D1 support this feature without a paid subscription or card.
Turnstile provides anonymous publishing verification. Cloudflare may change
service allowances; check [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

Existing deployments work with sharing disabled when the configuration is absent.
The Share dialog reports that sharing is unavailable. Configuring the feature
requires explicit operator setup, separate from building or merging the code.

1. Install the pinned release tools with `npm ci --prefix tools/release --ignore-scripts`.
2. Create a D1 database with `tools/release/node_modules/.bin/wrangler d1 create pullfiction-shares`.
   Retain its database UUID.
3. Create a managed Turnstile widget restricted to `pullfiction.com` in Cloudflare.
   Retain the public site key and private secret key.
4. Set `PULLFICTION_SHARE_DATABASE_ID` and `PULLFICTION_SHARE_SITE_KEY` in the
   deployment process environment. For GitHub releases, set repository variables
   with those names. Neither value is a credential.
5. Run `node scripts/sharing-config.mjs` to generate `.agent/work/sharing-deploy.json`.
6. Apply the schema with
   `tools/release/node_modules/.bin/wrangler d1 migrations apply pullfiction-shares --remote --config .agent/work/sharing-deploy.json`.
7. Set the Worker secret with
   `tools/release/node_modules/.bin/wrangler secret put TURNSTILE_SECRET --name pullfiction`.
   Enter the private key at the prompt. Never put it in a `VITE_` variable, Git,
   an Actions variable, or a frontend bundle.
8. Publish through the existing explicit release workflow or local deployment
   procedure. `deploy-static.sh` generates the configuration and deploys the
   audited assets with the Worker. It does not create or migrate databases.
9. Verify `GET https://pullfiction.com/api/shares/config` reports `enabled: true`.
   Publish a disposable plan, open its link in another browser, reload the source
   with an authorized WCL account, and verify deletion invalidates the link.

The deployment identity needs permission to bind the existing D1 database in
addition to its current Worker deployment permissions. Database creation,
migration, and secret setup can use a separate operator identity. The repository
contains no production database UUID or Turnstile secret. The public site key is
served by the Worker configuration endpoint, so no editor rebuild is needed to
change it.

If either configuration variable is missing while the other is set, deployment
configuration generation fails. If the database, secret, origin, site key, or
rate-limit bindings are unavailable at runtime, the API refuses access. To disable
sharing while keeping the application, omit both deployment variables on the
next deployment. Keep D1 for later recovery. Rolling back Worker code does not
roll back D1 data.

## Run the API locally

Use the separate local configuration. It uses an isolated local D1 database and
Cloudflare's public testing site key. Never use a testing key in production.
See [Turnstile testing](https://developers.cloudflare.com/turnstile/troubleshooting/testing/).

```bash
	tools/release/node_modules/.bin/wrangler d1 migrations apply pullfiction-shares-local --local --config wrangler.sharing-local.jsonc
	tools/release/node_modules/.bin/wrangler dev --config wrangler.sharing-local.jsonc --port 8787
```

Supply a local Turnstile secret through an ignored `.dev.vars` file. The API
validates the returned hostname and action even in local mode. Use a real widget
restricted to your development hostname when testing the complete publish flow.
Public testing responses might not provide the hostname required by these checks.

For the editor, set `PULLFICTION_SHARING_ORIGIN=http://localhost:8787` when starting
Vite. Open Vite at `http://localhost:5173`. The development proxy rewrites the
outgoing Origin to the local Worker origin. The production API always requires
its configured origin. No production-origin override or test-secret bypass is
included in the Worker.

## Security and capacity

The Worker reconstructs an allowed JSON payload with the same plan validator as
the editor. It validates the WCL code, encounter, map, and version, restricts
icons to identifiers, limits coordinates and text through the plan schema, and
rejects snapshots over 256 KiB. The request reader also limits streamed bytes
before JSON parsing. Notes render as text through React. SQL uses bound
parameters. No server request fetches a user-supplied WCL URL.

Every publish requires a server-validated, single-use Turnstile token with the
expected hostname and `publish_share` action. Browser origin checks complement
verification; origin headers and CORS do not authenticate non-browser callers.
The read ID contains 192 random bits. A separate 256-bit deletion token is sent
once to the creator; only its SHA-256 hash is stored in D1. Neither token appears
in request logs written by this application. The read link uses a URL fragment,
which browsers do not include in HTTP requests or referrers. API responses use
`no-store` and `noindex` headers. Copies and forwarded links remain outside the
creator's control.

Per Cloudflare location and client IP, the API permits 120 reads and five write
attempts per minute. These rate limits reduce bursts and are not exact global
quotas. Database triggers enforce global admission atomically, with defaults of
100 MB of active payload and 1,000 publications per UTC day. Deletes refund
storage but do not refund daily publication allowance. Those payload limits
leave room for database overhead below the free database capacity. Operators can
lower `share_budget.max_bytes` and `share_budget.max_daily` in D1. Anonymous
publishing can still exhaust free request or database allowances and temporarily
prevent sharing. Turnstile does not authenticate ownership or guarantee that a
visitor is legitimate.

Snapshots do not expire automatically. A creator's deletion capability, or an
operator's direct D1 action, removes a snapshot. The feature has no accounts,
shared editing, or private guild membership checks. Browser-local deletion
credentials depend on the application's existing script trust, as do other
local project data. Do not add untrusted scripts to the application.

## Verify changes

Run these checks from the repository root:

```bash
	node --test cloudflare/*.test.mjs
	npm run check --prefix web/editor
	npm test --prefix web/editor
```

The Worker tests execute its handlers against real SQLite tables and triggers.
They cover publishing, capability deletion, invalid verification, quota admission,
rate-limit refusal, payload filtering, and configuration. Client and controller
tests cover link parsing, current unsaved edits, independent imports, and missing
source behavior. Local tests do not establish live Cloudflare, Turnstile, WCL, or
browser rendering acceptance. Run the deployment checks above on the configured
origin before announcing production availability.
