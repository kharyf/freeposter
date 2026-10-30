import { config, redirectUri } from "../config.ts";
import { pkceChallenge } from "../crypto.ts";
import { FatalError, request, requestJson } from "../http.ts";
import type { Account } from "../types.ts";
import { expiresIn, firstLine, pollUntil, readChunk, type Publisher } from "./base.ts";

// Docs: https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD = "https://www.googleapis.com/upload/youtube/v3/videos";
const TOKEN = "https://oauth2.googleapis.com/token";
const SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"];
const CHUNK = 8 * 1024 * 1024; // must be a multiple of 256 KiB

const creds = () => config.credentials.youtube;

export const youtube: Publisher = {
  platform: "youtube",
  label: "YouTube Shorts",
  minDurationSec: 1,
  maxDurationSec: () => 180, // Shorts limit; longer vertical videos post as regular videos

  validate(post) {
    if (!(post.title || firstLine(post.caption, 100))) return "YouTube needs a title (or a caption to take one from)";
    if (post.caption.length > 5000) return "YouTube descriptions are limited to 5000 characters";
    if (/[<>]/.test(post.title)) return "YouTube titles cannot contain < or >";
    return null;
  },

  authorizeUrl(state, verifier) {
    const q = new URLSearchParams({
      client_id: creds().id,
      redirect_uri: redirectUri("youtube"),
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent", // guarantees a refresh_token on reconnect
      include_granted_scopes: "true",
      state,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  },

  async exchangeCode(code, verifier) {
    const t = await requestJson(TOKEN, {
      form: {
        code,
        client_id: creds().id,
        client_secret: creds().secret,
        redirect_uri: redirectUri("youtube"),
        grant_type: "authorization_code",
        code_verifier: verifier,
      },
    });
    if (!t.refresh_token) throw new FatalError("Google returned no refresh token; remove the app's access at myaccount.google.com/permissions and reconnect");
    const ch = await requestJson(`${API}/channels?part=snippet&mine=true`, {
      headers: { authorization: `Bearer ${t.access_token}` },
    });
    const channel = ch.items?.[0];
    if (!channel) throw new FatalError("this Google account has no YouTube channel");
    return [
      {
        platform: "youtube",
        externalId: channel.id,
        name: channel.snippet.title,
        accessToken: t.access_token,
        refreshToken: t.refresh_token,
        expiresAt: expiresIn(t.expires_in),
        refreshExpiresAt: null,
        meta: {},
      },
    ];
  },

  async refresh(account: Account) {
    if (!account.refreshToken) return null;
    const t = await requestJson(TOKEN, {
      form: {
        client_id: creds().id,
        client_secret: creds().secret,
        refresh_token: account.refreshToken,
        grant_type: "refresh_token",
      },
    });
    return {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? account.refreshToken,
      expiresAt: expiresIn(t.expires_in),
      refreshExpiresAt: null,
    };
  },

  async publish(ctx) {
    const { account, post, videoPath, videoSize, progress } = ctx;
    const auth = { authorization: `Bearer ${account.accessToken}` };

    if (!progress.videoId) {
      let offset = 0;
      if (progress.uploadUrl) {
        // Resume: ask the session how many bytes it already has.
        const res = await request(progress.uploadUrl, {
          method: "PUT",
          headers: { ...auth, "content-range": `bytes */${videoSize}` },
          okStatuses: [308, 404, 410],
        });
        if (res.status === 404 || res.status === 410) {
          ctx.log("upload session expired; starting a new one");
          delete progress.uploadUrl;
        } else if (res.status === 308) {
          offset = rangeEnd(res.headers.get("range"));
        } else {
          progress.videoId = (await res.json()).id;
          ctx.save(progress);
        }
      }
      if (!progress.uploadUrl && !progress.videoId) {
        const res = await request(`${UPLOAD}?uploadType=resumable&part=snippet,status`, {
          headers: { ...auth, "x-upload-content-length": String(videoSize), "x-upload-content-type": "video/mp4" },
          json: {
            snippet: {
              title: (post.title || firstLine(post.caption, 100)).slice(0, 100),
              description: post.caption,
              categoryId: "22",
            },
            status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
          },
        });
        progress.uploadUrl = res.headers.get("location");
        if (!progress.uploadUrl) throw new FatalError("YouTube did not return an upload session URL");
        ctx.save(progress);
      }
      while (!progress.videoId) {
        const chunk = await readChunk(videoPath, offset, CHUNK);
        const end = offset + chunk.length - 1;
        const res = await request(progress.uploadUrl, {
          method: "PUT",
          headers: { ...auth, "content-type": "video/mp4", "content-range": `bytes ${offset}-${end}/${videoSize}` },
          body: chunk,
          okStatuses: [308],
        });
        if (res.status === 308) {
          offset = rangeEnd(res.headers.get("range"));
          ctx.log(`uploaded ${Math.round((offset / videoSize) * 100)}%`);
        } else {
          progress.videoId = (await res.json()).id;
          ctx.save(progress);
        }
      }
    }

    const video = await pollUntil("YouTube processing", async () => {
      const r = await requestJson(`${API}/videos?part=status,processingDetails&id=${progress.videoId}`, { headers: auth });
      const v = r.items?.[0];
      if (!v) throw new FatalError(`YouTube video ${progress.videoId} not found (deleted?)`);
      const s = v.status.uploadStatus;
      if (s === "failed") throw new FatalError(`YouTube processing failed: ${v.status.failureReason}`);
      if (s === "rejected") throw new FatalError(`YouTube rejected the video: ${v.status.rejectionReason}`);
      if (s === "deleted") throw new FatalError("the video was deleted on YouTube");
      return s === "processed" ? v : undefined;
    }, { intervalMs: 10_000 });

    const url = `https://www.youtube.com/shorts/${progress.videoId}`;
    if (video.status.privacyStatus !== "public") {
      return { url, note: `YouTube set the video to ${video.status.privacyStatus}. Unaudited API projects are locked to private.` };
    }
    return { url };
  },
};

/** "bytes=0-1234" → next offset 1235; missing header means nothing received yet. */
function rangeEnd(range: string | null): number {
  const m = range?.match(/bytes=0-(\d+)/);
  return m ? Number(m[1]) + 1 : 0;
}
