import type { GameVersion, Gear } from "./types";

export const WOWHEAD_WIDGET_URL = "https://wow.zamimg.com/js/tooltips.js";

export function wowheadDataset(
  kind: "item" | "spell",
  id: number,
  version: GameVersion,
  options: { buff?: boolean; gear?: Gear; equipped?: readonly Gear[] } = {},
) {
  if (!Number.isInteger(id) || id <= 0) return undefined;
  const params = new URLSearchParams({ domain: "classic", [kind]: String(id) });
  if (version === "sod") params.set("dataEnv", "4");
  if (kind === "spell" && options.buff) params.set("buff", "1");
  if (kind === "item") {
    const enchant = options.gear?.permanentEnchant;
    if (Number.isInteger(enchant) && enchant! > 0)
      params.set("ench", String(enchant));
    const pieces = [...new Set((options.equipped ?? []).map((g) => g.id))]
      .filter((n) => Number.isInteger(n) && n > 0)
      .sort((a, b) => a - b);
    if (pieces.length) params.set("pcs", pieces.join(":"));
  }
  return decodeURIComponent(params.toString());
}

export interface WidgetReferenceLine {
  text: string;
  color?: string;
}
export interface WowheadWidgetApi {
  replaceWithTooltip?: (
    element: HTMLElement,
    type: number,
    id: number,
    environment: number,
    locale?: number,
    params?: Record<string, unknown>,
    transform?: (
      html: string,
      entity: { data?: { tooltip?: string; buff?: string } },
    ) => string,
  ) => boolean;
}

export function referenceContextHtml(
  lines: readonly WidgetReferenceLine[] = [],
) {
  const escape = (s: string) =>
    s.replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c]!,
    );
  return lines.length
    ? '<div style="margin-top:8px">' +
        lines
          .map((line) => {
            const colored = line.color && /^#[0-9a-f]{6}$/i.test(line.color);
            return `<div${colored ? ` style="color:${line.color}"` : ' class="q0"'}>${escape(line.text)}</div>`;
          })
          .join("") +
        "</div>"
    : "";
}

/** Delegate inline presentation and its data cache to the same hosted widget. */
export function renderWidgetReference(
  element: HTMLElement,
  kind: "item" | "spell",
  id: number,
  version: GameVersion,
  buff: boolean,
  footer: string,
) {
  const wh = (window as WidgetHost).WH;
  const api = wh?.Tooltips,
    type = wh?.Types?.[kind === "spell" ? "SPELL" : "ITEM"];
  if (!api?.replaceWithTooltip || type === undefined) return false;
  return api.replaceWithTooltip(
    element,
    type,
    id,
    version === "sod" ? 4 : 2,
    undefined,
    buff ? { buff: true } : {},
    (html, entity) => {
      // The hosted inline renderer otherwise consults the active floating
      // tooltip's buff mode. Choose this reference's own mode explicitly.
      const own = buff
        ? entity.data?.buff || entity.data?.tooltip
        : entity.data?.tooltip;
      return (own || html) + footer;
    },
  );
}

type WidgetHost = Window & {
  whTooltips?: {
    colorLinks: boolean;
    iconizeLinks: boolean;
    renameLinks: boolean;
  };
  WH?: { Types?: { ITEM: number; SPELL: number }; Tooltips?: WowheadWidgetApi };
};
let loading: Promise<boolean> | undefined;

/** Use the supported hosted widget; do not bundle Wowhead's script or data. */
export function ensureWowheadWidget(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  const host = window as WidgetHost;
  if (host.WH?.Tooltips) return Promise.resolve(true);
  if (loading) return loading;
  host.whTooltips = {
    colorLinks: false,
    iconizeLinks: false,
    renameLinks: false,
  };
  loading = new Promise<boolean>((resolve) => {
    const script = document.createElement("script");
    script.src = WOWHEAD_WIDGET_URL;
    script.async = true;
    script.addEventListener("load", () => resolve(Boolean(host.WH?.Tooltips)), {
      once: true,
    });
    script.addEventListener(
      "error",
      () => {
        loading = undefined;
        script.remove();
        resolve(false);
      },
      { once: true },
    );
    document.head.append(script);
  });
  return loading;
}

/** Embedded widget content contains Wowhead-root-relative links. */
export function widgetReferenceUrl(href: string, version: GameVersion) {
  if (!href.startsWith("/") || href.startsWith("//")) return undefined;
  const url = new URL(href, "https://www.wowhead.com");
  if (version === "sod") url.searchParams.set("env", "4");
  return url.toString();
}
