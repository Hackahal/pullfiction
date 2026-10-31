// Developer-time numeric metadata retrieval only. Never used by the website.
import { pathToFileURL } from "node:url";

const maxBytes = 3 * 1024 * 1024;

export async function fetchPage(value, request = fetch) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "www.wowhead.com" ||
      !/^\/classic\/(?:npc|zone)=\d+$/.test(url.pathname) || !["", "?env=4"].includes(url.search)) {
    throw new Error("Only numeric Wowhead Classic metadata pages are allowed");
  }
  let current = url;
  let response;
  const signal = AbortSignal.timeout(15000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    response = await request(current, {
      signal,
      redirect: "manual",
      headers: { "User-Agent": "PullFiction-Metadata-Prefetch/1.0" },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("Location");
    const next = location && new URL(location, current);
    if (redirects === 3 || !next || next.protocol !== "https:" || next.hostname !== url.hostname ||
        !(next.pathname === url.pathname || next.pathname.startsWith(`${url.pathname}/`)) ||
        !["", url.search].includes(next.search)) {
      throw new Error("Unexpected metadata source redirect");
    }
    await response.body?.cancel();
    current = next;
  }
  if (!response.ok) return { status: response.status };
  if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("text/html")) {
    throw new Error("Source is not an HTML metadata page");
  }
  const reader = response.body.getReader();
  let length = 0;
  const chunks = [];
  for (;;) {
    const { value: bytes, done } = await reader.read();
    if (done) break;
    length += bytes.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new Error("Source page exceeds the metadata size bound");
    }
    chunks.push(bytes);
  }
  return { status: response.status, body: Buffer.concat(chunks, length).toString("base64") };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node scripts/wowhead-page-fetch.mjs SOURCE_URL");
    process.stdout.write(JSON.stringify(await fetchPage(process.argv[2])));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Metadata request failed"}\n`);
    process.exitCode = 1;
  }
}
