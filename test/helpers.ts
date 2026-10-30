import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.ts";
import type { NewAccount, Platform } from "../src/types.ts";

export const tmp = () => mkdtempSync(join(tmpdir(), "freeposter-test-"));

/** Small synthetic clips standing in for real uploads; generated once per test process. */
export function makeVideo(dir: string, name: string, args: string[]): string {
  const out = join(dir, name);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args, out]);
  return out;
}

export const landscape60 = (dir: string, seconds = 4) =>
  makeVideo(dir, "landscape60.mp4", [
    "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=60",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
    "-t", String(seconds), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
  ]);

export const verticalSilent = (dir: string, seconds = 4) =>
  makeVideo(dir, "vertical-silent.mp4", [
    "-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=24", "-t", String(seconds), "-c:v", "libx264", "-pix_fmt", "yuv420p",
  ]);

export const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

export function newStore(dir = tmp()) {
  return new Store(join(dir, "test.db"), randomBytes(32));
}

export function account(platform: Platform, overrides: Partial<NewAccount> = {}): NewAccount {
  return {
    platform,
    externalId: `${platform}-1`,
    name: `@${platform}user`,
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: Date.now() + 3_600_000,
    refreshExpiresAt: null,
    meta: { username: `${platform}user` },
    ...overrides,
  };
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/** Replaces global fetch with a scripted fake that records every call. */
export function mockFetch(handler: Handler) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body: init.body });
    return handler(url, init);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A multipart/form-data body for app.inject, like the browser's FormData upload. */
export function multipart(fields: Record<string, string>, file?: { name: string; data: Buffer }) {
  const boundary = "----freeposter" + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="${file.name}"\r\nContent-Type: video/mp4\r\n\r\n`));
    parts.push(file.data, Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
