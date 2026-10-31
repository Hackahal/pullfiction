import type { EditorController } from "./controller";
import type { Snapshot } from "./types";

export function BrowserClient({
  state,
  controller,
}: {
  state: Snapshot;
  controller: EditorController;
}) {
  const opening =
    (state.clientStatus === "opening" && !state.clientNeedsFiles) ||
    state.clientAttaching;
  return (
    <section className="browser-client" aria-label="Local game client">
      <strong>
        {state.clientNeedsFiles
          ? "Load more game assets"
          : "Open your Warcraft client"}
      </strong>
      <p>
        {state.clientNeedsFiles
          ? `Select the same client build (${state.clientBuild || "your saved version"}) to continue. Cached assets stay available.`
          : "Select the World of Warcraft root folder containing .build.info and Data. Game files stay on this device."}
      </p>
      {!state.clientNeedsFiles && (
        <p>
          Assets you use are saved in this browser and reopen automatically next
          visit.
        </p>
      )}
      <label className="gold-button client-folder">
        {opening ? "Preparing client…" : "Choose client folder"}
        <input
          aria-label="World of Warcraft client folder"
          type="file"
          multiple
          {...{ webkitdirectory: "", directory: "" }}
          disabled={opening}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            if (files.length) void controller.openClient(files);
          }}
        />
      </label>
      {state.clientCanRemember && !opening && !state.clientNeedsFiles && (
        <details className="client-folder-fallback">
          <summary>Remember folder access instead</summary>
          <p>
            For folders outside protected system locations. Your browser may ask
            to reconnect on a later visit.
          </p>
          <div className="client-folder-actions">
            <button
              onClick={() =>
                void (state.clientReconnect
                  ? controller.reconnectClientFolder()
                  : controller.chooseClientFolder())
              }
            >
              {state.clientReconnect
                ? "Reconnect remembered folder"
                : "Remember a client folder"}
            </button>
            {state.clientRemembered && (
              <button onClick={() => void controller.forgetClientFolder()}>
                Forget folder
              </button>
            )}
          </div>
        </details>
      )}
      <span role="status">{state.error ?? state.clientProgress}</span>
      {state.clientNeedsFiles && state.ready && (
        <button
          disabled={opening}
          onClick={() => controller.dismissClientSource()}
        >
          Not now
        </button>
      )}
      {state.clientNeedsRestart && (
        <button
          className="gold-button"
          onClick={() => void controller.restartClientCache()}
        >
          Restart with updated client
        </button>
      )}
      {opening && !state.ready && (
        <button onClick={() => controller.cancelClient()}>
          Cancel preparation
        </button>
      )}
    </section>
  );
}
