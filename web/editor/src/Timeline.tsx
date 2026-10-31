import { replayIdentity, streamComplete } from "./replay-buffer";
import { useGameIconImage } from "./GameIcon";
import { createPortal } from "react-dom";
import { WowheadReference } from "./WidgetReference";
import { PanelSettings } from "./PanelSettings";
import { useAnalysisData } from "./use-analysis-data";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  timelineCastHandlers,
  type TimelineHover,
} from "./timeline-cast-handlers";
import {
  Stage,
  Layer,
  Rect,
  Text,
  Line,
  Group as CanvasGroup,
  Image as CanvasImage,
} from "react-konva";
import { time, preciseTime, CLASS_COLORS } from "./domain";
import {
  playerTracks,
  followingStart,
  raidTimelineLanes,
  searchTimelineLanes,
  timelineMatches,
  nextTimelineMatch,
  draggedTimelineRange,
  type TimelineView,
  detailLanes,
  abilityColor,
  castOutcome,
  TRACK_HEIGHT as ROW,
} from "./timeline-model";
import type { Snapshot, Actor, Cast } from "./types";
import type { EditorController } from "./controller";
const LABEL = 190,
  RULER = 25,
  HEADER = 0;
export function Timeline({
  state,
  controller,
  actor,
  onRaid,
  onRange,
}: {
  state: Snapshot;
  controller: EditorController;
  actor?: Actor;
  onRaid: () => void;
  onRange: (start: number, end: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    [size, setSize] = useState({ width: 1000, height: 180 }),
    [panning, setPanning] = useState(false),
    panDrag = useRef<{
      x: number;
      y: number;
      start: number;
      vertical: number;
      msPerPixel: number;
    } | null>(null),
    [zoom, setZoom] = useState(1),
    [offset, setOffset] = useState(0),
    [vertical, setVertical] = useState(0),
    [follow, setFollow] = useState(true),
    [search, setSearch] = useState(""),
    [view, setView] = useState<TimelineView>("players"),
    [matchCursor, setMatchCursor] = useState(-1),
    [melee, setMelee] = useState(false),
    [buffs, setBuffs] = useState(true),
    [debuffs, setDebuffs] = useState(true),
    [hover, setHover] = useState<TimelineHover | null>(null);
  const showReference = (
    event: { evt: MouseEvent },
    spell: number | undefined,
    text: string,
    buff = false,
  ) => {
    if (spell === undefined || spell <= 1) return;
    setHover({ x: event.evt.clientX, y: event.evt.clientY, spell, text, buff });
  };
  const replay = state.replay,
    duration = replay?.duration ?? 1;
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const observer = new ResizeObserver(([e]) =>
      setSize({ width: e.contentRect.width, height: e.contentRect.height }),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setZoom(Math.max(1, Math.min(512, duration / 60000)));
    setOffset(0);
    setVertical(0);
    setFollow(true);
  }, [replayIdentity(replay), duration]);
  const span = duration / zoom,
    start = Math.max(0, Math.min(duration - span, offset)),
    plot = Math.max(1, size.width - LABEL),
    scale = plot / span;
  useAnalysisData(
    state,
    controller,
    replay ? [[start, Math.min(duration, start + span)]] : [],
  );
  const tracks = useMemo(() => (replay ? playerTracks(replay) : []), [replay]);
  const lanes = useMemo(() => {
    if (!replay) return [];
    const all = actor
      ? detailLanes(actor, replay, melee, buffs, debuffs)
      : raidTimelineLanes(tracks, view, melee);
    return searchTimelineLanes(all, replay, search);
  }, [tracks, view, melee, actor, replay, buffs, debuffs, search]);
  const matches = useMemo(
    () => (search.trim() ? timelineMatches(lanes) : []),
    [lanes, search],
  );
  useEffect(() => {
    setMatchCursor(-1);
    setHover(null);
  }, [replay]);
  useEffect(() => {
    setVertical(0);
    setMatchCursor(-1);
    setHover(null);
  }, [search, view, actor?.key, replayIdentity(replay), melee, buffs, debuffs]);
  function jumpMatch(direction: 1 | -1) {
    const i = nextTimelineMatch(matches, state.time, direction, matchCursor);
    if (i < 0) return;
    const match = matches[i];
    setMatchCursor(i);
    setFollow(false);
    setOffset(Math.max(0, Math.min(duration - span, match.t - span * 0.25)));
    setVertical(
      Math.max(0, lanes.findIndex((l) => l.key === match.lane) * ROW),
    );
    setHover(null);
    controller.seek(match.t);
  }
  useEffect(() => {
    onRange(start, start + span);
  }, [start, span]);
  useEffect(() => {
    setVertical(0);
    setHover(null);
  }, [actor?.key]);
  const top = RULER + HEADER,
    trackHeight = Math.max(1, size.height - top),
    maxVertical = Math.max(0, lanes.length * ROW - trackHeight),
    scrollY = Math.min(maxVertical, vertical);
  useEffect(() => {
    if (follow)
      setOffset((old) => followingStart(state.time, old, span, duration));
  }, [state.time, state.playing, follow, span, duration]);
  useEffect(() => {
    const i = lanes.findIndex((a) => a.actor.key === state.selected);
    if (i < 0) return;
    setVertical((old) =>
      i * ROW < old
        ? i * ROW
        : (i + 1) * ROW > old + trackHeight
          ? Math.max(0, (i + 1) * ROW - trackHeight)
          : old,
    );
  }, [state.selected, lanes, trackHeight]);
  useEffect(() => {
    const detail = state.detail;
    if (detail?.castIndex == null || !replay) return;
    const cast = replay.actors.find((a) => a.key === detail.actorKey)?.casts[
      detail.castIndex
    ];
    if (cast)
      setOffset((old) => followingStart(cast.start, old, span, duration));
  }, [state.detail, replayIdentity(replay), span, duration]);
  const first = Math.floor(scrollY / ROW),
    last = Math.min(lanes.length, Math.ceil((scrollY + trackHeight) / ROW));
  const rows = useMemo(
    () =>
      lanes.slice(first, last).map((lane, i) => ({
        ...lane,
        row: first + i,
        casts: lane.casts.filter(
          ({ cast }) =>
            cast.start <= start + span &&
            (cast.instant ? cast.start : cast.end) >= start,
        ),
      })),
    [lanes, first, last, start, span],
  );
  const x = (t: number) => LABEL + (t - start) * scale;
  const seek = (pixel: number) =>
    controller.seek(start + Math.max(0, pixel - LABEL) / scale);
  const step =
    [
      100, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000,
      300000, 600000,
    ].find((s) => s * scale > 65) ?? 600000;
  function changeZoom(value: number) {
    const next = Math.max(1, Math.min(512, value));
    setZoom(next);
    setOffset(Math.max(0, state.time - (duration / next) * 0.25));
  }
  function pan(value: number) {
    setFollow(false);
    setOffset(Math.max(0, Math.min(duration - span, value)));
  }
  return (
    <section className="timeline" aria-label="Timeline">
      {replay?.raw.stream && !streamComplete(replay.raw) && (
        <div className="replay-data-notice">
          Cast search covers downloaded sections. The run navigator includes
          every encounter.
        </div>
      )}
      <div className="timeline-tools">
        {actor && (
          <>
            <button onClick={onRaid}>‹ Raid</button>
            <strong style={{ color: CLASS_COLORS[actor.class] }}>
              {actor.name}
            </strong>
          </>
        )}

        <input
          className="track-search"
          type="search"
          aria-label="Search timeline"
          placeholder="Ability, player, target…"
          title="Search names or spell IDs. Filters: ability:, spell:, player:, class:, target:, buff:, debuff:. Enter for next match; Shift+Enter for previous."
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              jumpMatch(e.shiftKey ? -1 : 1);
            }
            if (e.key === "Escape") setSearch("");
          }}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setVertical(0);
          }}
        />
        {search.trim() && (
          <>
            <span className="timeline-search-count" role="status">
              {matchCursor >= 0 && matches[matchCursor]?.t === state.time
                ? `${matchCursor + 1} / `
                : ""}
              {matches.length} matches
            </span>
            <button
              disabled={!matches.length}
              aria-label="Previous timeline match"
              title="Previous match (Shift+Enter)"
              onClick={() => jumpMatch(-1)}
            >
              ↑
            </button>
            <button
              disabled={!matches.length}
              aria-label="Next timeline match"
              title="Next match (Enter)"
              onClick={() => jumpMatch(1)}
            >
              ↓
            </button>
            <button
              aria-label="Clear timeline search"
              onClick={() => setSearch("")}
            >
              Clear
            </button>
          </>
        )}
        <PanelSettings title="Timeline settings">
          <div className="timeline-options">
            <select
              aria-label="Timeline rows"
              hidden={!!actor}
              value={view}
              onChange={(e) => {
                setView(e.target.value as TimelineView);
                setVertical(0);
              }}
            >
              <option value="players">By player</option>
              <option value="combined">By player + ability</option>
              <option value="abilities">By ability</option>
            </select>
            <label className="timeline-melee">
              <input
                type="checkbox"
                checked={melee}
                onChange={(e) => setMelee(e.target.checked)}
              />
              Melee
            </label>
            <button
              className={follow ? "active" : ""}
              aria-pressed={follow}
              onClick={() => {
                setFollow(!follow);
                if (!follow)
                  setOffset(followingStart(state.time, start, span, duration));
              }}
            >
              Follow
            </button>
            <div className="timeline-zoom">
              <button
                aria-label="Zoom out"
                onClick={() => changeZoom(zoom / 2)}
              >
                −
              </button>
              <input
                aria-label="Timeline zoom"
                type="range"
                min="0"
                max="9"
                step=".1"
                value={Math.log2(zoom)}
                onChange={(e) => changeZoom(2 ** Number(e.target.value))}
              />
              <button aria-label="Zoom in" onClick={() => changeZoom(zoom * 2)}>
                +
              </button>
              <button
                onClick={() => {
                  setZoom(1);
                  setOffset(0);
                }}
              >
                Fit
              </button>
            </div>
            {actor && (
              <>
                <label className="panel-check">
                  <input
                    type="checkbox"
                    checked={buffs}
                    onChange={(e) => setBuffs(e.target.checked)}
                  />
                  Buffs
                </label>
                <label className="panel-check">
                  <input
                    type="checkbox"
                    checked={debuffs}
                    onChange={(e) => setDebuffs(e.target.checked)}
                  />
                  Debuffs
                </label>
              </>
            )}
          </div>
        </PanelSettings>
      </div>
      <div
        className="timeline-canvas"
        ref={host}
        style={{ cursor: panning ? "grabbing" : undefined }}
        onContextMenu={(e) => e.preventDefault()}
        onPointerDownCapture={(e) => {
          if (e.button !== 2) return;
          e.preventDefault();
          setFollow(false);
          setHover(null);
          panDrag.current = {
            x: e.clientX,
            y: e.clientY,
            start,
            vertical: scrollY,
            msPerPixel: 1 / scale,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
          setPanning(true);
        }}
        onPointerMove={(e) => {
          const drag = panDrag.current;
          if (!drag) return;
          e.preventDefault();
          setHover(null);
          const next = draggedTimelineRange(
            drag.start,
            drag.vertical,
            e.clientX - drag.x,
            e.clientY - drag.y,
            drag.msPerPixel,
            duration,
            span,
            maxVertical,
          );
          setOffset(next.start);
          setVertical(next.vertical);
        }}
        onPointerUp={(e) => {
          if (!panDrag.current) return;
          panDrag.current = null;
          setPanning(false);
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => {
          panDrag.current = null;
          setPanning(false);
        }}
        onLostPointerCapture={() => {
          panDrag.current = null;
          setPanning(false);
        }}
      >
        <Stage
          width={size.width}
          height={size.height}
          onMouseDown={(e) => {
            if (e.evt.button === 0) {
              const p = e.target.getStage()?.getPointerPosition();
              if (p && p.x >= LABEL && p.y < RULER) seek(p.x);
            }
          }}
          onMouseMove={(e) => {
            if (panDrag.current) return;
            if (e.evt.buttons === 1) {
              const p = e.target.getStage()?.getPointerPosition();
              if (p && p.x >= LABEL && p.y < RULER) seek(p.x);
            }
          }}
          onWheel={(e) => {
            e.evt.preventDefault();
            setHover(null);
            if (e.evt.ctrlKey || e.evt.metaKey)
              changeZoom(zoom * (e.evt.deltaY > 0 ? 0.8 : 1.25));
            else if (
              e.evt.shiftKey ||
              Math.abs(e.evt.deltaX) > Math.abs(e.evt.deltaY)
            )
              pan(start + (e.evt.deltaX || e.evt.deltaY) / scale);
            else
              setVertical(
                Math.max(0, Math.min(maxVertical, scrollY + e.evt.deltaY)),
              );
          }}
        >
          <TimelineGrid
            width={size.width}
            height={size.height}
            start={start}
            span={span}
            scale={scale}
            step={step}
            top={top}
          />
          <Layer>
            <CanvasGroup
              clipX={0}
              clipY={top}
              clipWidth={size.width}
              clipHeight={trackHeight}
            >
              {rows.map(
                ({
                  key,
                  actor,
                  row,
                  casts,
                  spell,
                  name,
                  icon,
                  intervals,
                  aggregate,
                }) => {
                  const y = top + row * ROW - scrollY,
                    color =
                      spell !== undefined
                        ? abilityColor(spell)
                        : (CLASS_COLORS[actor.class] ?? "#ccc");
                  return (
                    <CanvasGroup key={key}>
                      <Rect
                        x={0}
                        y={y}
                        width={size.width}
                        height={ROW}
                        fill={
                          !aggregate && actor.key === state.selected
                            ? "#caa45d0d"
                            : row % 2
                              ? "#ffffff02"
                              : "#00000000"
                        }
                        listening={false}
                      />
                      <Rect
                        x={0}
                        y={y}
                        width={LABEL}
                        height={ROW}
                        fill={spell === undefined ? "#25292c" : "#1a1d20"}
                        onMouseDown={(e) => {
                          e.cancelBubble = true;
                        }}
                        onMouseEnter={(event) =>
                          showReference(
                            event,
                            spell,
                            name,
                            intervals !== undefined,
                          )
                        }
                        onMouseLeave={() => setHover(null)}
                        onClick={() =>
                          aggregate && spell !== undefined
                            ? controller.inspectSpell(spell)
                            : controller.select(actor.key)
                        }
                      />
                      <Rect
                        x={0}
                        y={y + 5}
                        width={3}
                        height={ROW - 10}
                        fill={color}
                        listening={false}
                      />
                      <Text
                        x={spell === undefined ? 12 : 36}
                        y={y + 9}
                        width={LABEL - (spell === undefined ? 20 : 42)}
                        text={name}
                        onMouseEnter={(event) =>
                          showReference(
                            event,
                            spell,
                            name,
                            intervals !== undefined,
                          )
                        }
                        onMouseLeave={() => setHover(null)}
                        fill={color}
                        fontSize={11}
                        onMouseDown={(e) => {
                          e.cancelBubble = true;
                        }}
                        onClick={() => {
                          if (!aggregate) controller.select(actor.key);
                          if (spell !== undefined)
                            controller.inspectSpell(spell);
                        }}
                      />
                      {spell !== undefined && (
                        <AbilityIcon
                          icon={icon}
                          spell={spell}
                          x={14}
                          y={y + 5}
                        />
                      )}
                      <TimelineRowRule y={y} width={size.width} />
                      <CanvasGroup
                        clipX={LABEL}
                        clipY={y}
                        clipWidth={plot}
                        clipHeight={ROW}
                      >
                        {intervals
                          ?.filter(
                            (a) => a.end >= start && a.start <= start + span,
                          )
                          .map((a, i) => (
                            <CanvasGroup
                              key={`aura-${i}`}
                              onMouseDown={(e) => {
                                e.cancelBubble = true;
                              }}
                              onClick={() => controller.inspectSpell(a.spell)}
                              onMouseEnter={(e) =>
                                setHover({
                                  x: e.evt.clientX,
                                  y: e.evt.clientY,
                                  text: `${a.name} · ${a.stack} stack${a.stack === 1 ? "" : "s"} · ${time(a.start)}–${time(a.end)}`,
                                  spell: a.spell,
                                  buff: true,
                                })
                              }
                              onMouseLeave={() => setHover(null)}
                            >
                              <Rect
                                x={x(a.start)}
                                y={y + 6}
                                width={Math.max(2, (a.end - a.start) * scale)}
                                height={16}
                                fill={a.debuff ? "#bc5555" : color}
                                opacity={
                                  a.start <= state.time && a.end > state.time
                                    ? 0.65
                                    : 0.25
                                }
                                stroke={
                                  a.start <= state.time && a.end > state.time
                                    ? "#e5c67e"
                                    : undefined
                                }
                              />
                            </CanvasGroup>
                          ))}
                        {casts.map(({ cast, index, actor: source }) => {
                          const caster = source ?? actor;
                          const active =
                            state.detail?.actorKey === caster.key &&
                            state.detail.castIndex === index;
                          const width = cast.instant
                            ? 3
                            : Math.max(3, (cast.end - cast.start) * scale - 1);
                          return (
                            <TimelineCast
                              key={`${caster.key}:${index}`}
                              caster={caster}
                              cast={cast}
                              index={index}
                              controller={controller}
                              onHover={setHover}
                              x={x(cast.start)}
                              y={y}
                              width={width}
                              color={
                                aggregate
                                  ? (CLASS_COLORS[caster.class] ?? color)
                                  : color
                              }
                              active={active}
                            />
                          );
                        })}
                        {(spell === undefined ? actor.deaths : [])
                          .filter(
                            ([t, dead]) =>
                              dead && t >= start && t <= start + span,
                          )
                          .map(([t], i) => (
                            <TimelineDeath
                              key={i}
                              x={x(t)}
                              y={y}
                              actor={actor}
                              at={t}
                              controller={controller}
                            />
                          ))}
                      </CanvasGroup>
                    </CanvasGroup>
                  );
                },
              )}
            </CanvasGroup>
            {state.loop && (
              <CanvasGroup
                clipX={LABEL}
                clipY={0}
                clipWidth={plot}
                clipHeight={size.height}
                listening={false}
              >
                <Rect
                  x={x(state.loop[0])}
                  y={0}
                  width={(state.loop[1] - state.loop[0]) * scale}
                  height={size.height}
                  fill="#d9b56308"
                  stroke="#b99a5450"
                />
              </CanvasGroup>
            )}
          </Layer>
          <Layer>
            {replay &&
              x(state.time) >= LABEL &&
              x(state.time) <= size.width && (
                <CanvasGroup
                  x={x(state.time)}
                  draggable
                  dragBoundFunc={(p) => ({
                    x: Math.max(LABEL, Math.min(size.width, p.x)),
                    y: 0,
                  })}
                  onDragMove={(e) => seek(e.target.x())}
                >
                  <Rect
                    x={-7}
                    width={14}
                    height={size.height}
                    fill="#ffffff00"
                  />
                  <Line points={[0, 0, 0, size.height]} stroke="#e5c67e" />
                  <Line points={[-5, 0, 5, 0, 0, 7]} closed fill="#e5c67e" />
                </CanvasGroup>
              )}
          </Layer>
        </Stage>
        {search.trim() && lanes.length === 0 && (
          <div className="timeline-no-results">
            No matches. Try another search or enable Melee, Buffs or Debuffs.
          </div>
        )}
        <div className="sr-only">
          {tracks.map((actor) => (
            <button
              key={actor.key}
              onClick={() => controller.select(actor.key)}
            >
              {actor.name} casts
            </button>
          ))}
        </div>
        {maxVertical > 0 && (
          <input
            type="range"
            className="track-scroll"
            aria-label="Player track position"
            min={0}
            max={maxVertical}
            value={scrollY}
            onChange={(e) => setVertical(Number(e.target.value))}
          />
        )}
        {hover &&
          createPortal(
            <div
              role="tooltip"
              className="timeline-reference-hover"
              style={{
                left: Math.max(
                  8,
                  Math.min(hover.x + 14, window.innerWidth - 355),
                ),
                top: Math.max(
                  8,
                  Math.min(hover.y - 240, window.innerHeight - 420),
                ),
              }}
            >
              {hover.spell && hover.spell > 1 ? (
                <WowheadReference
                  kind="spell"
                  id={hover.spell}
                  buff={hover.buff}
                  context={
                    hover.actor && hover.cast
                      ? [
                          {
                            text: `${hover.actor.name}${hover.cast.target ? ` → ${replay?.actors.find((a) => a.key === hover.cast!.target)?.name ?? "Unknown"}` : ""}`,
                            color: CLASS_COLORS[hover.actor.class],
                          },
                          { text: hover.text },
                          {
                            text: `${preciseTime(hover.cast.start)} → ${preciseTime(hover.cast.end)} · ${castOutcome(hover.cast)}${hover.cast.inferredEnd && hover.cast.timingSource ? ` · ${hover.cast.timingSource}` : ""}`,
                          },
                        ]
                      : [{ text: hover.text }]
                  }
                />
              ) : (
                <div className="timeline-event-note">{hover.text}</div>
              )}
            </div>,
            document.body,
          )}
      </div>
      <input
        className="accessible-seek"
        aria-label="Replay timeline"
        type="range"
        min={0}
        max={duration}
        step={10}
        value={state.time}
        disabled={!replay}
        onChange={(e) => controller.seek(Number(e.target.value))}
      />
      <input
        className="timeline-scroll"
        aria-label="Timeline position"
        type="range"
        min={0}
        max={Math.max(0, duration - span)}
        value={start}
        disabled={zoom === 1}
        onChange={(e) => pan(Number(e.target.value))}
      />
    </section>
  );
}

