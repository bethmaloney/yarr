import type { SessionTrace } from "./types";

export type SortField =
  | "start_time"
  | "plan_file"
  | "prompt"
  | "outcome"
  | "total_iterations"
  | "total_cost_usd"
  | "duration";
export type SortDir = "asc" | "desc";

export function sortTraces(
  traces: SessionTrace[],
  field: SortField,
  dir: SortDir,
): SessionTrace[] {
  const copy = [...traces];
  const mul = dir === "asc" ? 1 : -1;

  copy.sort((a, b) => {
    switch (field) {
      case "start_time":
      case "prompt":
      case "outcome":
        return mul * a[field].localeCompare(b[field]);

      case "plan_file": {
        const aVal = a.plan_file;
        const bVal = b.plan_file;
        if (aVal === null && bVal === null) return 0;
        if (aVal === null) return 1;
        if (bVal === null) return -1;
        return mul * aVal.localeCompare(bVal);
      }

      case "total_iterations":
      case "total_cost_usd":
        return mul * (a[field] - b[field]);

      case "duration": {
        const aDur =
          a.end_time === null
            ? null
            : new Date(a.end_time).getTime() - new Date(a.start_time).getTime();
        const bDur =
          b.end_time === null
            ? null
            : new Date(b.end_time).getTime() - new Date(b.start_time).getTime();
        if (aDur === null && bDur === null) return 0;
        if (aDur === null) return 1;
        if (bDur === null) return -1;
        return mul * (aDur - bDur);
      }
    }
  });

  return copy;
}
