// Drive files carry their posting choices in the name, in this order, every part after the name optional:
//   {name}_{post-date}_{post-time}_{editing-style}_{account-set}_[RAW]
// e.g. "Gatekeeping_11.1.26_5.30.pm_Basic_PersonalBrand.mp4" posts at 5:30 PM on 1 November 2026 (this computer's
// local time), edited in the Basic style, to the accounts in the "Personal Brand" set. Underscores only separate
// parts, so the name itself has none. With no time it posts as soon as possible on the date, and with no date the
// date is the day it was uploaded. The time may also be written 5:30pm, 5:30PM, 5.30pm or 5pm. The style and set
// are matched to the ones that exist, ignoring case (a set is written without its spaces: PersonalBrand); left off,
// they are the defaults. A last part of _RAW (any case) means the video was already edited elsewhere: it posts as
// uploaded, so it takes no style. Anything that isn't clearly one of these refuses the file, with the reason.
//
// Files that arrived before styles and sets were in the name are read by the older rules (no vocabulary given):
// {name}_{m.d.yy}_{h.mm.am|pm}[_RAW], where the name may contain underscores.

/** The editing styles and account sets a name may refer to, each by the word written in the filename. */
export interface NameVocabulary {
  styles: { id: string; token: string }[];
  sets: { id: number; token: string }[];
}

/**
 * `at` is the earliest it may post; after `latest` it is late (the set time, or the end of a date with no time).
 * `raw` is true when the name ends in _RAW: FreePoster skips its own edit. `styleId` and `setId` are null when
 * the name leaves them off (the defaults apply) or when it was read by the older rules.
 */
export type DriveName =
  | { ok: true; name: string; at: number; latest: number; raw: boolean; styleId: string | null; setId: number | null }
  | { ok: false; reason: string };

const LEGACY_FORMAT = "the name must look like name_m.d.yy_h.mm.am (for example Gatekeeping_11.1.26_5.30.pm); the date and time may be left off, and _RAW may be added at the end";
const FORMAT = "the name must look like name_m.d.yy_h.mm.am_style_set_RAW (for example Gatekeeping_11.1.26_5.30.pm); every part after the name may be left off";

// Anything shaped like a date or time is read as one, so a typo is reported instead of posting right away.
const looksLikeTime = (s: string) => /^\d[\d.:]*\s*(am|pm)$/i.test(s);
const looksLikeDate = (s: string) => /^\d+(\.\d+)+$/.test(s);
const isRaw = (s: string) => /^raw$/i.test(s.trim());

// Drop a file extension (it has a letter), but not a time's trailing ".pm"/".30pm" or a date's ".26".
const stripExtension = (filename: string) => filename.trim().replace(/\.(?!\d*\s*(?:am|pm)$)(?=[^._]*[a-z])[^._]{1,5}$/i, "");

export function parseDriveName(filename: string, uploadedAt: number, vocab?: NameVocabulary): DriveName {
  return vocab ? parseCurrent(stripExtension(filename), uploadedAt, vocab) : parseLegacy(stripExtension(filename), uploadedAt);
}

const SLOTS = ["date", "time", "editing style", "account set", "RAW"] as const;
const DATE = 0, TIME = 1, STYLE = 2, SET = 3, RAW = 4;

