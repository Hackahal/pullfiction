/** Versioned field deltas. A successful send is the only event that advances the baseline. */
export class ReplayFrameTransport {
  private source = "";
  private rows = new Map<string, Map<string, string>>();
  reset() {
    this.source = "";
    this.rows.clear();
  }
  send<T extends { key: string }>(
    source: string,
    actors: readonly T[],
    publish: (json: string) => void,
  ) {
    const reset = this.source !== source;
    const next = new Map<string, Map<string, string>>();
    const updates: string[] = [];
    const order: string[] = [];
    for (const actor of actors) {
      if (next.has(actor.key)) throw new Error("Duplicate replay actor key");
      order.push(actor.key);
      const previous = reset ? undefined : this.rows.get(actor.key);
      const fields = new Map<string, string>();
      const changed: string[] = [];
      for (const [name, value] of Object.entries(actor)) {
        const encoded = JSON.stringify(value);
        if (encoded === undefined) continue;
        fields.set(name, encoded);
        if (!previous || previous.get(name) !== encoded)
          changed.push(`${JSON.stringify(name)}:${encoded}`);
      }
      for (const name of previous?.keys() ?? [])
        if (!fields.has(name)) changed.push(`${JSON.stringify(name)}:null`);
      if (changed.length) {
        if (previous) changed.unshift(`"key":${JSON.stringify(actor.key)}`);
        updates.push(`{${changed.join(",")}}`);
      }
      next.set(actor.key, fields);
    }
    publish(
      `{"version":1,"source":${JSON.stringify(source)},"reset":${reset},"order":${JSON.stringify(order)},"updates":[${updates.join(",")}]}`,
    );
    this.source = source;
    this.rows = next;
  }
}
