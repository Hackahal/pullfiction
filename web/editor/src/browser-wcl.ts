import { BrowserLogs, browserQuery } from "./wcl-browser";
import { WclSession, type WclAuthConfig } from "./wcl-auth";

export function publicWclConfig(
  location: Pick<Location, "origin" | "pathname">,
): WclAuthConfig | null {
  const clientId = import.meta.env?.VITE_WCL_CLIENT_ID;
  if (!clientId) return null;
  return {
    clientId,
    redirectUri:
      import.meta.env?.VITE_WCL_REDIRECT_URI ||
      location.origin + location.pathname,
  };
}
export function isWclCallback(url: URL) {
  return url.searchParams.has("code") || url.searchParams.has("error");
}
export function clearWclCallback(url: URL) {
  const clean = new URL(url);
  for (const key of [
    "code",
    "state",
    "error",
    "error_description",
    "error_uri",
  ])
    clean.searchParams.delete(key);
  return clean.pathname + clean.search + clean.hash;
}
export function createBrowserLogs(
  config: WclAuthConfig,
  storage: Storage,
  disconnected: () => void = () => {},
) {
  const session = new WclSession(config, storage);
  const query = browserQuery({
    async accessToken(signal) {
      try {
        return await session.accessToken(signal);
      } catch (error) {
        disconnected();
        throw error;
      }
    },
    disconnect() {
      session.disconnect();
      disconnected();
    },
  });
  return { session, logs: new BrowserLogs(query) };
}
