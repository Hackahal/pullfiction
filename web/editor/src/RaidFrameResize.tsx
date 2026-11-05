import { useEffect, useRef, useState } from "react";
import type { EditorController } from "./controller";
import type { Snapshot } from "./types";
export function RaidFrameResize({
  state,
  controller,
}: {
  state: Snapshot;
  controller: EditorController;
}) {
  const root = useRef<HTMLDivElement>(null),
    drag = useRef<{
      x: number;
      y: number;
      width: number;
      height: number;
      requestedWidth: number;
      requestedHeight: number;
    } | null>(null);
  const [bounds, setBounds] = useState({ width: 2000, height: 1200 }),
    [resizing, setResizing] = useState(false),
    [hovered, setHovered] = useState(false);
  useEffect(() => {
    const node = root.current?.parentElement;
    if (!node) return;
    const observer = new ResizeObserver(([e]) =>
      setBounds({ width: e.contentRect.width, height: e.contentRect.height }),
    );
    observer.observe(node);
    // Observe the viewport so native frames still receive their pointer input.
    const move = (event: PointerEvent) => {
      const rect = root.current?.getBoundingClientRect();
      if (!rect) return;
      setHovered(
        event.clientX >= rect.left &&
          event.clientX <= rect.right + 9 &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom + 9,
      );
    };
    const leave = () => setHovered(false);
    node.addEventListener("pointermove", move, { passive: true });
    node.addEventListener("pointerleave", leave);
    return () => {
      observer.disconnect();
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerleave", leave);
    };
  }, []);
  const width = Math.max(
      80,
      Math.min(state.raidFrameSize.width, bounds.width - 24),
    ),
    height = Math.max(
      80,
      Math.min(state.raidFrameSize.height, bounds.height - 24),
    );
  // The native renderer clamps its own bounds. Do not replace the requested
  // size here: a temporary dock resize must not discard the user's settings.
  function resizeDrag(
    start: NonNullable<typeof drag.current>,
    x: number,
    y: number,
    persist: boolean,
  ) {
    const dx = x - start.x,
      dy = y - start.y;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
      controller.setRaidFrameSize(
        start.requestedWidth,
        start.requestedHeight,
        false,
      );
      return;
    }
    controller.setRaidFrameSize(
      Math.abs(dx) < 1
        ? start.requestedWidth
        : Math.max(80, Math.min(bounds.width - 24, start.width + dx)),
      Math.abs(dy) < 1
        ? start.requestedHeight
        : Math.max(80, Math.min(bounds.height - 24, start.height + dy)),
      persist,
    );
  }
  return (
    <div
      ref={root}
      className={`raid-frame-resize ${resizing ? "resizing" : ""} ${hovered ? "hovered" : ""}`}
      style={{ width, height }}
      aria-label={
        state.browserAssets ? "Raid frame bounds" : "Native raid frame bounds"
      }
    >
      <button
        aria-label="Resize raid frames"
        title="Drag to resize raid frames. Rows and columns adjust automatically."
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          drag.current = {
            x: e.clientX,
            y: e.clientY,
            width,
            height,
            requestedWidth: state.raidFrameSize.width,
            requestedHeight: state.raidFrameSize.height,
          };
          setResizing(true);
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          resizeDrag(d, e.clientX, e.clientY, false);
        }}
        onPointerUp={(e) => {
          if (!drag.current) return;
          const d = drag.current;
          drag.current = null;
          setResizing(false);
          resizeDrag(d, e.clientX, e.clientY, true);
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => {
          const d = drag.current;
          drag.current = null;
          setResizing(false);
          if (d)
            controller.setRaidFrameSize(
              d.requestedWidth,
              d.requestedHeight,
              false,
            );
        }}
        onKeyDown={(e) => {
          if (
            ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
          ) {
            e.preventDefault();
            e.stopPropagation();
            const delta = e.shiftKey ? 40 : 10;
            const horizontal = e.key === "ArrowRight" || e.key === "ArrowLeft";
            controller.setRaidFrameSize(
              horizontal
                ? width + (e.key === "ArrowRight" ? delta : -delta)
                : state.raidFrameSize.width,
              horizontal
                ? state.raidFrameSize.height
                : height + (e.key === "ArrowDown" ? delta : -delta),
            );
          }
        }}
      >
        ◢
      </button>
      {resizing && (
        <span>
          {Math.round(width)} × {Math.round(height)}
        </span>
      )}
    </div>
  );
}
