// The Resources tab's API: upload, add text, rename, delete and fetch the files kept per account set.
// Views never carry a file path: the page reaches a file only through /api/resources/:id/file.
import { unlinkSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { accountSets, defaultSetId, setToken } from "../accounts.ts";
import type { Store } from "../db.ts";
import { saveUpload } from "../posts.ts";
import { sendFile } from "../send-file.ts";
import type { Resource, ResourceKind, ResourceStore } from "./store.ts";

export interface ResourceView {
  id: number; setId: number; kind: ResourceKind; name: string; tag: string; sizeBytes: number;
  durationSec: number | null; width: number | null; height: number | null; textPreview: string | null; url: string; createdAt: number;
}

export function resourceView(rs: ResourceStore, r: Resource): ResourceView {
  let textPreview: string | null = null;
  if (r.kind === "text") {
    try { textPreview = rs.readText(r).slice(0, 200); } catch { textPreview = ""; }
  }
  return {
    id: r.id, setId: r.setId, kind: r.kind, name: r.name, tag: r.tag, sizeBytes: r.sizeBytes,
    durationSec: r.durationSec, width: r.width, height: r.height, textPreview, url: `/api/resources/${r.id}/file`, createdAt: r.createdAt,
  };
}

/** "PersonalBrand", "Personal Brand", "2" or undefined (the default set) → a set id, or why not. */
export function setIdFrom(store: Store, v: unknown): number | string {
  if (v === undefined || v === null || v === "") return defaultSetId(store);
  const sets = accountSets(store);
  const text = String(v).trim();
  if (/^\d+$/.test(text)) return sets.some((s) => s.id === Number(text)) ? Number(text) : "no such account set";
  const want = text.toLowerCase();
  const found = sets.find((s) => s.name.toLowerCase() === want || setToken(s.name).toLowerCase() === want);
  return found ? found.id : "no such account set";
}

/** Every set with its live resources, the shape of GET /api/resources and list_resources. */
export function resourceSets(store: Store, rs: ResourceStore) {
  return accountSets(store).map((s) => ({ id: s.id, name: s.name, token: setToken(s.name), resources: rs.list(s.id).map((r) => resourceView(rs, r)) }));
}

export function registerResourceRoutes(app: FastifyInstance, store: Store, rs: ResourceStore): void {
  app.get("/api/resources", async () => ({ sets: resourceSets(store, rs) }));

  app.post("/api/resources", async (req, reply) => {
    const fields: Record<string, string> = {};
    let saved: { path: string; filename: string } | undefined;
    try {
      for await (const part of req.parts()) {
        if (part.type === "file") {
          const s = await saveUpload(part.file, part.filename);
          saved = { path: s.path, filename: part.filename };
          if (part.file.truncated) throw new Error("file is larger than 4 GB");
        } else {
          fields[part.fieldname] = String(part.value);
        }
      }
      if (!saved) return reply.code(400).send({ error: "attach a file" });
      const setId = setIdFrom(store, fields.setId);
      if (typeof setId === "string") return reply.code(400).send({ error: setId });
      const file = saved;
      saved = undefined; // addFile moves or removes it from here on
      const made = await rs.addFile(setId, file.path, file.filename, { name: fields.name, tag: fields.tag?.trim() || undefined });
      return typeof made === "string" ? reply.code(400).send({ error: made }) : resourceView(rs, made);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    } finally {
      if (saved) try { unlinkSync(saved.path); } catch {}
    }
  });

  app.post<{ Body: { setId?: unknown; name?: unknown; text?: unknown; tag?: unknown } }>("/api/resources/text", async (req, reply) => {
    const b = req.body ?? {};
    const setId = setIdFrom(store, b.setId);
    if (typeof setId === "string") return reply.code(400).send({ error: setId });
    if (typeof b.text !== "string") return reply.code(400).send({ error: "text must be a string" });
    const made = rs.addText(setId, typeof b.name === "string" ? b.name : "", b.text, typeof b.tag === "string" && b.tag.trim() ? b.tag.trim() : undefined);
    return typeof made === "string" ? reply.code(400).send({ error: made }) : resourceView(rs, made);
  });

  app.patch<{ Params: { id: string }; Body: { name?: unknown; tag?: unknown; text?: unknown } }>("/api/resources/:id", async (req, reply) => {
    const r = rs.get(Number(req.params.id));
    if (!r || r.deletedAt !== null) return reply.code(404).send({ error: "no such resource" });
    const b = req.body ?? {};
    for (const k of ["name", "tag", "text"] as const) {
      if (b[k] !== undefined && typeof b[k] !== "string") return reply.code(400).send({ error: `${k} must be a string` });
    }
    const done = rs.update(r.id, { name: b.name as string | undefined, tag: b.tag as string | undefined, text: b.text as string | undefined });
    return typeof done === "string" ? reply.code(400).send({ error: done }) : resourceView(rs, done);
  });

  app.delete<{ Params: { id: string } }>("/api/resources/:id", async (req, reply) => {
    const error = rs.remove(Number(req.params.id));
    return error ? reply.code(404).send({ error: "no such resource" }) : { ok: true };
  });

  // Deleted resources are still served, so the review page of an edit that used one keeps working.
  app.get<{ Params: { id: string } }>("/api/resources/:id/file", async (req, reply) => {
    const r = rs.get(Number(req.params.id));
    if (!r) return reply.code(404).send({ error: "no such resource" });
    return sendFile(req, reply, r.path, r.mime);
  });
}
