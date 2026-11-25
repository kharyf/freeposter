// Editing styles: named, ready-made edits a Drive filename can ask for (its {editing-style} part). FreePoster ships
// with some (built in, here); the user adds their own on the Editing Styles tab, and agents through the MCP
// add_editing_style tool. Every style has a thumbnail: an image the user gave it, or one drawn from its steps.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountSets, setToken } from "../accounts.ts";
import { dataDir } from "../config.ts";
import type { Store } from "../db.ts";
import { isRaw, looksLikeDate, looksLikeTime } from "../drive/filename.ts";
import { CARD_FONT_TTF_BASE64 } from "./fancy/card-font.ts";
import { PALETTE } from "./fancy/palette.ts";
import { fancyTemplates } from "./fancy/templates.ts";
import { DEFAULT_EDIT, type EditSettings } from "./settings.ts";

export interface EditingStyle {
  id: string;
  /** shown on the tab, and (as is: no spaces) written in a filename */
  name: string;
  description: string;
  settings: EditSettings;
  /** shipped with FreePoster, so it can't be deleted */
  builtIn: boolean;
}

/** A style the user added, as saved. Deleted ones are kept (hidden) so videos already on their way keep their edit. */
interface SavedStyle {
  id: string;
  name: string;
  description: string;
  settings: EditSettings;
  createdAt: number;
  deleted?: boolean;
}

export const BUILT_IN_STYLES: readonly EditingStyle[] = [
  {
    id: "basic",
    name: "Basic",
    description:
      "Tightens the pauses and stumbles, adds word-by-word captions, reframes to vertical around the speaker, cleans up the sound, and adds gentle punch-in zooms.",
    settings: DEFAULT_EDIT,
    builtIn: true,
  },
  {
    id: "fancy",
    name: "Fancy",
    description:
      "Split screen with motion graphics about what's said, the speaker switching between the top and bottom halves, a cut or zoom at least every 2 seconds, and yellow italic serif captions.",
    settings: { ...DEFAULT_EDIT, look: "fancy" },
    builtIn: true,
  },
  {
    id: "slideshow",
    name: "Slideshow",
    description:
      "A photo slideshow presentation with smooth crossfade transitions, gentle Ken Burns-style pan-and-zoom motion on each image, a warm color grade (teal & orange), and minimal text overlays showing slide numbers.",
    settings: { ...DEFAULT_EDIT, look: "slideshow" },
    builtIn: true,
  },
];

/** The steps a style turns on or off, in the order they're shown, with what each does. */
export const STYLE_STEPS = [
  { key: "tighten", label: "Tighten", help: "Cuts long pauses, filler words and retakes." },
  { key: "captions", label: "Captions", help: "Burns in word-by-word captions, synced to the speech." },
  { key: "reframe", label: "Reframe", help: "Crops to vertical 9:16, keeping the speaker in frame." },
  { key: "audio", label: "Clean sound", help: "Evens out the loudness and cleans up the sound." },
  { key: "punchIn", label: "Punch-in zooms", help: "Zooms in gently on cuts to keep it moving." },
] as const;
export type StepKey = (typeof STYLE_STEPS)[number]["key"];

const CUSTOM_PREF = "edit.customStyles";
const DEFAULT_STYLE_PREF = "edit.defaultStyle";
const MAX_NAME = 40;
const MAX_DESCRIPTION = 500;

const saved = (store: Store) => store.pref<SavedStyle[]>(CUSTOM_PREF) ?? [];
const asStyle = (s: SavedStyle): EditingStyle => ({ id: s.id, name: s.name, description: s.description, settings: s.settings, builtIn: false });

/** The styles there are to pick from: the built-in ones, then the user's, oldest first. */
export function allStyles(store: Store): EditingStyle[] {
  return [...BUILT_IN_STYLES, ...saved(store).filter((s) => !s.deleted).map(asStyle)];
}

/** Any style a video may have been given, deleted ones included (a video on its way keeps its style). */
export function styleById(store: Store, id: string | null | undefined): EditingStyle | undefined {
  if (!id) return undefined;
  const builtIn = BUILT_IN_STYLES.find((s) => s.id === id);
  if (builtIn) return builtIn;
  const custom = saved(store).find((s) => s.id === id);
  return custom && asStyle(custom);
}

/** A style the user can pick now (not deleted). */
const liveStyle = (store: Store, id: string | null | undefined) => allStyles(store).find((s) => s.id === id);

