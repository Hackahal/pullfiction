import type { Ref } from "react";
import { preciseTime } from "./domain";
import { EditorIcon } from "./EditorIcon";
import { GameIcon } from "./GameIcon";
import { WowheadReference } from "./WidgetReference";
import type { RecordedEventDetail, Replay } from "./types";

export function EventDetails({
  id,
  trayRef,
  event,
  replay,
  seek,
  close,
}: {
  id: string;
  trayRef: Ref<HTMLElement>;
  event: RecordedEventDetail;
  replay: Replay;
  seek: (time: number) => void;
  close: () => void;
}) {
  const source = replay.actors.find((actor) => actor.key === event.source);
  const target = replay.actors.find((actor) => actor.key === event.target);
  const spell = event.spell === -4 ? 1 : event.spell;
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
          <dt>Run time</dt>
          <dd>
            <button
              type="button"
              onClick={() => seek(event.t)}
              title="Jump playhead to event"
            >
              {preciseTime(event.t)}
            </button>
          </dd>
          <dt>Source</dt>
          <dd>{source?.name ?? (event.source ? "Unknown" : "Environment")}</dd>
          <dt>Target</dt>
          <dd>{target?.name ?? "Unknown"}</dd>
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
        {spell > 0 && <WowheadReference kind="spell" id={spell} />}
      </div>
    </section>
  );
}
