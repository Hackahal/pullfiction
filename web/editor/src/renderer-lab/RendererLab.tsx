import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { EditorController } from "../controller";
import { BrowserClient } from "../BrowserClient";
import {
  RendererRunner,
  smokeCases,
  validateBatch,
  type LabSample,
} from "./runner";
import type { RendererCase } from "./cases";
import { RendererViewport } from "./RendererViewport";
import "./renderer-lab.css";
export function RendererLab({ controller }: { controller: EditorController }) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [cases, setCases] = useState<RendererCase[]>(smokeCases());
  const [results, setResults] = useState<LabSample[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [repeat, setRepeat] = useState(true);
  const [fixtureJson, setFixtureJson] = useState("");
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    void controller.boot().then(() => {
      if (new URL(location.href).searchParams.has("local-source"))
        return controller.openClient([], false);
    });
    return () => {
      active.current?.abort();
      controller.stop();
    };
  }, [controller]);
  async function run() {
    if (busy) return;
    const abort = new AbortController();
    active.current = abort;
    setBusy(true);
    setError("");
    setResults([]);
    const runner = new RendererRunner(controller);
    try {
      await runner.run(
        cases,
        abort.signal,
        (result) => setResults((old) => [...old, result]),
        repeat,
      );
    } catch (e) {
      setError(abort.signal.aborted ? "Batch stopped" : String(e));
    } finally {
      runner.dispose();
      active.current = null;
      setBusy(false);
    }
  }
  function download() {
    const report = {
      schema: 1,
      createdAt: new Date().toISOString(),
      build: state.clientBuild,
      client: controller.rendererLabResources().bridge?.build,
      renderer: (
        controller.rendererLabResources().engine as any
      )?.rendererArtifactIdentity?.(),
      cases,
      results,
      proofBoundary:
        "Captured is GPU evidence, not official-client fidelity or complete visual approval.",
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `renderer-batch-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  const captured = results.filter((r) => r.status === "captured");
  return (
    <main className="renderer-lab">
      <header>
        <strong>Renderer workbench</strong>
        <span>{state.clientBuild || "Local client required"}</span>
        <a href="/">Editor</a>
      </header>
      <section
        className="renderer-lab-controls"
        aria-label="Renderer batch controls"
      >
        <label>
          Fixture batch{" "}
          <input
            aria-label="Import renderer fixture batch"
            type="file"
            accept=".json,application/json"
            disabled={busy}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              try {
                setCases(validateBatch(JSON.parse(await file.text())));
                setError("");
              } catch (err) {
                setError(String(err));
              }
              e.target.value = "";
            }}
          />
        </label>
        <button onClick={() => setCases(smokeCases())} disabled={busy}>
          Smoke fixtures
        </button>
        <label>
          <input
            type="checkbox"
            checked={repeat}
            onChange={(e) => setRepeat(e.target.checked)}
            disabled={busy}
          />
          Duplicate frozen captures
        </label>
        <button onClick={() => void run()} disabled={!state.ready || busy}>
          Run {cases.length} cases
        </button>
        {state.ready && controller.rendererLabResources().needsSource && (
          <button onClick={() => controller.rendererLabConnectSource()}>
            Connect client source
          </button>
        )}
        <button disabled={!busy} onClick={() => active.current?.abort()}>
          Stop batch
        </button>
        <button onClick={download} disabled={!results.length}>
          Export evidence
        </button>
        <output role="status">
          {busy ? "Running" : "Idle"} · {captured.length} captures ·{" "}
          {results.length - captured.length} blocked/failed ·{" "}
          {captured.filter((r) => r.identical === false).length} unstable
          repeats
        </output>
      </section>
      <details>
        <summary>Paste fixture JSON</summary>
        <label>
          Renderer fixture JSON
          <textarea
            aria-label="Renderer fixture JSON"
            value={fixtureJson}
            onChange={(e) => setFixtureJson(e.target.value)}
            disabled={busy}
            rows={6}
            spellCheck={false}
          />
        </label>
        <button
          disabled={busy || !fixtureJson.trim()}
          onClick={() => {
            try {
              setCases(validateBatch(JSON.parse(fixtureJson)));
              setError("");
            } catch (err) {
              setError(String(err));
            }
          }}
        >
          Apply fixture JSON
        </button>
      </details>
      <p className="renderer-lab-boundary">
        Local assets only. Isolated asset fixtures use the known Molten Core
        entry stage. No logs, gameplay or official-client process. A capture is
        rendering evidence; visual correctness remains a separate check.
      </p>
      {error && <p role="alert">{error}</p>}
      <RendererViewport>
        {(!state.ready || state.clientNeedsFiles) &&
          !state.clientPromptHidden && (
            <BrowserClient state={state} controller={controller} />
          )}
      </RendererViewport>
      <details>
        <summary>Queued cases ({cases.length})</summary>
        <ol>
          {cases.map((c) => (
            <li key={c.id}>
              {c.id} · {c.category} · {c.timesMs.join(", ")} ms
            </li>
          ))}
        </ol>
      </details>
      <section
        className="renderer-lab-results"
        aria-label="Renderer contact sheet"
      >
        {results.map((r, i) => (
          <article key={i}>
            {r.image && (
              <img
                src={r.image}
                alt={`${r.label} at ${r.timeMs} milliseconds`}
              />
            )}
            <strong>{r.caseId}</strong>
            <span>
              {r.timeMs} ms · {r.status}
              {r.identical === undefined
                ? ""
                : r.identical
                  ? " · repeat identical"
                  : " · repeat changed"}
            </span>
            {r.error && <pre>{r.error}</pre>}
            <details>
              <summary>Native evidence</summary>
              <pre>
                {JSON.stringify(
                  {
                    ...r.native,
                    image: r.native?.image
                      ? { ...r.native.image, dataUrl: "[PNG above]" }
                      : undefined,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          </article>
        ))}
      </section>
    </main>
  );
}
