export interface TurnstileApi {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  remove(id: string): void;
}

// Share one pending script across closing/reopening the dialog. A failed attempt
// must release its script and handlers before another attempt can start.
export function createTurnstileLoader(
  getDocument: () => Document,
  getApi: () => TurnstileApi | undefined,
) {
  let loading: Promise<TurnstileApi> | undefined;
  return function load(): Promise<TurnstileApi> {
    const ready = getApi();
    if (ready) return Promise.resolve(ready);
    if (loading) return loading;
    loading = new Promise<TurnstileApi>((resolve, reject) => {
      const script = getDocument().createElement("script");
      script.src =
        "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      let settled = false;
      const cleanup = (remove: boolean) => {
        clearTimeout(timer);
        script.onload = script.onerror = null;
        if (remove) script.remove();
      };
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        cleanup(true);
        loading = undefined;
        reject(new Error(message));
      };
      const timer = setTimeout(
        () => fail("Verification did not load. Close Share and try again."),
        15000,
      );
      script.onload = () => {
        if (settled) return;
        const api = getApi();
        if (!api) {
          fail("Verification is unavailable.");
          return;
        }
        settled = true;
        cleanup(false);
        resolve(api);
      };
      script.onerror = () => fail("Could not load sharing verification.");
      getDocument().head.append(script);
    });
    return loading;
  };
}
