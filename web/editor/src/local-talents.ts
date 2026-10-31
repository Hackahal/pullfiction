// Metadata only. Recorded allocations belong to the replay; this catalog never
// turns tree-point totals into talent IDs or supplies ranks a log did not record.
export interface TalentNode {
  id: number;
  /** Zero-based client grid row and column. */
  row: number;
  column: number;
  maxRank: number;
  /** Spell IDs in ascending rank order. */
  ranks: number[];
  /** Required ranks are one-based. */
  prerequisites: { id: number; rank: number }[];
}
export interface TalentTree {
  id: number;
  classId: number;
  name: string;
  /** Local icon reference, for example id:135810. */
  icon: string;
  /** Zero-based order within the class. */
  order: number;
  nodes: TalentNode[];
}
export interface TalentCatalog {
  schema: 1;
  source: { product: string; version: string; buildKey: string };
  layouts: Record<string, string>;
  trees: TalentTree[];
  classes: { id: number; name: string }[];
  readable: boolean;
  partial: boolean;
  reason: string;
  coverage: {
    complete: boolean;
    tables: Record<
      string,
      { complete: boolean; includedRecords: number; [key: string]: unknown }
    >;
    unavailableTables: string[];
  };
}

type TalentsProvider = () => Promise<TalentCatalog>;
let provider: TalentsProvider | null = null;
let revision = 0;
let cached: TalentCatalog | null = null;
let pending: Promise<TalentCatalog | null> | null = null;

export function setLocalTalentsProvider(next: TalentsProvider | null): void {
  if (provider === next) return;
  provider = next;
  revision += 1;
  cached = null;
  pending = null;
}

export function loadLocalTalents(): Promise<TalentCatalog | null> {
  if (!provider) return Promise.resolve(null);
  if (cached) return Promise.resolve(cached);
  if (pending) return pending;
  const current = provider;
  const version = revision;
  const request = Promise.resolve()
    .then(current)
    .then((catalog) => {
      if (version !== revision || current !== provider) return null;
      if (catalog.schema !== 1 || !Array.isArray(catalog.trees)) return null;
      // Retry partial reads on the next tab opening. A complete catalog remains
      // cached until the selected local client changes.
      if (catalog.readable && !catalog.partial) cached = catalog;
      return catalog;
    })
    .catch(() => null)
    .finally(() => {
      if (pending === request) pending = null;
    });
  pending = request;
  return request;
}
