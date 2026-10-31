// Offline development asset source for the existing browser renderer workbench.
import http from "node:http";
import { parseArgs } from "node:util";
import { openLocalClient } from "./lib/renderer-local-client.mjs";
const { values } = parseArgs({
  options: {
    client: { type: "string" },
    archive: { type: "string" },
    port: { type: "string", default: "8102" },
    origin: { type: "string", default: "http://127.0.0.1:8100" },
  },
});
if (!values.client || !values.archive)
  throw Error(
    "Usage: tsx scripts/renderer-local-source.mts --client GAME_FOLDER --archive DIAGNOSTIC_RUNTIME/archive",
  );
const origin = new URL(values.origin!);
if (
  origin.protocol !== "http:" ||
  origin.hostname !== "127.0.0.1" ||
  origin.origin !== values.origin
)
  throw Error("Only an exact loopback development origin is allowed");
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw Error("Invalid local port");
const reader = await openLocalClient(values.client, values.archive);
const binary = new Set(["read", "model", "world"]);
const json = (value: unknown) =>
  JSON.stringify(value, (_key, value) =>
    value instanceof ArrayBuffer
      ? { rendererBytes: Buffer.from(value).toString("base64") }
      : ArrayBuffer.isView(value)
        ? {
            rendererBytes: Buffer.from(
              value.buffer,
              value.byteOffset,
              value.byteLength,
            ).toString("base64"),
          }
        : value,
  );
const server = http.createServer(async (request, response) => {
  if (request.headers.origin !== origin.origin) {
    response.writeHead(403);
    response.end();
    return;
  }
  response.setHeader("Access-Control-Allow-Origin", origin.origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "OPTIONS") {
    response.setHeader("Access-Control-Allow-Methods", "GET, POST");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.writeHead(204);
    response.end();
    return;
  }
  try {
    if (request.url === "/meta" && request.method === "GET") {
      response.setHeader("Content-Type", "application/json");
      response.end(json({ build: reader.build }));
      return;
    }
    if (request.url !== "/rpc" || request.method !== "POST") {
      response.writeHead(404);
      response.end();
      return;
    }
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (Buffer.byteLength(body) > 16384)
        throw Error("Request exceeds local source limit");
    }
    const { method, args } = JSON.parse(body);
    if (
      !["read", "model", "world", "map", "catalog", "appearance"].includes(
        method,
      ) ||
      !Array.isArray(args) ||
      args.length > 2
    )
      throw Error("Invalid local source operation");
    const result = await reader[method](...args);
    if (binary.has(method)) {
      response.setHeader("Content-Type", "application/octet-stream");
      response.end(Buffer.from(result.bytes));
    } else {
      response.setHeader("Content-Type", "application/json");
      response.end(json(result));
    }
  } catch (error) {
    response.writeHead(422, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolve);
});
console.log(
  JSON.stringify({
    ready: true,
    source: reader.build,
    workbench: `${origin.origin}/?renderer-lab=1&local-source=${encodeURIComponent(`http://127.0.0.1:${port}`)}`,
  }),
);
async function close() {
  server.close();
  await reader.close();
  process.exit(0);
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
