import { config, redirectUri } from "../config.ts";
import { pkceChallenge } from "../crypto.ts";
import { FatalError, requestJson } from "../http.ts";
import type { Account, TokenSet } from "../types.ts";
import { expiresIn, pollUntil, readChunk, type Publisher } from "./base.ts";

// Docs: https://docs.x.com/x-api/media/quickstart/media-upload-chunked
const API = "https://api.x.com/2";
const CHUNK = 4 * 1024 * 1024;
const creds = () => config.credentials.x;
const basic = () => `Basic ${Buffer.from(`${creds().id}:${creds().secret}`).toString("base64")}`;

/** X counts URLs as 23 characters and most emoji/CJK as 2. Close enough to reject before upload. */
export function xLength(text: string): number {
  let n = 0;
  const withoutUrls = text.replace(/https?:\/\/\S+/g, () => {
    n += 23;
    return "";
  });
  for (const ch of withoutUrls) n += (ch.codePointAt(0) ?? 0) > 0x10ff ? 2 : 1;
  return n;
}

function toTokens(t: any): TokenSet {
  return { accessToken: t.access_token, refreshToken: t.refresh_token ?? null, expiresAt: expiresIn(t.expires_in), refreshExpiresAt: null };
}

export const x: Publisher = {
  platform: "x",
  label: "X",
  minDurationSec: 0.5,
  maxDurationSec: () => config.xMaxVideoSeconds,

  validate(post) {
    const limit = config.xMaxChars;
    const len = xLength(post.caption);
    if (len > limit) return `X allows ${limit} characters on this account; the caption counts as ${len}`;
    return null;
  },

  authorizeUrl(state, verifier) {
    const q = new URLSearchParams({
      response_type: "code",
      client_id: creds().id,
      redirect_uri: redirectUri("x"),
      scope: "tweet.read tweet.write users.read media.write offline.access",
      state,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
    });
    return `https://x.com/i/oauth2/authorize?${q}`;
  },

  async exchangeCode(code, verifier) {
    const t = await requestJson(`${API}/oauth2/token`, {
      headers: { authorization: basic() },
      form: { grant_type: "authorization_code", code, redirect_uri: redirectUri("x"), code_verifier: verifier, client_id: creds().id },
    });
    const me = await requestJson(`${API}/users/me`, { headers: { authorization: `Bearer ${t.access_token}` } });
    return [
      {
        platform: "x",
        externalId: me.data.id,
        name: `@${me.data.username}`,
        ...toTokens(t),
        meta: { username: me.data.username },
      },
    ];
  },

  async refresh(account: Account) {
    if (!account.refreshToken) return null;
    // X rotates refresh tokens: the old one stops working once this succeeds.
    const t = await requestJson(`${API}/oauth2/token`, {
      headers: { authorization: basic() },
      form: { grant_type: "refresh_token", refresh_token: account.refreshToken, client_id: creds().id },
    });
    return toTokens(t);
  },

  async publish(ctx) {
    const { account, post, videoPath, videoSize, progress } = ctx;
    const auth = { authorization: `Bearer ${account.accessToken}` };

    if (!progress.mediaId) {
      const init = await requestJson(`${API}/media/upload/initialize`, {
        headers: auth,
        json: { media_type: "video/mp4", total_bytes: videoSize, media_category: "tweet_video" },
      });
      Object.assign(progress, { mediaId: init.data.id, nextSegment: 0 });
      ctx.save(progress);
    }

    const segments = Math.ceil(videoSize / CHUNK);
    for (let i = progress.nextSegment ?? segments; i < segments; i++) {
      const form = new FormData();
      form.append("segment_index", String(i));
      form.append("media", new Blob([await readChunk(videoPath, i * CHUNK, CHUNK)]), "chunk.mp4");
      await requestJson(`${API}/media/upload/${progress.mediaId}/append`, { headers: auth, body: form });
      progress.nextSegment = i + 1;
      ctx.save(progress);
      ctx.log(`uploaded segment ${i + 1}/${segments}`);
    }

    if (!progress.finalized) {
      await requestJson(`${API}/media/upload/${progress.mediaId}/finalize`, { headers: auth, method: "POST" });
      progress.finalized = true;
      ctx.save(progress);
    }

    if (!progress.processed) {
      await pollUntil("X media processing", async () => {
        const s = await requestJson(`${API}/media/upload?command=STATUS&media_id=${progress.mediaId}`, { headers: auth });
        const info = s.data?.processing_info;
        if (!info || info.state === "succeeded") return true;
        if (info.state === "failed") throw new FatalError(`X could not process the video: ${JSON.stringify(info.error ?? info)}`);
        return undefined;
      });
      progress.processed = true;
      ctx.save(progress);
    }

    if (!progress.tweetId) {
      if (progress.tweetRequested) progress.tweetId = await findRecentTweet(account, post.caption);
      if (!progress.tweetId) {
        progress.tweetRequested = true;
        ctx.save(progress);
        const t = await requestJson(`${API}/tweets`, {
          headers: auth,
          json: { text: post.caption, media: { media_ids: [progress.mediaId] } },
        });
        progress.tweetId = t.data.id;
      }
      ctx.save(progress);
    }

    return { url: `https://x.com/${account.meta.username}/status/${progress.tweetId}` };
  },
};

/** After a crash mid-request, look for the post we may already have made instead of posting twice. */
async function findRecentTweet(account: Account, text: string): Promise<string | undefined> {
  const r = await requestJson(`${API}/users/${account.externalId}/tweets?max_results=5`, {
    headers: { authorization: `Bearer ${account.accessToken}` },
  });
  // X appends the media link to the stored text, so compare the prefix.
  return (r.data ?? []).find((t: any) => t.text.startsWith(text.trim()))?.id;
}
