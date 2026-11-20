// The looks catalogue: the film looks an agent producer (the lemo-opuscar skill) offers, which the agent syncs in.
// A look an agent stops offering is hidden, not deleted, so videos already labelled with it keep their name.
import type { Store } from "../db.ts";

export const LOOK_KEY = /^[a-z0-9]+(-[a-z0-9]+)*:[a-z0-9]+(-[a-z0-9]+)*$/;
/** The key namespace each producer owns. */
const NAMESPACES: Record<string, string> = { "lemo-opuscar": "lemo" };
const NAME_MAX = 80, DESCRIPTION_MAX = 500;

export interface Look {
  key: string;
  producer: string;
  name: string;
  description: string;
  needsImageGen: boolean;
  libraryVersion: string;
  hidden: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS looks (
  key TEXT PRIMARY KEY,
  producer TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  needs_image_gen INTEGER NOT NULL,
  library_version TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);`;

interface LookRow {
  key: string; producer: string; name: string; description: string; needs_image_gen: number; library_version: string; hidden: number;
}
const toLook = (r: LookRow): Look => ({
  key: r.key, producer: r.producer, name: r.name, description: r.description,
  needsImageGen: r.needs_image_gen === 1, libraryVersion: r.library_version, hidden: r.hidden === 1,
});

/**
 * An agent's full list of looks for one producer. Every look is checked before anything is written; looks the
 * producer no longer lists become hidden.
 */
export function syncLooks(
  store: Store, producer: string, looks: Omit<Look, "producer" | "hidden">[],
): { added: number; updated: number; hidden: number } {
  const problems: string[] = [];
  const namespace = NAMESPACES[producer];
  if (!namespace) problems.push(`unknown producer "${producer}"`);
  const seen = new Set<string>();
  looks.forEach((l, i) => {
    const at = `look ${i + 1}`;
    if (typeof l.key !== "string" || !LOOK_KEY.test(l.key)) problems.push(`${at}: look key must look like "namespace:name" in lowercase letters, digits and dashes`);
    else {
      if (namespace && l.key.split(":")[0] !== namespace) problems.push(`${at}: ${producer} owns the "${namespace}:" namespace, not "${l.key}"`);
      if (seen.has(l.key)) problems.push(`${at}: look key ${l.key} is listed twice`);
      seen.add(l.key);
    }
    if (typeof l.name !== "string" || !l.name.trim() || l.name.length > NAME_MAX) problems.push(`${at}: name must be 1 to ${NAME_MAX} characters`);
    if (typeof l.description !== "string" || l.description.length > DESCRIPTION_MAX) problems.push(`${at}: description must be at most ${DESCRIPTION_MAX} characters`);
  });
  if (problems.length) throw new Error(problems.join("; "));

  const db = store.db;
  db.exec(SCHEMA);
  const now = Date.now();
  let added = 0, updated = 0, hidden = 0;
  db.exec("BEGIN");
  try {
    for (const l of looks) {
      const was = db.prepare("SELECT producer FROM looks WHERE key = ?").get(l.key) as { producer: string } | undefined;
      if (was && was.producer !== producer) throw new Error(`look key ${l.key} belongs to ${was.producer}`);
      db.prepare(
        `INSERT INTO looks (key, producer, name, description, needs_image_gen, library_version, hidden, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(key) DO UPDATE SET name = excluded.name, description = excluded.description, needs_image_gen = excluded.needs_image_gen,
           library_version = excluded.library_version, hidden = 0, updated_at = excluded.updated_at`,
      ).run(l.key, producer, l.name, l.description, l.needsImageGen ? 1 : 0, l.libraryVersion, now);
      if (was) updated++; else added++;
    }
    const mine = db.prepare("SELECT key FROM looks WHERE producer = ? AND hidden = 0").all(producer) as { key: string }[];
    for (const { key } of mine) {
      if (seen.has(key)) continue;
      db.prepare("UPDATE looks SET hidden = 1, updated_at = ? WHERE key = ?").run(now, key);
      hidden++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { added, updated, hidden };
}

/** The catalogue, hidden looks left out unless asked for. */
export function allLooks(store: Store, opts: { includeHidden?: boolean } = {}): Look[] {
  store.db.exec(SCHEMA);
  const rows = store.db.prepare(`SELECT * FROM looks ${opts.includeHidden ? "" : "WHERE hidden = 0"} ORDER BY key`).all() as unknown as LookRow[];
  return rows.map(toLook);
}

/** One look by key, hidden or not. */
export function lookByKey(store: Store, key: string): Look | undefined {
  store.db.exec(SCHEMA);
  const r = store.db.prepare("SELECT * FROM looks WHERE key = ?").get(key) as LookRow | undefined;
  return r && toLook(r);
}
