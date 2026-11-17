// One adapter per shot kind, all behind the same interface: adding a generator touches nothing else.
import type { Transcript } from "../../edit/transcribe.ts";
import type { ShotKind, ShotSpec } from "../spec.ts";
import type { Lane } from "../store.ts";
import { blenderAdapter } from "./blender.ts";
import { editAdapter } from "./edit.ts";
import { fileAdapter } from "./file.ts";
import { hyperframesAdapter } from "./hyperframes.ts";
import { remotionAdapter } from "./remotion.ts";
import { wanAdapter } from "./wan.ts";

export { Fatal, Retryable } from "./errors.ts";

export interface RenderContext {
  /** the shot's own folder: the adapter writes only here */
  dir: string;
  signal: AbortSignal;
  onProgress(fraction: number): void;
}

export interface ShotAdapter<S extends ShotSpec = ShotSpec> {
  kind: ShotKind;
  lane: Lane;
  /** bump to invalidate cached renders when the adapter's output changes */
  version: number;
  /** `missing`: the tool isn't there at all (as opposed to there but not working) */
  health(): Promise<{ ok: boolean; detail: string; missing?: boolean }>;
  /** the clip and how much of it the production uses (assembly trims to durationSec) */
  render(shot: S, ctx: RenderContext): Promise<{ path: string; durationSec: number }>;
}

export type Adapters = { [K in ShotKind]: ShotAdapter<Extract<ShotSpec, { kind: K }>> };

/** speechFor: the edit pipeline's transcript of a file (EditWorker.speechFor). */
export function adapters(opts: { speechFor: (src: { sourcePath: string; sha256: string }) => Promise<Transcript> }): Adapters {
  return {
    hyperframes: hyperframesAdapter(),
    remotion: remotionAdapter(),
    wan: wanAdapter(),
    blender: blenderAdapter(),
    file: fileAdapter(),
    edit: editAdapter(opts.speechFor),
  };
}
