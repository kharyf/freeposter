// Local calendar days and times of day, as campaigns count them.
import type { MakeInstruction, PostInstruction } from "./spec.ts";

const pad = (n: number) => String(n).padStart(2, "0");

/** The local calendar day of a time, YYYY-MM-DD. */
export const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export const parseDay = (key: string) => key.split("-").map(Number) as [number, number, number];

/** That local day at "HH:MM" (a time a DST change skips moves forward, as Date does). */
export const localAt = (key: string, hhmm: string) => {
  const [y, m, d] = parseDay(key);
  const [h, min] = hhmm.split(":").map(Number);
  return new Date(y, m - 1, d, h, min).getTime();
};

/** The "HH:MM" a line's copy posts at: its own time, else the campaign's defaults; null for a video to keep (or none). */
export function lineTime(ins: MakeInstruction | PostInstruction, copy: number, defaults: string[]): string | null {
  if (ins.kind === "post") return ins.at ?? defaults[0] ?? null;
  if (ins.post === null) return null;
  if (ins.post.at !== "default") return ins.post.at;
  return defaults.length ? defaults[copy % defaults.length] : null;
}
