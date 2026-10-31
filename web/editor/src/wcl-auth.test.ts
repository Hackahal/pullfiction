import { test } from "node:test";
import assert from "node:assert/strict";
import { WclSession, WclSignInRequired } from "./wcl-auth";

const config = {
  clientId: "public-client",
  redirectUri: "https://pullfiction.example/oauth/callback",
};
function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
  };
}
function callback(authorization: URL) {
  const url = new URL(config.redirectUri);
  url.search = new URLSearchParams({
    code: "test-code",
    state: authorization.searchParams.get("state")!,
  }).toString();
  return url;
}
function reply(access = "test-token", extra = {}) {
  return Response.json({
    access_token: access,
    token_type: "Bearer",
    expires_in: 3600,
    ...extra,
  });
}

test("token exchange and refresh invoke browser fetch with its global receiver", async () => {
  let now = 0;
  let requests = 0;
  const session = new WclSession(
    config,
    storage(),
    async function (this: unknown) {
      assert.equal(
        this,
        globalThis,
        "browser fetch must not receive WclSession as this",
      );
      requests++;
      return reply(`token-${requests}`, {
        expires_in: 60,
        refresh_token: "refresh",
      });
    },
    () => now,
  );
  await session.finish(callback(await session.begin()));
  assert.equal(await session.accessToken(), "token-1");
  now = 31000;
  assert.equal(await session.accessToken(), "token-2");
  assert.equal(requests, 2);
});

test("PKCE redirect survives reload, binds state and sends no client secret", async () => {
  const local = storage();
  const authorization = await new WclSession(config, local).begin(
    "/?raid=409#plan",
  );
  assert.equal(authorization.origin, "https://www.warcraftlogs.com");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.match(
    authorization.searchParams.get("code_challenge")!,
    /^[\w-]{43}$/,
  );
  const session = new WclSession(config, local, async (url, options) => {
    assert.equal(url, "https://www.warcraftlogs.com/oauth/token");
    const body = new URLSearchParams(options?.body as string);
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("client_id"), config.clientId);
    assert.equal(body.get("client_secret"), null);
    assert.match(body.get("code_verifier")!, /^[\w-]{43,128}$/);
    assert.equal(new Headers(options?.headers).has("authorization"), false);
    assert.equal(options?.credentials, "omit");
    return reply();
  });
  assert.equal(
    await session.finish(callback(authorization)),
    "/?raid=409#plan",
  );
  assert.equal(await session.accessToken(), "test-token");
  assert.equal(
    local.values.size,
    0,
    "neither tokens nor used verifiers persist",
  );
  await assert.rejects(
    session.finish(callback(authorization)),
    WclSignInRequired,
  );
  session.disconnect();
  await assert.rejects(session.accessToken(), WclSignInRequired);
});

test("wrong state, expired state, duplicate codes and wrong callback never exchange a code", async () => {
  for (const invalid of ["state", "expired", "duplicate", "origin", "client"]) {
    const local = storage();
    let now = 1000,
      requests = 0;
    const session = new WclSession(
      config,
      local,
      async () => {
        requests++;
        return reply();
      },
      () => now,
    );
    const authorization = await session.begin();
    const url = callback(authorization);
    if (invalid === "state") url.searchParams.set("state", "wrong");
    if (invalid === "expired") now += 600001;
    if (invalid === "duplicate") url.searchParams.append("code", "second");
    if (invalid === "origin") url.hostname = "other.example";
    if (invalid === "client") {
      const [key, value] = [...local.values][0];
      local.setItem(
        key,
        JSON.stringify({ ...JSON.parse(value), clientId: "other" }),
      );
    }
    await assert.rejects(session.finish(url));
    assert.equal(requests, 0, invalid);
  }
});

test("refresh is serialized and disconnect invalidates an in-flight response", async () => {
  const local = storage();
  let now = 0,
    release!: (response: Response) => void,
    requests = 0;
  const session = new WclSession(
    config,
    local,
    async (_url, options) => {
      requests++;
      const body = new URLSearchParams(options?.body as string);
      if (body.get("grant_type") === "authorization_code")
        return reply("first", {
          refresh_token: "refresh-test",
          expires_in: 60,
        });
      assert.equal(body.get("refresh_token"), "refresh-test");
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    () => now,
  );
  await session.finish(callback(await session.begin()));
  now = 31000;
  const first = session.accessToken(),
    second = session.accessToken();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 2);
  session.disconnect();
  release(reply("refreshed"));
  await assert.rejects(first, WclSignInRequired);
  await assert.rejects(second, WclSignInRequired);
  await assert.rejects(session.accessToken(), WclSignInRequired);
});

test("return paths stay local and unavailable session storage fails before navigation", async () => {
  const session = new WclSession(config, storage());
  for (const path of [
    "https://other.example",
    "//other.example",
    "/\\other.example",
  ])
    await assert.rejects(session.begin(path));
  const local = storage();
  local.setItem = () => {
    throw new Error("storage unavailable");
  };
  await assert.rejects(
    new WclSession(config, local).begin(),
    /storage unavailable/,
  );
  assert.throws(
    () =>
      new WclSession(
        { ...config, redirectUri: "http://public.example/callback" },
        storage(),
      ),
    /Invalid/,
  );
});

test("cancelling one refresh waiter preserves the shared refresh for other requests", async () => {
  const local = storage();
  let now = 0,
    calls = 0,
    release!: (response: Response) => void;
  const session = new WclSession(
    config,
    local,
    async (_url, options) => {
      calls++;
      if (
        new URLSearchParams(options?.body as string).get("grant_type") ===
        "authorization_code"
      )
        return reply("first", {
          refresh_token: "refresh-test",
          expires_in: 60,
        });
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    () => now,
  );
  await session.finish(callback(await session.begin()));
  now = 31000;
  const controller = new AbortController();
  const cancelled = session.accessToken(controller.signal);
  controller.abort();
  await assert.rejects(cancelled, /abort/i);
  const waiting = session.accessToken();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  release(reply("new"));
  assert.equal(await waiting, "new");
  assert.equal(await session.accessToken(), "new");
});
