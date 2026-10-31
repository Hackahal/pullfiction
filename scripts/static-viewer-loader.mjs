// The static package contains compressed application code, never client data.
export * from "./pullfiction_viewer.bindgen.js";
import initialize from "./pullfiction_viewer.bindgen.js";

let pending;
let loadedArtifact;
let identify = false;
export function enableRendererIdentity() { identify = true; }
export function rendererArtifactIdentity() { return loadedArtifact ?? null; }

export default function initializeViewer(options) {
  if (options !== undefined) return initialize(options);
  if (!pending) {
    pending = loadViewer().catch((error) => {
      pending = undefined;
      throw error;
    });
  }
  return pending;
}

async function loadViewer() {
  if (typeof DecompressionStream !== "function") {
    throw new Error("This browser cannot decompress the viewer. Use a current desktop Chromium browser.");
  }
  const response = await fetch(new URL("./pullfiction_viewer_bg.wasm.gz", import.meta.url));
  if (!response.ok || !response.body) {
    throw new Error(`Viewer download failed (${response.status}).`);
  }
  // Serve .gz as application/gzip without Content-Encoding. The browser decodes
  // this stream explicitly so the uploaded file stays below the hosting limit.
  const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
  const bytes = await new Response(stream).arrayBuffer();
  const digest = identify ? crypto.subtle.digest("SHA-256", bytes) : null;
  const instance = await initialize({ module_or_path: bytes });
  if (digest) loadedArtifact = { schema: 1, wasmSha256: [...new Uint8Array(await digest)].map(b => b.toString(16).padStart(2,"0")).join("") };
  return instance;
}
