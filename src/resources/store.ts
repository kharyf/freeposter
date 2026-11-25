// Files and notes the user keeps per account set (text, audio, image, video) in SQLite, with the files under data/resources/<set>/.
// An edit uses them only when it names their tag. Deleting is soft and text edits write a new file, so an edit
// that was queued with a resource still renders from the exact file it was given.
import { execFile } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { config, dataDir } from "../config.ts";
import type { Store } from "../db.ts";
import { imageKind } from "../edit/styles.ts";
import { hashFile } from "../review/media.ts";

const run = promisify(execFile);

export type ResourceKind = "text" | "audio" | "image" | "video";
export interface Resource {
  id: number; setId: number; kind: ResourceKind; name: string; tag: string;
  path: string; sha256: string; sizeBytes: number; mime: string;
  durationSec: number | null; width: number | null; height: number | null;
  createdAt: number; deletedAt: number | null;
}

const MiB = 1024 * 1024;
export const MAX_RESOURCE_BYTES: Record<ResourceKind, number> = { text: MiB, image: 25 * MiB, audio: 200 * MiB, video: 4096 * MiB };
const LIMIT_LABEL: Record<ResourceKind, string> = { text: "1 MB", image: "25 MB", audio: "200 MB", video: "4 GB" };
const NOT_READABLE = "that file isn't text, audio, image or video FreePoster can read";
const TAG = /^[a-z0-9][a-z0-9-]{0,31}$/;
const IMAGE_MIME = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" } as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS resources (
  id INTEGER PRIMARY KEY, set_id INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, tag TEXT NOT NULL,
  path TEXT NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL, mime TEXT NOT NULL,
  duration_sec REAL, width INTEGER, height INTEGER, created_at INTEGER NOT NULL, deleted_at INTEGER
);`;

export const resourcesDir = () => join(dataDir, "resources");

export function tagProblem(tag: string): string | null {
  return TAG.test(tag) ? null : "a tag is 1 to 32 lowercase letters, digits or dashes, starting with a letter or digit";
}

/** A tag slugged from a name. Doesn't check that it's free. */
export function tagFrom(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
  return slug || "resource";
}

export interface Sniffed { kind: ResourceKind; mime: string; durationSec: number | null; width: number | null; height: number | null }

const AUDIO_MIME: Record<string, string> = { ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac" };
const VIDEO_MIME: Record<string, string> = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska" };

function head(path: string, n: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    return buf.subarray(0, readSync(fd, buf, 0, n, 0));
  } finally {
    closeSync(fd);
  }
}

async function ffprobeJson(path: string): Promise<any | null> {
  try {
    const { stdout } = await run(config.ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], { maxBuffer: 16 * MiB });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/** What a file is, by its bytes rather than its name: an image by magic bytes, text by being valid UTF-8, else ffprobe. A string is why not. */
export async function sniffKind(path: string, filename: string): Promise<Sniffed | string> {
  const ext = extname(filename).toLowerCase();
  const bytes = head(path, 16);
  const img = imageKind(bytes);
  if (img) {
    const info = await ffprobeJson(path);
    const v = info?.streams?.find((s: any) => s.codec_type === "video");
    return { kind: "image", mime: IMAGE_MIME[img], durationSec: null, width: v?.width ?? null, height: v?.height ?? null };
  }
  if ((ext === ".txt" || ext === ".md") && statSync(path).size <= MAX_RESOURCE_BYTES.text) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
      return { kind: "text", mime: "text/plain; charset=utf-8", durationSec: null, width: null, height: null };
    } catch {}
  }
  const info = await ffprobeJson(path);
  if (!info?.streams) return NOT_READABLE;
  const duration = Number(info.format?.duration ?? 0) || null;
  const video = info.streams.find((s: any) => s.codec_type === "video" && !s.disposition?.attached_pic);
  if (video) return { kind: "video", mime: VIDEO_MIME[ext] ?? "video/mp4", durationSec: duration, width: video.width ?? null, height: video.height ?? null };
  if (info.streams.some((s: any) => s.codec_type === "audio")) return { kind: "audio", mime: AUDIO_MIME[ext] ?? "audio/mpeg", durationSec: duration, width: null, height: null };
  return NOT_READABLE;
}

const COLS = "id, set_id AS setId, kind, name, tag, path, sha256, size_bytes AS sizeBytes, mime, duration_sec AS durationSec, width, height, created_at AS createdAt, deleted_at AS deletedAt";

export class ResourceStore {
  private store: Store;

  constructor(store: Store) {
    this.store = store;
    store.db.exec(SCHEMA);
  }

  list(setId?: number): Resource[] {
    const rows = setId === undefined
      ? this.store.db.prepare(`SELECT ${COLS} FROM resources WHERE deleted_at IS NULL ORDER BY id`).all()
      : this.store.db.prepare(`SELECT ${COLS} FROM resources WHERE deleted_at IS NULL AND set_id = ? ORDER BY id`).all(setId);
    return rows as unknown as Resource[];
  }

  get(id: number): Resource | undefined {
    return this.store.db.prepare(`SELECT ${COLS} FROM resources WHERE id = ?`).get(id) as unknown as Resource | undefined;
  }

  byTag(setId: number, tag: string): Resource | undefined {
    return this.store.db.prepare(`SELECT ${COLS} FROM resources WHERE set_id = ? AND tag = ? AND deleted_at IS NULL`).get(setId, tag.toLowerCase()) as unknown as Resource | undefined;
  }

  /** A free tag in the set: the wanted one, or it with -2, -3… */
  private freeTag(setId: number, wanted: string): string {
    if (!this.byTag(setId, wanted)) return wanted;
    for (let n = 2; ; n++) {
      const suffix = `-${n}`;
      const t = wanted.slice(0, 32 - suffix.length).replace(/-+$/, "") + suffix;
      if (!this.byTag(setId, t)) return t;
    }
  }

  private chooseTag(setId: number, name: string, tag?: string): string {
    if (!tag) return this.freeTag(setId, tagFrom(name));
    const t = tag.toLowerCase();
    const problem = tagProblem(t);
    if (problem) throw new Error(problem);
    if (this.byTag(setId, t)) throw new Error(`the tag @${t} is already used in this account set`);
    return t;
  }

  private insert(setId: number, name: string, tag: string, sha256: string, size: number, meta: Sniffed, ext: string, place: (to: string) => void): Resource {
    const db = this.store.db;
    const id = Number(db.prepare(
      "INSERT INTO resources (set_id, kind, name, tag, path, sha256, size_bytes, mime, duration_sec, width, height, created_at) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?)",
    ).run(setId, meta.kind, name, tag, sha256, size, meta.mime, meta.durationSec, meta.width, meta.height, Date.now()).lastInsertRowid);
    const dir = join(resourcesDir(), String(setId));
    const path = join(dir, `${id}-${sha256.slice(0, 8)}${ext}`);
    try {
      mkdirSync(dir, { recursive: true });
      place(path);
    } catch (err) {
      db.prepare("DELETE FROM resources WHERE id = ?").run(id);
      throw err;
    }
    db.prepare("UPDATE resources SET path = ? WHERE id = ?").run(path, id);
    return this.get(id)!;
  }

  async addFile(setId: number, tempPath: string, filename: string, opts: { name?: string; tag?: string } = {}): Promise<Resource | string> {
    try {
      const size = statSync(tempPath).size;
      if (size === 0) return "the file is empty";
      const meta = await sniffKind(tempPath, filename);
      if (typeof meta === "string") return meta;
      if (size > MAX_RESOURCE_BYTES[meta.kind]) return `${meta.kind} files can be at most ${LIMIT_LABEL[meta.kind]}`;
      const name = (opts.name?.trim() || filename).slice(0, 200);
      const tag = this.chooseTag(setId, name, opts.tag);
      const sha = await hashFile(tempPath);
      const ext = meta.kind === "text" ? ".txt" : extname(filename).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 8);
      return this.insert(setId, name, tag, sha, size, meta, ext, (to) => {
        try {
          renameSync(tempPath, to);
        } catch {
          copyFileSync(tempPath, to);
          unlinkSync(tempPath);
        }
      });
    } catch (err) {
      return (err as Error).message;
    } finally {
      // A refused file never stays behind in the upload folder.
      if (existsSync(tempPath)) try { unlinkSync(tempPath); } catch {}
    }
  }

  addText(setId: number, name: string, text: string, tag?: string): Resource | string {
    const bytes = Buffer.from(text, "utf8");
    if (!text.trim()) return "the text is empty";
    if (bytes.length > MAX_RESOURCE_BYTES.text) return `text can be at most ${LIMIT_LABEL.text}`;
    try {
      const n = (name.trim() || "Note").slice(0, 200);
      const t = this.chooseTag(setId, n, tag);
      const sha = createHash("sha256").update(bytes).digest("hex");
      const meta: Sniffed = { kind: "text", mime: "text/plain; charset=utf-8", durationSec: null, width: null, height: null };
      return this.insert(setId, n, t, sha, bytes.length, meta, ".txt", (to) => writeFileSync(to, bytes));
    } catch (err) {
      return (err as Error).message;
    }
  }

  update(id: number, f: { name?: string; tag?: string; text?: string }): Resource | string {
    const r = this.get(id);
    if (!r || r.deletedAt !== null) return "no such resource";
    const db = this.store.db;
    try {
      if (f.text !== undefined) {
        if (r.kind !== "text") return "only a text resource has text to change";
        const bytes = Buffer.from(f.text, "utf8");
        if (!f.text.trim()) return "the text is empty";
        if (bytes.length > MAX_RESOURCE_BYTES.text) return `text can be at most ${LIMIT_LABEL.text}`;
        const sha = createHash("sha256").update(bytes).digest("hex");
        if (sha !== r.sha256) {
          // A new file, never an overwrite: edits already queued keep the text they were made with.
          const path = join(resourcesDir(), String(r.setId), `${r.id}-${sha.slice(0, 8)}.txt`);
          writeFileSync(path, bytes);
          db.prepare("UPDATE resources SET path = ?, sha256 = ?, size_bytes = ? WHERE id = ?").run(path, sha, bytes.length, id);
        }
      }
      if (f.name !== undefined) {
        const n = f.name.trim();
        if (!n) return "the name is empty";
        db.prepare("UPDATE resources SET name = ? WHERE id = ?").run(n.slice(0, 200), id);
      }
      if (f.tag !== undefined) {
        const t = f.tag.toLowerCase();
        const problem = tagProblem(t);
        if (problem) return problem;
        const other = this.byTag(r.setId, t);
        if (other && other.id !== id) return `the tag @${t} is already used in this account set`;
        db.prepare("UPDATE resources SET tag = ? WHERE id = ?").run(t, id);
      }
    } catch (err) {
      return (err as Error).message;
    }
    return this.get(id)!;
  }

  /** Hides the resource and frees its tag. The file stays so queued edits still render. */
  remove(id: number): string | null {
    const r = this.get(id);
    if (!r || r.deletedAt !== null) return "no such resource";
    this.store.db.prepare("UPDATE resources SET deleted_at = ? WHERE id = ?").run(Date.now(), id);
    return null;
  }

  readText(r: Resource): string {
    return readFileSync(r.path, "utf8");
  }
}
