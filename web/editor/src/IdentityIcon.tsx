import { useState } from "react";
import { characterClass, factionName } from "./identity-model";

function IdentityIcon({ label, src }: { label: string; src: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <span className="identity-fallback">{label}</span>
  ) : (
    <img
      className="identity-icon"
      src={src}
      alt={label}
      title={label}
      width="22"
      height="22"
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}
export function ClassIcon({ value }: { value: unknown }) {
  const name = characterClass(value);
  return name ? (
    <IdentityIcon
      key={name}
      label={name}
      src={`https://wow.zamimg.com/images/wow/icons/medium/classicon_${name.toLowerCase()}.jpg`}
    />
  ) : null;
}
export function FactionIcon({ value }: { value: unknown }) {
  const faction = factionName(value);
  return faction ? (
    <IdentityIcon
      key={faction}
      label={faction}
      src={`https://assets.rpglogs.com/img/warcraft/faction-${faction === "Alliance" ? 0 : 1}.png`}
    />
  ) : null;
}
export function SourceIcon({
  source,
}: {
  source: { kind: "guild" | "character"; classID?: number; faction?: unknown };
}) {
  return source.kind === "character" ? (
    <ClassIcon value={source.classID} />
  ) : (
    <FactionIcon value={source.faction} />
  );
}
