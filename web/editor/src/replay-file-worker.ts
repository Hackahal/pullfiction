import type { RawReplay } from "./types";
import type { ReplayFileResponse, ReplayFileEventTarget } from "./replay-file";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<File | "next">) => void) | null;
  postMessage(value: ReplayFileResponse): void;
};
const batchSize = 3000;
let channels: { target: ReplayFileEventTarget; events: unknown[] }[] = [];
let offset = 0;

scope.onmessage = async ({ data }) => {
  if (data === "next") {
    while (channels.length && offset === channels[0].events.length) {
      channels.shift();
      offset = 0;
    }
    const channel = channels[0];
    if (!channel) {
      scope.postMessage({ kind: "done" });
    } else {
      const events = channel.events.slice(offset, offset + batchSize);
      offset += events.length;
      scope.postMessage({ kind: "events", target: channel.target, events });
    }
    return;
  }
  try {
    const replay = JSON.parse(await data.text()) as RawReplay;
    if (!replay || !Array.isArray(replay.events))
      throw new Error("Replay file is missing its event list");
    const { events, ...header } = replay;
    channels = [{ target: "events", events }];
    offset = 0;
    if (header.stream) {
      header.stream = { ...header.stream };
      for (const target of ["stateEvents", "contextEvents"] as const) {
        const events = header.stream[target];
        if (Array.isArray(events)) {
          channels.push({ target, events });
          header.stream[target] = [];
        }
      }
    }
    scope.postMessage({
      kind: "header",
      header,
      total: channels.reduce((sum, channel) => sum + channel.events.length, 0),
    });
  } catch (error) {
    scope.postMessage({
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
