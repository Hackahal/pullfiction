import type { RawReplay } from "./types";

export type ReplayFileEventTarget = "events" | "stateEvents" | "contextEvents";

export type ReplayFileResponse =
  | { kind: "header"; header: Omit<RawReplay, "events">; total: number }
  | {
      kind: "events";
      target: ReplayFileEventTarget;
      events: RawReplay["events"];
    }
  | { kind: "done" }
  | { kind: "error"; message: string };

const workerThresholdBytes = 16 * 1024 * 1024;

export async function readReplayFile(
  file: File,
  signal: AbortSignal,
  progress: (completed: number, total: number) => void,
  createWorker?: () => Worker,
): Promise<RawReplay> {
  signal.throwIfAborted();
  if (
    file.size < workerThresholdBytes ||
    (!createWorker && typeof Worker === "undefined")
  ) {
    const text = await file.text();
    signal.throwIfAborted();
    return JSON.parse(text) as RawReplay;
  }

  const worker =
    createWorker?.() ??
    new Worker(new URL("./replay-file-worker.ts", import.meta.url), {
      type: "module",
    });
  return new Promise((resolve, reject) => {
    let replay: RawReplay | undefined;
    let total = 0;
    let completed = 0;
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
      settle();
    };
    const fail = (reason: unknown) => finish(() => reject(reason));
    const abort = () => fail(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) =>
      fail(new Error(event.message || "Replay file worker failed"));
    worker.onmessageerror = () =>
      fail(new Error("Could not read replay data from the worker"));
    worker.onmessage = ({ data }: MessageEvent<ReplayFileResponse>) => {
      try {
        if (data.kind === "error") throw new Error(data.message);
        if (data.kind === "header" && !replay) {
          replay = { ...data.header, events: [] };
          total = data.total;
        } else if (data.kind === "events" && replay) {
          const target =
            data.target === "events"
              ? replay.events
              : replay.stream?.[data.target];
          if (!Array.isArray(target) || completed + data.events.length > total)
            throw new Error("Invalid replay event batch");
          for (const event of data.events) target.push(event);
          completed += data.events.length;
        } else if (data.kind === "done" && replay && completed === total) {
          const result = replay;
          finish(() => resolve(result));
          return;
        } else throw new Error("Incomplete replay file data");
        progress(completed, total);
        if (!signal.aborted) worker.postMessage("next");
      } catch (error) {
        fail(error);
      }
    };
    try {
      signal.throwIfAborted();
      worker.postMessage(file);
    } catch (error) {
      fail(error);
    }
  });
}
