// Runs queued edits one at a time, beside the job runner: transcribe (cached per source file), then render.
// Edits are slow (minutes); they never hold up posting, and a quit or crash just starts the edit over.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../config.ts";
import type { Store } from "../db.ts";
import { probe } from "../media.ts";
import type { Edit } from "../types.ts";
import { renderEdit } from "./render.ts";
import { transcribe as whisper, type Transcript } from "./transcribe.ts";

export interface EditWorkerOptions {
  /** where edited files and transcripts go (data/edits) */
  dir?: string;
  transcribe?: (path: string) => Promise<Transcript>;
}

const log = (edit: Edit, msg: string) => console.log(`[edit ${edit.id}] ${msg}`);

export class EditWorker {
  store: Store;
  dir: string;
  transcribe: (path: string) => Promise<Transcript>;
  timer: NodeJS.Timeout | undefined;
  running: Promise<void> | undefined;

  constructor(store: Store, opts: EditWorkerOptions = {}) {
    this.store = store;
    this.dir = opts.dir ?? join(dataDir, "edits");
    this.transcribe = opts.transcribe ?? ((path) => whisper(path));
    store.requeueInterruptedEdits();
  }

  start(intervalMs = 2_000) {
    const tick = () => {
      void this.tick();
      this.timer = setTimeout(tick, intervalMs);
    };
    tick();
  }

  stop() {
    clearTimeout(this.timer);
  }

  /** Starts the next queued edit unless one is already running. */
  tick(): Promise<void> | undefined {
    if (this.running) return this.running;
    const edit = this.store.claimNextEdit();
    if (!edit) return undefined;
    this.running = this.process(edit).finally(() => (this.running = undefined));
    return this.running;
  }

  /** The words of a source file, transcribed once and kept beside the edits. */
  async transcriptFor(edit: Pick<Edit, "sourcePath" | "sha256">): Promise<Transcript> {
    const path = join(this.dir, `${edit.sha256}.words.json`);
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
    const transcript = await this.transcribe(edit.sourcePath);
    writeFileSync(path, JSON.stringify(transcript));
    return transcript;
  }

  async process(edit: Edit) {
    try {
      log(edit, "transcribing");
      const transcript = await this.transcriptFor(edit);
      this.store.updateEdit(edit.id, { state: "editing", transcriptPath: join(this.dir, `${edit.sha256}.words.json`) });
      const out = join(this.dir, `${edit.key}.mp4`);
      let durationSec: number;
      if (existsSync(out)) {
        durationSec = (await probe(out)).durationSec;
      } else {
        log(edit, "editing");
        let last = 0;
        ({ durationSec } = await renderEdit(edit.sourcePath, transcript, edit.settings, out, (f) => {
          if (f - last >= 0.02) { last = f; this.store.updateEdit(edit.id, { progress: f }); }
        }));
      }
      this.store.updateEdit(edit.id, { state: "ready", progress: 1, outputPath: out, durationSec, error: null });
      log(edit, `ready (${durationSec.toFixed(1)}s)`);
    } catch (err) {
      log(edit, `failed: ${(err as Error).message}`);
      this.store.updateEdit(edit.id, { state: "failed", error: (err as Error).message });
    }
  }
}
