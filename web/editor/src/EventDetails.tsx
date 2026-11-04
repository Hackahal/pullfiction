import type { Ref } from "react";
import { preciseTime } from "./domain";
import { EditorIcon } from "./EditorIcon";
import { GameIcon } from "./GameIcon";
import { WowheadReference } from "./WidgetReference";
import type { Actor, RecordedEventDetail, Replay } from "./types";

export function EventDetails({
  id,
  trayRef,
  event,
  replay,
  seek,
  canFocus,
  focusActor,
  close,
}: {
  id: string;
  trayRef: Ref<HTMLElement>;
  event: RecordedEventDetail;
  replay: Replay;
  seek: (time: number) => void;
  canFocus: (actor: Actor) => boolean;
  focusActor: (key: string) => void;
  close: () => void;
}) {
  const source = replay.actors.find((actor) => actor.key === event.source);
  const target = replay.actors.find((actor) => actor.key === event.target);
  const spell = event.spell === -4 ? 1 : event.spell;
  const runTime = preciseTime(event.t);
  function actorValue(
    role: string,
    actor: Actor | undefined,
    fallback: string,
  ) {
    if (!actor) return fallback;
    const available = canFocus(actor);
    return (
      <button
        type="button"
        className="event-actor-focus"
        aria-label={`Focus ${role.toLowerCase()}: ${actor.name}`}
        aria-disabled={!available}
        title={
          available
            ? `Focus ${actor.name} at the current playhead`
            : "No actor position at the current playhead"
        }
        onClick={() => {
          if (available) focusActor(actor.key);
        }}
      >
        <span>{actor.name}</span>
        <EditorIcon name="focus" />
      </button>
    );
  }
  return (
    <section
      className="event-details-tray"
      id={id}
      ref={trayRef}
      tabIndex={-1}
      aria-label="Selected combat event"
    >
      <header>
        <GameIcon
          name={replay.abilities.get(event.spell)?.icon}
          spell={spell > 0 ? spell : undefined}
        />
        <strong>{event.name}</strong>
        <button
          type="button"
          onClick={close}
          aria-label="Close combat event details"
        >
          <EditorIcon name="close" />
        </button>
      </header>
      <div className="event-details-body">
        <dl className="ability-event-facts">
          <dt>Source</dt>
          <dd>
            {actorValue(
              "Source",
              source,
              event.source ? "Unknown" : "Environment",
            )}
          </dd>
          <dt>Target</dt>
          <dd>{actorValue("Target", target, "Unknown")}</dd>
        </dl>
        <div className="event-details-actions">
          <span className="event-details-result">
            {event.kind}
            {event.amount !== undefined && (
              <>
                {" "}
                · <strong>{event.amount.toLocaleString()}</strong>
              </>
            )}
          </span>
          <button
            className="event-seek"
            type="button"
            aria-label={`Go to event at run time ${runTime}`}
            onClick={() => seek(event.t)}
            title="Jump playhead to event"
          >
            <EditorIcon name="next" />
            <span>
              Go to <b>{runTime}</b>
            </span>
          </button>
        </div>
        {spell > 0 && <WowheadReference kind="spell" id={spell} />}
      </div>
    </section>
  );
}
