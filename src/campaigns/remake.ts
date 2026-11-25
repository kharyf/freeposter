// Which of a row's videos to retire when a campaign's table is saved. Pure: compares the table before and after.
import type { Row } from "./rows.ts";
import type { Day } from "./spec.ts";

export interface Retirement {
  rowId: number;
  /** the weekdays whose open tasks go, or every day */
  days: Day[] | "all";
  /** only copies numbered from this one up */
  fromCopy: number;
  /** the row's videos are made again (its content changed), rather than just dropped */
  remake: boolean;
}

/**
 * Every Row field except the ones that only move a video (time, days) or count them (quantity), and the id. Checked against
 * Row at compile time: a new Row field fails typecheck until it is listed here or among the excluded ones.
 */
const CONTENT_FIELDS = ["hook", "angle", "cta", "style", "model", "videoModel", "type", "sec", "origin", "text"] as const satisfies readonly (keyof Omit<Row, "id" | "time" | "days" | "quantity">)[];
type Missing = Exclude<keyof Omit<Row, "id" | "time" | "days" | "quantity">, (typeof CONTENT_FIELDS)[number]>;
const _allClassified: [Missing] extends [never] ? true : never = true;
void _allClassified;
const content = (r: Row): string =>
  JSON.stringify(CONTENT_FIELDS.map((k) => r[k]).map((v) => (v !== null && typeof v === "object" ? canon(v) : v)));
const canon = (o: object): object => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

export function planRetirements(before: Row[], after: Row[]): Retirement[] {
  const now = new Map(after.map((r) => [r.id, r]));
  const out: Retirement[] = [];
  for (const old of before) {
    const next = now.get(old.id);
    if (!next) out.push({ rowId: old.id, days: "all", fromCopy: 0, remake: false });
    else if (content(old) !== content(next)) out.push({ rowId: old.id, days: "all", fromCopy: 0, remake: true });
    else {
      const removed = old.days.filter((d) => !next.days.includes(d));
      if (removed.length) out.push({ rowId: old.id, days: removed, fromCopy: 0, remake: false });
      if (next.quantity < old.quantity) out.push({ rowId: old.id, days: "all", fromCopy: next.quantity, remake: false });
    }
  }
  return out;
}
