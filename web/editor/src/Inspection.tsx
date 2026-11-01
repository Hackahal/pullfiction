import { useEffect, useMemo, useState } from "react";
import { FloatingWindow } from "./FloatingWindow";
import { GearIcon, ReferenceHover } from "./FocusWidgets";
import { GameIcon } from "./GameIcon";
import { EditorIcon } from "./EditorIcon";
import { wowheadUrl } from "./Wowhead";
import { CLASS_COLORS, classIDs } from "./domain";
import { gearRunes, type GearRune } from "./rune-model";
import { loadLocalTalents, type TalentCatalog } from "./local-talents";
import { classTalentTrees, recordedTalents } from "./talent-model";
import type { Actor, Snapshot } from "./types";
import type { EditorController } from "./controller";
const SLOTS = [
  "Head",
  "Neck",
  "Shoulders",
  "Shirt",
  "Chest",
  "Waist",
  "Legs",
  "Feet",
  "Wrists",
  "Hands",
  "Finger 1",
  "Finger 2",
  "Trinket 1",
  "Trinket 2",
  "Back",
  "Main hand",
  "Off hand",
  "Ranged",
  "Tabard",
];
const LEFT = [0, 1, 2, 14, 4, 3, 18, 8],
  RIGHT = [9, 5, 6, 7, 10, 11, 12, 13];
