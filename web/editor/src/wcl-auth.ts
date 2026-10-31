import * as oauth from "oauth4webapi";

// WCL documents PKCE for browser clients at https://www.warcraftlogs.com/api/docs.
// Only a public client ID belongs in the static application. Tokens stay in memory.
const server: oauth.AuthorizationServer = {
  issuer: "https://www.warcraftlogs.com",
  authorization_endpoint: "https://www.warcraftlogs.com/oauth/authorize",
  token_endpoint: "https://www.warcraftlogs.com/oauth/token",
};
const PENDING_KEY = "pullfiction.wcl.authorization.v1";
const MAX_PENDING_AGE = 10 * 60 * 1000;
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type WclAuthConfig = { clientId: string; redirectUri: string };
type Pending = {
  clientId: string;
  redirectUri: string;
  state: string;
  verifier: string;
  created: number;
  returnTo: string;
};

export class WclSignInRequired extends Error {
  constructor() {
    super("Connect Warcraft Logs to import a report.");
    this.name = "WclSignInRequired";
  }
}

export class WclSession {
  private client: oauth.Client;
  private redirect: URL;
  private tokens: oauth.TokenEndpointResponse | null = null;
  private expires = 0;
  private epoch = 0;
  private refreshing: Promise<string> | null = null;
  constructor(
    config: WclAuthConfig,
    private storage: StoragePort,
    private request: typeof fetch = fetch,
    private now = Date.now,
  ) {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(config.clientId))
      throw new Error("A public Warcraft Logs client ID is required.");
    this.redirect = new URL(config.redirectUri);
    if (
      (this.redirect.protocol !== "https:" &&
        !(
          this.redirect.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(this.redirect.hostname)
        )) ||
      this.redirect.username ||
      this.redirect.password ||
      this.redirect.search ||
      this.redirect.hash
    )
      throw new Error("Invalid Warcraft Logs callback URL.");
    this.client = {
      client_id: config.clientId,
      token_endpoint_auth_method: "none",
    };
  }

  async begin(returnTo = "/") {
    if (
      returnTo.length > 1024 ||
      !returnTo.startsWith("/") ||
      returnTo.startsWith("//")
    )
      throw new Error("Invalid sign-in return path.");
    const destination = new URL(returnTo, this.redirect);
    if (destination.origin !== this.redirect.origin)
      throw new Error("Invalid sign-in return path.");
    const verifier = oauth.generateRandomCodeVerifier();
    const state = oauth.generateRandomState();
    const challenge = await oauth.calculatePKCECodeChallenge(verifier);
    const pending: Pending = {
      clientId: this.client.client_id,
      redirectUri: this.redirect.href,
      verifier,
      state,
      created: this.now(),
      returnTo: destination.pathname + destination.search + destination.hash,
    };
    // If session storage is unavailable, do not navigate to a flow we cannot finish.
    this.storage.setItem(PENDING_KEY, JSON.stringify(pending));
    const url = new URL(server.authorization_endpoint!);
    url.search = new URLSearchParams({
      client_id: this.client.client_id,
      redirect_uri: this.redirect.href,
      response_type: "code",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return url;
  }

  async finish(callback: URL, signal?: AbortSignal) {
    if (
      callback.origin !== this.redirect.origin ||
      callback.pathname !== this.redirect.pathname ||
      callback.hash
    )
      throw new Error("Unexpected Warcraft Logs callback URL.");
    const raw = this.storage.getItem(PENDING_KEY);
    this.storage.removeItem(PENDING_KEY);
    if (!raw || raw.length > 4096) throw new WclSignInRequired();
    let pending: Pending;
    try {
      pending = JSON.parse(raw);
    } catch {
      throw new WclSignInRequired();
    }
    if (
      pending?.clientId !== this.client.client_id ||
      pending.redirectUri !== this.redirect.href ||
      typeof pending.state !== "string" ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(pending.verifier) ||
      !Number.isFinite(pending.created) ||
      pending.created > this.now() ||
      this.now() - pending.created > MAX_PENDING_AGE ||
      typeof pending.returnTo !== "string" ||
      new URL(pending.returnTo, this.redirect).origin !== this.redirect.origin
    )
      throw new WclSignInRequired();
    const params = oauth.validateAuthResponse(
      server,
      this.client,
      callback,
      pending.state,
    );
    const epoch = this.epoch;
    const response = await oauth.authorizationCodeGrantRequest(
      server,
      this.client,
      oauth.None(),
      params,
      this.redirect.href,
      pending.verifier,
      this.options(signal),
    );
    const tokens = await oauth.processAuthorizationCodeResponse(
      server,
      this.client,
      response,
    );
    signal?.throwIfAborted();
    if (epoch !== this.epoch) throw new WclSignInRequired();
    this.accept(tokens);
    return pending.returnTo;
  }

  private options(signal?: AbortSignal): oauth.TokenEndpointRequestOptions {
    return {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(45000)])
        : AbortSignal.timeout(45000),
      [oauth.customFetch]: (url, options) =>
        this.request.call(globalThis, url, {
          ...options,
          credentials: "omit",
          cache: "no-store",
          referrerPolicy: "no-referrer",
        }),
    };
  }

  private accept(tokens: oauth.TokenEndpointResponse) {
    if (tokens.token_type.toLowerCase() !== "bearer" || !tokens.expires_in)
      throw new Error("Warcraft Logs returned an unsupported access token.");
    this.tokens = tokens;
    this.expires = this.now() + tokens.expires_in * 1000;
  }

  async accessToken(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (this.tokens && this.now() < this.expires - 30000)
      return this.tokens.access_token;
    if (this.refreshing) return this.waitForToken(this.refreshing, signal);
    if (!this.tokens?.refresh_token) throw new WclSignInRequired();
    const refresh = this.tokens.refresh_token;
    const epoch = this.epoch;
    const operation: Promise<string> = (async () => {
      try {
        const response = await oauth.refreshTokenGrantRequest(
          server,
          this.client,
          oauth.None(),
          refresh,
          this.options(),
        );
        const tokens = await oauth.processRefreshTokenResponse(
          server,
          this.client,
          response,
        );
        if (epoch !== this.epoch) throw new WclSignInRequired();
        this.accept({
          ...tokens,
          refresh_token: tokens.refresh_token ?? refresh,
        });
        return tokens.access_token;
      } catch (error) {
        if (epoch === this.epoch) this.tokens = null;
        throw error;
      }
    })().finally(() => {
      if (this.refreshing === operation) this.refreshing = null;
    });
    this.refreshing = operation;
    return this.waitForToken(operation, signal);
  }

  private async waitForToken(operation: Promise<string>, signal?: AbortSignal) {
    if (!signal) return operation;
    signal.throwIfAborted();
    let aborted!: () => void;
    const cancel = new Promise<never>((_resolve, reject) => {
      aborted = () => reject(signal.reason);
      signal.addEventListener("abort", aborted, { once: true });
    });
    try {
      return await Promise.race([operation, cancel]);
    } finally {
      signal.removeEventListener("abort", aborted);
    }
  }

  disconnect() {
    this.epoch++;
    this.tokens = null;
    this.refreshing = null;
    this.storage.removeItem(PENDING_KEY);
  }
}
