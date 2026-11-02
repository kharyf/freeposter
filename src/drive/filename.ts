// Drive files carry their posting time in the name: {name}_{m.d.yy}_{h.mm.am|pm}, in this computer's local
// time, e.g. "Gatekeeping_11.1.26_5.30.pm.mp4" posts at 5:30 PM on 1 November 2026.

export type DriveName = { ok: true; name: string; at: number } | { ok: false; reason: string };

const FORMAT = "the name must look like name_m.d.yy_h.mm.am (for example Gatekeeping_11.1.26_5.30.pm)";

export function parseDriveName(filename: string): DriveName {
  // Drop a file extension, but not the trailing ".am"/".pm" of a name that has none.
  const base = filename.trim().replace(/\.(?!(?:am|pm)$)[^._]{1,5}$/i, "");
  const parts = base.split("_");
  if (parts.length < 3) return { ok: false, reason: FORMAT };
  const time = parts.pop()!;
  const date = parts.pop()!;
  const name = parts.join("_").trim();
  if (!name) return { ok: false, reason: `${FORMAT}; the name part is missing` };

  const d = /^(\d{1,2})\.(\d{1,2})\.(\d{2})$/.exec(date);
  if (!d) return { ok: false, reason: `"${date}" is not a date like 11.1.26 (month.day.two-digit year)` };
  const t = /^(\d{1,2})\.(\d{2})\.(am|pm)$/i.exec(time);
  if (!t) return { ok: false, reason: `"${time}" is not a time like 5.30.pm (hour.two-digit minutes.am or pm)` };

  const [month, day, year] = [Number(d[1]), Number(d[2]), 2000 + Number(d[3])];
  const [hour12, minute] = [Number(t[1]), Number(t[2])];
  if (hour12 < 1 || hour12 > 12 || minute > 59) return { ok: false, reason: `"${time}" is not a valid time` };
  const hour = (hour12 % 12) + (t[3].toLowerCase() === "pm" ? 12 : 0);
  const at = new Date(year, month - 1, day, hour, minute);
  // new Date rolls 2.30 over into March; a real date comes back unchanged.
  if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== day) {
    return { ok: false, reason: `"${date}" is not a real date` };
  }
  return { ok: true, name, at: at.getTime() };
}
