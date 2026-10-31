import { useEffect, useRef, useState } from "react";
import type { EditorController } from "./controller";
import type { PlanLayer, Snapshot } from "./types";
import { time } from "./domain";
import { adjustedStepRange, selectedPeriod } from "./layer-model";
export function LayerHeaders({
  state,
  controller,
}: {
  state: Snapshot;
  controller: EditorController;
}) {
  return (
    <>
      {state.plan.layers.map((layer, i) => (
        <LayerHeader
          key={layer.id}
          layer={layer}
          index={i}
          state={state}
          controller={controller}
        />
      ))}
    </>
  );
}
function LayerHeader({
  layer,
  index,
  state,
  controller,
}: {
  layer: PlanLayer;
  index: number;
  state: Snapshot;
  controller: EditorController;
}) {
  const [name, setName] = useState(layer.name);
  useEffect(() => setName(layer.name), [layer.name]);
  return (
    <div className={`layer-row-label ${layer.hidden ? "muted" : ""}`}>
      <button
        aria-label={`${layer.hidden ? "Show" : "Hide"} ${layer.name}`}
        aria-pressed={!layer.hidden}
        title="Show or hide layer"
        onClick={() =>
          controller.updateLayer(layer.id, { hidden: !layer.hidden })
        }
      >
        {layer.hidden ? "○" : "●"}
      </button>
      <input
        aria-label={`Layer ${index + 1} name`}
        value={name}
        maxLength={100}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          const value = name.trim() || layer.name;
          setName(value);
          if (value !== layer.name)
            controller.updateLayer(layer.id, { name: value });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            setName(layer.name);
          }
        }}
      />
      <button
        aria-label={`Move ${layer.name} up`}
        disabled={index === 0}
        onClick={() => controller.moveLayer(layer.id, -1)}
      >
        ↑
      </button>
      <button
        aria-label={`Move ${layer.name} down`}
        disabled={index === state.plan.layers.length - 1}
        onClick={() => controller.moveLayer(layer.id, 1)}
      >
        ↓
      </button>
      <button
        aria-label={`Delete ${layer.name} and its pages`}
        title="Delete layer and its pages · Undo to restore"
        disabled={state.plan.layers.length === 1}
        onClick={() => controller.deleteLayer(layer.id)}
      >
        ×
      </button>
    </div>
  );
}
interface Gesture {
  id?: string;
  layerId: string;
  x: number;
  width: number;
  start: number;
  end: number;
  edge: "move" | "start" | "end";
  moved: boolean;
  order: number;
}
interface Preview {
  id?: string;
  layerId: string;
  start: number;
  end: number;
  guide: number | null;
  order: number;
}
export function LayerTracks({
  state,
  controller,
  start,
  span,
  snapping,
  onSelectPage,
}: {
  state: Snapshot;
  controller: EditorController;
  start: number;
  span: number;
  snapping: boolean;
  onSelectPage?: () => void;
}) {
  const root = useRef<HTMLDivElement>(null),
    drag = useRef<Gesture | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const ordered = !state.replay,
    duration = controller.duration(),
    count = state.plan.steps.length;
  useEffect(() => {
    const cancel = (e: KeyboardEvent | Event) => {
      if (e.type === "blur" || (e as KeyboardEvent).key === "Escape") {
        drag.current = null;
        setPreview(null);
      }
    };
    window.addEventListener("keydown", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", cancel);
      window.removeEventListener("blur", cancel);
    };
  }, []);
  const targets = [
    0,
    duration,
    state.time,
    ...(state.replay?.chapters.flatMap((c) => [c.start, c.end]) ?? []),
    ...state.plan.steps
      .filter((s) => s.id !== drag.current?.id)
      .flatMap((s) => [s.start, s.end].filter((t) => t !== null) as number[]),
  ];
  const percent = (t: number) => ((t - start) / span) * 100;
  function pointAt(x: number, width: number) {
    return Math.max(
      0,
      Math.min(duration, start + (x / Math.max(1, width)) * span),
    );
  }
  function snap(t: number, bypass: boolean, width: number) {
    if (!snapping || bypass) return { t, guide: null as number | null };
    const near = targets
      .map((n) => ({ t: n, d: Math.abs(n - t) }))
      .filter((n) => n.d <= (8 / Math.max(1, width)) * span)
      .sort((a, b) => a.d - b.d)[0];
    return near ? { t: near.t, guide: near.t } : { t, guide: null };
  }
  function calculate(
    e: { clientX: number; clientY: number; altKey: boolean },
    d: Gesture,
  ): Preview {
    const row = [
      ...root.current!.querySelectorAll<HTMLElement>("[data-layer-track]"),
    ].find((n) => {
      const b = n.getBoundingClientRect();
      return e.clientY >= b.top && e.clientY < b.bottom;
    });
    const layerId = row?.dataset.layerTrack ?? d.layerId;
    if (ordered)
      return {
        id: d.id,
        layerId,
        start: 0,
        end: 0,
        guide: null,
        order: Math.max(
          0,
          Math.min(
            count - 1,
            Math.round(d.order + ((e.clientX - d.x) / d.width) * count),
          ),
        ),
      };
    if (d.id) {
      const range = adjustedStepRange(
        d.start,
        d.end,
        ((e.clientX - d.x) / d.width) * span,
        d.edge,
        duration,
        targets,
        snapping && !e.altKey ? (8 / d.width) * span : 0,
      );
      return { id: d.id, layerId, ...range, order: d.order };
    }
    const end = snap(
      Math.max(
        0,
        Math.min(duration, d.start + ((e.clientX - d.x) / d.width) * span),
      ),
      e.altKey,
      d.width,
    );
    return {
      layerId: d.layerId,
      start: Math.min(d.start, end.t),
      end: Math.max(d.start, end.t),
      guide: end.guide,
      order: 0,
    };
  }
  return (
    <div
      className="plan-layer-tracks"
      ref={root}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {state.plan.layers.map((layer) => (
        <div
          key={layer.id}
          data-layer-track={layer.id}
          className={`plan-layer-track ${layer.hidden ? "muted" : ""}`}
          title={
            ordered
              ? "Click a page to show it · Drag pages to reorder"
              : "Drag empty space to set a period · Drag clips to move · Drag edges to trim"
          }
          onPointerDown={(e) => {
            if (e.button !== 0 || layer.hidden) return;
            e.stopPropagation();
            e.preventDefault();
            e.currentTarget.closest<HTMLElement>(".run-tracks")?.focus();
            const block = (e.target as HTMLElement).closest<HTMLElement>(
                "[data-page]",
              ),
              page = state.plan.steps.find((s) => s.id === block?.dataset.page);
            const box = e.currentTarget.getBoundingClientRect();
            if (!state.replay && !page) {
              controller.addLayerPage(layer.id);
              return;
            }
            if (state.playing) controller.seek(state.time);
            const startAt =
              page?.start ??
              snap(
                pointAt(e.clientX - box.left, box.width),
                e.altKey,
                box.width,
              ).t;
            const edge = (e.target as HTMLElement).dataset.edge as
              "start" | "end" | undefined;
            const clipId =
              page?.start === null && !ordered ? undefined : page?.id;
            const gesture: Gesture = {
              id: clipId,
              layerId: layer.id,
              x: e.clientX,
              width: Math.max(1, box.width),
              start: startAt,
              end: clipId ? (page?.end ?? duration) : startAt,
              edge: page?.start === null ? "move" : (edge ?? "move"),
              moved: false,
              order: page ? state.plan.steps.indexOf(page) : 0,
            };
            if (page) {
              controller.setActiveStep(page.id, false);
            }
            drag.current = gesture;
            setPreview({
              id: gesture.id,
              layerId: layer.id,
              start: gesture.start,
              end: gesture.end,
              guide: null,
              order: gesture.order,
            });
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            e.stopPropagation();
            if (
              Math.abs(e.clientX - d.x) > 3 ||
              e.currentTarget.dataset.layerTrack !== d.layerId
            )
              d.moved = true;
            const next = calculate(e, d);
            if (next.layerId !== d.layerId) d.moved = true;
            setPreview(next);
          }}
          onPointerUp={(e) => {
            const d = drag.current;
            if (!d) return;
            e.stopPropagation();
            const next = calculate(e, d);
            drag.current = null;
            setPreview(null);
            const moved =
              d.moved ||
              Math.abs(e.clientX - d.x) > 3 ||
              next.layerId !== d.layerId;
            if (d.id) {
              controller.setActiveStep(d.id, false);
              onSelectPage?.();
              if (moved) {
                if (ordered)
                  controller.movePageTo(d.id, next.layerId, next.order);
                else
                  controller.updateStep({
                    layerId: next.layerId,
                    start: next.start,
                    end: next.end,
                  });
              } else {
                controller.setActiveStep(d.id);
              }
            } else if (moved) {
              const range = selectedPeriod(next.start, next.end, duration);
              if (range) {
                controller.setPeriod(d.layerId, range.start, range.end);
                onSelectPage?.();
              }
            }
            if (e.currentTarget.hasPointerCapture(e.pointerId))
              e.currentTarget.releasePointerCapture(e.pointerId);
          }}
          onLostPointerCapture={() => {
            drag.current = null;
            setPreview(null);
          }}
          onPointerCancel={(e) => {
            e.stopPropagation();
            drag.current = null;
            setPreview(null);
          }}
        >
          {state.plan.steps
            .filter((s) => s.layerId === layer.id)
            .map((page) => {
              const p = preview?.id === page.id ? preview : null;
              if (p && p.layerId !== layer.id) return null;
              const index = state.plan.steps.indexOf(page),
                position = ordered
                  ? ((p?.order ?? index) / count) * 100
                  : page.start === null
                    ? 0
                    : percent(p?.start ?? page.start);
              const width = ordered
                ? 100 / count
                : page.start === null
                  ? 100
                  : (((p?.end ?? page.end ?? duration) -
                      (p?.start ?? page.start)) /
                      span) *
                    100;
              const emptyAlways =
                !ordered &&
                page.start === null &&
                !page.annotations.length &&
                !page.snapshot &&
                !page.notes;
              if (emptyAlways) return null;
              return (
                <div
                  key={page.id}
                  data-page={page.id}
                  className={`layer-clip ${page.id === state.activeStep ? "active" : ""} ${page.start === null && !ordered ? "always" : ""}`}
                  style={{
                    left: `${position}%`,
                    width: `${Math.max(0.15, width)}%`,
                  }}
                  title={
                    ordered
                      ? `${index + 1}. ${page.name}`
                      : `${page.name} · ${page.start === null ? "Always" : `${time(p?.start ?? page.start)}–${time(p?.end ?? page.end ?? duration)}`} · ${page.annotations.length} drawings`
                  }
                >
                  {!ordered && page.start !== null && <i data-edge="start" />}
                  <span>
                    {ordered ? `${index + 1}. ` : ""}
                    {page.name}
                    {page.start === null && !ordered ? " · Always" : ""}
                  </span>
                  {!ordered && page.start !== null && <i data-edge="end" />}
                </div>
              );
            })}
          {preview &&
            preview.layerId === layer.id &&
            !ordered &&
            (!preview.id ||
              state.plan.steps.find((s) => s.id === preview.id)?.layerId !==
                layer.id) && (
              <div
                className="layer-clip preview"
                style={{
                  left: `${percent(preview.start)}%`,
                  width: `${Math.max(0.15, ((preview.end - preview.start) / span) * 100)}%`,
                }}
              >
                <span>
                  {time(preview.start)} – {time(preview.end)}
                </span>
              </div>
            )}
          {preview &&
            ordered &&
            preview.layerId === layer.id &&
            state.plan.steps.find((s) => s.id === preview.id)?.layerId !==
              layer.id && (
              <div
                className="layer-clip preview"
                style={{
                  left: `${(preview.order / count) * 100}%`,
                  width: `${100 / count}%`,
                }}
              >
                <span>
                  {state.plan.steps.find((s) => s.id === preview.id)?.name}
                </span>
              </div>
            )}
          {preview?.layerId === layer.id &&
            preview.guide !== null &&
            preview.guide !== undefined &&
            !ordered && (
              <div
                className="layer-snap-guide"
                style={{ left: `${percent(preview.guide)}%` }}
              />
            )}
        </div>
      ))}
    </div>
  );
}
