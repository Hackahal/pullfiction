import type { RawReplay } from "./types";

const positiveID = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) > 0 && Number(value) <= 0xffffffff;
const row = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;

// Supply the original replay consumers with stable native icon names backed by
// this client's actual FileDataIDs. The caller retains the unmodified raw export.
export function localSpellReplay(
  raw: RawReplay,
  catalog: Record<string, unknown>,
): RawReplay {
  const abilities = new Map(
    (raw.abilities ?? []).map((ability) => [ability.gameID, { ...ability }]),
  );
  const observed = new Set(abilities.keys());
  for (const value of raw.events) {
    const event = row(value);
    if (!event) continue;
    const spell = event.abilityGameID ?? row(event.ability)?.guid;
    if (positiveID(spell)) observed.add(spell);
    if (event.type === "combatantinfo" && Array.isArray(event.auras))
      for (const aura of event.auras) {
        const id = row(aura)?.ability ?? row(aura)?.abilityGameID;
        if (positiveID(id)) observed.add(id);
      }
  }
  for (const id of observed) {
    const client = row(catalog[id]);
    if (!client) continue;
    const ability = abilities.get(id) ?? { gameID: id };
    if (positiveID(client.iconFile)) ability.icon = `pf_${client.iconFile}.blp`;
    if (
      (!ability.name || /^Spell \d+$/.test(ability.name)) &&
      typeof client.name === "string"
    )
      ability.name = client.name;
    abilities.set(id, ability);
  }
  return { ...raw, abilities: [...abilities.values()] };
}
