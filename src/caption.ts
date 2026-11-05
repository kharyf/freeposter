// Writes a Drive video's title and caption with Claude. Only the transcript text and the filename's name
// are sent; the video itself never leaves this computer. Claude runs through the user's own Claude Code,
// on their Claude plan (see claude.ts).
import { askClaude, type ClaudeRun } from "./claude.ts";
import { config } from "./config.ts";
import type { Publisher } from "./platforms/base.ts";
import type { Account, Platform, Post } from "./types.ts";

const RETRIES = 2;

const SCHEMA = {
  type: "object",
  properties: { title: { type: "string" }, caption: { type: "string" } },
  required: ["title", "caption"],
  additionalProperties: false,
};

function system(platforms: string[], limit: number) {
  return `You write the post text for one short vertical video that will be posted to: ${platforms.join(", ")}.

Reply with a title and a caption.
- Title: at most 100 characters, no < or > characters. A plain-spoken hook that says what the video is about.
- Caption: at most ${limit} characters in total, hashtags included. One or two short sentences in the speaker's own voice that make people want to watch, then 2 to 4 relevant hashtags at the end.
- Use only what the speaker actually says. Don't invent facts, numbers, names or promises, and don't add links or @mentions.`;
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

export async function writeCaption(
  input: { topic: string; transcript: string; accounts: Account[] },
  publishers: Record<Platform, Publisher>,
  opts: { run?: ClaudeRun; claudePath?: string } = {},
): Promise<{ title: string; caption: string }> {
  if (!input.transcript.trim()) throw new Error("no speech to write a caption from");
  const platforms = [...new Set(input.accounts.map((a) => publishers[a.platform].label))];
  const limit = input.accounts.some((a) => a.platform === "x") ? config.xMaxChars : 2200;
  const request = `Topic (from the file name): ${input.topic}\n\nTranscript:\n${input.transcript.trim()}`;
  // Each try is a fresh `claude -p`, so earlier answers and what was wrong with them are carried in the prompt.
  const history: string[] = [];

  let last: string[] = [];
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    let text: { title: string; caption: string };
    try {
      text = await askClaude<{ title: string; caption: string }>(
        { system: system(platforms, limit), prompt: [request, ...history].join("\n\n"), schema: SCHEMA },
        opts,
      );
    } catch (err) {
      throw new Error(`caption writing failed: ${(err as Error).message}`);
    }
    text = { title: String(text?.title ?? "").trim(), caption: String(text?.caption ?? "").trim() };
    last = problems(text, input.accounts, publishers);
    if (!last.length) return text;
    history.push(`Your earlier answer:\n${JSON.stringify(text)}\n\nThat doesn't fit: ${last.join("; ")}. Write it again so it does.`);
  }
  throw new Error(`caption writing failed: ${last.join("; ")}`);
}
