import { useContext, useEffect, useRef, useState } from "react";
import { GameVersionContext, wowheadUrl } from "./Wowhead";
import {
  ensureWowheadWidget,
  referenceContextHtml,
  renderWidgetReference,
  wowheadDataset,
  widgetReferenceUrl,
  type WidgetReferenceLine,
} from "./wowhead-widget";

/** React owns the empty host; the hosted widget owns its rendered contents. */
export function WowheadReference({
  kind,
  id,
  buff = false,
  context = [],
}: {
  kind: "item" | "spell";
  id: number;
  buff?: boolean;
  context?: readonly WidgetReferenceLine[];
}) {
  const version = useContext(GameVersionContext);
  const host = useRef<HTMLDivElement>(null);
  const key = `${version}:${kind}:${id}:${buff}`;
  const [rendered, setRendered] = useState("");
  const footer = referenceContextHtml(context);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let active = true;
    const observer = new MutationObserver(() => {
      if (!active) return;
      for (const link of element.querySelectorAll<HTMLAnchorElement>(
        "a[href]",
      )) {
        const url = widgetReferenceUrl(
          link.getAttribute("href") ?? "",
          version,
        );
        if (url) {
          link.href = url;
          link.target = "_blank";
          link.rel = "noreferrer noopener";
          link.dataset.wowhead = `domain=classic${version === "sod" ? "&dataEnv=4" : ""}`;
        }
      }
      if (element.querySelector(".wowhead-tooltip")) setRendered(key);
    });
    observer.observe(element, { childList: true, subtree: true });
    void ensureWowheadWidget().then((available) => {
      if (active && available) {
        try {
          renderWidgetReference(element, kind, id, version, buff, footer);
        } catch {}
      }
    });
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [key, kind, id, version, buff, footer]);
  return (
    <section className="widget-reference">
      <div ref={host} key={key} />
      {rendered !== key && (
        <a
          href={wowheadUrl(kind, id, version)}
          data-wowhead={wowheadDataset(kind, id, version, { buff })}
          target="_blank"
          rel="noreferrer"
        >
          {kind === "spell" ? "Spell" : "Item"} details on Wowhead ↗
        </a>
      )}
    </section>
  );
}
