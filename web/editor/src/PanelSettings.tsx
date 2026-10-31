import { useId, useRef, useState, type ReactNode } from "react";
import { EditorIcon } from "./EditorIcon";

export function PanelSettings({
  title,
  children,
}: {
  title: string;
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
    const width = Math.min(400, window.innerWidth - 16);
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const useBelow = below >= Math.min(360, above);
    setPosition({
      left: Math.max(
        8,
        Math.min(window.innerWidth - width - 8, rect.right - width),
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
        className="panel-settings-trigger"
        aria-label={title}
        title={title}
        aria-expanded={open}
        aria-controls={id}
        popoverTarget={id}
        onClick={anchor}
      >
        <EditorIcon name="settings" />
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
