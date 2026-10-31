import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { EditorIcon } from "./EditorIcon";
import { clampFocus } from "./focus-model";
export function FloatingWindow({
  title,
  label,
  positionKey,
  close,
  children,
  className = "",
}: {
  title: string;
  label: string;
  positionKey: string;
  close: () => void;
  children: ReactNode;
  className?: string;
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
        position
          ? { left: position.x, top: position.y, transform: "none" }
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
