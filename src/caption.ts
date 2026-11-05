// Writes a Drive video's title and caption with Claude. A video with speech sends only its transcript text and
// the filename's name. A video with no speech sends a few still frames instead, so Claude can read its text
// overlays; the video file itself never leaves this computer. When Claude can't tell what a video is about, it
// gets FALLBACK_CAPTION. Claude runs through the user's own Claude Code, on their Claude plan (see claude.ts).
import { askClaude, type ClaudeRun } from "./claude.ts";
import { config } from "./config.ts";
import { sampleFrames } from "./media.ts";
import type { Publisher } from "./platforms/base.ts";
import type { Account, Platform, Post } from "./types.ts";

const RETRIES = 2;

/** The caption when nothing better can be written: no speech and nothing readable on screen, or Claude failed. */
export const FALLBACK_CAPTION = "#fyp";

/** Title and caption for a video Claude couldn't caption: the filename's name and FALLBACK_CAPTION. */
export function fallbackText(topic: string): { title: string; caption: string } {
  return { title: topic.replace(/[<>]/g, "").trim().slice(0, 100) || "Video", caption: FALLBACK_CAPTION };
}

/** A transcript's words as plain text ("" when nobody speaks). */
export const transcriptText = (t: { words: { text: string }[] }) => t.words.map((w) => w.text).join(" ").trim();

export interface CaptionDeps {
  /** writeCaption, bound to the publishers (a stand-in in tests) */
  writeCaption: (input: { topic: string; transcript: string; accounts: Account[]; frames?: Buffer[] }) => Promise<{ title: string; caption: string } | null>;
  /** stills for captioning a video with no speech (default: sampleFrames) */
  frames?: (sourcePath: string) => Promise<Buffer[]>;
}

/**
 * The text for any upload (Drive, the web page or MCP). It never waits for the user: from the speech, or from
 * the frames when nobody speaks, or else the fallback. `note` says why when it's the fallback.
 */
export async function captionVideo(
  v: { topic: string; transcript: string; sourcePath: string; accounts: Account[] },
  deps: CaptionDeps,
  log: (msg: string) => void = () => {},
): Promise<{ title: string; caption: string; note: string | null }> {
  const transcript = v.transcript.trim();
  let why: string;
  try {
    let frames: Buffer[] = [];
    if (!transcript) {
      log("no speech; looking at its frames");
      frames = await (deps.frames ?? sampleFrames)(v.sourcePath).catch(() => []);
    }
    log("writing the caption");
    const written = await deps.writeCaption({ topic: v.topic, transcript, accounts: v.accounts, frames });
    if (written) return { ...written, note: null };
    why = frames.length ? "no speech, and its frames didn't show what it's about" : "no speech, and no frames could be read";
  } catch (err) {
    why = (err as Error).message;
  }
  const fallback = fallbackText(v.topic);
  log(`captioned ${fallback.caption}: ${why}`);
  return { ...fallback, note: `${why}; captioned ${fallback.caption}` };
}

const SCHEMA = {
  type: "object",
  properties: { title: { type: "string" }, caption: { type: "string" } },
  required: ["title", "caption"],
  additionalProperties: false,
};

// From frames, Claude also says whether they showed what the video is about.
const VISUAL_SCHEMA = {
  type: "object",
  properties: { understood: { type: "boolean" }, title: { type: "string" }, caption: { type: "string" } },
  required: ["understood", "title", "caption"],
  additionalProperties: false,
};

function rules(platforms: string[], limit: number) {
  return `You write the post text for one short vertical video that will be posted to: ${platforms.join(", ")}.

Reply with a title and a caption.
- Title: at most 100 characters, no < or > characters. A plain-spoken hook that says what the video is about.
- Caption: at most ${limit} characters in total, hashtags included. One or two short sentences that make people want to watch, then 2 to 4 relevant hashtags at the end.`;
}