export function Inspection({
  state,
  actor,
  controller,
  close,
}: {
  state: Snapshot;
  actor: Actor;
  controller: EditorController;
  close: () => void;
}) {
  const [catalog, setCatalog] = useState<TalentCatalog | null>(null);
  const source = `${state.gameVersion}:${state.replay?.report.code ?? state.projectId ?? ""}`;
  useEffect(() => {
    if (!state.ready) return;
    // Capture once per inspected character/source. Replay ticks and changing
    // actor object identities must not recapture the still image.
    controller.requestActorInspection(actor.key, 0);
    return () => controller.closeActorInspection();
  }, [controller, actor.key, source, state.ready]);
  useEffect(() => {
    let disposed = false;
    loadLocalTalents().then((value) => {
      if (!disposed) {
        setCatalog(value);
      }
    });
    return () => {
      disposed = true;
    };
  }, [state.ready]);
  const preview =
    state.inspectionModel?.key === actor.key &&
    state.inspectionModel.source ===
      `${state.gameVersion}:${state.replay?.report.code ?? state.projectId ?? ""}`
      ? state.inspectionModel
      : null;
  const gear = new Map(actor.gear.map((item) => [item.slot, item]));
  const runes = useMemo(
    () => gearRunes(actor.gear, state.gameVersion, actor.id, state.replay),
    [
      actor.gear,
      actor.id,
      state.gameVersion,
      state.replay,
      state.replay?.raw.playerDetails,
    ],
  );
  const runeBySlot = new Map(runes.map((r) => [r.slot, r]));
  const slot = (index: number) => (
    <div
      key={index}
      className={`paperdoll-slot slot-${index}`}
      aria-label={`${SLOTS[index]} slot`}
    >
      {gear.has(index) ? (
        <GearIcon
          key={`${state.gameVersion}:${actor.key}:${index}:${gear.get(index)!.id}`}
          gear={gear.get(index)!}
          equipped={actor.gear}
          rune={runeBySlot.get(index)}
        />
      ) : (
        <span
          className="paperdoll-empty"
          title={`${SLOTS[index]} · Not recorded`}
          aria-label={`${SLOTS[index]} not recorded`}
        >
          <EditorIcon name={index >= 15 && index <= 17 ? "sword" : "inspect"} />
        </span>
      )}
    </div>
  );
  return (
    <FloatingWindow
      title={actor.name}
      label="Inspect"
      positionKey="pullfiction.inspect.position.v1"
      close={close}
      className="inspect-window"
    >
      <div className="inspect-overview">
        <TalentDistribution actor={actor} state={state} catalog={catalog} />
        {runes.length > 0 && (
          <details className="inspect-runes">
            <summary>
              Runes <span>{runes.length}</span>
            </summary>
            <div
              className="inspect-rune-list"
              role="list"
              aria-label="Equipped runes"
            >
              {runes.map((rune) => (
                <div role="listitem" key={`${rune.slot}:${rune.enchant}`}>
                  <RuneEntry rune={rune} state={state} />
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
      <div className="paperdoll" role="group" aria-label="Equipment">
        <div className="paperdoll-slots left">{LEFT.map(slot)}</div>
        <div className="paperdoll-model">
          {preview?.url ? (
            <img
              src={preview.url}
              alt={`${actor.name} wearing recorded equipment`}
              draggable={false}
            />
          ) : (
            <div className="inspection-model-status" role="status">
              <EditorIcon name="person" />
              <span>
                {preview?.error ??
                  (state.ready
                    ? "Preparing character…"
                    : "Loading character assets.")}
              </span>
              {preview?.error && (
                <button
                  onClick={() =>
                    controller.requestActorInspection(actor.key, 0)
                  }
                >
                  Retry model
                </button>
              )}
            </div>
          )}
        </div>
        <div className="paperdoll-slots right">{RIGHT.map(slot)}</div>
        <div className="paperdoll-weapons">{[15, 16, 17].map(slot)}</div>
        <div
          className="inspection-appearance"
          title="The model uses available appearance data. Unrecorded race, body and cosmetic choices use the viewer's defaults. Enchant visuals, guild tabard patterns and hidden equipment preferences may be unavailable."
        >
          Appearance may be estimated
        </div>
      </div>
    </FloatingWindow>
  );
}
const TREE_NAMES: Record<string, string[]> = {
  Warrior: ["Arms", "Fury", "Protection"],
  Paladin: ["Holy", "Protection", "Retribution"],
  Hunter: ["Beast Mastery", "Marksmanship", "Survival"],
  Rogue: ["Assassination", "Combat", "Subtlety"],
  Priest: ["Discipline", "Holy", "Shadow"],
  Shaman: ["Elemental", "Enhancement", "Restoration"],
  Mage: ["Arcane", "Fire", "Frost"],
  Warlock: ["Affliction", "Demonology", "Destruction"],
  Druid: ["Balance", "Feral Combat", "Restoration"],
};
export function TalentDistribution({
  actor,
  state,
  catalog,
}: {
  actor: Actor;
  state: Snapshot;
  catalog: TalentCatalog | null;
}) {
  const build = recordedTalents(state.replay, actor, state.time);
  const trees = classTalentTrees(catalog, classIDs[actor.class] ?? 0);
  return (
    <div className="inspect-distribution" aria-label="Talent distribution">
      {build?.points ? (
        build.points.map((points, index) => {
          const tree = trees[index],
            name =
              tree?.name ??
              TREE_NAMES[actor.class]?.[index] ??
              `Tree ${index + 1}`;
          return (
            <span key={index} title={`${name}: ${points} points`}>
              {tree?.icon && (
                <GameIcon name={tree.icon.replace(/^id:/, "pf_")} />
              )}
              <span>{name}</span>
              <strong>{points}</strong>
            </span>
          );
        })
      ) : (
        <span className="inspect-distribution-empty">
          Talent distribution not recorded
        </span>
      )}
      <span
        className="inspect-class"
        style={{ color: CLASS_COLORS[actor.class] }}
      >
        {actor.class}
      </span>
    </div>
  );
}
function RuneEntry({ rune, state }: { rune: GearRune; state: Snapshot }) {
  const content = (
    <>
      <span className="inspect-rune-slot">{SLOTS[rune.slot]}</span>
      <span className="inspect-rune-name">
        {(rune.spellId || rune.icon) && (
          <GameIcon spell={rune.spellId} name={rune.icon} />
        )}
        <span>{rune.name}</span>
      </span>
    </>
  );
  return rune.spellId ? (
    <ReferenceHover kind="spell" id={rune.spellId} title={rune.name}>
      <a
        className="inspect-rune-entry"
        aria-label={`${SLOTS[rune.slot]} rune: ${rune.name}`}
        href={wowheadUrl("spell", rune.spellId, state.gameVersion)}
        target="_blank"
        rel="noreferrer"
      >
        {content}
      </a>
    </ReferenceHover>
  ) : (
    <div
      className="inspect-rune-entry"
      title={`Recorded ${SLOTS[rune.slot]} engraving · Enchantment ${rune.enchant}`}
    >
      {content}
    </div>
  );
}
