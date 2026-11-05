// Writes the caption of every post made on the web page or through MCP with a blank one, the same way Drive videos
// are captioned (see captionVideo): from the speech, else the frames, else #fyp. The post's jobs wait until it's in
// (Store.claimNextJob); nothing waits for the user. Pending posts are kept in the database, so a restart carries on.
import { captionVideo, transcriptText, type CaptionDeps } from "./caption.ts";
import type { Store } from "./db.ts";
import type { Transcript } from "./edit/transcribe.ts";
import type { Account, Post } from "./types.ts";

export interface CaptionerDeps extends CaptionDeps {
  /** shared with edits, so each video is transcribed once */
  transcribe: (sourcePath: string, sha256: string) => Promise<Transcript>;
}

export class Captioner {
  store: Store;
  deps: CaptionerDeps;
  /** posts being captioned in this process */
  busy = new Set<number>();
  timer: NodeJS.Timeout | undefined;

  constructor(store: Store, deps: CaptionerDeps) {
    this.store = store;
    this.deps = deps;
  }

  start(intervalMs = 3_000) {
    const tick = () => {
      void this.tick().catch((err) => console.error(`captioner: ${(err as Error).message}`));
      this.timer = setTimeout(tick, intervalMs);
    };
    tick();
  }

  stop() {
    clearTimeout(this.timer);
  }

  /** Starts a caption for each waiting post not already being captioned; resolves when those are done. */
  async tick() {
    await Promise.all(this.store.postsAwaitingCaption().filter((p) => !this.busy.has(p.id)).map((p) => this.caption(p)));
  }

  private async caption(post: Post) {
    this.busy.add(post.id);
    const log = (m: string) => console.log(`[post ${post.id}] ${m}`);
    try {
      // A failed transcription leaves the frames to go on.
      const transcript = await this.deps.transcribe(post.sourcePath, post.sha256).catch((err) => {
        log(`transcription failed, captioning from frames: ${(err as Error).message}`);
        return { words: [], language: null } as Transcript;
      });
      const accounts = this.store.jobsForPost(post.id).map((j) => this.store.account(j.accountId)).filter((a): a is Account => Boolean(a));
      const text = await captionVideo({ topic: post.captionTopic!, transcript: transcriptText(transcript), sourcePath: post.sourcePath, accounts }, this.deps, log);
      if (!this.store.fillCaption(post.id, text.caption, text.title)) log("the post was given a caption or cancelled meanwhile; this one isn't used");
    } finally {
      this.busy.delete(post.id);
    }
  }
}
