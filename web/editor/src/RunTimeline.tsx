import { PanelSettings } from "./PanelSettings";
import { GameIcon } from "./GameIcon";
import { replayIdentity } from "./replay-buffer";
import { LayerHeaders, LayerTracks } from "./LayerTracks";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { preciseTime, pullAt, time } from "./domain";
import type { EditorController } from "./controller";
import type { Snapshot } from "./types";
import {
  projectRunClip,
  runRange,
  runSegments,
  runTimeAt,
  visibleRunMobs,
  zoomRunRange,
  type RunSegment,
} from "./run-timeline-model";

export function RunTimeline({
  state,
  controller,
  pageDetails = false,
  onPageDetails,
}: {
  state: Snapshot;
  controller: EditorController;
  pageDetails?: boolean;
  onPageDetails?: (on: boolean) => void;
}) {
  const replay = state.replay;
  const duration = controller.duration();
  const pull = replay && pullAt(replay, state.time);
  const host = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    x: number;
    start: number;
    span: number;
    width: number;
    pan: boolean;
    captionStart: number | null;
  } | null>(null);
  const [width, setWidth] = useState(1000);
  const [range, setRange] = useState(() => runRange(0, duration, duration));
  const [panning, setPanning] = useState(false);
  const [compactLane, setCompactLane] = useState<"pulls" | "mobs" | "pages">(
    "pulls",
  );
  const [layerSnap, setLayerSnap] = useState(true);
  const [follow, setFollow] = useState(true);
  const lastHit = useRef<RunSegment | null>(null);
  const view = runRange(range.start, range.span, duration);
  const fullRange = runRange(0, duration, duration);
  const pullRange =
    pull && runRange(pull.start, pull.end - pull.start, duration);
  const sameRange = (range: typeof view) =>
    view.start === range.start && view.span === range.span;
  const showingFullRun = sameRange(fullRange);
  const showingPull = Boolean(
    pullRange && !showingFullRun && sameRange(pullRange),
  );
  const segments = useMemo(
    () => (replay ? runSegments(replay) : { bosses: [], mobs: [] }),
    [replay],
  );
  const currentBoss =
    pull &&
    segments.bosses.find((s) => s.start === pull.start && s.end === pull.end);
  const activePullName =
    pull && ("name" in pull ? pull.name : replay?.fight.name);
  let occupiedUntil = 0;
  const visibleBosses = segments.bosses
    .flatMap((segment) => {
      const clip = projectRunClip(segment, view);
      return clip ? [{ segment, clip }] : [];
    })
    .sort((a, b) => a.clip.left - b.clip.left)
    .map((item) => {
      occupiedUntil = Math.max(occupiedUntil, item.clip.left + item.clip.width);
      return { ...item, occupiedUntil };
    });
  const mobs = useMemo(
    () => visibleRunMobs(segments.mobs, view, width),
    [segments, view.start, view.span, width],
  );
  useEffect(() => {
    setRange(runRange(0, duration, duration));
    setFollow(true);
  }, [replayIdentity(replay), duration]);
  useEffect(() => {
    if (state.ready && replay) controller.requestMapPortraits();
  }, [controller, replay, state.ready]);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(1, entry.contentRect.width)),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [!!replay]);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const wheel = (e: WheelEvent) => {
      const rows = node.closest<HTMLElement>(".run-navigator-body");
      if (
        !replay ||
        (!e.ctrlKey &&
          !e.metaKey &&
          !e.shiftKey &&
          Math.abs(e.deltaY) >= Math.abs(e.deltaX) &&
          rows &&
          rows.scrollHeight > rows.clientHeight)
      )
        return;
      e.preventDefault();
      const box = node.getBoundingClientRect();
      if (!e.ctrlKey && !e.metaKey) setFollow(false);
      setRange((old) => {
        const current = runRange(old.start, old.span, duration);
        return e.ctrlKey || e.metaKey
          ? zoomRunRange(
              current,
              e.deltaY > 0 ? 0.8 : 1.25,
              (e.clientX - box.left) / Math.max(1, box.width),
              duration,
            )
          : runRange(
              current.start +
                ((e.deltaX || e.deltaY) / Math.max(1, box.width)) *
                  current.span,
              current.span,
              duration,
            );
      });
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, [!!replay, duration]);
  useEffect(() => {
    if (follow && !drag.current)
      setRange((old) => {
        const r = runRange(old.start, old.span, duration);
        return state.time < r.start || state.time > r.start + r.span
          ? runRange(state.time - r.span * 0.15, r.span, duration)
          : old;
      });
  }, [state.time, follow, duration]);
  const percent = (t: number) => ((t - view.start) / view.span) * 100;
  function zoom(
    factor: number,
    anchor = Math.max(0, Math.min(1, (state.time - view.start) / view.span)),
  ) {
    setRange(zoomRunRange(view, factor, anchor, duration));
  }
  function fitSegment(segment: RunSegment) {
    const span = Math.max(1000, segment.end - segment.start);
    setRange(runRange(segment.start - span * 0.05, span * 1.1, duration));
    controller.seek(segment.start);
  }
  const step =
    [
      1000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 1800000,
    ].find((s) => (s / view.span) * width >= 85) ?? 3600000;
  const ticks: number[] = [];
  for (
    let t = Math.ceil(view.start / step) * step;
    t <= view.start + view.span;
    t += step
  )
    ticks.push(t);
  const minorStep = step / ((step / view.span) * width >= 120 ? 4 : 2);
  const minorTicks: number[] = [];
  for (
    let t = Math.ceil(view.start / minorStep) * minorStep;
    t <= view.start + view.span;
    t += minorStep
  )
    if (t % step !== 0) minorTicks.push(t);
  const portrait = (segment: RunSegment) =>
    segment.actor ? controller.portraitUrl(segment.actor) : undefined;
  const segmentStyle = (segment: RunSegment) => ({
    left: `${Math.max(0, percent(segment.start))}%`,
    width: `${Math.max(0.2, Math.min(100, percent(segment.end)) - Math.max(0, percent(segment.start)))}%`,
  });
  if (!replay && state.workspaceMode !== "plan") return null;
  return (
    <section
      className="run-navigator"
      data-workspace={state.workspaceMode}
      data-compact-lane={compactLane}
      data-input-context="timeline"
      aria-label={replay ? "Raid scrubber" : "Plan steps"}
    >
      <div className="run-navigator-tools">
        <strong>{replay ? "Run" : "Steps"}</strong>
        {replay ? (
          <>
            <span>
              {time(view.start)} – {time(view.start + view.span)}
            </span>
            <button
              disabled={!pullRange}
              aria-pressed={showingPull}
              title="Zoom this timeline to the current pull without moving the playhead"
              onClick={() => {
                if (pullRange) setRange(pullRange);
              }}
            >
              Fit pull
            </button>
            <button
              aria-pressed={showingFullRun}
              onClick={() => setRange(fullRange)}
            >
              Full run
            </button>
            {state.workspaceMode === "analyse" && (
              <select
                className="run-compact-lane"
                aria-label="Timeline lane"
                title="Choose the visible track in a short timeline dock"
                value={compactLane}
                onChange={(event) =>
                  setCompactLane(
                    event.currentTarget.value as typeof compactLane,
                  )
                }
              >
                <option value="pulls">Pulls</option>
                <option value="mobs">Mobs</option>
                <option value="pages">Plan pages</option>
              </select>
            )}
          </>
        ) : (
          <>
            <button
              aria-label="Previous plan page"
              onClick={() => controller.stepPage(-1)}
            >
              ‹
            </button>
            <span>
              {state.plan.steps.findIndex((s) => s.id === state.activeStep) + 1}{" "}
              / {state.plan.steps.length}
            </span>
            <button
              aria-label="Next plan page"
              onClick={() => controller.stepPage(1)}
            >
              ›
            </button>
          </>
        )}
        {state.workspaceMode === "plan" && (
          <>
            <button
              onClick={() => {
                controller.addStep();
                onPageDetails?.(true);
              }}
            >
              {replay ? "+ Page" : "+ Step"}
            </button>
            <button
              aria-pressed={pageDetails}
              onClick={() => onPageDetails?.(!pageDetails)}
            >
              Page details
            </button>
          </>
        )}
        <div className="menu-spacer" />
        <PanelSettings title="Timeline options" label="Options" width={320}>
          <div className="run-timeline-options">
            {replay && (
              <>
                <fieldset>
                  <legend>Timeline zoom</legend>
                  <div className="timeline-zoom-controls">
                    <button
                      aria-label="Zoom out raid scrubber"
                      onClick={() => zoom(0.5)}
                    >
                      −
                    </button>
                    <input
                      aria-label="Raid scrubber zoom"
                      type="range"
                      min={0}
                      max={Math.log2(
                        Math.max(1, duration / Math.min(1000, duration)),
                      )}
                      step={0.1}
                      value={Math.log2(duration / view.span)}
                      onChange={(e) =>
                        zoom(
                          view.span / (duration / 2 ** Number(e.target.value)),
                        )
                      }
                    />
                    <button
                      aria-label="Zoom in raid scrubber"
                      onClick={() => zoom(2)}
                    >
                      +
                    </button>
                  </div>
                </fieldset>
                <label>
                  <input
                    type="checkbox"
                    checked={follow}
                    onChange={(e) => setFollow(e.target.checked)}
                  />
                  Follow playhead
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={layerSnap}
                    onChange={(e) => setLayerSnap(e.target.checked)}
                  />
                  Snap pages to playhead and edges
                </label>
              </>
            )}
            {state.workspaceMode === "plan" && (
              <fieldset>
                <legend>Plan pages</legend>
                <label>
                  <input
                    type="checkbox"
                    checked={state.followSteps}
                    onChange={(e) =>
                      controller.setStepView({ followSteps: e.target.checked })
                    }
                  />
                  Use replay timing
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={state.showAllSteps}
                    onChange={(e) =>
                      controller.setStepView({ showAllSteps: e.target.checked })
                    }
                  />
                  Preview all pages
                </label>
                <button
                  disabled={!replay}
                  onClick={() => controller.stepsFromLog()}
                >
                  Create pages from log
                </button>
              </fieldset>
            )}
            <button onClick={() => controller.addLayer()}>Add layer</button>
          </div>
        </PanelSettings>
      </div>
      <div className="run-timeline-workspace">
        <div className="run-navigator-body">
          <div className="run-lane-labels">
            {replay && (
              <div className="run-fixed-labels">
                <span />
                <span className="run-encounter-label">
                  {currentBoss && (
                    <GameIcon
                      source={portrait(currentBoss)}
                      name="inv_misc_head_dragon_01"
                    />
                  )}
                  <span className="run-encounter-context">
                    {activePullName ? (
                      <>
                        <strong title={activePullName}>{activePullName}</strong>
                        {pull && (
                          <small
                            title={`${preciseTime(pull.start)} – ${preciseTime(pull.end)} run time`}
                          >
                            {time(pull.end - pull.start)} pull
                          </small>
                        )}
                      </>
                    ) : (
                      <small>Pulls</small>
                    )}
                  </span>
                </span>
                <span className="run-mob-label">Mobs</span>
              </div>
            )}
            <LayerHeaders state={state} controller={controller} />
          </div>
          <div
            ref={host}
            className={`run-tracks${panning ? " panning" : ""}`}
            role="slider"
            aria-orientation="horizontal"
            tabIndex={0}
            aria-label={replay ? "Scrub raid playback" : "Navigate plan steps"}
            aria-valuemin={0}
            aria-valuemax={
              replay ? duration : Math.max(0, state.plan.steps.length - 1)
            }
            aria-valuenow={
              replay
                ? Math.round(state.time)
                : state.plan.steps.findIndex((s) => s.id === state.activeStep)
            }
            aria-valuetext={
              replay
                ? time(state.time)
                : state.plan.steps.find((s) => s.id === state.activeStep)?.name
            }
            title="Drag to scrub · Page Up/Down: previous/next boss pull · Right-drag to pan · Ctrl/⌘ + wheel to zoom · Double-click a segment to zoom to it"
            onContextMenu={(e) => e.preventDefault()}
            onDoubleClick={() => {
              if (lastHit.current) fitSegment(lastHit.current);
            }}
            onKeyDown={(e) => {
              if (!replay) {
                if (
                  ["ArrowLeft", "ArrowRight", "Home", "End", " "].includes(
                    e.key,
                  )
                ) {
                  e.preventDefault();
                  e.stopPropagation();
                  if (e.key === "ArrowLeft") controller.stepPage(-1);
                  else if (e.key === "ArrowRight" || e.key === " ")
                    controller.stepPage(1);
                  else
                    controller.setActiveStep(
                      e.key === "Home"
                        ? state.plan.steps[0].id
                        : state.plan.steps.at(-1)!.id,
                    );
                }
                return;
              }
              const delta = e.shiftKey ? 10000 : 1000;
              if (
                [
                  "ArrowLeft",
                  "ArrowRight",
                  "Home",
                  "End",
                  "PageUp",
                  "PageDown",
                  " ",
                ].includes(e.key)
              ) {
                e.preventDefault();
                e.stopPropagation();
              }
              if (e.key === "ArrowLeft")
                controller.seek(Math.max(0, state.time - delta));
              if (e.key === "ArrowRight")
                controller.seek(Math.min(duration, state.time + delta));
              if (e.key === "Home") controller.seek(0);
              if (e.key === "End") controller.seek(duration);
              if (e.key === "PageUp" || e.key === "PageDown") {
                const previous = e.key === "PageUp";
                const next = segments.bosses.reduce<RunSegment | null>(
                  (nearest, segment) => {
                    const inDirection = previous
                      ? segment.start < state.time
                      : segment.start > state.time;
                    if (!inDirection) return nearest;
                    return !nearest ||
                      (previous
                        ? segment.start > nearest.start
                        : segment.start < nearest.start)
                      ? segment
                      : nearest;
                  },
                  null,
                );
                if (next) controller.seek(next.start);
              }
              if (e.key === " ") controller.toggle();
            }}
            onPointerDown={(e) => {
              if (e.button !== 0 && e.button !== 2) return;
              e.preventDefault();
              e.currentTarget.focus();
              if (!replay) {
                const box = e.currentTarget.getBoundingClientRect();
                const i = Math.max(
                  0,
                  Math.min(
                    state.plan.steps.length - 1,
                    Math.floor(
                      ((e.clientX - box.left) / box.width) *
                        state.plan.steps.length,
                    ),
                  ),
                );
                controller.setActiveStep(state.plan.steps[i].id, false);
                return;
              }
              const hit = (e.target as HTMLElement).closest<HTMLElement>(
                "[data-segment]",
              );
              const key = hit?.dataset.segment;
              lastHit.current =
                [...segments.bosses, ...mobs].find((s) => s.key === key) ??
                null;
              const captionStart =
                e.button === 0 && hit?.classList.contains("run-boss-caption")
                  ? (lastHit.current?.start ?? null)
                  : null;
              if (e.button === 2) {
                setFollow(false);
                lastHit.current = null;
              }
              const box = e.currentTarget.getBoundingClientRect();
              drag.current = {
                x: e.clientX,
                start: view.start,
                span: view.span,
                width: box.width,
                pan: e.button === 2,
                captionStart,
              };
              setPanning(e.button === 2);
              e.currentTarget.setPointerCapture(e.pointerId);
              if (e.button === 0 && captionStart === null)
                controller.seek(
                  runTimeAt(e.clientX - box.left, box.width, view, duration),
                );
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              if (d.captionStart !== null) {
                if (Math.abs(e.clientX - d.x) <= 3) return;
                d.captionStart = null;
                lastHit.current = null;
              }
              if (d.pan)
                setRange(
                  runRange(
                    d.start -
                      ((e.clientX - d.x) / Math.max(1, d.width)) * d.span,
                    d.span,
                    duration,
                  ),
                );
              else
                controller.seek(
                  runTimeAt(
                    e.clientX - e.currentTarget.getBoundingClientRect().left,
                    d.width,
                    { start: d.start, span: d.span },
                    duration,
                  ),
                );
            }}
            onPointerUp={(e) => {
              const d = drag.current;
              if (d?.captionStart != null) {
                const x =
                  e.clientX - e.currentTarget.getBoundingClientRect().left;
                if (Math.abs(e.clientX - d.x) <= 3)
                  controller.seek(d.captionStart);
                else {
                  lastHit.current = null;
                  controller.seek(runTimeAt(x, d.width, d, duration));
                }
              }
              drag.current = null;
              setPanning(false);
              if (e.currentTarget.hasPointerCapture(e.pointerId))
                e.currentTarget.releasePointerCapture(e.pointerId);
            }}
            onPointerCancel={() => {
              drag.current = null;
              setPanning(false);
            }}
            onLostPointerCapture={() => {
              drag.current = null;
              setPanning(false);
            }}
          >
            {replay && (
              <div className="run-fixed-tracks">
                <div className="run-ruler">
                  {replay.raw.stream?.full.map(([a, b]) => (
                    <div
                      key={a}
                      className="run-buffered"
                      title="Downloaded replay events"
                      style={{
                        left: `${percent(a)}%`,
                        width: `${((b - a) / view.span) * 100}%`,
                      }}
                    />
                  ))}
                  {minorTicks.map((t) => (
                    <i
                      key={t}
                      className="run-minor-tick"
                      aria-hidden="true"
                      style={{ left: `${percent(t)}%` }}
                    />
                  ))}
                  {ticks
                    .filter((t) => ((100 - percent(t)) / 100) * width >= 32)
                    .map((t) => (
                      <span key={t} style={{ left: `${percent(t)}%` }}>
                        {time(t)}
                      </span>
                    ))}
                </div>
                <div className="run-bosses">
                  {visibleBosses.map(
                    ({ segment: s, clip, occupiedUntil }, index) => {
                      const pixels = (clip.width / 100) * width;
                      const detail =
                        pixels >= 100
                          ? "named"
                          : pixels >= 35
                            ? "portrait"
                            : "bar";
                      const current = currentBoss?.key === s.key;
                      const edge = clip.left + clip.width;
                      const gap =
                        (visibleBosses[index + 1]?.clip.left ?? 100) - edge;
                      const showCaption =
                        detail !== "named" &&
                        s.start >= view.start &&
                        edge >= occupiedUntil &&
                        (gap / 100) * width >= 50;
                      return (
                        <Fragment key={s.key}>
                          <div
                            className={`run-segment boss${current ? " current" : ""}`}
                            data-detail={detail}
                            style={{
                              left: `${clip.left}%`,
                              width: `${clip.width}%`,
                            }}
                            title={`${s.name} · ${preciseTime(s.start)} – ${preciseTime(s.end)}${s.kill === true ? " · Kill" : s.kill === false ? " · Wipe" : ""}`}
                            data-segment={s.key}
                          >
                            {detail !== "bar" && (
                              <GameIcon
                                source={portrait(s)}
                                name="inv_misc_head_dragon_01"
                              />
                            )}
                            {detail === "named" && <span>{s.name}</span>}
                          </div>
                          {showCaption && (
                            <span
                              className="run-boss-caption"
                              data-current={current || undefined}
                              style={{ left: `${edge}%`, maxWidth: `${gap}%` }}
                              data-segment={s.key}
                              title={`Jump to ${s.name} · ${preciseTime(s.start)}`}
                            >
                              {s.name}
                            </span>
                          )}
                        </Fragment>
                      );
                    },
                  )}
                </div>
                <div className="run-mobs">
                  {mobs.map((s, i) => (
                    <div
                      key={s.key}
                      className="run-segment mob"
                      style={segmentStyle({
                        ...s,
                        end: Math.min(s.end, mobs[i + 1]?.start ?? Infinity),
                      })}
                      title={`${s.names}\n${time(s.start)}–${time(s.end)}`}
                      data-segment={s.key}
                    >
                      <GameIcon
                        source={portrait(s)}
                        name={
                          s.actor?.icon?.replace(/^custom-icon-/i, "") ??
                          "inv_misc_monsterhead_02"
                        }
                      />
                      {s.count > 1 && <b>{s.count}</b>}
                      <span>{s.names.replaceAll("\n", ", ")}</span>
                    </div>
                  ))}
                </div>
                {state.time >= view.start &&
                  state.time <= view.start + view.span && (
                    <div
                      className="run-playhead"
                      style={{ left: `${percent(state.time)}%` }}
                    >
                      <i />
                    </div>
                  )}
              </div>
            )}
            <LayerTracks
              state={state}
              controller={controller}
              start={view.start}
              span={view.span}
              snapping={layerSnap}
              onSelectPage={() => onPageDetails?.(true)}
            />
            {replay &&
              state.time >= view.start &&
              state.time <= view.start + view.span && (
                <div
                  className="run-playhead"
                  style={{ left: `${percent(state.time)}%` }}
                >
                  <i />
                </div>
              )}
          </div>
        </div>
      </div>
      {replay && (
        <input
          className="run-pan"
          aria-label="Raid scrubber position"
          type="range"
          min={0}
          max={Math.max(0, duration - view.span)}
          step={10}
          value={view.start}
          disabled={view.span >= duration}
          onChange={(e) => {
            setFollow(false);
            setRange(runRange(Number(e.target.value), view.span, duration));
          }}
        />
      )}
    </section>
  );
}
