import { openAsBlob } from "node:fs";
import { config } from "../config.ts";
import { FatalError, requestJson } from "../http.ts";
import { pollUntil, type Publisher } from "./base.ts";
import { graph, metaAuthorizeUrl, metaPages } from "./meta.ts";

// Docs: https://developers.facebook.com/docs/video-api/guides/reels-publishing
// Facebook only allows API publishing to Pages; personal profiles are not reachable.

/** how long a just-finished reel may be reported as nonexistent before we believe it */
const NOT_FOUND_GRACE_MS = 5 * 60_000;

export const facebook: Publisher = {
  platform: "facebook",
  label: "Facebook Page Reels",
  minDurationSec: 3,
  maxDurationSec: () => 90,

  validate() {
    return null;
  },

  authorizeUrl(state) {
    return metaAuthorizeUrl("facebook", state, ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "business_management"]);
  },

  async exchangeCode(code) {
    const pages = await metaPages("facebook", code, "id,name,access_token,tasks");
    const usable = pages.filter((p) => !p.tasks || p.tasks.includes("CREATE_CONTENT"));
    if (!usable.length) throw new FatalError("no Facebook Pages you can post to were shared with the app (personal profiles can't be posted to via the API)");
    return usable.map((p) => ({
      platform: "facebook" as const,
      externalId: p.id,
      name: p.name,
      accessToken: p.access_token,
      refreshToken: null,
      expiresAt: null,
      refreshExpiresAt: null,
      meta: {},
    }));
  },

  async refresh() {
    return null;
  },

  async publish(ctx) {
    const { account, post, videoPath, videoSize, progress } = ctx;
    const token = account.accessToken;
    const pageId = account.externalId;

    if (!progress.videoId) {
      const s = await requestJson(`${graph()}/${pageId}/video_reels`, {
        form: { upload_phase: "start", access_token: token },
      });
      Object.assign(progress, { videoId: s.video_id, uploadUrl: s.upload_url });
      ctx.save(progress);
    }

    if (!progress.uploaded) {
      await requestJson(progress.uploadUrl ?? `https://rupload.facebook.com/video-upload/${config.graphVersion}/${progress.videoId}`, {
        headers: { authorization: `OAuth ${token}`, offset: "0", file_size: String(videoSize) },
        body: await openAsBlob(videoPath),
      });
      progress.uploaded = true;
      ctx.save(progress);
    }

    const status = async () =>
      requestJson(`${graph()}/${progress.videoId}?fields=status,permalink_url&access_token=${token}`);

    if (!progress.finished) {
      // If an earlier attempt sent "finish" and crashed, publishing will already have started.
      const before = progress.finishRequested ? await status() : null;
      const phase = before?.status?.publishing_phase?.status;
      if (!phase || phase === "not_started") {
        progress.finishRequested = true;
        ctx.save(progress);
        await requestJson(`${graph()}/${pageId}/video_reels`, {
          form: {
            upload_phase: "finish",
            video_id: progress.videoId,
            video_state: "PUBLISHED",
            description: post.caption,
            access_token: token,
          },
        });
      }
      progress.finished = true;
      ctx.save(progress);
    }

    const v = await pollUntil("Facebook processing", async () => {
      let r;
      try {
        r = await status();
      } catch (err) {
        // For a short while after "finish", Graph can report the new reel as nonexistent (code 100,
        // subcode 33) even though it is publishing. Keep polling; give up only if it stays missing.
        if (!(err instanceof FatalError && err.graph?.code === 100 && err.graph.error_subcode === 33)) throw err;
        progress.notFoundSince ??= Date.now();
        ctx.save(progress);
        if (Date.now() - progress.notFoundSince > NOT_FOUND_GRACE_MS) throw err;
        return undefined;
      }
      const st = r.status ?? {};
      for (const phase of ["uploading_phase", "processing_phase", "publishing_phase"]) {
        if (st[phase]?.status === "error") {
          throw new FatalError(`Facebook ${phase.replace("_", " ")} failed: ${JSON.stringify(st[phase].errors ?? st[phase])}`);
        }
      }
      if (st.video_status === "error") throw new FatalError("Facebook could not process the video");
      return st.publishing_phase?.status === "complete" ? r : undefined;
    }, { intervalMs: 10_000 });

    const link: string = v.permalink_url ?? `/reel/${progress.videoId}`;
    return { url: link.startsWith("http") ? link : `https://www.facebook.com${link}` };
  },
};
