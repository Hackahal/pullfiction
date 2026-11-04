import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { EditorIcon } from "./EditorIcon";
import { clampFocus } from "./focus-model";
import type { ScreenAnchor } from "./types";

export function FloatingWindow({
  title,
  label,
  positionKey,
  close,
  children,
  className = "",
  anchor,
}: {
  title: string;
  label: string;
  positionKey: string;
  close: () => void;
  children: ReactNode;
  className?: string;
  anchor?: ScreenAnchor;
}) {
  const panel = useRef<HTMLElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    () => {
      try {
        const p = JSON.parse(localStorage.getItem(positionKey) ?? "null");
        return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
      } catch {
        return null;
      }
    },
  );
  const [anchoredPosition, setAnchoredPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  useLayoutEffect(() => {
    const node = panel.current;
    if (!anchor || !node || position) return;
    const place = () => {
      const width = window.innerWidth,
        height = window.innerHeight;
      const w = node.offsetWidth,
        h = node.offsetHeight,
        gap = 12;
      let x = anchor.left,
        y = anchor.top;
      if (anchor.left >= w + gap) x = anchor.left - w - gap;
      else if (anchor.right + gap + w <= width) x = anchor.right + gap;
      else if (anchor.bottom + gap + h <= height) y = anchor.bottom + gap;
      else if (anchor.top >= h + gap) y = anchor.top - h - gap;
      else
        y =
          height - anchor.bottom > anchor.top
            ? anchor.bottom + gap
            : anchor.top - h - gap;
      setAnchoredPosition(clampFocus(x, y, width, height, w, h));
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(node);
    observer.observe(document.documentElement);
    return () => observer.disconnect();
  }, [anchor, position]);
  useEffect(() => {
    const node = panel.current;
    if (!node) return;
    const observer = new ResizeObserver(() =>
      setPosition((p) =>
        p
          ? clampFocus(
              p.x,
              p.y,
              window.innerWidth,
              window.innerHeight,
              node.offsetWidth,
              node.offsetHeight,
            )
          : null,
      ),
    );
    observer.observe(node);
    observer.observe(document.documentElement);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (position)
      try {
        localStorage.setItem(positionKey, JSON.stringify(position));
      } catch {}
  }, [position, positionKey]);
  if (typeof document === "undefined") return null;
  const placement = position ?? (anchor ? anchoredPosition : null);
  return createPortal(
    <aside
      ref={panel}
      tabIndex={-1}
      role="dialog"
      aria-label={label}
      className={`floating-window ${className}`}
      data-input-context="inspect"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      }}
      style={
        placement
          ? {
              left: placement.x,
              top: placement.y,
              right: "auto",
              transform: "none",
            }
          : undefined
      }
    >
      <header
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as Element).closest("button")) return;
          e.preventDefault();
          const node = panel.current!;
          node.focus({ preventScroll: true });
          const r = node.getBoundingClientRect(),
            x = e.clientX,
            y = e.clientY,
            target = e.currentTarget;
          target.setPointerCapture(e.pointerId);
          const move = (v: PointerEvent) =>
            setPosition(
              clampFocus(
                r.x + v.clientX - x,
                r.y + v.clientY - y,
                window.innerWidth,
                window.innerHeight,
                node.offsetWidth,
                node.offsetHeight,
              ),
            );
          const end = () => {
            target.removeEventListener("pointermove", move);
            target.removeEventListener("pointerup", end);
            target.removeEventListener("pointercancel", end);
          };
          target.addEventListener("pointermove", move);
          target.addEventListener("pointerup", end);
          target.addEventListener("pointercancel", end);
        }}
      >
        <strong>{title}</strong>
        <button aria-label={`Close ${label}`} onClick={close}>
          <EditorIcon name="close" />
        </button>
      </header>
      {children}
    </aside>,
    document.body,
  );
}