const TimelineGrid = memo(function TimelineGrid({
  width,
  height,
  start,
  span,
  scale,
  step,
  top,
}: {
  width: number;
  height: number;
  start: number;
  span: number;
  scale: number;
  step: number;
  top: number;
}) {
  const ticks = [];
  for (let t = Math.ceil(start / step) * step; t <= start + span; t += step)
    ticks.push(t);
  const x = (t: number) => LABEL + (t - start) * scale;
  return (
    <Layer listening={false}>
      <Rect width={width} height={height} fill="#17191c" />
      {ticks.map((t) => (
        <CanvasGroup key={t}>
          <Line points={[x(t), 0, x(t), height]} stroke="#ffffff0c" />
          <Text
            x={x(t) + 5}
            y={7}
            text={time(t)}
            fill="#858b92"
            fontSize={10}
          />
        </CanvasGroup>
      ))}
      <Rect width={LABEL} height={top} fill="#1c1e21" />
    </Layer>
  );
});

const TimelineRowRule = memo(function TimelineRowRule({
  y,
  width,
}: {
  y: number;
  width: number;
}) {
  return (
    <Line
      points={[0, y + ROW, width, y + ROW]}
      stroke="#ffffff09"
      listening={false}
    />
  );
});

const TimelineDeath = memo(function TimelineDeath({
  x,
  y,
  actor,
  at,
  controller,
}: {
  x: number;
  y: number;
  actor: Actor;
  at: number;
  controller: EditorController;
}) {
  return (
    <Line
      points={[x - 3, y + 9, x + 3, y + 21, x + 3, y + 9, x - 3, y + 21]}
      stroke="#ef6b5b"
      strokeWidth={2}
      onClick={() => {
        controller.select(actor.key);
        controller.seek(at);
      }}
    />
  );
});

