import type { EditorController } from "./controller";
import type { Snapshot } from "./types";

export function BrowserClient({
  state,
  controller,
}: {
  state: Snapshot;
  controller: EditorController;
}) {
  const opening = state.clientStatus === "opening";
  return (
    <section className="browser-client" aria-label="Game assets">
      <strong>
        {opening ? "Loading game assets" : "Game assets unavailable"}
      </strong>
      <p>Raid assets download automatically and are cached in this browser.</p>
      <span role="status">{state.error ?? state.clientProgress}</span>
      {!opening && (
        <button
          className="gold-button"
          onClick={() => void controller.openClient([], false)}
        >
          Retry download
        </button>
      )}
    </section>
  );
}
