import { useEffect, useRef, useState } from "react";
import type { EditorController } from "./controller";
import type { Snapshot } from "./types";
import type { LogListing, LogZone, LogRealm } from "./wcl-browser";
import { time } from "./domain";
import { EditorIcon } from "./EditorIcon";
import {
  emptyGuildLibrary,
  readGuildLibrary,
  writeGuildLibrary,
  saveGuild,
  removeGuild,
  selectedGuild,
  type GuildLibrary,
  type SavedGuild,
} from "./guild-library";

type Draft = { name?: string; realm?: string; region?: string; query?: string };
function readDraft(): Draft {
  try {
    const d = JSON.parse(
      sessionStorage.getItem("pullfiction.guildSearch.v1") ?? "{}",
    );
    return Object.fromEntries(
      Object.entries(d).filter(
        (e): e is [string, string] =>
          typeof e[1] === "string" && e[1].length <= 500,
      ),
    );
  } catch {
    return {};
  }
}

export function GuildBrowser({
  state,
  controller,
  preview,
}: {
  state: Snapshot;
  controller: EditorController;
  preview: (code: string) => Promise<void>;
}) {
  const [initial] = useState(() => {
    try {
      return { library: readGuildLibrary(localStorage), error: "" };
    } catch {
      return {
        library: emptyGuildLibrary(),
        error:
          "Saved guilds are unavailable. You can still search and open runs.",
      };
    }
  });
  const [library, setLibrary] = useState(initial.library);
  const [storageError, setStorageError] = useState(initial.error);
  const [guild, setGuild] = useState<SavedGuild | null>(() =>
    selectedGuild(initial.library, state.gameVersion),
  );
  const [draft] = useState(readDraft);
  const [name, setName] = useState(draft.name ?? "");
  const [realm, setRealm] = useState(draft.realm ?? "");
  const [region, setRegion] = useState(draft.region ?? "eu");
  const [realms, setRealms] = useState<LogRealm[]>([]);
  const [realmsLoading, setRealmsLoading] = useState(false);
  const [realmsError, setRealmsError] = useState("");
  const [realmRetry, setRealmRetry] = useState(0);
  const [query, setQuery] = useState(draft.query ?? "");
  const [searchOpen, setSearchOpen] = useState(!guild);
  const [finding, setFinding] = useState(false);
  const [lookupError, setLookupError] = useState("");
  const [runsError, setRunsError] = useState("");
  const [zoneError, setZoneError] = useState("");
  const [zones, setZones] = useState<LogZone[]>([]);
  const [zone, setZone] = useState("");
  const [period, setPeriod] = useState("all");
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [listing, setListing] = useState<LogListing[]>([]);
  const [refresh, setRefresh] = useState(0);
  const lookup = useRef<AbortController | null>(null);
  const saved = library.guilds.filter(
    (g) => g.gameVersion === state.gameVersion,
  );
  const isSaved = Boolean(guild && saved.some((g) => g.id === guild.id));
  const disabled = state.busy || !state.wclConnected;

  useEffect(() => {
    try {
      sessionStorage.setItem(
        "pullfiction.guildSearch.v1",
        JSON.stringify({ name, realm, region, query }),
      );
    } catch {}
  }, [name, realm, region, query]);
  useEffect(() => () => lookup.current?.abort(), []);
  useEffect(() => {
    if (!state.wclConnected || !searchOpen) return;
    const ac = new AbortController();
    setRealms([]);
    setRealmsLoading(true);
    setRealmsError("");
    void controller
      .logRealms(region, ac.signal)
      .then((data) => {
        if (ac.signal.aborted) return;
        setRealms(data);
        setRealm(
          (value) =>
            data.find(
              (r) =>
                r.slug === value ||
                r.name.toLowerCase() === value.toLowerCase(),
            )?.slug ?? "",
        );
      })
      .catch((e) => {
        if (!ac.signal.aborted) setRealmsError(String(e.message ?? e));
      })
      .finally(() => {
        if (!ac.signal.aborted) setRealmsLoading(false);
      });
    return () => ac.abort();
  }, [
    controller,
    state.wclConnected,
    state.gameVersion,
    searchOpen,
    region,
    realmRetry,
  ]);
  useEffect(() => {
    if (!state.wclConnected) {
      setZones([]);
      return;
    }
    const ac = new AbortController();
    setZoneError("");
    void controller
      .logZones(ac.signal)
      .then((data) => {
        if (!ac.signal.aborted) setZones(data);
      })
      .catch((e) => {
        if (!ac.signal.aborted) setZoneError(String(e.message ?? e));
      });
    return () => ac.abort();
  }, [controller, state.wclConnected, state.gameVersion]);
  useEffect(() => {
    setListing([]);
    setMore(false);
    setRunsError("");
    if (!guild || !state.wclConnected) {
      setLoading(false);
      return;
    }
    const ac = new AbortController();
    setLoading(true);
    void controller
      .searchLogs(
        {
          guildID: guild.id,
          page,
          ...(zone ? { zoneID: Number(zone) } : {}),
          ...(period !== "all"
            ? { startTime: Date.now() - Number(period) * 86400000 }
            : {}),
        },
        ac.signal,
      )
      .then((result) => {
        if (ac.signal.aborted) return;
        setListing([...result.data].sort((a, b) => b.startTime - a.startTime));
        setMore(result.has_more_pages);
      })
      .catch((e) => {
        if (!ac.signal.aborted) setRunsError(String(e.message ?? e));
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [
    controller,
    guild?.id,
    state.wclConnected,
    state.gameVersion,
    zone,
    period,
    page,
    refresh,
  ]);
  useEffect(() => {
    if (!state.wclConnected) {
      lookup.current?.abort();
      setFinding(false);
    }
  }, [state.wclConnected]);

  function persist(next: GuildLibrary) {
    setLibrary(next);
    try {
      writeGuildLibrary(localStorage, next);
      setStorageError("");
    } catch {
      setStorageError(
        "Guild changes could not be saved in this browser. Try saving again before reloading.",
      );
    }
  }
  function choose(g: SavedGuild) {
    lookup.current?.abort();
    setFinding(false);
    setLookupError("");
    setGuild(g);
    setPage(1);
    setZone("");
    setPeriod("all");
    setSearchOpen(false);
    if (
      library.guilds.some(
        (s) => s.id === g.id && s.gameVersion === g.gameVersion,
      )
    )
      persist({
        ...library,
        selected: { ...library.selected, [g.gameVersion]: g.id },
      });
  }
  async function find() {
    lookup.current?.abort();
    const ac = new AbortController();
    lookup.current = ac;
    setFinding(true);
    setLookupError("");
    try {
      const result = await controller.findLogGuild(
        { name, realm, region },
        ac.signal,
      );
      if (!ac.signal.aborted)
        choose({ ...result, gameVersion: state.gameVersion });
    } catch (e: any) {
      if (!ac.signal.aborted) setLookupError(String(e.message ?? e));
    } finally {
      if (lookup.current === ac) setFinding(false);
    }
  }
  return (
    <>
      <form
        className="log-direct compact-link"
        onSubmit={(e) => {
          e.preventDefault();
          void preview(query);
        }}
      >
        <label htmlFor="library-report">Open a run link</label>
        <div className="input-row">
          <input
            id="library-report"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Paste a Warcraft Logs link"
            spellCheck={false}
          />
          <button
            disabled={
              state.busy ||
              !query.trim() ||
              (state.browserAssets && !state.wclConnected)
            }
          >
            Open
          </button>
        </div>
      </form>
      {storageError && (
        <div className="guild-inline-error" role="alert">
          {storageError}
          <button onClick={() => persist(library)}>Retry save</button>
        </div>
      )}
      <section className="saved-guilds" aria-label="Saved guilds">
        <div className="guild-section-heading">
          <span>Saved guilds</span>
          <button
            aria-expanded={searchOpen}
            onClick={() => {
              if (searchOpen) {
                lookup.current?.abort();
                setFinding(false);
              }
              setSearchOpen(!searchOpen);
            }}
          >
            <EditorIcon name={searchOpen ? "minus" : "plus"} />
            {searchOpen ? "Close search" : "Find guild"}
          </button>
        </div>
        {saved.length ? (
          <div className="saved-guild-list">
            {saved.map((g) => (
              <button
                key={g.id}
                className="saved-guild"
                aria-pressed={guild?.id === g.id}
                onClick={() => choose(g)}
              >
                <EditorIcon name="guild" />
                <span>
                  <strong>{g.name}</strong>
                  <small>
                    {g.server.name} · {g.server.region.slug.toUpperCase()}
                  </small>
                </span>
              </button>
            ))}
          </div>
        ) : (
          !searchOpen && <p>No saved guilds yet.</p>
        )}
      </section>
      {searchOpen && (
        <form
          className="guild-search"
          onSubmit={(e) => {
            e.preventDefault();
            void find();
          }}
        >
          <label>
            Guild name
            <input
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Full guild name"
            />
          </label>
          <div className="input-row">
            <label className="guild-region">
              Region
              <select
                value={region}
                onChange={(e) => {
                  setRegion(e.target.value);
                  setRealm("");
                  setRealms([]);
                }}
              >
                {["eu", "us", "kr", "tw", "cn"].map((r) => (
                  <option key={r} value={r}>
                    {r.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Realm
              <select
                required
                value={realm}
                disabled={disabled || realmsLoading || !realms.length}
                onChange={(e) => setRealm(e.target.value)}
              >
                <option value="">
                  {!state.wclConnected
                    ? "Connect to load realms"
                    : realmsLoading
                      ? "Loading realms…"
                      : realms.length
                        ? "Choose a realm"
                        : "No realms available"}
                </option>
                {realms.map((r) => (
                  <option key={r.id} value={r.slug}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="gold-button"
              disabled={
                disabled ||
                finding ||
                realmsLoading ||
                !name.trim() ||
                !realms.some((r) => r.slug === realm)
              }
            >
              {finding ? "Finding…" : "Find guild"}
            </button>
          </div>
          {realmsError && (
            <p className="guild-inline-error" role="alert">
              {realmsError}
              <button
                type="button"
                onClick={() => setRealmRetry(realmRetry + 1)}
              >
                Retry realms
              </button>
            </p>
          )}
          {lookupError && (
            <p className="guild-inline-error" role="alert">
              {lookupError}
            </p>
          )}
        </form>
      )}
      {guild ? (
        <>
          <header className="guild-current">
            <div>
              <h2>{guild.name}</h2>
              <span>
                {guild.server.name} · {guild.server.region.slug.toUpperCase()}
              </span>
            </div>
            <button
              className={isSaved ? "guild-is-saved" : ""}
              aria-label={
                isSaved
                  ? `Remove ${guild.name} from saved guilds`
                  : `Save ${guild.name}`
              }
              onClick={() =>
                persist(
                  isSaved
                    ? removeGuild(library, guild)
                    : saveGuild(library, guild),
                )
              }
            >
              <EditorIcon name={isSaved ? "check" : "plus"} />
              {isSaved ? "Saved" : "Save guild"}
            </button>
          </header>
          <div className="guild-run-filters">
            <label>
              Raid
              <select
                aria-label="Filter guild runs by raid"
                value={zone}
                disabled={disabled || !zones.length}
                onChange={(e) => {
                  setZone(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">All raids</option>
                {zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Date
              <select
                aria-label="Filter guild runs by date"
                value={period}
                disabled={disabled}
                onChange={(e) => {
                  setPeriod(e.target.value);
                  setPage(1);
                }}
              >
                <option value="all">All dates</option>
                <option value="30">Last 30 days</option>
                <option value="90">Last 90 days</option>
              </select>
            </label>
            <button
              aria-label="Refresh guild runs"
              title="Refresh runs"
              disabled={disabled || loading}
              onClick={() => setRefresh(refresh + 1)}
            >
              <EditorIcon name="refresh" />
            </button>
          </div>
          {zoneError && (
            <p className="guild-inline-error" role="alert">
              Raid filters unavailable. {zoneError}
            </p>
          )}
          <div className="guild-runs-heading">
            Recent runs{loading && <span role="status">Loading…</span>}
          </div>
          <div
            className="report-list"
            aria-label="Guild runs"
            aria-busy={loading}
          >
            {runsError ? (
              <div className="log-list-empty" role="alert">
                {runsError}
                <button onClick={() => setRefresh(refresh + 1)}>Retry</button>
              </div>
            ) : !state.wclConnected ? (
              <p className="log-list-empty">
                Connect Warcraft Logs to load this guild's recent runs.
              </p>
            ) : !loading && !listing.length ? (
              <p className="log-list-empty">
                No runs found. Try another raid or date range.
              </p>
            ) : (
              listing.map((r) => (
                <button
                  className={`report-result ${r.code === state.reportCode ? "active" : ""}`}
                  key={r.code}
                  disabled={state.busy}
                  onClick={() => void preview(r.code)}
                >
                  <EditorIcon name="logs" />
                  <span>
                    <strong>{r.title.trim() || "Untitled run"}</strong>
                    <small>{r.zone?.name ?? "Mixed instances"}</small>
                    <small>
                      {new Date(r.startTime).toLocaleDateString()} ·{" "}
                      {time(r.endTime - r.startTime)}
                      {r.owner?.name ? ` · ${r.owner.name}` : ""}
                    </small>
                  </span>
                  <span className="report-access">
                    {r.visibility !== "public" ? r.visibility : ""}
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="log-pagination">
            <button
              disabled={page === 1 || disabled || loading}
              onClick={() => setPage(page - 1)}
            >
              Newer
            </button>
            <span>Page {page}</span>
            <button
              disabled={!more || disabled || loading}
              onClick={() => setPage(page + 1)}
            >
              Older
            </button>
          </div>
        </>
      ) : (
        <div className="guild-start">
          <EditorIcon name="guild" />
          <p>Find a guild to browse its runs.</p>
        </div>
      )}
    </>
  );
}
