import { castEvents, castDuration, castOutcome } from "./timeline-model";
import { CLASS_COLORS, preciseTime, time } from "./domain";
import { GameIcon } from "./GameIcon";
import { WowheadReference } from "./WidgetReference";
import { useMemo } from "react";
import type { Snapshot } from "./types";
import type { EditorController } from "./controller";
export function CastDetails({
  state,
  controller,
}: {
  state: Snapshot;
  controller: EditorController;
}) {
  const detail = state.detail,
    replay = state.replay;
  const actor = detail
      ? replay?.actors.find((a) => a.key === detail.actorKey)
      : undefined,
    cast = detail?.castIndex != null ? actor?.casts[detail.castIndex] : null;
  const events = useMemo(
    () => (replay && actor && cast ? castEvents(replay, actor, cast) : []),
    [replay, actor, cast],
  );
  if (!detail || !replay) return null;
  const target = cast?.target
    ? replay.actors.find((a) => a.key === cast.target)
    : null;
  const event = detail.event;
  const eventSource = replay.actors.find((a) => a.key === event?.source);
  const eventTarget = replay.actors.find((a) => a.key === event?.target);
  const ability = replay.abilities.get(detail.spell);
  return (
    <section className="cast-details">
      <div className="ability-heading">
        <GameIcon
          name={ability?.icon}
          spell={detail.spell > 0 ? detail.spell : undefined}
        />
        <h3>{event?.name ?? cast?.name ?? ability?.name ?? "Spell"}</h3>
      </div>
      {event && (
        <dl className="ability-event-facts">
          <dt>Recorded at</dt>
          <dd>
            <button onClick={() => controller.seek(event.t)}>
              {preciseTime(event.t)}
            </button>
          </dd>
          <dt>Source</dt>
          <dd>
            {eventSource?.name ?? (event.source ? "Unknown" : "Environment")}
          </dd>
          <dt>Target</dt>
          <dd>{eventTarget?.name ?? "Unknown"}</dd>
          <dt>Event</dt>
          <dd>
            {event.kind}
            {event.amount !== undefined && (
              <>
                {" "}
                · <strong>{event.amount.toLocaleString()}</strong>
              </>
            )}
          </dd>
        </dl>
      )}
      {actor && cast && (
        <>
          <div className="cast-facts">
            <button
              style={{ color: CLASS_COLORS[actor.class] }}
              onClick={() => controller.select(actor.key, true)}
            >
              {actor.name}
            </button>
            {target && (
              <>
                <span>→</span>
                <button onClick={() => controller.select(target.key, true)}>
                  {target.name}
                </button>
              </>
            )}
          </div>
          <dl className="cast-metrics">
            <dt>Start</dt>
            <dd>
              <button onClick={() => controller.seek(cast.start)}>
                {preciseTime(cast.start)}
              </button>
            </dd>
            <dt>Duration</dt>
            <dd>{castDuration(cast)}</dd>
            <dt>Result</dt>
            <dd>{castOutcome(cast)}</dd>
            <dt>Timing</dt>
            <dd>
              {cast.timingSource ??
                (cast.inferredEnd ? "Estimated" : "Recorded")}
              {cast.channel ? " · channel" : ""}
            </dd>
          </dl>
          <div className="cast-navigation">
            <button
              disabled={detail.castIndex === 0}
              onClick={() =>
                controller.inspectCast(actor.key, detail.castIndex! - 1)
              }
            >
              Previous cast
            </button>
            <button
              disabled={detail.castIndex === actor.casts.length - 1}
              onClick={() =>
                controller.inspectCast(actor.key, detail.castIndex! + 1)
              }
            >
              Next cast
            </button>
          </div>
        </>
      )}
      {detail.spell > 0 && <WowheadReference kind="spell" id={detail.spell} />}
      {!!events.length && (
        <section className="inspector-section">
          <h3>Recorded events</h3>
          <div className="cast-event-list">
            {events.slice(0, 80).map((e) => {
              const target = replay.actors.find((a) => a.key === e.target);
              return (
                <button
                  key={e.id}
                  onClick={() => {
                    controller.seek(e.t);
                    if (target) controller.focus(target.key);
                  }}
                >
                  <time>{preciseTime(e.t)}</time>
                  <span>
                    {e.kind}
                    {target ? ` · ${target.name}` : ""}
                  </span>
                  <b>{e.amount?.toLocaleString() ?? ""}</b>
                </button>
              );
            })}
          </div>
        </section>
      )}
    </section>
  );
}
