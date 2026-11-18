// The compiled campaign: what a campaign's plain-English text becomes once the user confirms it. Types only here;
// the strict parser lives with the format code.
import type { LibraryEntry } from "./store.ts";

export type Day = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
export const DAYS: Day[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export type Pick = { pick: "named"; id: number } | { pick: "random" } | { pick: "best" } | { pick: "same_as_rule" };

export interface MakeInstruction {
  kind: "make";
  count: number;
  style: string;
  hook: Pick;
  angle: Pick;
  cta: Pick;
  types: number[];
  post: { at: string } | null;
  source: string;
}

export interface PostInstruction {
  kind: "post";
  name: string;
  at: string | null;
  style: string | null;
  types: number[];
  source: string;
}

export interface Rule {
  when: {
    label: "hook" | "angle" | "cta" | "style" | "type";
    is: "working" | "not_working";
    thresholdPct: number;
    minVideos: number;
    age: "24h" | "72h" | "7d";
    scope: "campaign" | "account";
  };
  then: { kind: "make"; count: number; keep: string[]; vary: string[]; post: boolean } | { kind: "stop_using" };
  source: string;
}

export interface CompiledCampaign {
  version: 1;
  days: Record<Day, (MakeInstruction | PostInstruction)[]>;
  rules: Rule[];
}

/** What the compiler may name: the user's styles, types and library. */
export interface Vocabulary {
  styles: { id: string; token: string }[];
  types: { id: number; name: string }[];
  hooks: LibraryEntry[];
  angles: LibraryEntry[];
  ctas: LibraryEntry[];
}
