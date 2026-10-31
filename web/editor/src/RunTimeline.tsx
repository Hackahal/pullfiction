import { GameIcon } from "./GameIcon";
import { replayIdentity } from "./replay-buffer";
import { LayerHeaders, LayerTracks } from "./LayerTracks";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { time } from "./domain";
import type { EditorController } from "./controller";
import type { Snapshot } from "./types";
import {
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
  const host = useRef<HTMLDivElement>(null);
  const optionsId = useId(),
    optionsMenu = useRef<HTMLDivElement>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const drag = useRef<{
    x: number;
    start: number;
    span: number;
    width: number;
    pan: boolean;
  } | null>(null);
  const [width, setWidth] = useState(1000);
  const [range, setRange] = useState(() => runRange(0, duration, duration));
  const [panning, setPanning] = useState(false);
  const [layerSnap, setLayerSnap] = useState(true);
  const [follow, setFollow] = useState(true);
  const lastHit = useRef<RunSegment | null>(null);
  const view = runRange(range.start, range.span, duration);
  const segments = useMemo(
    () => (replay ? runSegments(replay) : { bosses: [], mobs: [] }),
    [replay],
  );
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
            <button aria-pressed={follow} onClick={() => setFollow(!follow)}>
              Follow
            </button>
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
              max={Math.log2(Math.max(1, duration / Math.min(1000, duration)))}
              step={0.1}
              value={Math.log2(duration / view.span)}
              onChange={(e) =>
                zoom(view.span / (duration / 2 ** Number(e.target.value)))
              }
            />
            <button aria-label="Zoom in raid scrubber" onClick={() => zoom(2)}>
              +
            </button>
            <button onClick={() => setRange(runRange(0, duration, duration))}>
              Full run
            </button>
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
            <button
              aria-expanded={optionsOpen}
              aria-controls={optionsId}
              onClick={(e) => {
                const menu = optionsMenu.current;
                if (!menu) return;
                if (menu.matches(":popover-open")) {
                  menu.hidePopover();
                  return;
                }
                const r = e.currentTarget.getBoundingClientRect();
                menu.showPopover();
                menu.style.left = `${Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, r.left))}px`;
                menu.style.top = `${Math.max(8, r.top - menu.offsetHeight - 4)}px`;
              }}
            >
              Plan options
            </button>
            <div
              id={optionsId}
              ref={optionsMenu}
              popover="auto"
              className="run-plan-options"
              onToggle={(e) =>
                setOptionsOpen(e.currentTarget.matches(":popover-open"))
              }
            >
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
                onClick={() => {
                  controller.stepsFromLog();
                  optionsMenu.current?.hidePopover();
                }}
              >
                Create pages from log
              </button>
            </div>
          </>
        )}
        <div className="menu-spacer" />
        {replay && (
          <button
            aria-pressed={layerSnap}
            onClick={() => setLayerSnap((v) => !v)}
            title="Snap to playhead, encounters and other page edges"
          >
            Snap
          </button>
        )}
        <button onClick={() => controller.addLayer()}>+ Layer</button>
      </div>
      <div className="run-timeline-workspace">
        <div className="run-navigator-body">
          <div className="run-lane-labels">
            {replay && (
              <div className="run-fixed-labels">
                <span />
                <span>Bosses</span>
                <span>Mobs</span>
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
            title="Drag to scrub · Right-drag to pan · Ctrl/⌘ + wheel to zoom · Double-click a segment to zoom to it"
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
                ["ArrowLeft", "ArrowRight", "Home", "End", " "].includes(e.key)
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
              const key = (e.target as HTMLElement).closest<HTMLElement>(
                "[data-segment]",
              )?.dataset.segment;
              lastHit.current =
                [...segments.bosses, ...mobs].find((s) => s.key === key) ??
                null;
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
              };
              setPanning(e.button === 2);
              e.currentTarget.setPointerCapture(e.pointerId);
              if (e.button === 0)
                controller.seek(
                  runTimeAt(e.clientX - box.left, box.width, view, duration),
                );
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
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
                  {ticks.map((t) => (
                    <span key={t} style={{ left: `${percent(t)}%` }}>
                      {time(t)}
                    </span>
                  ))}
                </div>
                <div className="run-bosses">
                  {segments.bosses
                    .filter(
                      (s) =>
                        s.end >= view.start &&
                        s.start <= view.start + view.span,
                    )
                    .map((s) => (
                      <div
                        key={s.key}
                        className={`run-segment boss${state.time >= s.start && state.time < s.end ? " current" : ""}`}
                        style={segmentStyle(s)}
                        title={`${s.name} · ${time(s.start)}–${time(s.end)}${s.kill === true ? " · Kill" : s.kill === false ? " · Wipe" : ""}`}
                        data-segment={s.key}
                      >
                        <GameIcon
                          source={portrait(s)}
                          name="inv_misc_head_dragon_01"
                        />
                        <span>{s.name}</span>
                      </div>
                    ))}
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
