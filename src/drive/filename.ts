// Drive files carry their posting time in the name: {name}_{m.d.yy}_{h.mm.am|pm}, in this computer's local
// time, e.g. "Gatekeeping_11.1.26_5.30.pm.mp4" posts at 5:30 PM on 1 November 2026. Both keys are optional:
// with no time it posts as soon as possible on the date, and with no date the date is the day it was uploaded.

/** `at` is the earliest it may post; after `latest` it is late (the set time, or the end of a date with no time). */
export type DriveName = { ok: true; name: string; at: number; latest: number } | { ok: false; reason: string };

const FORMAT = "the name must look like name_m.d.yy_h.mm.am (for example Gatekeeping_11.1.26_5.30.pm); the date and time may be left off";

// Anything shaped like a date or time is read as one, so a typo is reported instead of posting right away.
const looksLikeTime = (s: string) => /^\d[\d.]*(am|pm)$/i.test(s);
const looksLikeDate = (s: string) => /^\d+(\.\d+)+$/.test(s);

export function parseDriveName(filename: string, uploadedAt: number): DriveName {
  // Drop a file extension (it has a letter), but not the trailing ".am"/".pm" or a date's ".26".
  const base = filename.trim().replace(/\.(?!(?:am|pm)$)(?=[^._]*[a-z])[^._]{1,5}$/i, "");
  const parts = base.split("_");
  const time = parts.length > 1 && looksLikeTime(parts.at(-1)!) ? parts.pop()! : null;
  const date = parts.length > 1 && looksLikeDate(parts.at(-1)!) ? parts.pop()! : null;
  if (parts.some((p) => looksLikeTime(p) || looksLikeDate(p))) return { ok: false, reason: FORMAT };
  const name = parts.join("_").trim();
  if (!name) return { ok: false, reason: `${FORMAT}; the name part is missing` };

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
  if (time === null) return { ok: true, name, at: dayStart.getTime(), latest: new Date(year, month - 1, day + 1).getTime() - 1 };

  const t = /^(\d{1,2})\.(\d{2})\.(am|pm)$/i.exec(time);
  if (!t) return { ok: false, reason: `"${time}" is not a time like 5.30.pm (hour.two-digit minutes.am or pm)` };
  const [hour12, minute] = [Number(t[1]), Number(t[2])];
  if (hour12 < 1 || hour12 > 12 || minute > 59) return { ok: false, reason: `"${time}" is not a valid time` };
  const at = new Date(year, month - 1, day, (hour12 % 12) + (t[3].toLowerCase() === "pm" ? 12 : 0), minute).getTime();
  return { ok: true, name, at, latest: at };
}
