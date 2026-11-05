import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { EditorIcon } from "./EditorIcon";

export function PanelSettings({
  title,
  children,
  icon = "settings",
  width = 400,
  placement = "anchor",
  anchorBoundary,
  label,
  triggerLabel,
}: {
  title: string;
  icon?: string;
  label?: string;
  triggerLabel?: string;
  width?: number;
  placement?: "anchor" | "edge";
  anchorBoundary?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const id = useId(),
    trigger = useRef<HTMLButtonElement>(null),
    close = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  }>({ left: 8, top: 8, maxHeight: 500 });
  const anchor = useCallback(() => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const actualWidth = Math.min(width, window.innerWidth - 16);
    if (placement === "edge") {
      setPosition({
        left: Math.max(8, window.innerWidth - actualWidth - 16),
        top: 16,
        maxHeight: window.innerHeight - 32,
      });
      return;
    }
    const boundary = anchorBoundary?.current?.getBoundingClientRect() ?? rect;
    const roomOutsideBoundary = Math.max(
      boundary.top - 12,
      window.innerHeight - boundary.bottom - 12,
    );
    const box = roomOutsideBoundary >= 80 ? boundary : rect;
    const below = window.innerHeight - box.bottom - 12;
    const above = box.top - 12;
    const useBelow = below >= Math.min(360, above);
    setPosition({
      left: Math.max(
        8,
        Math.min(window.innerWidth - actualWidth - 8, rect.right - actualWidth),
      ),
      top: useBelow ? box.bottom + 6 : undefined,
      bottom: useBelow ? undefined : window.innerHeight - box.top + 6,
      maxHeight: Math.max(
        box === boundary && boundary !== rect ? 0 : 120,
        useBelow ? below : above,
      ),
    });
  }, [anchorBoundary, placement, width]);
  useEffect(() => {
    const node = anchorBoundary?.current;
    if (!open || !node) return;
    const observer = new ResizeObserver(anchor);
    observer.observe(node);
    window.addEventListener("resize", anchor);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", anchor);
    };
  }, [anchor, anchorBoundary, open]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`panel-settings-trigger${label ? " has-label" : ""}`}
        aria-label={triggerLabel ?? title}
        title={title}
        aria-expanded={open}
        aria-controls={id}
        popoverTarget={id}
        onClick={anchor}
      >
        <EditorIcon name={icon} />
        {label && <span>{label}</span>}
      </button>
      <div
        id={id}
        popover="auto"
        role="dialog"
        aria-label={title}
        className="panel-settings"
        onToggle={(event) => {
          setOpen(event.newState === "open");
          if (event.newState === "open") close.current?.focus();
        }}
        onKeyDown={(event) => event.stopPropagation()}
        style={{
          width: `min(${width}px, calc(100vw - 16px))`,
          left: position.left,
          top: position.top,
          bottom: position.bottom,
          maxHeight: position.maxHeight,
        }}
      >
        <div className="panel-settings-heading">
          <strong>{title}</strong>
          <button
            ref={close}
            type="button"
            popoverTarget={id}
            popoverTargetAction="hide"
            aria-label={`Close ${title.toLowerCase()}`}
          >
            <EditorIcon name="close" />
          </button>
        </div>
        <div className="panel-settings-body">{children}</div>
      </div>
    </>
  );
}