const TimelineCast = memo(function TimelineCast({
  caster,
  cast,
  index,
  controller,
  onHover,
  x,
  y,
  width,
  color,
  active,
}: {
  caster: Actor;
  cast: Cast;
  index: number;
  controller: EditorController;
  onHover: (hover: TimelineHover | null) => void;
  x: number;
  y: number;
  width: number;
  color: string;
  active: boolean;
}) {
  const handlers = useMemo(
    () => timelineCastHandlers(controller, caster, cast, index, onHover),
    [controller, caster, cast, index, onHover],
  );
  return (
    <CanvasGroup {...handlers}>
      <Rect
        x={x}
        y={y + 11}
        width={width}
        height={6}
        fill={color}
        opacity={active ? 1 : 0.65}
        listening={false}
      />
      <Rect
        x={x}
        y={y + 4}
        width={20}
        height={20}
        fill="#101214"
        stroke={active ? "#ffe2a4" : cast.interrupted ? "#d34e43" : "#62676b"}
        strokeWidth={active ? 2 : 1}
      />
      <AbilityIcon
        icon={cast.icon}
        spell={cast.spell}
        x={x + 1}
        y={y + 5}
        size={18}
      />
      <Rect
        x={x}
        y={y + 3}
        width={Math.max(20, width)}
        height={22}
        fill="#ffffff00"
      />
    </CanvasGroup>
  );
});

function AbilityIcon({
  icon,
  spell,
  x,
  y,
  size = 19,
}: {
  icon?: string;
  spell?: number;
  x: number;
  y: number;
  size?: number;
}) {
  const image = useGameIconImage({ icon, spell });
  return (
    <CanvasImage
      image={image}
      x={x}
      y={y}
      width={size}
      height={size}
      listening={false}
    />
  );
}
