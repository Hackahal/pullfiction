import { useEffect, useState } from "react";
import type { EditorController } from "./controller";
import type { Snapshot } from "./types";
import type { LogListing, LogRealm } from "./wcl-browser";
import { type FollowedSource, sourceKey } from "./followed-sources";
import { raidForZone, time } from "./domain";
import { RaidArt } from "./RaidArt";
import { SourceIcon } from "./IdentityIcon";
import { reportSource } from "../../planner/game-versions.mjs";

export function FindRuns({
  state,
  controller,
  preview,
  followed,
  chosen,
  choose,
  toggle,
}: {
  state: Snapshot;
  controller: EditorController;
  preview: (code: string) => Promise<void>;
  followed: FollowedSource[];
  chosen: FollowedSource | null;
  choose: (s: FollowedSource | null) => void;
  toggle: (s: FollowedSource) => void;
}) {
  const [kind, setKind] = useState<"guild" | "character">("guild"),
    [name, setName] = useState(""),
    [region, setRegion] = useState("eu"),
    [realm, setRealm] = useState("");
  const [realms, setRealms] = useState<LogRealm[]>([]),
    [realmsBusy, setRealmsBusy] = useState(false),
    [realmError, setRealmError] = useState(""),
    [retryRealms, setRetryRealms] = useState(0);
  const [result, setResult] = useState<FollowedSource | null>(null),
    [finding, setFinding] = useState(false),
    [lookupError, setLookupError] = useState(""),
    [error, setError] = useState("");
  const [page, setPage] = useState(1),
    [listing, setListing] = useState<LogListing[]>([]),
    [more, setMore] = useState(false),
    [loading, setLoading] = useState(false),
    [retry, setRetry] = useState(0),
    [raid, setRaid] = useState("");
  const [search, setSearch] = useState<{
    kind: "guild" | "character";
    name: string;
    realm: string;
    region: string;
  } | null>(null);
  const [reportLink, setReportLink] = useState(""),
    [linkError, setLinkError] = useState("");
  const source = chosen?.gameVersion === state.gameVersion ? chosen : result;
  useEffect(() => {
    setPage(1);
    setRaid("");
  }, [source?.id, source?.kind]);
  useEffect(() => {
    setRealm("");
    setRealms([]);
    setRealmError("");
    if (!state.wclConnected) return;
    const ac = new AbortController();
    setRealmsBusy(true);
    void controller
      .logRealms(region, ac.signal)
      .then((data) => {
        if (!ac.signal.aborted) setRealms(data);
      })
      .catch((e) => {
        if (!ac.signal.aborted) setRealmError(String(e.message ?? e));
      })
      .finally(() => {
        if (!ac.signal.aborted) setRealmsBusy(false);
      });
    return () => ac.abort();
  }, [region, state.wclConnected, controller, retryRealms]);
  useEffect(() => {
    setResult(null);
    setLookupError("");
    if (!search || !state.wclConnected) return;
    const ac = new AbortController();
    setFinding(true);
    void (
      search.kind === "guild"
        ? controller.findLogGuild(search, ac.signal)
        : controller.findLogCharacter(search, ac.signal)
    )
      .then((data) => {
        if (!ac.signal.aborted) {
          const next = {
            ...data,
            kind: search.kind,
            gameVersion: state.gameVersion,
          };
          setResult(next);
          choose(next);
        }
      })
      .catch((e) => {
        if (!ac.signal.aborted) setLookupError(String(e.message ?? e));
      })
      .finally(() => {
        if (!ac.signal.aborted) setFinding(false);
      });
    return () => ac.abort();
  }, [search, state.wclConnected, controller, state.gameVersion]);
  useEffect(() => {
    setListing([]);
    setMore(false);
    setError("");
    if (!source || !state.wclConnected) {
      setLoading(false);
      return;
    }
    const ac = new AbortController();
    setLoading(true);
    void (
      source.kind === "guild"
        ? controller.searchLogs({ guildID: source.id, page }, ac.signal)
        : controller.characterReports(source.id, page, ac.signal)
    )
      .then((data) => {
        if (!ac.signal.aborted) {
          setListing(data.data);
          setMore(data.has_more_pages);
        }
      })
      .catch((e) => {
        if (!ac.signal.aborted) setError(String(e.message ?? e));
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [source?.id, source?.kind, page, state.wclConnected, controller, retry]);
  const shown = listing.filter(
    (r) =>
      !raid || raidForZone(r.zone, state.gameVersion)?.map === Number(raid),
  );
  return (
    <section className="find-runs">
      <div className="library-toolbar">
        <div>
          <h1>Find runs</h1>
          <p>
            Find your guild or a player. Browse the runs behind their
            strategies.
          </p>
        </div>
      </div>
      <form
        className="discovery-report-link"
        onSubmit={(e) => {
          e.preventDefault();
          try {
            reportSource(reportLink, state.gameVersion);
            setLinkError("");
            void preview(reportLink.trim());
          } catch (error) {
            setLinkError(
              error instanceof Error ? error.message : String(error),
            );
          }
        }}
      >
        <label htmlFor="discovery-report-link">Warcraft Logs report link</label>
        <div>
          <input
            id="discovery-report-link"
            value={reportLink}
            onChange={(e) => {
              setReportLink(e.target.value);
              setLinkError("");
            }}
            placeholder="Paste a WCL report link or report code"
            required
            aria-invalid={Boolean(linkError)}
            aria-describedby={
              linkError ? "discovery-report-link-error" : undefined
            }
          />
          <button
            className="gold-button"
            disabled={!reportLink.trim() || !state.wclConnected || state.busy}
          >
            Open report
          </button>
        </div>
        {linkError && (
          <p id="discovery-report-link-error" role="alert">
            {linkError}
          </p>
        )}
        {!state.wclConnected && (
          <p className="library-caption">
            Connect Warcraft Logs to open a report.
          </p>
        )}
      </form>
      <form
        className="discovery-search"
        onSubmit={(e) => {
          e.preventDefault();
          choose(null);
          setResult(null);
          setSearch({ kind, name, realm, region });
        }}
      >
        <label>
          Find
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="guild">Guild</option>
            <option value="character">Player</option>
          </select>
        </label>
        <label className="discovery-name">
          {kind === "guild" ? "Guild name" : "Character name"}
          <input
            value={name}
            maxLength={100}
            required
            placeholder={
              kind === "guild" ? "Full guild name" : "Character name"
            }
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Region
          <select value={region} onChange={(e) => setRegion(e.target.value)}>
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
            disabled={!state.wclConnected || realmsBusy || !realms.length}
            onChange={(e) => setRealm(e.target.value)}
          >
            <option value="">
              {realmsBusy ? "Loading realms…" : "Choose a realm"}
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
          disabled={!state.wclConnected || finding || !realm || !name.trim()}
        >
          {finding ? "Finding…" : "Search"}
        </button>
      </form>
      <p className="library-caption">
        Use the exact name and realm from Warcraft Logs.
      </p>
      {realmError && (
        <p role="alert">
          {realmError}{" "}
          <button onClick={() => setRetryRealms((n) => n + 1)}>
            Retry realms
          </button>
        </p>
      )}
      {!source && (
        <div className="followed-grid">
          {followed
            .filter((s) => s.gameVersion === state.gameVersion)
            .map((s) => (
              <button key={sourceKey(s)} onClick={() => choose(s)}>
                <strong className="identity-name">
                  <SourceIcon source={s} />
                  {s.name}
                </strong>
                <small>
                  {s.kind === "guild" ? "Guild" : "Player"} · {s.server.name} ·{" "}
                  {s.server.region.slug.toUpperCase()}
                </small>
              </button>
            ))}
        </div>
      )}
      {source && (
        <>
          <div className="library-section-heading">
            <div>
              <h2 className="identity-name">
                <SourceIcon source={source} />
                {source.name}
              </h2>
              <p>
                {source.kind === "guild" ? "Guild" : "Player"} ·{" "}
                {source.server.name} · {source.server.region.slug.toUpperCase()}
              </p>
            </div>
            <button
              onClick={() => toggle(source)}
              aria-pressed={followed.some(
                (s) => sourceKey(s) === sourceKey(source),
              )}
            >
              {followed.some((s) => sourceKey(s) === sourceKey(source))
                ? "Following"
                : "Follow"}
            </button>
          </div>
          <div className="discovery-filters">
            <label>
              Raid
              <select value={raid} onChange={(e) => setRaid(e.target.value)}>
                <option value="">All raids on this page</option>
                {[
                  ...new Map(
                    listing.flatMap((r) => {
                      const x = raidForZone(r.zone, state.gameVersion);
                      return x ? [[x.map, x] as const] : [];
                    }),
                  ).values(),
                ].map((r) => (
                  <option key={r.map} value={r.map}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <button disabled={loading} onClick={() => setRetry((n) => n + 1)}>
              Refresh
            </button>
          </div>
          <div aria-busy={loading} aria-label="Runs">
            {loading ? (
              <p role="status">Loading runs…</p>
            ) : (
              shown.map((r) => {
                const map = raidForZone(r.zone, state.gameVersion)?.map;
                return (
                  <button
                    className="discovery-report"
                    key={r.code}
                    disabled={state.busy}
                    onClick={() => void preview(r.code)}
                  >
                    {map ? (
                      <RaidArt map={map} version={state.gameVersion} />
                    ) : (
                      <span className="raid-art">Raids</span>
                    )}
                    <span>
                      <strong>{r.title || "Untitled run"}</strong>
                      <small>
                        {r.zone?.name ?? "Mixed raids"} ·{" "}
                        {new Date(r.startTime).toLocaleDateString()}
                      </small>
                    </span>
                    <span className="library-caption">
                      {time(r.endTime - r.startTime)}
                      <small>Report duration</small>
                    </span>
                  </button>
                );
              })
            )}
          </div>
          {!loading && !shown.length && !error && (
            <p className="library-empty">No runs found for this selection.</p>
          )}
          <div className="discovery-pagination">
            <button
              disabled={page === 1 || loading}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </button>
            <span>Page {page}</span>
            <button
              disabled={!more || loading}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}
      {lookupError && (
        <p className="library-error" role="alert">
          {lookupError}
          <button
            disabled={finding}
            onClick={() => {
              if (search) setSearch({ ...search });
            }}
          >
            Retry search
          </button>
        </p>
      )}
      {error && (
        <p className="library-error" role="alert">
          {error}
          <button onClick={() => setRetry((n) => n + 1)}>Retry runs</button>
        </p>
      )}
    </section>
  );
}
