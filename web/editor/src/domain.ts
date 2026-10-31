import { BROWSER_ASSETS, schematicIcon } from "./browser-mode";
import * as data from "../../planner/replay.mjs";
import * as plans from "../../planner/plan.mjs";
import type {
  GameVersion,
  Actor,
  Replay,
  RawReplay,
  Health,
  Cast,
  Aura,
  Plan,
  Point,
  Tool,
  ResourceChange,
  Annotation,
  PlanStep,
  AnnotationType,
  MarkStyle,
} from "./types";
export const CLASS_COLORS: Record<string, string> = data.CLASS_COLORS;
export const RACES: Record<number, string> = data.RACES;
export const PLAN_COLORS: string[] = plans.PLAN_COLORS;
export const planId = plans.planId as () => string;
export const newStep = plans.newStep as unknown as (
  name?: string,
  kind?: PlanStep["kind"],
) => PlanStep;
export const newAnnotation = plans.newAnnotation as unknown as (
  type: AnnotationType,
  point: Point,
  style?: Partial<Annotation>,
) => Annotation;
export const STORAGE_KEY = plans.STORAGE_KEY;
export const emptyPlan = plans.emptyPlan as (
  map?: number,
  version?: GameVersion,
) => Plan;
export const planStorageKey = plans.planStorageKey as (
  map: number,
  version?: GameVersion,
) => string;
export {
  RAIDS,
  raidsForVersion,
  raidByMap,
  raidForZone,
  reportRaids,
} from "../../planner/raids.mjs";
export const parsePlan = plans.parsePlan as (text: string) => Plan;
export const validatePlan = plans.validatePlan as (plan: unknown) => Plan;
export const addPoint = plans.addPoint as (
  plan: Plan,
  tool: Tool,
  point: Point,
) => Plan;
export const routeLength = plans.routeLength as (points: Point[]) => number;
export const reportCode = data.reportCode;
export const normalizeReplay = data.normalizeReplay as unknown as (
  raw: RawReplay,
  models: Record<string, unknown>,
) => Replay;
export const enrichCombat = data.enrichCombat as unknown as (
  replay: Replay,
  models: Record<string, unknown>,
  spells?: Record<string, unknown>,
) => Replay;
export const poseAt = data.poseAt as unknown as (
  actor: Actor,
  t: number,
  smooth?: boolean,
) => {
  pos: [number, number, number | null];
  speed: number;
  facing: number;
  dead: boolean;
  stale: boolean;
  estimated: boolean;
  wisp: boolean;
  discontinuity: boolean;
  sampleAge: number | null;
  positionSource: string;
} | null;
export const combatStateAt = data.combatStateAt as unknown as (
  actor: Actor,
  t: number,
) => {
  health: Health | null;
  power: { current: number | null; max: number; type: number } | null;
  resources: {
    changes: ResourceChange[];
    totals: { type: number; gain: number; waste: number }[];
  };
  cast: Cast | null;
  auras: Aura[];
};
export const eventsBetween = data.eventsBetween as unknown as (
  replay: Replay,
  from: number,
  to: number,
) => Replay["combat"];
export const visualEventsBetween =
  data.visualEventsBetween as unknown as typeof eventsBetween;
export const chapterAt = data.chapterAt as unknown as (
  replay: Replay,
  t: number,
) => Replay["chapters"][number] | null;
export const time = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
export const preciseTime = (ms: number) =>
  `${time(ms)}.${String(Math.floor(ms % 1000)).padStart(3, "0")}`;
export const classIDs: Record<string, number> = {
  Warrior: 1,
  Paladin: 2,
  Hunter: 3,
  Rogue: 4,
  Priest: 5,
  Shaman: 7,
  Mage: 8,
  Warlock: 9,
  Druid: 11,
};
export function iconUrl(icon?: string) {
  if (BROWSER_ASSETS) return schematicIcon;
  const stem =
    icon?.split(/[\\/]/).pop()?.split(".")[0] ?? "INV_Misc_QuestionMark";
  return `/game-ui/icons/${encodeURIComponent(stem.toLowerCase())}.png`;
}
