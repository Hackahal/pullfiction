type Field = { value: unknown; encoded: string };
/** Versioned field deltas. A successful send is the only event that advances the baseline. */
export class ReplayFrameTransport {
  private source = "";
  private sourceJson = '""';
  private order: string[] = [];
  private orderJson = "[]";
  private rows = new Map<string, Map<string, Field>>();
  private fieldNames = new Map<string, string>();
  private generation?: object;
  reset() {
    this.source = "";
    this.sourceJson = '""';
    this.order = [];
    this.orderJson = "[]";
    this.rows.clear();
    this.fieldNames.clear();
    this.generation = undefined;
  }
  send<T extends { key: string }>(
    source: string,
    actors: readonly T[],
    publish: (json: string) => void,
    // Callers may promise that reused object references cannot mutate within
    // this generation. Omit it when nested values can change in place.
    generation?: object,
    // Plain frame rows keep stable string keys and their own property set throughout serialization.
    plainRows = false,
  ) {
    const reset = this.source !== source;
    const stableObjects =
      generation !== undefined && this.generation === generation;
    const next = new Map<string, Map<string, Field>>();
    const patches: {
      fields: Map<string, Field>;
      set?: [string, Field][];
      remove?: string[];
    }[] = [];
    const updates: string[] = [];
    let order: string[] | undefined =
      plainRows && !reset && actors.length === this.order.length
        ? undefined
        : [];
    const fieldName = (name: string) => {
      let encoded = this.fieldNames.get(name);
      if (encoded === undefined) {
        encoded = JSON.stringify(name);
        this.fieldNames.set(name, encoded);
      }
      return encoded;
    };
    let rowIndex = 0;
    for (const actor of actors) {
      if (next.has(actor.key)) throw new Error("Duplicate replay actor key");
      if (order) order.push(actor.key);
      else if (this.order[rowIndex] !== actor.key) {
        order = this.order.slice(0, rowIndex);
        order.push(actor.key);
      }
      const previous = reset ? undefined : this.rows.get(actor.key);
      const fields = previous ?? new Map<string, Field>();
      let set: [string, Field][] | undefined;
      let remove: string[] | undefined;
      let changed: string[] | undefined;
      let matched = 0;
      for (const name of Object.keys(actor)) {
        const value = (actor as Record<string, unknown>)[name];
        const old = previous?.get(name);
        if (old) matched++;
        // A new metadata generation rechecks objects even when their reference
        // is reused, so edits between generations remain observable.
        if (
          old &&
          (stableObjects || value === null || typeof value !== "object") &&
          typeof value !== "function" &&
          Object.is(old.value, value)
        ) {
          continue;
        }
        const encoded = JSON.stringify(value);
        if (encoded === undefined) {
          if (old) (remove ??= []).push(name);
          continue;
        }
        if (!old || !Object.is(old.value, value) || old.encoded !== encoded)
          (set ??= []).push([name, { value, encoded }]);
        if (!old || old.encoded !== encoded)
          (changed ??= []).push(`${fieldName(name)}:${encoded}`);
      }
      // Most playback rows keep all their keys. Only look for missing
      // properties if a prior field was not visited.
      if (previous && (!plainRows || matched !== previous.size))
        for (const name of previous.keys())
          if (!Object.hasOwn(actor, name)) (remove ??= []).push(name);
      if (remove)
        for (const name of remove)
          (changed ??= []).push(`${fieldName(name)}:null`);
      if (changed) {
        if (previous) {
          const key =
            (plainRows ? previous.get("key")?.encoded : undefined) ??
            JSON.stringify(actor.key);
          changed.unshift(`"key":${key}`);
        }
        updates.push(`{${changed.join(",")}}`);
      }
      next.set(actor.key, fields);
      if (set || remove) patches.push({ fields, set, remove });
      rowIndex++;
    }
    if (!order && rowIndex !== this.order.length)
      order = this.order.slice(0, rowIndex);
    const sourceJson = reset ? JSON.stringify(source) : this.sourceJson;
    const orderJson = order ? JSON.stringify(order) : this.orderJson;
    publish(
      `{"version":1,"source":${sourceJson},"reset":${reset},"order":${orderJson},"updates":[${updates.join(",")}]}`,
    );
    // Retained maps belong to the successful baseline. Never edit them while
    // constructing a packet: failed serialization or publication must be retryable.
    for (const patch of patches) {
      if (patch.remove)
        for (const name of patch.remove) patch.fields.delete(name);
      if (patch.set)
        for (const [name, field] of patch.set) patch.fields.set(name, field);
    }
    this.source = source;
    this.sourceJson = sourceJson;
    if (order) this.order = order;
    this.orderJson = orderJson;
    this.rows = next;
    this.generation = generation;
  }
}
