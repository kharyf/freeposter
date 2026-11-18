// WanGP's speech (text to speech) and music models, headless, for campaign videos' voiceover and soundtrack. Same
// runner as the video shots (adapters/wan.ts): one settings file, `wgp.py --process` checked with --dry-run, then run.
// WanGP saves an audio-only model's result as <output_filename>.<codec> in --output-dir; the codec is the user's
// "audio_stand_alone_output_codec" (wav unless they chose flac or mp3; wgp.py and shared/utils/audio_video.py).
import { newestFile, ownSettings, runWanGP, wanCommand } from "./adapters/wan.ts";
import { Fatal } from "./adapters/errors.ts";
import { wangpArchitecture, wangpAudioModel, wangpDir, wangpSpeechModel } from "./tools.ts";

export interface WanAudioOptions {
  signal?: AbortSignal;
  dir?: () => string;
  /** the model id (default: the speech or audio slot from Setup) */
  model?: () => string;
  command?: (args: string[]) => { bin: string; args: string[] };
  onProgress?: (fraction: number) => void;
}

/** Longest voiceover asked for: the speech models' "Max duration" caps their output (index_tts2, qwen3 handlers). */
const SPEECH_MAX_SEC = 300;
/** Music families that take lyrics in `prompt` and the sound in `alt_prompt` (the caption). */
const LYRICS_ARCH = /^(ace_step|heartmula|minimax_music|yue)/;

const AUDIO_FILE = /\.(wav|flac|mp3)$/i;

async function run(kind: "speech" | "music", settings: Record<string, unknown>, outDir: string, opts: WanAudioOptions & { dir: () => string }) {
  const d = opts.dir();
  const tail = await runWanGP({
    dir: d, command: opts.command ?? wanCommand(opts.dir), settings, workDir: outDir, settingsName: `wan-${kind}-settings.json`,
    label: kind, signal: opts.signal ?? new AbortController().signal, onProgress: opts.onProgress,
  });
  const file = newestFile(outDir, new RegExp(`^${kind}.*${AUDIO_FILE.source}`, "i"));
  if (!file) throw new Fatal(`${kind}: WanGP finished but wrote no audio:\n${tail}`);
  return file;
}

/** A voiceover of `text`, spoken by the speech model from Setup. Returns the audio file's path. */
export async function generateSpeech(text: string, outDir: string, opts: WanAudioOptions = {}): Promise<string> {
  const model = (opts.model ?? wangpSpeechModel)();
  if (!model) throw new Fatal("set a WanGP speech model in Setup");
  const dir = opts.dir ?? wangpDir;
  const own = ownSettings(dir(), model);
  const settings: Record<string, unknown> = {
    ...own,
    model_type: model,
    // The words to speak (every TTS handler validates `prompt`); "FG" keeps every line in one prompt instead of one
    // generation per line (shared/utils/prompt_parser.py).
    prompt: text,
    multi_prompts_gen_type: "FG",
    duration_seconds: SPEECH_MAX_SEC,
    repeat_generation: 1,
    output_filename: "speech",
  };
  // "A" means "clone audio_guide": kept when the user's own settings hold a voice sample, else the model's own voice
  // (wgp.py refuses "A" without an audio_guide; index_tts2 and qwen3_tts_base need a sample and say so).
  if (!own.audio_guide) settings.audio_prompt_type = "";
  return run("speech", settings, outDir, { ...opts, dir });
}

/** An instrumental soundtrack described by `prompt`, `sec` long, from the audio model in Setup. Returns its path. */
export async function generateMusic(prompt: string, sec: number, outDir: string, opts: WanAudioOptions = {}): Promise<string> {
  const model = (opts.model ?? wangpAudioModel)();
  if (!model) throw new Fatal("set a WanGP audio model in Setup");
  const dir = opts.dir ?? wangpDir;
  const arch = wangpArchitecture(dir(), model);
  const lyrics = LYRICS_ARCH.test(arch);
  const settings: Record<string, unknown> = {
    ...ownSettings(dir(), model),
    model_type: model,
    // Lyric models: "[Instrumental]" alone for a fully instrumental track, the sound in the caption
    // (models/TTS/ace_step_handler.py); Stable Audio takes the description as its prompt.
    prompt: lyrics ? "[Instrumental]" : prompt,
    ...(lyrics ? { alt_prompt: prompt } : {}),
    // ACE-Step usually fades out at 67-97% of the length asked for: ask about a third more (ace_step_handler.py).
    duration_seconds: arch.startsWith("ace_step") ? Math.ceil((sec * 4) / 3) : Math.ceil(sec),
    // text only: no cover source or timbre sample
    audio_prompt_type: "",
    multi_prompts_gen_type: "FG",
    repeat_generation: 1,
    output_filename: "music",
  };
  return run("music", settings, outDir, { ...opts, dir });
}
