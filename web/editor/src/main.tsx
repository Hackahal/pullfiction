import { createRoot } from "react-dom/client";
import { App } from "./App";
import { EditorController } from "./controller";
import { ensureWowheadWidget } from "./wowhead-widget";
import "./styles.css";
import "./analysis-ui.css";
import "./speedrun-timer.css";
import "./library.css";
import "@runtime-art.css";
let storage: Storage | undefined;
try {
  storage = window.localStorage;
} catch {}
const rendererLab =
  (import.meta.env.DEV || import.meta.env.MODE === "renderer-lab") &&
  new URL(location.href).searchParams.get("renderer-lab") === "1";
if (!rendererLab) void ensureWowheadWidget();
const controller = rendererLab
  ? new EditorController(undefined, {
      rendererLab: true,
      loadEngine: async () => {
        const path = "/pullfiction_viewer.js";
        const engine = await import(/* @vite-ignore */ path);
        engine.enableRendererIdentity?.();
        return engine;
      },
      projectStore: null,
      clientFolders: null,
    })
  : new EditorController(storage);
(
  window as unknown as { pullfiction: (kind: string, value: string) => void }
).pullfiction = controller.receive;
const root = createRoot(document.getElementById("root")!);
if (rendererLab) {
  void import("./renderer-lab/RendererLab").then(({ RendererLab }) =>
    root.render(<RendererLab controller={controller} />),
  );
} else root.render(<App controller={controller} />);
// The game owns one canvas and one Bevy runtime for the lifetime of the editor.

window.addEventListener("unhandledrejection", (event) => {
  if (/pointer lock/i.test(event.reason?.message ?? "")) {
    event.preventDefault();
    controller.notify("Click the scene to capture the mouse");
  }
});
if (import.meta.hot) import.meta.hot.dispose(() => controller.stop());
