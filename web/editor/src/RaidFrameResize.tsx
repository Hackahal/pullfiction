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
  useEffect(() => {
    controller.setRaidFrameSize(width, height, false);
  }, [width, height, controller]);
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
          drag.current = { x: e.clientX, y: e.clientY, width, height };
          setResizing(true);
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          controller.setRaidFrameSize(
            Math.max(
              80,
              Math.min(bounds.width - 24, d.width + e.clientX - d.x),
            ),
            Math.max(
              80,
              Math.min(bounds.height - 24, d.height + e.clientY - d.y),
            ),
            false,
          );
        }}
        onPointerUp={(e) => {
          if (!drag.current) return;
          const d = drag.current;
          drag.current = null;
          setResizing(false);
          controller.setRaidFrameSize(
            Math.max(
              80,
              Math.min(bounds.width - 24, d.width + e.clientX - d.x),
            ),
            Math.max(
              80,
              Math.min(bounds.height - 24, d.height + e.clientY - d.y),
            ),
            true,
          );
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => {
          const d = drag.current;
          drag.current = null;
          setResizing(false);
          if (d) controller.setRaidFrameSize(d.width, d.height, false);
        }}
        onKeyDown={(e) => {
          if (
            ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
          ) {
            e.preventDefault();
            e.stopPropagation();
            const delta = e.shiftKey ? 40 : 10;
            controller.setRaidFrameSize(
              width +
                (e.key === "ArrowRight"
                  ? delta
                  : e.key === "ArrowLeft"
                    ? -delta
                    : 0),
              height +
                (e.key === "ArrowDown"
                  ? delta
                  : e.key === "ArrowUp"
                    ? -delta
                    : 0),
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
