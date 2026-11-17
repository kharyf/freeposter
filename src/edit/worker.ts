// Runs queued edits one at a time, beside the job runner: transcribe (cached per source file), then render.
// Edits are slow (minutes); they never hold up posting, and a quit or crash just starts the edit over.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../config.ts";
import type { Store } from "../db.ts";
import { probe } from "../media.ts";
import type { Edit } from "../types.ts";
import { queueEvent } from "../notify.ts";
import type { Question } from "../ai/providers.ts";
import { adapters as productionAdapters, type Adapters } from "../produce/adapters/index.ts";
import { fixWords, remapWords, type Segment } from "./cuts.ts";
import { cadenceProblems, planBeats } from "./fancy/beats.ts";
import { makeCover } from "./fancy/cover.ts";
import { pruneGraphicsCache, renderGraphics } from "./fancy/graphics.ts";
import { cachedPlan, planGraphics, PLAN_VERSION } from "./fancy/plan.ts";
import { renderFancy } from "./fancy/render.ts";
import { fancyTemplates } from "./fancy/templates.ts";
import { planFaceTrack, type FaceKey } from "./reframe.ts";
import { planSegments, renderEdit } from "./render.ts";
import { isFancy } from "./settings.ts";
import { findLyricsWithAi, spokenWords, type FindLyrics } from "./speech.ts";
import { transcribe as whisper, type Transcript } from "./transcribe.ts";

export interface EditWorkerOptions {
  /** where edited files and transcripts go (data/edits) */
  dir?: string;
  transcribe?: (path: string) => Promise<Transcript>;
  /** tells song lyrics from talking (default: asks the AI providers) */
  findLyrics?: FindLyrics;
  /** replaces the AI, the graphics tools and the face tracker (tests) */
  fancy?: {
    ask?: <T>(q: Question) => Promise<T>;
    adapters?: Pick<Adapters, "remotion" | "hyperframes" | "blender">;
    faceTrack?: typeof planFaceTrack;
  };
}

const shortHash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 8);
/** Changes when a template is added, removed or its schema changes: cached plans were made against the old catalogue. */
const catalogueHash = () => shortHash(Object.values(fancyTemplates()).map(({ dir, ...t }) => t));

const log = (edit: Edit, msg: string) => console.log(`[edit ${edit.id}] ${msg}`);

/** A Fancy edit at least this long should have at least MIN_SPLITS split screens; fewer gets a note on the review card. */
const SPLITS_FROM_SEC = 8;
const MIN_SPLITS = 3;

export class EditWorker {
  store: Store;
  dir: string;
  transcribe: (path: string) => Promise<Transcript>;
  findLyrics: FindLyrics;
  fancy: NonNullable<EditWorkerOptions["fancy"]>;
  /** cancels a running Fancy edit's graphics and render when the worker stops */
  cancel = new AbortController();
  timer: NodeJS.Timeout | undefined;
  running: Promise<void> | undefined;
  /** when cached Fancy graphics were last pruned */
  lastCleanup = 0;

  constructor(store: Store, opts: EditWorkerOptions = {}) {
    this.store = store;
    this.dir = opts.dir ?? join(dataDir, "edits");
    this.transcribe = opts.transcribe ?? ((path) => whisper(path));
    this.findLyrics = opts.findLyrics ?? findLyricsWithAi;
    this.fancy = opts.fancy ?? {};
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
    this.cancel.abort();
  }

  /** Starts the next queued edit unless one is already running. */
  tick(): Promise<void> | undefined {
    if (this.running) return this.running;
    // Between edits, so no graphic is rendering into the cache.
    if (Date.now() - this.lastCleanup > 3_600_000) this.cleanup();
    const edit = this.store.claimNextEdit();
    if (!edit) return undefined;
    this.running = this.process(edit).finally(() => (this.running = undefined));
    return this.running;
  }

  /** Everything Whisper heard in a source file, transcribed once and kept beside the edits. */
  async transcriptFor(edit: Pick<Edit, "sourcePath" | "sha256">): Promise<Transcript> {
    const path = join(this.dir, `${edit.sha256}.words.json`);
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
    const transcript = await this.transcribe(edit.sourcePath);
    writeFileSync(path, JSON.stringify(transcript));
    return transcript;
  }

