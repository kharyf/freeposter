// A talking-head take run through the existing edit pipeline (cuts, captions, reframing, sound), as a shot.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { renderEdit } from "../../edit/render.ts";
import type { Transcript } from "../../edit/transcribe.ts";
import type { EditShot } from "../spec.ts";
import { Fatal } from "./errors.ts";
import type { RenderContext, ShotAdapter } from "./index.ts";

export function editAdapter(speechFor: (src: { sourcePath: string; sha256: string }) => Promise<Transcript>): ShotAdapter<EditShot> {
  return {
    kind: "edit",
    lane: "cpu",
    version: 1,
    async health() {
      return { ok: true, detail: "uses FreePoster's edit pipeline" };
    },
    async render(shot: EditShot, ctx: RenderContext) {
      const hash = createHash("sha256");
      await pipeline(createReadStream(shot.path), hash);
      const sha256 = hash.digest("hex");
      try {
        const transcript = await speechFor({ sourcePath: shot.path, sha256 });
        if (ctx.signal.aborted) throw new Error("cancelled");
        return await renderEdit(shot.path, transcript, shot.settings, join(ctx.dir, "shot.mp4"), (f) => ctx.onProgress(f));
      } catch (err) {
        if ((err as Error).message === "cancelled") throw err;
        throw new Fatal(`${shot.id}: the edit failed: ${(err as Error).message}`);
      }
    },
  };
}
