import { useEffect, useState } from "react";
import type { EditorController } from "./controller";
import type { Snapshot } from "./types";
import type { RankingRaid, RankingMetric, RankingEntry } from "./wcl-discovery";
import { defaultSpeedSelection } from "./speedrun-world-record";
import { RaidArt } from "./RaidArt";
import { ClassIcon, FactionIcon } from "./IdentityIcon";
import { time } from "./domain";

export function Rankings({
  state,
  controller,
  preview,
}: {
  state: Snapshot;
  controller: EditorController;
  preview: (code: string) => Promise<void>;
}) {
  const [raids, setRaids] = useState<RankingRaid[]>([]),
    [map, setMap] = useState(state.plan.mapId),
    [metric, setMetric] = useState<RankingMetric>("speed");
  const [encounter, setEncounter] = useState(0),
    [partition, setPartition] = useState(0),
    [difficulty, setDifficulty] = useState(0),
    [size, setSize] = useState<number | null>(null),
    [region, setRegion] = useState(""),
    [className, setClassName] = useState("");
  const [page, setPage] = useState(1),
    [entries, setEntries] = useState<RankingEntry[]>([]),
    [more, setMore] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0),
    [catalogError, setCatalogError] = useState(""),
    [catalogLoading, setCatalogLoading] = useState(false);
  const raid = raids.find((r) => r.map === map);
  useEffect(() => {
    if (!state.wclConnected) return;
    const ac = new AbortController();
    setCatalogError("");
    setCatalogLoading(true);
    void controller
      .rankingRaids(ac.signal)
      .then((data) => {
        if (!ac.signal.aborted) {
          setRaids(data);
          if (!data.some((r) => r.map === map) && data[0]) setMap(data[0].map);
        }
      })
      .catch((e) => {
        if (!ac.signal.aborted) setCatalogError(String(e.message ?? e));
      })
      .finally(() => {
        if (!ac.signal.aborted) setCatalogLoading(false);
      });
    return () => ac.abort();
  }, [controller, state.wclConnected, retry]);
  useEffect(() => {
    if (!raid) return;
    const def = defaultSpeedSelection(raid);
    setPartition(def.partition);
    setDifficulty(def.difficulty);
    setSize(def.size);
    setEncounter(0);
    setPage(1);
  }, [raid]);
  useEffect(() => {
    setPage(1);
  }, [map, metric, encounter, partition, difficulty, size, region, className]);
  useEffect(() => {
    setEntries([]);
    setMore(false);
    setError("");
    if (!state.wclConnected || !raid || !partition) {
      setLoading(false);
      return;
    }
    const ac = new AbortController();
    setLoading(true);
    void (async () => {
      const id =
        encounter ||
        (metric === "speed"
          ? (await controller.speedCategory(state.gameVersion, map, ac.signal))
              .encounterID
          : raid.encounters[0]?.id);
      if (!id) throw new Error("Choose an encounter to view this ranking.");
      const result = await controller.rankingPage(
        {
          encounter: id,
          metric,
          partition,
          difficulty,
          size,
          region,
          className,
          page,
        },
        ac.signal,
      );
      if (!ac.signal.aborted) {
        setEntries(result.entries);
        setMore(result.more);
      }
    })()
      .catch((e) => {
        if (!ac.signal.aborted) setError(String(e.message ?? e));
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [
    controller,
    state.wclConnected,
    raid,
    map,
    metric,
    encounter,
    partition,
    difficulty,
    size,
    region,
    className,
    page,
    retry,
  ]);
  const selectMetric = (m: RankingMetric) => {
    setMetric(m);
    setEncounter(m === "speed" ? 0 : (raid?.encounters[0]?.id ?? 0));
    setClassName("");
  };
  return (
    <section className="rankings-page">
      <div className="library-toolbar">
        <div>
          <h1>Rankings</h1>
          <p>
            Find a reference run. Study the fastest clears and top performances.
          </p>
        </div>
      </div>
      {catalogError && (
        <p role="alert" className="library-error">
          {catalogError}
          <button onClick={() => setRetry((n) => n + 1)}>
            Retry categories
          </button>
        </p>
      )}
      <div className="ranking-raids" aria-label="Choose a ranking raid">
        {raids.map((r) => (
          <button
            key={r.zoneID}
            aria-pressed={map === r.map}
            onClick={() => setMap(r.map)}
          >
            <RaidArt map={r.map} version={state.gameVersion} />
            <strong>{r.name}</strong>
          </button>
        ))}
      </div>
      {catalogLoading && <p role="status">Loading raid categories…</p>}
      {!catalogLoading &&
        !raids.length &&
        !catalogError &&
        state.wclConnected && (
          <div className="library-empty">
            <h2>No compatible ranking categories</h2>
            <p>Try another game version or reload the WCL catalogue.</p>
            <button onClick={() => setRetry((n) => n + 1)}>
              Reload categories
            </button>
          </div>
        )}
      {!state.wclConnected && (
        <p className="library-empty">
          Connect Warcraft Logs to browse live rankings.
        </p>
      )}
      {raid && (
        <>
          <div className="library-section-heading">
            <div className="raid-heading">
              <RaidArt map={map} version={state.gameVersion} />
              <h2>{raid.name}</h2>
            </div>
            <div className="open-mode" aria-label="Ranking metric">
              {(
                [
                  ["speed", "Speed"],
                  ["dps", "Damage"],
                  ["hps", "Healing"],
                ] as const
              ).map(([m, n]) => (
                <button
                  key={m}
                  aria-pressed={metric === m}
                  onClick={() => selectMetric(m)}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <div className="ranking-filters">
            <label>
              Encounter
              <select
                value={encounter}
                onChange={(e) => setEncounter(Number(e.target.value))}
              >
                {metric === "speed" && <option value={0}>Full raid</option>}
                {raid.encounters.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Partition
              <select
                value={partition}
                onChange={(e) => setPartition(Number(e.target.value))}
              >
                {raid.partitions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Difficulty
              <select
                value={difficulty}
                onChange={(e) => {
                  const d = raid.difficulties.find(
                    (d) => d.id === Number(e.target.value),
                  )!;
                  setDifficulty(d.id);
                  setSize(d.sizes[0] ?? null);
                }}
              >
                {raid.difficulties.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            {!!raid.difficulties.find((d) => d.id === difficulty)?.sizes
              .length && (
              <label>
                Raid size
                <select
                  value={size ?? ""}
                  onChange={(e) => setSize(Number(e.target.value))}
                >
                  {raid.difficulties
                    .find((d) => d.id === difficulty)
                    ?.sizes.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <label>
              Region
              <select
                value={region}
                onChange={(e) => setRegion(e.target.value)}
              >
                <option value="">World</option>
                {["eu", "us", "kr", "tw", "cn"].map((r) => (
                  <option key={r} value={r}>
                    {r.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            {metric !== "speed" && (
              <label>
                Class
                <select
                  value={className}
                  onChange={(e) => setClassName(e.target.value)}
                >
                  <option value="">All classes</option>
                  {[
                    "Warrior",
                    "Paladin",
                    "Hunter",
                    "Rogue",
                    "Priest",
                    "Shaman",
                    "Mage",
                    "Warlock",
                    "Druid",
                  ].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className="ranking-list" aria-busy={loading}>
            {loading ? (
              <p role="status">Loading rankings…</p>
            ) : error ? (
              <p className="library-error" role="alert">
                {error}
                <button onClick={() => setRetry((n) => n + 1)}>Retry</button>
              </p>
            ) : entries.length ? (
              entries.map((r, i) => (
                <div className="ranking-entry" key={`${page}-${i}`}>
                  <span className="ranking-position">{r.position ?? "—"}</span>
                  <div>
                    <strong className="identity-name">
                      {metric === "speed" ? (
                        <FactionIcon value={r.faction} />
                      ) : (
                        <ClassIcon value={r.className} />
                      )}
                      {r.name}
                    </strong>
                    <small>{r.server || "Realm unavailable"}</small>
                  </div>
                  <span className="ranking-value">
                    {metric === "speed"
                      ? time(r.amount)
                      : `${r.amount.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${metric.toUpperCase()}`}
                  </span>
                  <button
                    disabled={!r.reportCode || state.busy}
                    onClick={() => void preview(r.reportCode!)}
                  >
                    {r.reportCode ? "View run" : "No backing log"}
                  </button>
                </div>
              ))
            ) : (
              <p className="library-empty">
                No rankings in this category. Try another partition or
                encounter.
              </p>
            )}
          </div>
          <div className="discovery-pagination">
            <button
              disabled={page === 1 || loading}
              onClick={() => setPage((n) => n - 1)}
            >
              Previous
            </button>
            <span>Page {page}</span>
            <button
              disabled={!more || loading}
              onClick={() => setPage((n) => n + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </section>
  );
}
