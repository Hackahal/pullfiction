import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  paneIds,
  PANEL_MIME,
  defaultDock,
  parseDock,
  moveDock,
  resizeDock,
  dockGeometry,
  dockDropAt,
  migrateFullHeightLeft,
  applyDockDrop,
  dockLeft,
  leftDockRatio,
  type DockDropTarget,
  type PaneId,
  type Edge,
  type DockNode,
} from "./dock-model";
import { EditorIcon } from "./EditorIcon";
export const DOCK_STORAGE = "pullfiction.workspace.layout.v2";
const LEGACY_DOCK_STORAGE = "pullfiction.workspace.layout.v1";
export interface DockPanel {
  id: PaneId;
  title: string;
  content: ReactNode;
  visible?: boolean;
  close?: () => void;
}
export function DockWorkspace({
  panels,
  mode = "analyse",
  onOpen,
  onReset,
}: {
  panels: DockPanel[];
  mode?: "analyse" | "plan";
  onOpen: (id: PaneId) => void;
  onReset: () => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    drag = useRef<PaneId | null>(null),
    pointerDrag = useRef<{
      source: PaneId;
      x: number;
      y: number;
      moved: boolean;
    } | null>(null);
  const [draggingPanel, setDraggingPanel] = useState(false);
  const [layouts, setLayouts] = useState<Record<string, DockNode>>(() => {
    const read = (name: string) => {
      try {
        const current = localStorage.getItem(`${DOCK_STORAGE}.${name}`);
        if (current !== null) return parseDock(current);
        const legacy =
          localStorage.getItem(`${LEGACY_DOCK_STORAGE}.${name}`) ??
          (name === "analyse"
            ? localStorage.getItem(LEGACY_DOCK_STORAGE)
            : null);
        return migrateFullHeightLeft(parseDock(legacy));
      } catch {
        return defaultDock();
      }
    };
    return { analyse: read("analyse"), plan: read("plan") };
  });
  const layout = layouts[mode];
  const setLayout = (update: SetStateAction<DockNode>) =>
    setLayouts((old) => ({
      ...old,
      [mode]: typeof update === "function" ? update(old[mode]) : update,
    }));
  const [size, setSize] = useState({ width: 1000, height: 650 }),
    [drop, setDrop] = useState<DockDropTarget | null>(null);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(([e]) =>
      setSize({ width: e.contentRect.width, height: e.contentRect.height }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(`${DOCK_STORAGE}.${mode}`, JSON.stringify(layout));
    } catch {}
  }, [layout, mode]);
  useEffect(() => {
    const clear = () => {
      drag.current = null;
      pointerDrag.current = null;
      setDraggingPanel(false);
      setDrop(null);
    };
    const cancel = (e: KeyboardEvent) => {
      if (e.key === "Escape") clear();
    };
    window.addEventListener("dragend", clear);
    window.addEventListener("blur", clear);
    window.addEventListener("keydown", cancel);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("blur", clear);
      window.removeEventListener("keydown", cancel);
    };
  }, []);
  const visible = new Set(
      panels.filter((p) => p.visible !== false).map((p) => p.id),
    ),
    geometry = dockGeometry(layout, visible, size.width, size.height);
  const dropAt = (source: PaneId | null, clientX: number, clientY: number) => {
    const bounds = host.current!.getBoundingClientRect();
    return dockDropAt(
      geometry.panes,
      source,
      clientX - bounds.left,
      clientY - bounds.top,
      { x: 0, y: 0, ...size },
    );
  };
  const commitDrop = (source: PaneId, target: DockDropTarget) => {
    setLayout((old) => applyDockDrop(old, source, target));
    onOpen(source);
  };
  return (
    <div
      className={[
        "dock-workspace",
        visible.size === 1 ? "solo" : "",
        draggingPanel ? "moving-pane" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      ref={host}
      aria-label="Dockable workspace"
      onDragOver={(e) => {
        if (!drag.current && !e.dataTransfer.types.includes(PANEL_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDraggingPanel(true);
        setDrop(dropAt(drag.current, e.clientX, e.clientY));
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        const source = drag.current ?? e.dataTransfer.getData(PANEL_MIME);
        if (paneIds.includes(source as PaneId)) {
          const target = dropAt(source as PaneId, e.clientX, e.clientY);
          if (target) commitDrop(source as PaneId, target);
        }
        drag.current = null;
        setDraggingPanel(false);
        setDrop(null);
      }}
    >
      {paneIds.map((id) => {
        const panel = panels.find((p) => p.id === id),
          box = geometry.panes[id];
        if (!panel) return null;
        return (
          <section
            key={id}
            data-pane={id}
            tabIndex={-1}
            onPointerDownCapture={(e) => {
              if (
                !(e.target as HTMLElement).closest(
                  'button,input,select,textarea,a,[tabindex="0"]',
                )
              )
                e.currentTarget.focus({ preventScroll: true });
            }}
            className="dock-pane"
            style={{
              left: box?.x,
              top: box?.y,
              width: box?.width,
              height: box?.height,
              display: box ? "flex" : "none",
            }}
            aria-label={`${panel.title} panel`}
          >
            <header className="dock-header">
              <span
                role="button"
                tabIndex={0}
                aria-label={`Move ${panel.title} panel`}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.currentTarget.parentElement
                      ?.querySelector("details")
                      ?.setAttribute("open", "");
                  }
                }}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  e.stopPropagation();
                  pointerDrag.current = {
                    source: id,
                    x: e.clientX,
                    y: e.clientY,
                    moved: false,
                  };
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  const d = pointerDrag.current;
                  if (!d) return;
                  if (
                    Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4 &&
                    !d.moved
                  )
                    return;
                  d.moved = true;
                  setDraggingPanel(true);
                  setDrop(dropAt(d.source, e.clientX, e.clientY));
                }}
                onPointerUp={(e) => {
                  const d = pointerDrag.current;
                  pointerDrag.current = null;
                  if (d?.moved) {
                    const target = dropAt(d.source, e.clientX, e.clientY);
                    if (target) commitDrop(d.source, target);
                  }
                  setDraggingPanel(false);
                  setDrop(null);
                  if (e.currentTarget.hasPointerCapture(e.pointerId))
                    e.currentTarget.releasePointerCapture(e.pointerId);
                }}
                onPointerCancel={() => {
                  pointerDrag.current = null;
                  setDraggingPanel(false);
                  setDrop(null);
                }}
                onLostPointerCapture={() => {
                  pointerDrag.current = null;
                  setDraggingPanel(false);
                  setDrop(null);
                }}
                onDragStart={(e) => {
                  drag.current = id;
                  setDraggingPanel(true);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("application/x-pullfiction-panel", id);
                }}
                onDragEnd={() => {
                  drag.current = null;
                  setDraggingPanel(false);
                  setDrop(null);
                }}
                title={`Drag ${panel.title} to a pane edge or the full-height left zone`}
              >
                <EditorIcon name="grip" />
                <span>{panel.title}</span>
              </span>
              <details>
                <summary
                  aria-label={`${panel.title} panel actions`}
                  title={`${panel.title} panel actions`}
                >
                  <EditorIcon name="more" />
                </summary>
                <div className="dock-menu">
                  <p className="dock-menu-title">Move {panel.title}</p>
                  <button
                    onClick={(e) => {
                      setLayout((old) => dockLeft(old, id));
                      e.currentTarget
                        .closest("details")
                        ?.removeAttribute("open");
                    }}
                  >
                    Dock in left zone
                  </button>
                  {visible.size > 1 && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const data = new FormData(e.currentTarget);
                        const target = data.get("target") as PaneId;
                        const edge = data.get("edge") as Edge;
                        if (
                          target !== id &&
                          visible.has(target) &&
                          ["left", "right", "top", "bottom"].includes(edge)
                        ) {
                          setLayout((old) => moveDock(old, id, target, edge));
                          e.currentTarget
                            .closest("details")
                            ?.removeAttribute("open");
                        }
                      }}
                    >
                      <label>
                        Next to
                        <select
                          name="target"
                          aria-label={`Move ${panel.title} next to`}
                        >
                          {paneIds
                            .filter((p) => p !== id && visible.has(p))
                            .map((target) => (
                              <option key={target} value={target}>
                                {panels.find((p) => p.id === target)?.title}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label>
                        Position
                        <select
                          name="edge"
                          aria-label={`Position ${panel.title}`}
                          defaultValue="right"
                        >
                          <option value="left">Left</option>
                          <option value="right">Right</option>
                          <option value="top">Above</option>
                          <option value="bottom">Below</option>
                        </select>
                      </label>
                      <button type="submit">Move {panel.title}</button>
                    </form>
                  )}
                  <button
                    className="dock-reset"
                    onClick={(e) => {
                      setLayout(defaultDock());
                      onReset();
                      e.currentTarget
                        .closest("details")
                        ?.removeAttribute("open");
                    }}
                  >
                    Reset workspace layout
                  </button>
                </div>
              </details>
              {panel.close && (
                <button
                  aria-label={`Close ${panel.title}`}
                  onClick={panel.close}
                >
                  <EditorIcon name="close" />
                </button>
              )}
            </header>
            <div className="dock-content">{box ? panel.content : null}</div>
            {drop?.pane === id && !drop.workspace && (
              <div className={`dock-drop-preview ${drop.edge}`} />
            )}
          </section>
        );
      })}
      {drop?.workspace && (
        <div
          className="dock-drop-preview workspace-left"
          style={{
            left: 0,
            top: 0,
            bottom: 0,
            width: Math.max(0, size.width - 5) * leftDockRatio(layout),
          }}
        >
          <span>Dock left</span>
        </div>
      )}
      {geometry.dividers.map((d) => (
        <div
          key={d.path}
          className={`dock-divider ${d.axis}`}
          style={{ left: d.x, top: d.y, width: d.width, height: d.height }}
          role="separator"
          aria-label="Resize panels"
          aria-orientation={d.axis === "row" ? "vertical" : "horizontal"}
          aria-valuemin={10}
          aria-valuemax={90}
          aria-valuenow={Math.round(d.ratio * 100)}
          tabIndex={0}
          onKeyDown={(e) => {
            const back = d.axis === "row" ? "ArrowLeft" : "ArrowUp",
              forward = d.axis === "row" ? "ArrowRight" : "ArrowDown";
            if (e.key === back || e.key === forward) {
              e.preventDefault();
              setLayout((old) =>
                resizeDock(
                  old,
                  d.path,
                  d.ratio + (e.key === forward ? 0.05 : -0.05),
                ),
              );
            }
          }}
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            const initial = d.axis === "row" ? e.clientX : e.clientY,
              ratio = d.ratio;
            const node = e.currentTarget;
            const move = (event: PointerEvent) => {
              const at = d.axis === "row" ? event.clientX : event.clientY;
              setLayout((old) =>
                resizeDock(
                  old,
                  d.path,
                  ratio + (at - initial) / Math.max(1, d.extent),
                ),
              );
            };
            const end = () => {
              node.removeEventListener("pointermove", move);
              node.removeEventListener("pointerup", end);
              node.removeEventListener("pointercancel", end);
            };
            node.addEventListener("pointermove", move);
            node.addEventListener("pointerup", end);
            node.addEventListener("pointercancel", end);
          }}
        />
      ))}
    </div>
  );
}
