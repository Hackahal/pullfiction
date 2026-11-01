import { useEffect, useRef, useState } from "react";
interface TurnstileApi {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  remove(id: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}
let loading: Promise<TurnstileApi> | undefined;
function load() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  return (loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    const timer = setTimeout(() => {
      loading = undefined;
      reject(
        new Error("Verification did not load. Close Share and try again."),
      );
    }, 15000);
    script.onload = () => {
      clearTimeout(timer);
      window.turnstile
        ? resolve(window.turnstile)
        : reject(new Error("Verification is unavailable."));
    };
    script.onerror = () => {
      clearTimeout(timer);
      loading = undefined;
      script.remove();
      reject(new Error("Could not load sharing verification."));
    };
    document.head.append(script);
  }));
}
export function Turnstile({
  siteKey,
  attempt,
  onToken,
}: {
  siteKey: string;
  attempt: number;
  onToken: (token: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false,
      id: string | undefined,
      api: TurnstileApi;
    onToken("");
    setError("");
    void load()
      .then((value) => {
        if (disposed || !ref.current) return;
        api = value;
        id = api.render(ref.current, {
          sitekey: siteKey,
          action: "publish_share",
          theme: "dark",
          callback: (token: string) => {
            if (!disposed) onToken(token);
          },
          "expired-callback": () => onToken(""),
          "error-callback": () => {
            onToken("");
            setError("Verification failed. Close Share and try again.");
          },
        });
      })
      .catch((error) => {
        if (!disposed) setError(error.message);
      });
    return () => {
      disposed = true;
      if (id !== undefined) api.remove(id);
    };
  }, [siteKey, attempt, onToken]);
  return (
    <>
      <div ref={ref} />
      {error && <p role="alert">{error}</p>}
    </>
  );
}
