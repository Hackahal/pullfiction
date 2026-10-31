import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ImgHTMLAttributes,
} from "react";
import { BROWSER_ASSETS, schematicIcon } from "./browser-mode";
import { iconUrl } from "./domain";
import {
  getLocalIcons,
  subscribeLocalIcons,
  iconRequestKey,
  type IconRequest,
} from "./local-icons";

export function useGameIcon(request: IconRequest, enabled = true) {
  const cache = useSyncExternalStore(
    subscribeLocalIcons,
    getLocalIcons,
    getLocalIcons,
  );
  const key = iconRequestKey(request);
  const [result, setResult] = useState<{
    cache: typeof cache;
    key: string;
    url?: string;
  }>();
  useEffect(() => {
    if (!BROWSER_ASSETS || !cache || !enabled) return;
    let active = true;
    const lease = cache.acquire(request);
    void lease.url.then((url) => {
      if (active) setResult({ cache, key, url });
    });
    return () => {
      active = false;
      lease.release();
    };
  }, [cache, key, enabled]);
  if (!BROWSER_ASSETS) return iconUrl(request.icon);
  return result && result.cache === cache && result.key === key && result.url
    ? result.url
    : schematicIcon;
}
export function useGameIconImage(request: IconRequest) {
  const url = useGameIcon(request);
  const [result, setResult] = useState<{
    url: string;
    image: HTMLImageElement;
  }>();
  useEffect(() => {
    let active = true;
    const image = new Image();
    image.onload = () => {
      if (active) setResult({ url, image });
    };
    image.onerror = () => {
      image.onload = null;
      image.onerror = null;
    };
    image.src = url;
    return () => {
      active = false;
      image.onload = null;
      image.onerror = null;
    };
  }, [url]);
  return result?.url === url ? result.image : undefined;
}
export function GameIcon({
  name,
  spell,
  item,
  iconFile,
  source,
  ...props
}: {
  name?: string;
  spell?: number;
  item?: number;
  iconFile?: number;
  source?: string;
} & Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "onError">) {
  const local = useGameIcon({ icon: name, spell, item, iconFile }, !source);
  return (
    <img
      draggable={false}
      alt=""
      {...props}
      src={source ?? local}
      onError={(event) => {
        const fallback = iconUrl();
        if (event.currentTarget.getAttribute("src") !== fallback)
          event.currentTarget.src = fallback;
      }}
    />
  );
}