function system(platforms: string[], limit: number) {
  return `${rules(platforms, limit)}
- Write in the speaker's own voice. Use only what the speaker actually says. Don't invent facts, numbers, names or promises, and don't add links or @mentions.`;
}

function visualSystem(platforms: string[], limit: number) {
  return `${rules(platforms, limit)}
- Nobody speaks in this video. You get still frames from it, in order. Work from its on-screen text (text overlays, captions, titles) first, then from what is plainly shown.
- Use only what the frames show. Don't invent facts, numbers, names or promises, don't guess at who people are, and don't add links or @mentions.
- Set understood to false, with an empty title and caption, when the frames don't make clear what the video is about. Set it to true only when they do.`;
}

/** Problems with a proposed title and caption, as each target platform's own checks see them. */
function problems(text: { title: string; caption: string }, accounts: Account[], publishers: Record<Platform, Publisher>): string[] {
  const found = new Set<string>();
  if (!text.title.trim()) found.add("the title is empty");
  if (text.title.length > 100) found.add(`the title must be at most 100 characters; it has ${text.title.length}`);
  if (!text.caption.trim()) found.add("the caption is empty");
  const post: Post = {
    id: 0, createdAt: 0, sourcePath: "", sha256: "", caption: text.caption, title: text.title,
    // Drive posts go to TikTok as "Only me"; the caption checks don't depend on it.
    tiktok: { privacyLevel: "SELF_ONLY", disableComment: false, disableDuet: false, disableStitch: false, brandContent: false, brandOrganic: false },
  };
  for (const a of accounts) {
    const reason = publishers[a.platform].validate(post, a);
    if (reason) found.add(reason);
  }
  return [...found];
}

/**
 * A title and caption from the transcript or, when nobody speaks, from `frames` (JPEG stills). Null when there's
 * no speech and the frames don't show what the video is about (or there are none). Throws when Claude fails.
 */
export async function writeCaption(
  input: { topic: string; transcript: string; accounts: Account[]; frames?: Buffer[] },
  publishers: Record<Platform, Publisher>,
  opts: { run?: ClaudeRun; claudePath?: string } = {},
): Promise<{ title: string; caption: string } | null> {
  const spoken = Boolean(input.transcript.trim());
  const frames = spoken ? [] : input.frames ?? [];
  if (!spoken && !frames.length) return null;
  const platforms = [...new Set(input.accounts.map((a) => publishers[a.platform].label))];
  const limit = input.accounts.some((a) => a.platform === "x") ? config.xMaxChars : 2200;
  const request = spoken
    ? `Topic (from the file name): ${input.topic}\n\nTranscript:\n${input.transcript.trim()}`
    : `Topic (from the file name, which may not mean much): ${input.topic}\n\nThe video has no speech. Here are ${frames.length} still frames from it, in order.`;
  // Each try is a fresh `claude -p`, so earlier answers and what was wrong with them are carried in the prompt.
  const history: string[] = [];

  let last: string[] = [];
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    let text: { title: string; caption: string; understood?: boolean };
    try {
      text = await askClaude<{ title: string; caption: string; understood?: boolean }>(
        spoken
          ? { system: system(platforms, limit), prompt: [request, ...history].join("\n\n"), schema: SCHEMA }
          : { system: visualSystem(platforms, limit), prompt: [request, ...history].join("\n\n"), schema: VISUAL_SCHEMA, images: frames },
        opts,
      );
    } catch (err) {
      throw new Error(`caption writing failed: ${(err as Error).message}`);
    }
    if (!spoken && text?.understood !== true) return null;
    text = { title: String(text?.title ?? "").trim(), caption: String(text?.caption ?? "").trim() };
    last = problems(text, input.accounts, publishers);
    if (!last.length) return text;
    history.push(`Your earlier answer:\n${JSON.stringify(text)}\n\nThat doesn't fit: ${last.join("; ")}. Write it again so it does.`);
  }
  throw new Error(`caption writing failed: ${last.join("; ")}`);
}
