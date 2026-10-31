import { GameIcon } from "./GameIcon";
import { EditorIcon } from "./EditorIcon";
import { BROWSER_ASSETS } from "./browser-mode";
import {
  Children,
  cloneElement,
  isValidElement,
  useContext,
  useEffect,
  useState,
  type AnchorHTMLAttributes,
  type ReactNode,
} from "react";
import { iconUrl } from "./domain";
import {
  GameVersionContext,
  loadWowheadMetadata,
  wowheadUrl,
  type WowheadMetadata,
} from "./Wowhead";
import { itemIcon, itemIconName } from "./focus-model";
import { wowheadDataset } from "./wowhead-widget";
import type { Actor, Aura, Gear, Snapshot } from "./types";
import type { EditorController } from "./controller";
import type { GearRune } from "./rune-model";
const qualityColors = [
  "#9d9d9d",
  "#ffffff",
  "#1eff00",
  "#0070dd",
  "#a335ee",
  "#ff8000",
];
function LocalIcon({ icon, spell }: { icon?: string; spell?: number }) {
  return <GameIcon name={icon} spell={spell} />;
}
export function Bar({
  label,
  current,
  max,
  color,
  estimated = false,
  text,
}: {
  label: string;
  current?: number | null;
  max?: number;
  color: string;
  estimated?: boolean;
  text?: string;
}) {
  const known = Number.isFinite(current) && Number.isFinite(max) && max! > 0,
    percent = known ? Math.max(0, Math.min(100, (current! / max!) * 100)) : 0;
  return (
    <div
      className={`focus-bar ${!known ? "unknown" : ""}`}
      title={
        estimated
          ? "Full health assumed before a recorded health sample"
          : undefined
      }
      role="meter"
      aria-label={label}
      aria-valuemin={known ? 0 : undefined}
      aria-valuemax={known ? max : undefined}
      aria-valuenow={known ? (current ?? undefined) : undefined}
      aria-valuetext={
        known
          ? `${Math.round(percent)}%`
          : max
            ? `Current level not recorded; maximum ${max}`
            : "No recorded value"
      }
    >
      <div style={{ width: `${percent}%`, background: color }} />
      <span>{label}</span>
      <strong>
        {text ??
          (estimated && known
            ? `${Math.round(percent)}% · estimated`
            : known
              ? `${current!.toLocaleString()} / ${max!.toLocaleString()} · ${Math.round(percent)}%`
              : max
                ? `? / ${max.toLocaleString()}`
                : "--")}
      </strong>
    </div>
  );
}
export function AuraGroup({
  label,
  auras,
  state,
  controller,
  compact = false,
}: {
  label: string;
  auras: Aura[];
  compact?: boolean;
  state: Snapshot;
  controller: EditorController;
}) {
  if (compact && !auras.length) return null;
  return (
    <section
      aria-label={label}
      className={`${compact ? "focus-aura-row" : "focus-section"} ${label.toLowerCase().includes("debuffs") ? "focus-debuffs" : ""}`}
    >
      {!compact && (
        <h3>
          {label}
          <span>{auras.length}</span>
        </h3>
      )}
      <div className="focus-auras">
        {auras.length ? (
          auras.map((a) => {
            const meta = state.replay?.abilities.get(a.spell);
            return (
              <ReferenceHover
                key={a.spell}
                kind="spell"
                buff
                id={a.spell}
                title={`${meta?.name ?? a.name ?? `Spell ${a.spell}`}${a.stack > 1 ? ` · ${a.stack} stacks` : ""}`}
              >
                <a
                  role="button"
                  href={wowheadUrl("spell", a.spell, state.gameVersion)}
                  aria-label={meta?.name ?? a.name ?? `Spell ${a.spell}`}
                  onClick={(event) => {
                    event.preventDefault();
                    controller.inspectSpell(a.spell);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === " ") {
                      event.preventDefault();
                      controller.inspectSpell(a.spell);
                    }
                  }}
                >
                  <LocalIcon icon={meta?.icon ?? a.icon} spell={a.spell} />
                  {a.stack > 1 && <small>{a.stack}</small>}
                </a>
              </ReferenceHover>
            );
          })
        ) : (
          <span className="focus-none">None</span>
        )}
      </div>
    </section>
  );
}
export function GearIcon({
  gear,
  rune,
  equipped,
}: {
  gear: Gear;
  rune?: GearRune;
  equipped?: readonly Gear[];
}) {
  const version = useContext(GameVersionContext);
  const [data, setData] = useState<WowheadMetadata>();
  const [failedIcons, setFailedIcons] = useState<string[]>([]);
  useEffect(() => {
    if (itemIconName(gear.icon) && gear.name && gear.quality !== undefined)
      return;
    let active = true;
    loadWowheadMetadata("item", gear.id, version)
      .then((d) => {
        if (active) setData(d);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [gear.id, gear.icon, gear.name, gear.quality, version]);
  const name =
      gear.name ?? data?.name ?? String(gear.model?.name ?? `Item ${gear.id}`),
    color =
      qualityColors[
        gear.quality ?? data?.quality ?? Number(gear.model?.quality ?? 1)
      ] ?? "#aaa",
    recordedIcon = itemIconName(gear.icon),
    icon = [
      recordedIcon ? iconUrl(recordedIcon) : null,
      itemIcon(gear.icon),
      itemIcon(data?.icon),
    ].find((src): src is string => Boolean(src && !failedIcons.includes(src)));
  return (
    <ReferenceHover
      kind="item"
      id={gear.id}
      title={name}
      gear={gear}
      equipped={equipped}
    >
      <a
        href={wowheadUrl("item", gear.id, version)}
        target="_blank"
        rel="noreferrer"
        aria-label={rune ? `${name} · Rune: ${rune.name}` : name}
        style={{ borderColor: color }}
      >
        {BROWSER_ASSETS ? (
          <GameIcon name={gear.icon} item={gear.id} />
        ) : icon ? (
          <img
            alt=""
            draggable={false}
            src={icon}
            onError={() => setFailedIcons((failed) => [...failed, icon])}
          />
        ) : (
          <LocalIcon />
        )}
      </a>
      {rune &&
        (rune.spellId ? (
          <a
            className="gear-rune-badge"
            href={wowheadUrl("spell", rune.spellId, version)}
            data-wowhead={wowheadDataset("spell", rune.spellId, version)}
            aria-label={`Rune: ${rune.name}`}
            target="_blank"
            rel="noreferrer"
          >
            <GameIcon spell={rune.spellId} name={rune.icon} />
          </a>
        ) : (
          <span
            className="gear-rune-badge"
            title={`Rune: ${rune.name}`}
            aria-label={`Rune: ${rune.name}`}
          >
            {rune.icon ? <GameIcon name={rune.icon} /> : "R"}
          </span>
        ))}
    </ReferenceHover>
  );
}
type ReferenceAnchorProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  "data-wowhead"?: string;
};

export function ReferenceHover({
  kind,
  id,
  title,
  buff,
  gear,
  equipped,
  children,
  className = "focus-icon-wrap",
}: {
  kind: "spell" | "item";
  id: number;
  title: string;
  buff?: boolean;
  gear?: Gear;
  equipped?: readonly Gear[];
  children: ReactNode;
  className?: string;
}) {
  const version = useContext(GameVersionContext);
  const dataset = wowheadDataset(kind, id, version, { buff, gear, equipped });
  return (
    <span className={className}>
      {Children.map(children, (child) => {
        if (!isValidElement<ReferenceAnchorProps>(child) || child.type !== "a")
          return child;
        return cloneElement(child, {
          "data-wowhead": child.props["data-wowhead"] ?? dataset,
          "aria-label": child.props["aria-label"] ?? title,
          // Wowhead delegates pointer hover to the document. Mirror that event
          // for keyboard focus without depending on its private renderer API.
          onFocus: (event) => {
            child.props.onFocus?.(event);
            const bounds = event.currentTarget.getBoundingClientRect();
            event.currentTarget.dispatchEvent(
              new MouseEvent("mouseover", {
                bubbles: true,
                clientX: bounds.right,
                clientY: bounds.top,
              }),
            );
          },
          onBlur: (event) => {
            child.props.onBlur?.(event);
            event.currentTarget.dispatchEvent(
              new MouseEvent("mouseout", {
                bubbles: true,
                relatedTarget: event.relatedTarget,
              }),
            );
          },
        });
      })}
    </span>
  );
}