/** The default style: the one chosen, or the first when none is (or the chosen one no longer exists). */
export function defaultStyleId(store: Store): string {
  return liveStyle(store, store.pref<string>(DEFAULT_STYLE_PREF))?.id ?? BUILT_IN_STYLES[0].id;
}

/** False when there's no such style. */
export function setDefaultStyle(store: Store, id: string): boolean {
  if (!liveStyle(store, id)) return false;
  store.setPref(DEFAULT_STYLE_PREF, id);
  return true;
}

/** The word a filename uses for a style. */
export const styleToken = (s: { name: string }) => s.name.replace(/\s+/g, "");

/**
 * Fancy became a built-in, so a style the user already saved as "Fancy" clashes with it twice over: its id was
 * most likely "fancy" (the built-in's id, which would then win every lookup), and its name would clash in a
 * filename. Run at startup before anything reads styles; running it again changes nothing.
 *
 * A saved style with the id "fancy" (deleted ones too: videos on their way keep theirs) gets a fresh id, and with
 * it its thumbnail and sample files, the default-style choice and every Drive file that chose it. A live style
 * named Fancy is renamed "My Fancy" (or "My Fancy 2", ...).
 * Edits already made keep their settings, not a style id, so they need nothing.
 */
export function migrateFancyStyle(store: Store): { id: string | null; name: string | null } {
  const all = saved(store);
  let id: string | null = null;
  const clash = all.find((s) => s.id === "fancy");
  if (clash) {
    id = newId(store, "My Fancy");
    const dir = stylesDir();
    for (const file of [...(Object.keys(IMAGE_TYPES) as ImageExt[]).map((ext) => `.thumbnail.${ext}`), ".mp4"]) {
      const from = join(dir, `fancy${file}`), to = join(dir, `${id}${file}`);
      if (existsSync(from) && !existsSync(to)) renameSync(from, to);
    }
    // A deleted style can't have been the default (deleting it cleared that), so "fancy" then means the built-in.
    if (!clash.deleted && store.pref<string>(DEFAULT_STYLE_PREF) === "fancy") store.setPref(DEFAULT_STYLE_PREF, id);
    store.renameDriveStyle("fancy", id);
    clash.id = id;
    console.log(`gave your style "${clash.name}" the id "${id}": Fancy is now built in`);
  }
  let name: string | null = null;
  const style = all.find((s) => !s.deleted && styleToken(s).toLowerCase() === "fancy");
  if (style) {
    const taken = new Set([...BUILT_IN_STYLES, ...all.filter((s) => !s.deleted)].map((s) => styleToken(s).toLowerCase()));
    name = "My Fancy";
    for (let n = 2; taken.has(styleToken({ name }).toLowerCase()); n++) name = `My Fancy ${n}`;
    style.name = name;
    console.log(`renamed your style "Fancy" to "${name}": Fancy is now built in`);
  }
  // Saved last: were it cut short, the next start finds the "fancy" id again and makes the same moves.
  if (clash || style) store.setPref(CUSTOM_PREF, all);
  return { id, name };
}

/**
 * Why a style can't have this name, or null when it can. Its filename word must not be empty, contain an
 * underscore (which separates a filename's parts), read as a date, a time or RAW, or match another style or an
 * account set, ignoring case.
 */
