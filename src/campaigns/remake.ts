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

/** Everything about a row except when it posts (time, days) and how many are made (quantity). */
const content = (r: Row): string =>
  JSON.stringify([r.hook, r.angle, r.cta, r.style, r.model, r.type, r.sec, r.origin, r.text].map((v) => (v !== null && typeof v === "object" ? canon(v) : v)));
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
