import { useBufferedView } from "./ReplayLoading";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EditorIcon } from "./EditorIcon";
import { GameIcon } from "./GameIcon";
import { CastDetails } from "./CastDetails";
import { AuraGroup, Bar } from "./FocusWidgets";
import { CLASS_COLORS, combatStateAt } from "./domain";
import {
  clampFocus,
  POWER_COLORS,
  POWER_NAMES,
  focusTargetAt,
} from "./focus-model";
import type { Actor, Snapshot } from "./types";
import type { EditorController } from "./controller";
const POSITION_KEY = "pullfiction.focus.units.position.v1";
export function Focus({
  state: inputState,
  actor,
  controller,
  close,
  inspect,
}: {
  state: Snapshot;
  actor?: Actor;
  controller: EditorController;
  close: () => void;
  inspect?: () => void;
}) {
  const state = useBufferedView(inputState);
  const panel = useRef<HTMLElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    () => {
      try {
        const p = JSON.parse(localStorage.getItem(POSITION_KEY) ?? "null");
        return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
      } catch {
        return null;
      }
    },
  );
  useEffect(() => {
    const node = panel.current,
      parent = node?.parentElement;
    if (!node || !parent) return;
    const observer = new ResizeObserver(() =>
      setPosition((old) =>
        old
          ? clampFocus(
              old.x,
              old.y,
              parent.clientWidth,
              parent.clientHeight,
              node.offsetWidth,
              node.offsetHeight,
            )
          : null,
      ),
    );
    observer.observe(node);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (position)
      try {
        localStorage.setItem(POSITION_KEY, JSON.stringify(position));
      } catch {}
  }, [position]);
  const targetEvidence =
    actor && state.replay
      ? focusTargetAt(state.replay, actor, state.time)
      : undefined;
  const target = targetEvidence?.target;
  const focusedCombat = actor ? combatStateAt(actor, state.time) : null,
    targetCombat = target ? combatStateAt(target, state.time) : null;
  const reservePower = Boolean(focusedCombat?.power || targetCombat?.power);
  const reserveCast = Boolean(
    (focusedCombat?.cast && !focusedCombat.cast.instant) ||
    (targetCombat?.cast && !targetCombat.cast.instant),
  );
  return (
    <>
      <aside
        ref={panel}
        className="focus-units"
        aria-label="Focus"
        style={position ? { left: position.x, top: position.y } : undefined}
      >
        <div className="focus-unit-tools">
          <span
            className="focus-move"
            role="button"
            tabIndex={0}
            aria-label="Move Focus"
            title="Drag to move Focus"
            onKeyDown={(e) => {
              const moves: Record<string, number[]> = {
                ArrowLeft: [-10, 0],
                ArrowRight: [10, 0],
                ArrowUp: [0, -10],
                ArrowDown: [0, 10],
              };
              const d = moves[e.key],
                node = panel.current,
                parent = node?.parentElement;
              if (!d || !node || !parent) return;
              e.preventDefault();
              const r = node.getBoundingClientRect(),
                p = parent.getBoundingClientRect();
              setPosition(
                clampFocus(
                  r.left - p.left + d[0],
                  r.top - p.top + d[1],
                  parent.clientWidth,
                  parent.clientHeight,
                  node.offsetWidth,
                  node.offsetHeight,
                ),
              );
            }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              const node = panel.current!,
                parent = node.parentElement!,
                r = node.getBoundingClientRect(),
                pr = parent.getBoundingClientRect();
              const x = e.clientX,
                y = e.clientY,
                left = r.left - pr.left,
                top = r.top - pr.top,
                target = e.currentTarget;
              target.setPointerCapture(e.pointerId);
              const move = (event: PointerEvent) =>
                setPosition(
                  clampFocus(
                    left + event.clientX - x,
                    top + event.clientY - y,
                    parent.clientWidth,
                    parent.clientHeight,
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
            <EditorIcon name="grip" />
          </span>
          <button aria-label="Close Focus" onClick={close}>
            <EditorIcon name="close" />
          </button>
        </div>
        {actor ? (
          <>
            <FocusedUnit
              actor={actor}
              combat={focusedCombat!}
              reservePower={reservePower}
              reserveCast={reserveCast}
              state={state}
              controller={controller}
              inspect={inspect}
            />
            {target && (
              <FocusedUnit
                actor={target}
                combat={targetCombat!}
                reservePower={reservePower}
                reserveCast={reserveCast}
                state={state}
                controller={controller}
                target
                evidence={
                  targetEvidence
                    ? `Recorded ${targetEvidence.kind === "begincast" ? "cast start" : targetEvidence.kind} · ${Math.max(0, (state.time - targetEvidence.at) / 1000).toFixed(1)}s ago`
                    : undefined
                }
              />
            )}
          </>
        ) : (
          <div className="focus-empty">Select a player or mob.</div>
        )}
      </aside>
      {state.detail &&
        typeof document !== "undefined" &&
        createPortal(
          <aside className="focus-ability-window" aria-label="Ability details">
            <header>
              <strong>Ability details</strong>
              <button
                aria-label="Close ability details"
                onClick={() => controller.closeDetail()}
              >
                <EditorIcon name="close" />
              </button>
            </header>
            <CastDetails state={state} controller={controller} />
          </aside>,
          document.body,
        )}
    </>
  );
}
function FocusedUnit({
  actor,
  combat,
  reservePower,
  reserveCast,
  state,
  controller,
  target = false,
  inspect,
  evidence,
}: {
  actor: Actor;
  combat: ReturnType<typeof combatStateAt>;
  reservePower: boolean;
  reserveCast: boolean;
  state: Snapshot;
  controller: EditorController;
  target?: boolean;
  inspect?: () => void;
  evidence?: string;
}) {
  const dead =
    actor.deaths.filter(([t]) => t <= state.time).at(-1)?.[1] ?? false;
  const color =
    CLASS_COLORS[actor.class] ?? (actor.type === "NPC" ? "#b65e4b" : "#a99b79");
  const cast = combat.cast && !combat.cast.instant ? combat.cast : null;
  return (
    <section
      className={`focus-unit-frame${target ? " target" : ""}`}
      aria-label={target ? "Focused target" : "Focused unit"}
    >
      <div className="focus-unit-auras">
        <AuraGroup
          label={target ? "Target debuffs" : "Debuffs"}
          auras={combat.auras.filter((a) => a.debuff)}
          state={state}
          controller={controller}
          compact
        />
        <AuraGroup
          label={target ? "Target buffs" : "Buffs"}
          auras={combat.auras.filter((a) => !a.debuff)}
          state={state}
          controller={controller}
          compact
        />
      </div>
      <div className="focus-unit-identity" style={{ borderColor: color }}>
        <button
          className="focus-unit-name"
          style={{ color: actor.type === "NPC" ? "#efc075" : color }}
          aria-label={target ? `Focus target: ${actor.name}` : undefined}
          title={target ? evidence : "Center camera on focused unit"}
          onClick={() =>
            target ? controller.select(actor.key) : controller.focus(actor.key)
          }
        >
          {actor.name}
        </button>
        {!target && actor.type === "Player" && (
          <button
            className="focus-inspect"
            onClick={inspect}
            title="Inspect equipment and talents"
          >
            <EditorIcon name="inspect" />
            Inspect
          </button>
        )}
      </div>
      <Bar
        label={target ? "Target health" : "Health"}
        current={dead ? 0 : combat.health?.current}
        text={dead ? "Dead" : undefined}
        max={combat.health?.max}
        estimated={!dead && combat.health?.initial}
        color={color}
      />
      {combat.power ? (
        <div
          title={
            [
              combat.power.current === null
                ? `Current ${POWER_NAMES[combat.power.type]?.toLowerCase() ?? "power"} not recorded`
                : "",
              combat.resources.changes
                .map(
                  (r) =>
                    `${r.name}: +${r.gain}${r.waste ? ` (${r.waste} wasted)` : ""}`,
                )
                .join("\n"),
            ]
              .filter(Boolean)
              .join("\n") || undefined
          }
        >
          <Bar
            label={`${target ? "Target " : ""}${POWER_NAMES[combat.power.type] ?? "Power"}`}
            current={combat.power.current}
            max={combat.power.max}
            color={POWER_COLORS[combat.power.type] ?? "#347bdc"}
          />
        </div>
      ) : reservePower ? (
        <div className="focus-power-space" aria-hidden="true" />
      ) : null}
      {cast ? (
        <button
          className="focus-unit-cast"
          onClick={() => controller.inspectSpell(cast.spell)}
          title={`${cast.name} · ${Math.max(0, (cast.end - state.time) / 1000).toFixed(1)}s`}
        >
          <i
            style={{
              width: `${Math.max(0, Math.min(100, ((state.time - cast.start) / Math.max(1, cast.end - cast.start)) * 100))}%`,
            }}
          />
          <GameIcon name={cast.icon} spell={cast.spell} />
          <span>{cast.name}</span>
          <b>{Math.max(0, (cast.end - state.time) / 1000).toFixed(1)}</b>
        </button>
      ) : reserveCast ? (
        <div className="focus-cast-space" aria-hidden="true" />
      ) : null}
    </section>
  );
}