export function styleNameProblem(store: Store, name: string): string | null {
  const trimmed = name.trim();
  const token = styleToken({ name: trimmed });
  if (!token) return "give the style a name";
  if (trimmed.length > MAX_NAME) return `a style's name is at most ${MAX_NAME} characters`;
  if (token.includes("_")) return "a style's name can't contain an underscore: underscores separate the parts of a Drive filename";
  if (/[\\/:*?"<>|]/.test(token)) return "a style's name can't contain \\ / : * ? \" < > or |, which filenames can't hold";
  if (isRaw(token)) return "RAW already means \"don't edit\" in a Drive filename";
  if (looksLikeDate(token) || looksLikeTime(token)) return `"${token}" reads as a date or time in a Drive filename`;
  const key = token.toLowerCase();
  const style = allStyles(store).find((s) => styleToken(s).toLowerCase() === key);
  if (style) return `"${token}" is already the editing style ${style.name}; a filename couldn't tell them apart`;
  const set = accountSets(store).find((s) => setToken(s.name).toLowerCase() === key);
  if (set) return `"${token}" is the account set ${set.name}; a filename couldn't tell them apart`;
  return null;
}

/** What a new style needs. Steps left out are on. */
export interface NewStyle {
  name: string;
  description?: string;
  steps?: Partial<Record<StepKey, boolean>>;
}

/** A style's steps, checked: only the five switches (keep/drop/caption fixes belong to one video, not a style). */
export function styleSettings(steps: unknown): EditSettings {
  if (steps === undefined || steps === null) return { ...DEFAULT_EDIT };
  if (typeof steps !== "object" || Array.isArray(steps)) throw new Error("steps must be an object of true/false switches");
  const out: EditSettings = { ...DEFAULT_EDIT };
  const keys = STYLE_STEPS.map((s) => s.key) as string[];
  for (const [k, v] of Object.entries(steps)) {
    if (!keys.includes(k)) throw new Error(`${k} is not a step a style can set; the steps are ${keys.join(", ")}`);
    if (typeof v !== "boolean") throw new Error(`step ${k} must be true or false`);
    out[k as StepKey] = v;
  }
  if (!keys.some((k) => out[k as StepKey])) throw new Error("turn on at least one step; a video that shouldn't be edited at all ends its filename in _RAW");
  return out;
}

/** The id kept on disk and in URLs: the name in lowercase letters, digits and dashes, unique among every style ever made. */
function newId(store: Store, name: string): string {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "style";
  const taken = new Set([...BUILT_IN_STYLES.map((s) => s.id), ...saved(store).map((s) => s.id)]);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** The new style, or why it couldn't be made. */
export function createStyle(store: Store, input: NewStyle): EditingStyle | string {
  const name = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ") : "";
  const problem = styleNameProblem(store, name);
  if (problem) return problem;
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (description.length > MAX_DESCRIPTION) return `a style's description is at most ${MAX_DESCRIPTION} characters`;
  let settings: EditSettings;
  try { settings = styleSettings(input.steps); } catch (err) { return (err as Error).message; }
  const style: SavedStyle = { id: newId(store, name), name, description, settings, createdAt: Date.now() };
  store.setPref(CUSTOM_PREF, [...saved(store), style]);
  removeThumbnail(style.id); // a leftover from a database since replaced would otherwise show as its own
  return asStyle(style);
}

/**
 * Only a style the user added. Null when deleted, else why not. Videos already given it keep its edit; the
 * default goes back to the first style when it was this one.
 */
export function deleteStyle(store: Store, id: string): string | null {
  if (BUILT_IN_STYLES.some((s) => s.id === id)) return "built-in styles can't be deleted";
  const all = saved(store);
  const style = all.find((s) => s.id === id && !s.deleted);
  if (!style) return "no such editing style";
  style.deleted = true;
  store.setPref(CUSTOM_PREF, all);
  if (store.pref<string>(DEFAULT_STYLE_PREF) === id) store.deletePref(DEFAULT_STYLE_PREF);
  removeThumbnail(id);
  return null;
}

// ---- samples and thumbnails, kept in data/styles ----

const stylesDir = () => join(dataDir, "styles");

/** Where a style's sample video is kept, when it has one. */
export const sampleVideoPath = (id: string) => join(stylesDir(), `${id}.mp4`);
export const hasSample = (id: string) => existsSync(sampleVideoPath(id));

const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" } as const;
type ImageExt = keyof typeof IMAGE_TYPES;
export const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;

/** What kind of image the bytes are, by their first few: PNG, JPEG or WebP, or null for anything else. */
export function imageKind(bytes: Buffer): ImageExt | null {
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length > 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

const thumbnailFile = (id: string, ext: ImageExt) => join(stylesDir(), `${id}.thumbnail.${ext}`);

/** The image the user gave a style, when there is one. */
export function uploadedThumbnail(id: string): { path: string; type: string } | null {
  for (const ext of Object.keys(IMAGE_TYPES) as ImageExt[]) {
    const path = thumbnailFile(id, ext);
    if (existsSync(path)) return { path, type: IMAGE_TYPES[ext] };
  }
  return null;
}

function removeThumbnail(id: string) {
  for (const ext of Object.keys(IMAGE_TYPES) as ImageExt[]) try { unlinkSync(thumbnailFile(id, ext)); } catch {}
}

/** Why these bytes can't be a thumbnail, or null when they can. */
export function thumbnailProblem(bytes: Buffer): string | null {
  if (!bytes.length) return "the thumbnail is empty";
  if (bytes.length > MAX_THUMBNAIL_BYTES) return "the thumbnail is larger than 5 MB";
  if (!imageKind(bytes)) return "the thumbnail must be a PNG, JPEG or WebP image";
  return null;
}

/** Keeps the image as the style's thumbnail, replacing any it had. Throws (with the reason) for anything but a PNG, JPEG or WebP. */
export function saveThumbnail(id: string, bytes: Buffer) {
  const problem = thumbnailProblem(bytes);
  if (problem) throw new Error(problem);
  const ext = imageKind(bytes)!;
  mkdirSync(stylesDir(), { recursive: true });
  removeThumbnail(id);
  writeFileSync(thumbnailFile(id, ext), bytes);
}

/** The thumbnail to show: the uploaded image, or one drawn from the style's steps. */
export function thumbnail(style: EditingStyle): { type: string; body: Buffer | string } {
  const uploaded = uploadedThumbnail(style.id);
  if (uploaded) return { type: uploaded.type, body: readFileSync(uploaded.path) };
  return { type: "image/svg+xml", body: style.builtIn && style.id === "fancy" ? fancyThumbnailSvg() : thumbnailSvg(style.settings) };
}

/** The speaker on a style card: a head and shoulders, filled with the card's #skin and #shirt gradients. */
function person(cx: number, top: number, scale: number): string {
  const r = 44 * scale, headY = top + r;
  const sw = 120 * scale, neck = headY + r * 0.9;
  return `<path d="M${cx - sw} ${neck + 150 * scale} Q${cx - sw} ${neck + 18 * scale} ${cx - 30 * scale} ${neck + 8 * scale} L${cx + 30 * scale} ${neck + 8 * scale} Q${cx + sw} ${neck + 18 * scale} ${cx + sw} ${neck + 150 * scale} Z" fill="url(#shirt)"/>
<rect x="${cx - 16 * scale}" y="${headY + r * 0.6}" width="${32 * scale}" height="${r * 0.6}" fill="#d9a27a"/>
<circle cx="${cx}" cy="${headY}" r="${r}" fill="url(#skin)"/>
<path d="M${cx - r} ${headY - 4 * scale} Q${cx - r} ${top - 6 * scale} ${cx} ${top - 4 * scale} Q${cx + r} ${top - 6 * scale} ${cx + r} ${headY - 4 * scale} Q${cx + r * 0.55} ${top + 16 * scale} ${cx - r} ${headY - 4 * scale} Z" fill="#2b2220"/>`;
}

/** Corner marks around a face: a zoom. */
function zoomMarks(face: { x: number; y: number; r: number }, colour: string): string {
  const pad = face.r * 1.9, x0 = face.x - pad, x1 = face.x + pad, y0 = face.y - pad * 0.9, y1 = face.y + pad * 1.1, l = face.r * 0.55;
  return `<g stroke="${colour}" stroke-width="3" stroke-linecap="round" fill="none" opacity=".9">
<path d="M${x0} ${y0 + l}V${y0}H${x0 + l}"/><path d="M${x1 - l} ${y0}H${x1}V${y0 + l}"/><path d="M${x0} ${y1 - l}V${y1}H${x0 + l}"/><path d="M${x1 - l} ${y1}H${x1}V${y1 - l}"/></g>`;
}

/**
 * Fancy's card, a 9:16 frame of a Fancy split: a gold coin and "3×" on ink in the top half, a gold seam, the
 * speaker in the bottom half with zoom corner marks, and the caption "the one SECRET" on the seam, SECRET lit in
 * yellow. The caption's font is embedded (an SVG in <img> can't load outside fonts), falling back to Georgia italic.
 */
export function fancyThumbnailSvg(): string {
  const W = 270, H = 480, seam = H / 2;
  const { ink, ink2, yellow, gold, cream } = PALETTE;
  const serif = `font-family="Fancy, Georgia, serif" font-style="italic" font-weight="700"`;
  const top = seam + 58, scale = 1.05;
  const face = { x: W / 2, y: top + 44 * scale, r: 44 * scale };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Example frame">
<defs>
  <style>@font-face{font-family:'Fancy';src:url(data:font/ttf;base64,${CARD_FONT_TTF_BASE64}) format('truetype');font-style:italic;font-weight:700}</style>
  <linearGradient id="ink" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${ink2}"/><stop offset="1" stop-color="${ink}"/></linearGradient>
  <radialGradient id="glow" cx=".36" cy=".48" r=".55"><stop offset="0" stop-color="${gold}" stop-opacity=".3"/><stop offset="1" stop-color="${gold}" stop-opacity="0"/></radialGradient>
  <linearGradient id="coinFace" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${yellow}"/><stop offset=".55" stop-color="${gold}"/><stop offset="1" stop-color="#9c7414"/></linearGradient>
  <linearGradient id="coinEdge" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7a5a0e"/><stop offset=".5" stop-color="#b98c1b"/><stop offset="1" stop-color="#5e440a"/></linearGradient>
  <linearGradient id="room" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a3c2c"/><stop offset="1" stop-color="#1e1813"/></linearGradient>
  <linearGradient id="skin" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f2c6a0"/><stop offset="1" stop-color="#d9a27a"/></linearGradient>
  <linearGradient id="shirt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b3a46"/><stop offset="1" stop-color="#22212a"/></linearGradient>
  <clipPath id="bottom"><rect y="${seam}" width="${W}" height="${seam}"/></clipPath>
</defs>
<rect width="${W}" height="${seam}" fill="url(#ink)"/>
<rect width="${W}" height="${seam}" fill="url(#glow)"/>
<g transform="rotate(-14 96 116)">
<ellipse cx="103" cy="122" rx="50" ry="50" fill="url(#coinEdge)"/>
<circle cx="96" cy="116" r="50" fill="url(#coinFace)"/>
<circle cx="96" cy="116" r="39" fill="none" stroke="#9c7414" stroke-width="2.5" opacity=".7"/>
<path d="M70 92 Q86 76 108 78" stroke="${cream}" stroke-width="5" stroke-linecap="round" fill="none" opacity=".55"/>
</g>
<text x="210" y="138" text-anchor="middle" font-size="62" fill="${yellow}" ${serif}>3×</text>
<g clip-path="url(#bottom)">
<rect y="${seam}" width="${W}" height="${seam}" fill="url(#room)"/>
${person(W / 2, top, scale)}
${zoomMarks(face, cream)}
</g>
<rect y="${seam - 2}" width="${W}" height="4" fill="${gold}"/>
<text x="${W / 2}" y="${seam + 11}" text-anchor="middle" font-size="31" ${serif} stroke="${ink}" stroke-width="5" stroke-linejoin="round" paint-order="stroke"><tspan fill="${cream}">the one </tspan><tspan fill="${yellow}">SECRET</tspan></text>
</svg>`;
}

/** What each graphics tool makes for Fancy, for the note when it's missing. */
const TOOL_GRAPHICS = {
  remotion: "counter, list, comparison, quote and step graphics",
  hyperframes: "moving-word and icon graphics",
  blender: "3D graphics",
} as const;
type GraphicsTool = keyof typeof TOOL_GRAPHICS;
const TOOL_NAMES: Record<GraphicsTool, string> = { remotion: "Remotion", hyperframes: "HyperFrames", blender: "Blender" };

/** A graphics tool's health check, as its adapter answers it. */
export interface ToolHealth { ok: boolean; detail: string; missing?: boolean }

/** A health check's detail on one line, short enough for a note. */
const brief = (detail: string) => {
  const line = detail.replace(/\s+/g, " ").trim() || "its check failed";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
};

/**
 * For the Editing Styles tab: which Fancy graphics fall back, given each tool's health check. A tool that isn't
 * there "isn't installed"; one that is there but fails its check "isn't working" (with why). Its graphics follow
 * their templates' fallback chains to the first healthy tool, or else to the built-in keyword card (where a failed
 * render can always end up too). Null when every tool is healthy.
 */
export function fancyToolNote(health: Record<GraphicsTool, ToolHealth>): string | null {
  const catalogue = fancyTemplates();
  const ok = (tool: string) => tool === "builtin" || health[tool as GraphicsTool].ok;
  const notes: string[] = [];
  for (const tool of Object.keys(TOOL_GRAPHICS) as GraphicsTool[]) {
    const h = health[tool];
    if (h.ok) continue;
    const madeWith = new Set<string>();
    for (const t of Object.values(catalogue)) {
      if (t.tool !== tool) continue;
      let next = t.fallback ? catalogue[t.fallback] : undefined;
      while (next && !ok(next.tool)) next = next.fallback ? catalogue[next.fallback] : undefined;
      if (next && next.tool !== "builtin") madeWith.add(TOOL_NAMES[next.tool as GraphicsTool]);
    }
    const via = madeWith.size ? `with ${[...madeWith].join(" or ")} or ` : "";
    const state = h.missing ? "isn't installed" : `isn't working (${brief(h.detail)})`;
    notes.push(`${TOOL_NAMES[tool]} ${state}: ${TOOL_GRAPHICS[tool]} will be made ${via}as keyword cards`);
  }
  return notes.length ? notes.join("; ") : null;
}

/**
 * A 9:16 example frame of what the steps do: the speaker filling a vertical frame (reframe) or letterboxed in a
 * wide one; corner marks for the punch-in zoom; a caption with its spoken word lit; level sound bars; and a strip
 * of the timeline with the pauses cut out (tighten).
 */
export function thumbnailSvg(s: Pick<EditSettings, StepKey>): string {
  const W = 270, H = 480;
  const parts: string[] = [];
  parts.push(`<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a3f58"/><stop offset="1" stop-color="#1b1d27"/></linearGradient>
  <linearGradient id="skin" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f2c6a0"/><stop offset="1" stop-color="#d9a27a"/></linearGradient>
  <linearGradient id="shirt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e8674f"/><stop offset="1" stop-color="#b8432f"/></linearGradient>
</defs>`);
  parts.push(`<rect width="${W}" height="${H}" fill="#0d0e12"/>`);
  // The speaker, in a vertical frame or a letterboxed wide one.
  let face: { x: number; y: number; r: number };
  if (s.reframe) {
    parts.push(`<rect width="${W}" height="${H}" fill="url(#bg)"/>`);
    const scale = s.punchIn ? 1.25 : 1;
    const top = s.punchIn ? 120 : 150;
    parts.push(person(W / 2, top, scale));
    face = { x: W / 2, y: top + 44 * scale, r: 44 * scale };
  } else {
    const fh = Math.round((W * 9) / 16), fy = Math.round((H - fh) / 2) - 30;
    parts.push(`<svg x="0" y="${fy}" width="${W}" height="${fh}" viewBox="0 0 ${W} ${fh}"><rect width="${W}" height="${fh}" fill="url(#bg)"/>${person(W * 0.62, 26, s.punchIn ? 0.62 : 0.5)}</svg>`);
    const scale = s.punchIn ? 0.62 : 0.5;
    face = { x: W * 0.62, y: fy + 26 + 44 * scale, r: 44 * scale };
  }
  // Corner marks closing in on the face: the zoom on a cut.
  if (s.punchIn) parts.push(zoomMarks(face, "#ffffff"));
  if (s.captions) {
    // A caption with the word being said lit up.
    const y = s.reframe ? 352 : 330;
    parts.push(`<g font-family="system-ui,-apple-system,Segoe UI,Arial,sans-serif" font-weight="800" font-size="26" text-anchor="middle">
<text x="${W / 2 - 78}" y="${y}" fill="#ffffff" stroke="#000" stroke-width="5" paint-order="stroke">THIS</text>
<rect x="${W / 2 - 34}" y="${y - 25}" width="72" height="34" rx="7" fill="#ffd23f"/>
<text x="${W / 2 + 2}" y="${y}" fill="#14141a">ONE</text>
<text x="${W / 2 + 78}" y="${y}" fill="#ffffff" stroke="#000" stroke-width="5" paint-order="stroke">TIP</text></g>`);
  }
  if (s.audio) {
    // Even sound: bars all at one level.
    const bars = Array.from({ length: 9 }, (_, i) => `<rect x="${20 + i * 7}" y="${28 - (i % 2 ? 7 : 9)}" width="4" height="${i % 2 ? 14 : 18}" rx="2" fill="#7ee0a6"/>`).join("");
    parts.push(`<g><rect x="12" y="12" width="78" height="32" rx="16" fill="#000" opacity=".45"/>${bars}</g>`);
  }
  // The timeline: one long take, or (tightened) the takes with the pauses cut out.
  const ty = H - 30;
  parts.push(`<rect x="16" y="${ty}" width="${W - 32}" height="12" rx="6" fill="#000" opacity=".45"/>`);
  if (s.tighten) {
    const segs = [[16, 58], [80, 44], [130, 70], [206, 48]];
    parts.push(segs.map(([x, w]) => `<rect x="${x}" y="${ty}" width="${w}" height="12" rx="3" fill="#8ab4ff"/>`).join(""));
    parts.push([74, 124, 200].map((x) => `<path d="M${x + 3} ${ty - 6}V${ty + 18}" stroke="#ffd23f" stroke-width="2" stroke-dasharray="3 3"/>`).join(""));
  } else {
    parts.push(`<rect x="16" y="${ty}" width="${W - 32}" height="12" rx="6" fill="#8ab4ff" opacity=".7"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Example frame">${parts.join("\n")}</svg>`;
}