function parseCurrent(base: string, uploadedAt: number, vocab: NameVocabulary): DriveName {
  const [first, ...rest] = base.split("_");
  const name = first.trim();
  if (!name) return { ok: false, reason: `${FORMAT}; the name part is missing` };
  if (looksLikeDate(name) || looksLikeTime(name)) return { ok: false, reason: `${FORMAT}; the name part is missing` };

  const found: (string | null)[] = [null, null, null, null, null];
  let styleId: string | null = null;
  let setId: number | null = null;
  let last = -1;
  for (const raw of rest) {
    const part = raw.trim();
    const key = part.toLowerCase();
    let slot: number;
    if (!part) return { ok: false, reason: "the name has an empty part (two underscores together, or one at the end)" };
    if (looksLikeDate(part)) slot = DATE;
    else if (looksLikeTime(part)) slot = TIME;
    else if (isRaw(part)) slot = RAW;
    else if (vocab.styles.some((s) => s.token.toLowerCase() === key)) {
      slot = STYLE;
      styleId = vocab.styles.find((s) => s.token.toLowerCase() === key)!.id;
    } else if (vocab.sets.some((s) => s.token.toLowerCase() === key)) {
      slot = SET;
      setId = vocab.sets.find((s) => s.token.toLowerCase() === key)!.id;
    } else {
      const styles = vocab.styles.map((s) => s.token).join(", ") || "none";
      const sets = vocab.sets.map((s) => s.token).join(", ") || "none";
      return { ok: false, reason: `"${part}" isn't a date, a time, an editing style (${styles}), an account set (${sets}) or RAW; underscores only separate those parts` };
    }
    if (slot <= last) {
      if (last === RAW) return { ok: false, reason: `_RAW goes at the end (for example Gatekeeping_11.1.26_5.30.pm_RAW)` };
      return { ok: false, reason: `the ${SLOTS[slot]} "${part}" is out of place; the parts go name, date, time, editing style, account set, RAW` };
    }
    found[slot] = part;
    last = slot;
  }
  if (found[RAW] !== null && found[STYLE] !== null) {
    return { ok: false, reason: `a RAW video isn't edited, so it can't take an editing style ("${found[STYLE]}")` };
  }
  const when = postingTime(found[DATE], found[TIME], uploadedAt);
  if (!when.ok) return when;
  return { ok: true, name, at: when.at, latest: when.latest, raw: found[RAW] !== null, styleId, setId };
}

function parseLegacy(base: string, uploadedAt: number): DriveName {
  const parts = base.split("_");
  const raw = parts.length > 1 && isRaw(parts.at(-1)!);
  if (raw) parts.pop();
  const time = parts.length > 1 && looksLikeTime(parts.at(-1)!) ? parts.pop()! : null;
  const date = parts.length > 1 && looksLikeDate(parts.at(-1)!) ? parts.pop()! : null;
  if (parts.some((p) => looksLikeTime(p) || looksLikeDate(p))) return { ok: false, reason: LEGACY_FORMAT };
  // "Name_RAW_11.1.26" would otherwise be edited as a video called "Name_RAW".
  if ((date !== null || time !== null) && parts.length > 1 && isRaw(parts.at(-1)!)) {
    return { ok: false, reason: `_RAW goes at the end, after the date and time (for example Gatekeeping_11.1.26_5.30.pm_RAW)` };
  }
  const name = parts.join("_").trim();
  if (!name) return { ok: false, reason: `${LEGACY_FORMAT}; the name part is missing` };
  const when = postingTime(date, time, uploadedAt);
  if (!when.ok) return when;
  return { ok: true, name, at: when.at, latest: when.latest, raw, styleId: null, setId: null };
}

/** The date (m.d.yy, else the upload day) and time (else as soon as possible that day) as `at` and `latest`. */
function postingTime(date: string | null, time: string | null, uploadedAt: number): { ok: true; at: number; latest: number } | { ok: false; reason: string } {
  const uploaded = new Date(uploadedAt);
  let [year, month, day] = [uploaded.getFullYear(), uploaded.getMonth() + 1, uploaded.getDate()];
  if (date !== null) {
    const d = /^(\d{1,2})\.(\d{1,2})\.(\d{2})$/.exec(date);
    if (!d) return { ok: false, reason: `"${date}" is not a date like 11.1.26 (month.day.two-digit year)` };
    [month, day, year] = [Number(d[1]), Number(d[2]), 2000 + Number(d[3])];
  }
  const dayStart = new Date(year, month - 1, day);
  // new Date rolls 2.30 over into March; a real date comes back unchanged.
  if (dayStart.getFullYear() !== year || dayStart.getMonth() !== month - 1 || dayStart.getDate() !== day) {
    return { ok: false, reason: `"${date}" is not a real date` };
  }
  if (time === null) return { ok: true, at: dayStart.getTime(), latest: new Date(year, month - 1, day + 1).getTime() - 1 };

  const t = /^(\d{1,2})(?:[.:](\d{2}))?\.?\s*(am|pm)$/i.exec(time);
  if (!t) return { ok: false, reason: `"${time}" is not a time like 5.30.pm (hour.two-digit minutes.am or pm)` };
  const [hour12, minute] = [Number(t[1]), Number(t[2] ?? 0)];
  if (hour12 < 1 || hour12 > 12 || minute > 59) return { ok: false, reason: `"${time}" is not a valid time` };
  const at = new Date(year, month - 1, day, (hour12 % 12) + (t[3].toLowerCase() === "pm" ? 12 : 0), minute).getTime();
  return { ok: true, at, latest: at };
}
