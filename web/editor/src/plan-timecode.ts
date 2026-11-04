import { preciseTime } from "./domain";

export type ParsedTimecode =
  { valid: true; value: number | null } | { valid: false };

/** Blank removes the bound. Accept clock notation or an explicit number of seconds. */
export function parsePlanTimecode(text: string): ParsedTimecode {
  const raw = text.trim();
  if (raw === "") return { valid: true, value: null };
  const clock = /^(\d+):([0-5]\d)(?:[.,](\d{1,3}))?$/.exec(raw);
  const seconds = /^(\d+)(?:[.,](\d{1,3}))?$/.exec(raw);
  if (!clock && !seconds) return { valid: false };
  const value = clock
    ? (Number(clock[1]) * 60 + Number(clock[2])) * 1000 +
      Number((clock[3] ?? "").padEnd(3, "0"))
    : Number(seconds![1]) * 1000 + Number((seconds![2] ?? "").padEnd(3, "0"));
  return Number.isSafeInteger(value)
    ? { valid: true, value }
    : { valid: false };
}

export function planRangeLabel(start: number | null, end: number | null) {
  if (start === null && end === null) return "Always visible";
  return `${start === null ? "Beginning" : preciseTime(start)} – ${end === null ? "End" : preciseTime(end)}`;
}