  /**
   * Only the words people in the video say: no "(upbeat music)" tags, no song lyrics. Kept beside the
   * transcript once the lyrics check has run, so it's asked once per source file.
   */
  async speechFor(edit: Pick<Edit, "sourcePath" | "sha256">): Promise<Transcript> {
    const path = join(this.dir, `${edit.sha256}.spoken.json`);
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
    const heard = await this.transcriptFor(edit);
    const { words, lyricsChecked } = await spokenWords(heard.words, this.findLyrics);
    const speech = { ...heard, words };
    if (lyricsChecked) writeFileSync(path, JSON.stringify(speech));
    return speech;
  }

  /** Deletes cached Fancy graphics not used for a while (pruneGraphicsCache). */
  cleanup() {
    this.lastCleanup = Date.now();
    pruneGraphicsCache(join(this.dir, "fancy-graphics"));
  }

  async process(edit: Edit) {
    try {
      log(edit, "transcribing");
      const transcript = await this.speechFor(edit);
      this.store.updateEdit(edit.id, { state: "editing", transcriptPath: join(this.dir, `${edit.sha256}.words.json`) });
      if (isFancy(edit.settings)) return await this.processFancy(edit, transcript);
      const out = join(this.dir, `${edit.key}.mp4`);
      // The kept source stretches: a redo note's "0:14" in the edit maps back to the source through these.
      const cuts = join(this.dir, `${edit.key}.cuts.json`);
      let durationSec: number;
      if (existsSync(out)) {
        durationSec = (await probe(out)).durationSec;
        if (!existsSync(cuts)) writeFileSync(cuts, JSON.stringify(planSegments(transcript, edit.settings, (await probe(edit.sourcePath)).durationSec)));
      } else {
        log(edit, "editing");
        let last = 0;
        let segments;
        ({ durationSec, segments } = await renderEdit(edit.sourcePath, transcript, edit.settings, out, (f) => {
          if (f - last >= 0.02) { last = f; this.store.updateEdit(edit.id, { progress: f }); }
        }));
        writeFileSync(cuts, JSON.stringify(segments));
      }
      this.store.updateEdit(edit.id, { state: "ready", progress: 1, outputPath: out, durationSec, error: null, cutsPath: cuts });
      this.announceReady(edit, durationSec);
    } catch (err) {
      this.fail(edit, err);
    }
  }

  private announceReady(edit: Edit, durationSec: number) {
    log(edit, `ready (${durationSec.toFixed(1)}s)`);
    // A Drive video's edit goes to review by itself (Drive intake asks for it); an agent asking too would only replace that card.
    const drive = this.store.driveFileForEdit(edit.id);
    queueEvent(this.store, "edit.ready", `edit.ready:${edit.id}`, { edit_id: edit.id, duration_sec: durationSec, parent_edit_id: edit.parentEditId, drive_file: drive?.name ?? null },
      drive
        ? `Edit ${edit.id} of the Drive video "${drive.name}" is ready (${durationSec.toFixed(1)} s). FreePoster sends it to the user for review itself; don't call request_review.`
        : `Edit ${edit.id} is ready (${durationSec.toFixed(1)} s). Call request_review with it so the user can approve, reject or redo it.`);
  }

  private fail(edit: Edit, err: unknown) {
    // A quit stopped the edit: leave it as it is, so the next start requeues it.
    if (this.cancel.signal.aborted) return log(edit, "stopped");
    log(edit, `failed: ${(err as Error).message}`);
    this.store.updateEdit(edit.id, { state: "failed", error: (err as Error).message });
    queueEvent(this.store, "edit.failed", `edit.failed:${edit.id}:${Date.now()}`, { edit_id: edit.id, error: (err as Error).message },
      `Edit ${edit.id} failed: ${(err as Error).message}`);
  }

