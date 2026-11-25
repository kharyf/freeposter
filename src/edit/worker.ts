// Runs queued edits one at a time, beside the job runner: transcribe (cached per source file), then render.
// Edits are slow (minutes); they never hold up posting, and a quit or crash just starts the edit over.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { campaignTaskFor } from "../campaigns/store.ts";
import { dataDir } from "../config.ts";
import type { Store } from "../db.ts";
import { probe } from "../media.ts";
import type { Edit } from "../types.ts";
import { queueEvent } from "../notify.ts";
import type { Question } from "../ai/providers.ts";
import { adapters as productionAdapters, type Adapters } from "../produce/adapters/index.ts";
import { fixWords, remapWords, sourceTime, type Segment } from "./cuts.ts";
import { cadenceProblems, planBeats } from "./fancy/beats.ts";
import { makeCover } from "./fancy/cover.ts";
import { pruneGraphicsCache, renderGraphics } from "./fancy/graphics.ts";
import { cachedPlan, planGraphics, PLAN_VERSION } from "./fancy/plan.ts";
import { renderFancy } from "./fancy/render.ts";
import { fancyTemplates } from "./fancy/templates.ts";
import { planFaceTrack, type FaceKey } from "./reframe.ts";
import { planSegments, renderEdit } from "./render.ts";
import { applyExtras, extrasOf, hasMediaExtras } from "./extras.ts";
import { isFancy, isSlideshow } from "./settings.ts";
import { isManifestSource } from "./create.ts";
import { buildAss } from "./captions.ts";
import { cachedSlideshowPlan, DEFAULT_SLIDE, MAX_SLIDES, planSlideshow, SLIDESHOW_PLAN_VERSION, type SlideAsset } from "./slideshow/plan.ts";
import { extractStill, renderSlideshow, renderSpeechTrack, type RenderSlide } from "./slideshow/render.ts";
import { sniffKind } from "../resources/store.ts";
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
  /** replaces the AI that plans a Slideshow (tests) */
  slideshow?: { ask?: <T>(q: Question) => Promise<T> };
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
  slideshow: NonNullable<EditWorkerOptions["slideshow"]>;
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
    this.slideshow = opts.slideshow ?? {};
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
      // A slideshow may have no video to hear, so it does its own listening.
      if (isSlideshow(edit.settings)) return await this.processSlideshow(edit);
      log(edit, "transcribing");
      const transcript = await this.speechFor(edit);
      this.store.updateEdit(edit.id, { state: "editing", transcriptPath: join(this.dir, `${edit.sha256}.words.json`) });
      if (isFancy(edit.settings)) return await this.processFancy(edit, transcript);
      const out = join(this.dir, `${edit.key}.mp4`);
      // The kept source stretches: a redo note's "0:14" in the edit maps back to the source through these.
      const cuts = join(this.dir, `${edit.key}.cuts.json`);
      const extras = extrasOf(edit.settings, (p) => readFileSync(p, "utf8"));
      const media = hasMediaExtras(extras);
      let durationSec: number;
      if (existsSync(out)) {
        durationSec = (await probe(out)).durationSec;
        if (!existsSync(cuts)) writeFileSync(cuts, JSON.stringify(planSegments(transcript, edit.settings, (await probe(edit.sourcePath)).durationSec)));
      } else {
        log(edit, "editing");
        let last = 0;
        const progress = (f: number) => {
          if (f - last >= 0.02) { last = f; this.store.updateEdit(edit.id, { progress: f }); }
        };
        let segments;
        // With a music bed, logo or end clip the edit is rendered first, then those are added in a second pass.
        const base = media ? join(this.dir, `${edit.key}.base.mp4`) : out;
        ({ durationSec, segments } = await renderEdit(edit.sourcePath, transcript, edit.settings, base, (f) => progress(media ? f * 0.9 : f)));
        writeFileSync(cuts, JSON.stringify(segments));
        if (media) {
          try {
            ({ durationSec } = await applyExtras(base, out, extras, { signal: this.cancel.signal, onProgress: (f) => progress(0.9 + 0.1 * f) }));
          } finally {
            try { unlinkSync(base); } catch {}
          }
        }
      }
      // Basic and custom styles don't write the AI's notes; say so rather than ignore text the user gave.
      const notes = extras.context ? ["text resources are only used by Fancy and Slideshow"] : [];
      this.store.updateEdit(edit.id, { state: "ready", progress: 1, outputPath: out, durationSec, error: null, cutsPath: cuts, notes });
      this.announceReady(edit, durationSec);
    } catch (err) {
      this.fail(edit, err);
    }
  }

  private announceReady(edit: Edit, durationSec: number) {
    log(edit, `ready (${durationSec.toFixed(1)}s)`);
    // A Drive video's edit goes to review by itself (Drive intake asks for it); an agent asking too would only replace that card.
    const drive = this.store.driveFileForEdit(edit.id);
    // So does a campaign's (and an agent asking too is refused).
    const task = drive ? null : campaignTaskFor(this.store, "edit", edit.id);
    queueEvent(this.store, "edit.ready", `edit.ready:${edit.id}`, { edit_id: edit.id, duration_sec: durationSec, parent_edit_id: edit.parentEditId, drive_file: drive?.name ?? null, campaign_task_id: task },
      drive
        ? `Edit ${edit.id} of the Drive video "${drive.name}" is ready (${durationSec.toFixed(1)} s). FreePoster sends it to the user for review itself; don't call request_review.`
        : task !== null
          ? `Edit ${edit.id} of a campaign video (campaign task ${task}) is ready (${durationSec.toFixed(1)} s). FreePoster sends it to the user for review itself; don't call request_review.`
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

    const extras = extrasOf(s, (p) => readFileSync(p, "utf8"));
    const media = hasMediaExtras(extras);
    log(edit, "planning graphics");
    // Notes from the user change what the AI plans, so they are part of the plan's cache name.
    const withContext = extras.context ? `-${shortHash(extras.context)}` : "";
    const planPath = join(this.dir, `${edit.sha256}-${shortHash([segments, words])}-${catalogueHash()}${withContext}-v${PLAN_VERSION}.fancy-plan.json`);
    const plan = await cachedPlan(planPath, () => planGraphics(words, editedSec, { ask: this.fancy.ask, context: extras.context }));
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
    const base = media ? join(this.dir, `${edit.key}.base.mp4`) : out;
    const scale = media ? 0.3 : 0.4; // the extras pass takes the last 0.1
    let { durationSec } = await renderFancy(edit.sourcePath, {
      segments, beats, clips: graphics.clips, faces, captionWords: s.captions ? words : null, settings: s, outPath: base, signal,
      onProgress: (f) => progress(0.6 + scale * f),
    });
    if (media) {
      try {
        ({ durationSec } = await applyExtras(base, out, extras, { signal, onProgress: (f) => progress(0.9 + 0.1 * f) }));
      } finally {
        try { unlinkSync(base); } catch {}
      }
    }

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

  /**
   * The Slideshow look: listen (with a video) -> plan the slides (AI, cached) -> render them over the narration and music.
   * Progress: 0-0.1 listening and planning, 0.1-0.9 the render, 0.9-1 the logo.
   */
  private async processSlideshow(edit: Edit) {
    const s = edit.settings;
    const signal = this.cancel.signal;
    let last = 0;
    const progress = (f: number) => {
      if (f - last >= 0.02) { last = f; this.store.updateEdit(edit.id, { progress: f }); }
    };
    this.store.updateEdit(edit.id, { state: "editing" });
    const hasVideo = !isManifestSource(edit.sourcePath);
    const uses = s.resources ?? [];
    const extras = extrasOf(s, (p) => readFileSync(p, "utf8"));
    const temp: string[] = [];
    const framesDir = join(this.dir, `${edit.key}.frames`);
    try {
      let segments: Segment[] = [];
      let words: Awaited<ReturnType<typeof remapWords>> = [];
      let narrationSec: number | null = null;
      let speechPath: string | null = null;
      let captionsAss: string | null = null;
      let cutsPath: string | null = null;
      if (hasVideo) {
        log(edit, "transcribing");
        const transcript = await this.speechFor(edit);
        this.store.updateEdit(edit.id, { transcriptPath: join(this.dir, `${edit.sha256}.words.json`) });
        const sourceSec = (await probe(edit.sourcePath)).durationSec;
        segments = planSegments(transcript, s, sourceSec);
        narrationSec = segments.reduce((t, g) => t + g.end - g.start, 0);
        words = remapWords(fixWords(transcript.words, s.captionFixes), segments);
        cutsPath = join(this.dir, `${edit.key}.cuts.json`);
        writeFileSync(cutsPath, JSON.stringify(segments));
        if (s.captions && words.length) captionsAss = buildAss(words);
        speechPath = await renderSpeechTrack(edit.sourcePath, segments, s.audio, join(this.dir, `${edit.key}.speech.m4a`), signal);
        temp.push(speechPath);
      }

      // The slides' pictures: tagged images and clips, or (with a video and none tagged) stills from the video itself.
      const assets: SlideAsset[] = [];
      for (const u of uses) {
        if (u.as === "slide") assets.push({ index: assets.length, kind: "image", path: u.path, name: u.tag, durationSec: null });
        else if (u.as === "clip") assets.push({ index: assets.length, kind: "video", path: u.path, name: u.tag, durationSec: (await probe(u.path)).durationSec });
      }
      if (!assets.length && hasVideo && narrationSec) {
        mkdirSync(framesDir, { recursive: true });
        const count = Math.min(MAX_SLIDES, Math.max(1, Math.ceil(narrationSec / DEFAULT_SLIDE)));
        for (let k = 0; k < count; k++) {
          const edited = Math.min(narrationSec - 0.05, (k + 0.5) * (narrationSec / count));
          const at = sourceTime(segments, Math.max(0, edited)) ?? 0;
          const path = await extractStill(edit.sourcePath, at, join(framesDir, `${k}.jpg`));
          assets.push({ index: k, kind: "frame", path, name: "", durationSec: null, atSec: at });
        }
      }

      let musicSec: number | null = null;
      if (extras.music) {
        const m = await sniffKind(extras.music, extras.music);
        musicSec = typeof m === "string" ? null : m.durationSec;
      }
      const notesText = uses.filter((u) => u.as === "context").map((u) => { try { return readFileSync(u.path, "utf8"); } catch { return ""; } }).filter(Boolean).join("\n\n").slice(0, 6000);
      progress(0.05);
      log(edit, "planning slides");
      const plan = await cachedSlideshowPlan(
        join(this.dir, `${edit.key}-v${SLIDESHOW_PLAN_VERSION}.slideshow-plan.json`),
        () => planSlideshow({ instructions: s.instructions ?? "", context: notesText, words, durationSec: narrationSec, musicSec, assets }, { ask: this.slideshow.ask }),
      );
      progress(0.1);

      const slides: RenderSlide[] = plan.slides.map((sl, k) => {
        const a = sl.asset === null ? null : assets[sl.asset];
        return { kind: !a ? "card" : a.kind === "video" ? "video" : "image", path: a?.path ?? null, seconds: sl.end - sl.start, zoomIn: k % 2 === 0 };
      });
      log(edit, "editing");
      const out = join(this.dir, `${edit.key}.mp4`);
      const base = extras.overlay ? join(this.dir, `${edit.key}.base.mp4`) : out;
      let { durationSec } = await renderSlideshow({
        slides, text: plan.slides, captionsAss, speechPath, musicPath: extras.music, totalSec: plan.durationSec, outPath: base, signal,
        onProgress: (f) => progress(0.1 + 0.8 * f),
      });
      if (extras.overlay) {
        try {
          ({ durationSec } = await applyExtras(base, out, { music: null, overlay: extras.overlay, endClip: null, context: "" }, { signal, onProgress: (f) => progress(0.9 + 0.1 * f) }));
        } finally {
          try { unlinkSync(base); } catch {}
        }
      }
      this.store.updateEdit(edit.id, { state: "ready", progress: 1, outputPath: out, durationSec, error: null, cutsPath, notes: plan.notes });
      this.announceReady(edit, durationSec);
    } catch (err) {
      this.fail(edit, err);
    } finally {
      for (const f of temp) try { unlinkSync(f); } catch {}
      try { rmSync(framesDir, { recursive: true, force: true }); } catch {}
    }
  }
}
