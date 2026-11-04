import { useId, useRef, useState, type ReactNode } from "react";
import { EditorIcon } from "./EditorIcon";

export function PanelSettings({
  title,
  children,
  icon = "settings",
  width = 400,
  placement = "anchor",
  label,
  triggerLabel,
}: {
  title: string;
  icon?: string;
  label?: string;
  triggerLabel?: string;
  width?: number;
  placement?: "anchor" | "edge";
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
  function anchor() {
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
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const useBelow = below >= Math.min(360, above);
    setPosition({
      left: Math.max(
        8,
        Math.min(window.innerWidth - actualWidth - 8, rect.right - actualWidth),
      ),
      top: useBelow ? rect.bottom + 6 : undefined,
      bottom: useBelow ? undefined : window.innerHeight - rect.top + 6,
      maxHeight: Math.max(120, useBelow ? below : above),
    });
  }
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
