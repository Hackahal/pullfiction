import { useEffect, useRef, useState } from "react";
import { createTurnstileLoader, type TurnstileApi } from "./turnstile-loader";
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}
const load = createTurnstileLoader(
  () => document,
  () => window.turnstile,
);
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
          "expired-callback": () => {
            if (!disposed) onToken("");
          },
          "error-callback": () => {
            if (disposed) return;
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
