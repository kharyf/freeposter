import { config, redirectUri } from "../config.ts";
import { FatalError, RetryableError, request, requestJson } from "../http.ts";
import type { Account, TokenSet } from "../types.ts";
import { expiresIn, pollUntil, readChunk, utf16Length, type Publisher } from "./base.ts";

// Docs: https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
const API = "https://open.tiktokapis.com/v2";
const MB = 1024 * 1024;
const creds = () => config.credentials.tiktok;

export interface CreatorInfo {
  creator_avatar_url: string;
  creator_username: string;
  creator_nickname: string;
  privacy_level_options: string[];
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_video_post_duration_sec: number;
}

/**
 * TikTok chunk rules: files under 5 MB go in one chunk; otherwise every chunk is 5–64 MB except the
 * last, which absorbs the remainder (up to 128 MB). total_chunk_count = floor(size / chunk_size).
 */
export function chunkPlan(size: number, preferred = 10 * MB) {
  if (size < 5 * MB) return { chunkSize: size, count: 1 };
  const chunkSize = Math.min(Math.max(preferred, 5 * MB), 64 * MB, size);
  return { chunkSize, count: Math.max(1, Math.floor(size / chunkSize)) };
}

export function chunkRange(size: number, plan: { chunkSize: number; count: number }, index: number) {
  const start = index * plan.chunkSize;
  const end = index === plan.count - 1 ? size - 1 : start + plan.chunkSize - 1;
  return { start, end };
}

/** TikTok wraps every response in { data, error: { code, message } }; code "ok" means success. */
async function tiktok(path: string, token: string, json: unknown = {}) {
  const r = await requestJson(`${API}${path}`, { headers: { authorization: `Bearer ${token}` }, json });
  const code = r.error?.code;
  if (code && code !== "ok") {
    const msg = `TikTok ${code}: ${r.error.message}`;
    if (code === "rate_limit_exceeded" || code === "spam_risk_too_many_pending_share") throw new RetryableError(msg, 10 * 60_000);
    if (code === "spam_risk_too_many_posts") throw new RetryableError(`${msg} (daily post cap reached)`, 6 * 3_600_000);
    throw new FatalError(msg);
  }
  return r.data;
}

export async function creatorInfo(account: Account): Promise<CreatorInfo> {
  return tiktok("/post/publish/creator_info/query/", account.accessToken);
}

function toTokens(t: any): TokenSet {
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: expiresIn(t.expires_in),
    refreshExpiresAt: expiresIn(t.refresh_expires_in),
  };
}

