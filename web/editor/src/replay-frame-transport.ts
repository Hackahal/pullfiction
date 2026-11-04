type Field = { value: unknown; encoded: string };
/** Versioned field deltas. A successful send is the only event that advances the baseline. */
export class ReplayFrameTransport {
  private source = "";
  private rows = new Map<string, Map<string, Field>>();
  private fieldNames = new Map<string, string>();
  private generation?: object;
  reset() {
    this.source = "";
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
  ) {
    const reset = this.source !== source;
    const stableObjects =
      generation !== undefined && this.generation === generation;
    const next = new Map<string, Map<string, Field>>();
    const patches: {
      fields: Map<string, Field>;
      set: [string, Field][];
      remove: string[];
    }[] = [];
    const updates: string[] = [];
    const order: string[] = [];
    const fieldName = (name: string) => {
      let encoded = this.fieldNames.get(name);
      if (encoded === undefined) {
        encoded = JSON.stringify(name);
        this.fieldNames.set(name, encoded);
      }
      return encoded;
    };
    for (const actor of actors) {
      if (next.has(actor.key)) throw new Error("Duplicate replay actor key");
      order.push(actor.key);
      const previous = reset ? undefined : this.rows.get(actor.key);
      const fields = previous ?? new Map<string, Field>();
      const set: [string, Field][] = [];
      const remove: string[] = [];
      const changed: string[] = [];
      for (const name of Object.keys(actor)) {
        const value = (actor as Record<string, unknown>)[name];
        const old = previous?.get(name);
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
          if (old) remove.push(name);
          continue;
        }
        if (!old || !Object.is(old.value, value) || old.encoded !== encoded)
          set.push([name, { value, encoded }]);
        if (!old || old.encoded !== encoded)
          changed.push(`${fieldName(name)}:${encoded}`);
      }
      for (const name of previous?.keys() ?? []) {
        if (!Object.hasOwn(actor, name)) remove.push(name);
      }
      for (const name of remove) changed.push(`${fieldName(name)}:null`);
      if (changed.length) {
        if (previous) changed.unshift(`"key":${JSON.stringify(actor.key)}`);
        updates.push(`{${changed.join(",")}}`);
      }
      next.set(actor.key, fields);
      if (set.length || remove.length) patches.push({ fields, set, remove });
    }
    publish(
      `{"version":1,"source":${JSON.stringify(source)},"reset":${reset},"order":${JSON.stringify(order)},"updates":[${updates.join(",")}]}`,
    );
    // Retained maps belong to the successful baseline. Never edit them while
    // constructing a packet: failed serialization or publication must be retryable.
    for (const patch of patches) {
      for (const name of patch.remove) patch.fields.delete(name);
      for (const [name, field] of patch.set) patch.fields.set(name, field);
    }
    this.source = source;
    this.rows = next;
    this.generation = generation;
  }
}
