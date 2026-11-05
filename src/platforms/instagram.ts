import { openAsBlob } from "node:fs";
import { config } from "../config.ts";
import { FatalError, requestJson } from "../http.ts";
import { pollUntil, utf16Length, type Publisher } from "./base.ts";
import { graph, metaAuthorizeUrl, metaPages } from "./meta.ts";

// Docs: https://developers.facebook.com/docs/instagram-platform/content-publishing/resumable-uploads
// Requires an Instagram Business/Creator account linked to a Facebook Page.

export const instagram: Publisher = {
  platform: "instagram",
  label: "Instagram Reels",
  minDurationSec: 3,
  maxDurationSec: () => 900,

  validate(post) {
    if (utf16Length(post.caption) > 2200) return "Instagram captions are limited to 2200 characters";
    if ((post.caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).length > 30) return "Instagram allows at most 30 hashtags";
    if ((post.caption.match(/@[\w.]+/g) ?? []).length > 20) return "Instagram allows at most 20 @mentions";
    return null;
  },

  authorizeUrl(state) {
    return metaAuthorizeUrl("instagram", state, [
      "instagram_basic",
      "instagram_content_publish",
      "pages_show_list",
      "pages_read_engagement",
      "business_management",
    ]);
  },

  async exchangeCode(code) {
    const pages = await metaPages("instagram", code, "id,name,access_token,instagram_business_account{id,username}");
    const linked = pages.filter((p) => p.instagram_business_account);
    if (!linked.length) {
      throw new FatalError(
        "none of the granted Facebook Pages has a linked Instagram Business/Creator account. Make the Instagram account Professional (Creator or Business), link it to a Page (Facebook Page → Settings → Linked accounts → Instagram), then reconnect and tick that Page when Facebook asks which Pages to allow.",
      );
    }
    return linked.map((p) => ({
      platform: "instagram" as const,
      externalId: p.instagram_business_account.id,
      name: `@${p.instagram_business_account.username}`,
      accessToken: p.access_token,
      refreshToken: null,
      expiresAt: null,
      refreshExpiresAt: null,
      meta: { username: p.instagram_business_account.username, pageId: p.id },
    }));
  },

  async refresh() {
    return null;
  },

  async publish(ctx) {
    const { account, post, videoPath, videoSize, progress } = ctx;
    const token = account.accessToken;
    const userId = account.externalId;
    const auth = { authorization: `OAuth ${token}` };
    const containerStatus = () =>
      requestJson(`${graph()}/${progress.containerId}?fields=status_code,status,video_status`, { headers: auth });

    if (!progress.containerId) {
      const c = await requestJson(`${graph()}/${userId}/media`, {
        headers: auth,
        form: { media_type: "REELS", upload_type: "resumable", caption: post.caption, share_to_feed: "true" },
      });
      Object.assign(progress, { containerId: c.id, uploadUri: c.uri });
      ctx.save(progress);
    }

    if (!progress.uploaded) {
      // On a retry, continue from the bytes Instagram already holds.
      const offset = progress.uploadStarted
        ? Number((await containerStatus()).video_status?.uploading_phase?.bytes_transferred ?? 0)
        : 0;
      progress.uploadStarted = true;
      ctx.save(progress);
      const file = await openAsBlob(videoPath);
      await requestJson(progress.uploadUri ?? `https://rupload.facebook.com/ig-api-upload/${config.graphVersion}/${progress.containerId}`, {
        headers: { ...auth, offset: String(offset), file_size: String(videoSize) },
        body: file.slice(offset),
      });
      progress.uploaded = true;
      ctx.save(progress);
    }

    if (!progress.mediaId) {
      await pollUntil("Instagram processing", async () => {
        const s = await containerStatus();
        if (s.status_code === "ERROR") throw new FatalError(`Instagram could not process the video: ${s.status}`);
        if (s.status_code === "EXPIRED") {
          ctx.save({}); // containers live 24h; the next attempt starts over
          throw new FatalError("Instagram upload container expired before publishing; retry to upload again");
        }
        const processed = s.video_status?.processing_phase?.status;
        return s.status_code === "FINISHED" || (s.status_code === "PUBLISHED" && processed === "complete") ? true : undefined;
      });

      if (progress.publishRequested) {
        // An earlier attempt may have published, then crashed before saving the media id.
        progress.mediaId = await findRecentMedia(userId, token, post.caption, progress.publishRequestedAt);
      }
      if (!progress.mediaId) {
        progress.publishRequested = true;
        progress.publishRequestedAt = Date.now();
        ctx.save(progress);
        const p = await requestJson(`${graph()}/${userId}/media_publish`, {
          headers: auth,
          form: { creation_id: progress.containerId },
        });
        progress.mediaId = p.id;
      }
      ctx.save(progress);
    }

    const m = await requestJson(`${graph()}/${progress.mediaId}?fields=permalink`, { headers: auth });
    return { url: m.permalink };
  },
};

async function findRecentMedia(userId: string, token: string, caption: string, since = 0): Promise<string | undefined> {
  const r = await requestJson(`${graph()}/${userId}/media?fields=id,caption,timestamp&limit=10`, {
    headers: { authorization: `OAuth ${token}` },
  });
  const match = (r.data ?? []).find(
    (m: any) => (m.caption ?? "") === caption && Date.parse(m.timestamp) >= since - 120_000,
  );
  return match?.id;
}