  /**
   * The Fancy look: plan (AI, cached) -> graphics (cached, never failing) -> face track -> beats -> composite -> cover.
   * Only the compositor failing fails the edit. Progress: 0-0.1 plan, 0.1-0.6 graphics, 0.6-1 composite.
   */
  private async processFancy(edit: Edit, transcript: Transcript) {
    const s = edit.settings;
    const signal = this.cancel.signal;
    let last = 0;
    const progress = (f: number) => {
      if (f - last >= 0.02) { last = f; this.store.updateEdit(edit.id, { progress: f }); }
    };

    const src = await probe(edit.sourcePath);
    const sourceSec = src.durationSec;
    const segments: Segment[] = planSegments(transcript, s, sourceSec);
    const editedSec = segments.reduce((t, g) => t + g.end - g.start, 0);
    const words = remapWords(fixWords(transcript.words, s.captionFixes), segments);
    const cuts = join(this.dir, `${edit.key}.cuts.json`);
    writeFileSync(cuts, JSON.stringify(segments));

    log(edit, "planning graphics");
    const planPath = join(this.dir, `${edit.sha256}-${shortHash([segments, words])}-${catalogueHash()}-v${PLAN_VERSION}.fancy-plan.json`);
    const plan = await cachedPlan(planPath, () => planGraphics(words, editedSec, { ask: this.fancy.ask }));
    progress(0.1);

    log(edit, "rendering graphics");
    const tools = this.fancy.adapters ?? productionAdapters({ speechFor: (src) => this.speechFor(src) });
    const graphicsDir = join(this.dir, "fancy-graphics");
    mkdirSync(graphicsDir, { recursive: true });
    const graphics = await renderGraphics(plan.graphics, { dir: graphicsDir, adapters: tools, signal, onProgress: (f) => progress(0.1 + 0.5 * f) });
    progress(0.6);
    const notes = [...(words.length ? [] : ["no speech heard: no graphics or captions"]), ...plan.notes, ...graphics.notes];

    let faces: FaceKey[] | null = null;
    if (s.reframe) {
      const track = this.fancy.faceTrack ?? planFaceTrack;
      faces = await track(edit.sourcePath, src).catch((err) => {
        console.error(`face tracking skipped: ${(err as Error).message}`);
        return null;
      });
    }

    const cutTimes: number[] = [];
    let at = 0;
    for (const g of segments.slice(0, -1)) cutTimes.push((at += g.end - g.start));
    const beats = planBeats({ durationSec: editedSec, words, graphics: plan.graphics, emphasis: plan.emphasis, cutTimes, punchIn: s.punchIn });
    for (const problem of cadenceProblems(beats, cutTimes)) log(edit, `cadence: ${problem}`);

    // The splits the speech made room for (a graphic that couldn't be made has its own note).
    const splits = new Set(beats.filter((b) => b.layout !== "full" && b.graphic !== null).map((b) => b.graphic)).size;
    if (words.length && editedSec >= SPLITS_FROM_SEC && splits < MIN_SPLITS) {
      notes.push(`only ${splits} split screen${splits === 1 ? "" : "s"}: too little speech for more graphics`);
    }

    log(edit, "editing");
    const out = join(this.dir, `${edit.key}.mp4`);
    const { durationSec } = await renderFancy(edit.sourcePath, {
      segments, beats, clips: graphics.clips, faces, captionWords: s.captions ? words : null, settings: s, outPath: out, signal,
      onProgress: (f) => progress(0.6 + 0.4 * f),
    });

    let cover: Edit["cover"] = null;
    try {
      const path = await makeCover(edit.sourcePath, { at: plan.cover.at, segments, faces, title: plan.cover.title, out: join(this.dir, `${edit.key}.cover.jpg`) });
      cover = { path, atSec: plan.cover.at };
    } catch (err) {
      log(edit, `no cover: ${(err as Error).message}`);
      notes.push("the cover couldn't be made");
    }
    this.store.updateEdit(edit.id, { state: "ready", progress: 1, outputPath: out, durationSec, error: null, cutsPath: cuts, notes, cover });
    this.announceReady(edit, durationSec);
  }
}
