export const LIBRARY_TABS = [
  "landing",
  "workspace",
  "projects",
  "logs",
  "rankings",
  "runs",
  "recent",
] as const;
export type LibraryTab = (typeof LIBRARY_TABS)[number];

/** Explicit links work on a fresh visit, while ordinary visits resume the last page. */
export function initialLibraryTab(
  search: string,
  remembered: string | null,
): LibraryTab {
  const requested = new URLSearchParams(search).get("page");
  for (const candidate of [requested, remembered]) {
    if (LIBRARY_TABS.includes(candidate as LibraryTab))
      return candidate as LibraryTab;
  }
  return "landing";
}

/** Keep refresh consistent after a landing entry action; launch parameters are one-shot. */
export function libraryNavigationUrl(href: string, tab: LibraryTab): string {
  const url = new URL(href);
  url.searchParams.set("page", tab);
  url.searchParams.delete("create");
  url.searchParams.delete("map");
  url.hash = "";
  return url.href;
}
