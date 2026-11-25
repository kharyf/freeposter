// Which resources an edit uses. Nothing is used automatically: only the tags a request lists or mentions as @tag.
// They are resolved once, when the edit is made, into a snapshot (id, path, hash, role) that goes into its key.
import { accountSets } from "../accounts.ts";
import type { Store } from "../db.ts";
import type { EditSettings, ResourceRole, ResourceUse } from "../edit/settings.ts";
import type { ResourceKind, ResourceStore } from "./store.ts";

export interface ResourceRef { tag: string; as?: ResourceRole }

export const ROLES_BY_KIND: Record<ResourceKind, readonly ResourceRole[]> = {
  text: ["context"], audio: ["music"], image: ["slide", "overlay"], video: ["clip"],
};

const ALL_ROLES: readonly string[] = ["music", "overlay", "slide", "clip", "context"];
export const MAX_SLIDES_AND_CLIPS = 30;
export const MAX_RESOURCES = 40;

export function defaultRole(kind: ResourceKind, look: EditSettings["look"]): ResourceRole {
  if (kind === "text") return "context";
  if (kind === "audio") return "music";
  if (kind === "video") return "clip";
  return look === "slideshow" ? "slide" : "overlay";
}

/** The @tags written in instructions, lowercase, once each, in order. An @ inside a word (an email, a URL) isn't one. */
export function mentionedTags(instructions: string | undefined): string[] {
  const seen: string[] = [];
  if (!instructions) return seen;
  for (const m of instructions.matchAll(/(?:^|[\s(,;])@([a-z0-9][a-z0-9-]{0,31})(?![a-z0-9-])/gi)) {
    const tag = m[1].toLowerCase();
    if (!seen.includes(tag)) seen.push(tag);
  }
  return seen;
}

/** A request's `resources` list ([{ tag, as? }]); throws what's wrong with it. */
export function parseRefs(raw: unknown): ResourceRef[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("resources must be a list of { tag, as? }");
  return raw.map((r) => {
    if (!r || typeof r !== "object" || typeof r.tag !== "string" || !r.tag.trim()) throw new Error("each resource needs a tag");
    const ref: ResourceRef = { tag: r.tag.trim().replace(/^@/, "").toLowerCase() };
    if (r.as !== undefined && r.as !== null) {
      if (typeof r.as !== "string" || !ALL_ROLES.includes(r.as)) throw new Error(`a resource's as must be one of ${ALL_ROLES.join(", ")}`);
      ref.as = r.as as ResourceRole;
    }
    return ref;
  });
}

/**
 * The resources an edit uses: the ones it already had (`keep`, even if deleted since), then `refs`, then @mentions,
 * each tag once. Returns why not as a string.
 */
export function resolveResources(rs: ResourceStore, store: Store, setId: number, refs: ResourceRef[], instructions: string | undefined,
  look: EditSettings["look"], keep: ResourceUse[] = []): ResourceUse[] | string {
  const uses: ResourceUse[] = [];
  const have = (tag: string) => uses.some((u) => u.tag === tag);
  for (const k of keep) if (!have(k.tag)) uses.push(k);
  const wanted: ResourceRef[] = [...refs, ...mentionedTags(instructions).map((tag) => ({ tag }))];
  for (const ref of wanted) {
    if (have(ref.tag)) continue;
    const r = rs.byTag(setId, ref.tag);
    if (!r) {
      const name = accountSets(store).find((s) => s.id === setId)?.name ?? `set ${setId}`;
      return `no resource tagged @${ref.tag} in the account set ${name}`;
    }
    const as = ref.as ?? defaultRole(r.kind, look);
    if (!ROLES_BY_KIND[r.kind].includes(as)) return `@${r.tag} is ${r.kind}: it can be used as ${ROLES_BY_KIND[r.kind].join(" or ")}`;
    if (as === "slide" && look !== "slideshow") return "slide is only for the Slideshow style";
    uses.push({ id: r.id, tag: r.tag, kind: r.kind, path: r.path, sha256: r.sha256, as });
  }
  const count = (role: ResourceRole) => uses.filter((u) => u.as === role).length;
  if (count("music") > 1) return "only one music resource per edit";
  if (count("overlay") > 1) return "only one overlay resource per edit";
  if (look !== "slideshow" && count("clip") > 1) return "only one end clip per edit";
  if (look === "slideshow" && count("slide") + count("clip") > MAX_SLIDES_AND_CLIPS) return "a slideshow takes at most 30 slides and clips";
  if (uses.length > MAX_RESOURCES) return "an edit takes at most 40 resources";
  return uses;
}
