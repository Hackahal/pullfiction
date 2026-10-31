import type { ChartResult } from "./chart-model";
import { perSecond } from "./combat-metrics";
export function chartCsvContent(result: ChartResult, seconds: number) {
  const quote = (s: string) =>
    `"${s.replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`;
  return [
    "Series,Total,Full-run average per second,Peak per second,Events,Critical events,Overheal",
    ...result.series.map((s) =>
      [
        quote(s.name),
        s.total,
        perSecond(s.total, seconds) ?? "",
        s.peak,
        s.count,
        s.crits,
        s.overheal,
      ].join(","),
    ),
  ].join("\n");
}