export const tiktokPublisher: Publisher = {
  platform: "tiktok",
  label: "TikTok",
  minDurationSec: 3,
  maxDurationSec: (account) => Number(account.meta.maxDurationSec ?? 600),

  validate(post) {
    if (!post.tiktok?.privacyLevel) return "choose a TikTok privacy level (TikTok requires an explicit choice)";
    if (post.tiktok.brandContent && post.tiktok.privacyLevel === "SELF_ONLY") {
      return "branded content cannot be posted with 'Only me' visibility";
    }
    if (utf16Length(post.caption) > 2200) return "TikTok captions are limited to 2200 characters";
    return null;
  },

  authorizeUrl(state) {
    const q = new URLSearchParams({
      client_key: creds().id,
      scope: "user.info.basic,video.publish",
      response_type: "code",
      redirect_uri: redirectUri("tiktok"),
      state,
    });
    return `https://www.tiktok.com/v2/auth/authorize/?${q}`;
  },

  async exchangeCode(code) {
    const t = await requestJson(`${API}/oauth/token/`, {
      form: {
        client_key: creds().id,
        client_secret: creds().secret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri("tiktok"),
      },
    });
    if (t.error && t.error !== "ok") throw new FatalError(`TikTok token exchange: ${t.error} ${t.error_description ?? ""}`);
    if (!String(t.scope ?? "").includes("video.publish")) throw new FatalError("the video.publish permission was not granted");
    const tokens = toTokens(t);
    const info = await creatorInfo({ accessToken: tokens.accessToken } as Account);
    return [
      {
        platform: "tiktok",
        externalId: t.open_id,
        name: `@${info.creator_username}`,
        ...tokens,
        meta: { username: info.creator_username, maxDurationSec: info.max_video_post_duration_sec },
      },
    ];
  },

  async refresh(account) {
    if (!account.refreshToken) return null;
    const t = await requestJson(`${API}/oauth/token/`, {
      form: {
        client_key: creds().id,
        client_secret: creds().secret,
        grant_type: "refresh_token",
        refresh_token: account.refreshToken,
      },
    });
    if (t.error && t.error !== "ok") throw new FatalError(`TikTok refresh: ${t.error} ${t.error_description ?? ""}`);
    return toTokens(t);
  },

  async publish(ctx) {
    const { account, post, videoPath, videoSize, durationSec, progress } = ctx;
    const opts = post.tiktok!;

    if (!progress.publishId) {
      // TikTok requires a fresh creator_info check right before every post.
      const info = await creatorInfo(account);
      if (!info.privacy_level_options.includes(opts.privacyLevel)) {
        throw new FatalError(`privacy "${opts.privacyLevel}" is not allowed for this account (allowed: ${info.privacy_level_options.join(", ")})`);
      }
      if (durationSec > info.max_video_post_duration_sec) {
        throw new FatalError(`this account can post up to ${info.max_video_post_duration_sec}s; the video is ${Math.ceil(durationSec)}s`);
      }
      const plan = chunkPlan(videoSize);
      const data = await tiktok("/post/publish/video/init/", account.accessToken, {
        post_info: {
          title: post.caption,
          privacy_level: opts.privacyLevel,
          disable_comment: opts.disableComment || info.comment_disabled,
          disable_duet: opts.disableDuet || info.duet_disabled,
          disable_stitch: opts.disableStitch || info.stitch_disabled,
          video_cover_timestamp_ms: 1000,
          brand_content_toggle: opts.brandContent,
          brand_organic_toggle: opts.brandOrganic,
        },
        source_info: {
          source: "FILE_UPLOAD",
          video_size: videoSize,
          chunk_size: plan.chunkSize,
          total_chunk_count: plan.count,
        },
      });
      Object.assign(progress, { publishId: data.publish_id, uploadUrl: data.upload_url, plan, nextChunk: 0 });
      ctx.save(progress);
    }

    if (progress.nextChunk < progress.plan.count) {
      try {
        for (let i = progress.nextChunk; i < progress.plan.count; i++) {
          const { start, end } = chunkRange(videoSize, progress.plan, i);
          await request(progress.uploadUrl, {
            method: "PUT",
            headers: { "content-type": "video/mp4", "content-range": `bytes ${start}-${end}/${videoSize}` },
            body: await readChunk(videoPath, start, end - start + 1),
          });
          progress.nextChunk = i + 1;
          ctx.save(progress);
          ctx.log(`uploaded chunk ${i + 1}/${progress.plan.count}`);
        }
      } catch (err) {
        if (err instanceof FatalError) {
          // Upload URLs expire after an hour. Nothing is posted until the upload completes,
          // so starting a fresh publish_id cannot create a duplicate.
          ctx.save({});
          throw new RetryableError(`TikTok upload failed, restarting upload: ${err.message}`);
        }
        throw err;
      }
    }

    const done = await pollUntil("TikTok processing", async () => {
      const s = await tiktok("/post/publish/status/fetch/", account.accessToken, { publish_id: progress.publishId });
      if (s.status === "FAILED") throw new FatalError(`TikTok rejected the post: ${s.fail_reason}`);
      return s.status === "PUBLISH_COMPLETE" ? s : undefined;
    });

    const username = account.meta.username as string;
    // The field name really is misspelled in TikTok's API.
    const postId = done.publicaly_available_post_id?.[0];
    if (postId) return { url: `https://www.tiktok.com/@${username}/video/${postId}` };
    return {
      url: `https://www.tiktok.com/@${username}`,
      note:
        opts.privacyLevel === "SELF_ONLY"
          ? "Posted as 'Only me', so TikTok gives no public link."
          : "Published; TikTok has not exposed the public post ID yet (it is usually still in moderation).",
    };
  },
};
