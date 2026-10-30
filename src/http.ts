/**
 * Errors are split by what the job runner should do next:
 * - RetryableError: network blips, 5xx, 429 — try again later.
 * - FatalError: bad token, policy rejection, spec violation — retrying will not help; show the reason.
 * - AuthError: token rejected — refresh once, then fail.
 */
export class RetryableError extends Error {
  retryAfterMs: number | undefined;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}
export class FatalError extends Error {}
export class AuthError extends FatalError {}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  body?: BodyInit;
  /** status codes treated as success in addition to 2xx (e.g. YouTube's 308 Resume Incomplete) */
  okStatuses?: number[];
}

export async function request(url: string, opts: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...opts.headers };
  let body = opts.body;
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json; charset=UTF-8";
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(opts.form).toString();
  }

  let res: Response;
  try {
    res = await fetch(url, { method: opts.method ?? (body ? "POST" : "GET"), headers, body, redirect: "manual" });
  } catch (err) {
    throw new RetryableError(`network error calling ${host(url)}: ${(err as Error).message}`);
  }
  if (res.ok || opts.okStatuses?.includes(res.status)) return res;

  const text = await res.text().catch(() => "");
  const detail = `${host(url)} ${res.status}: ${text.slice(0, 600)}`;
  if (res.status === 429 || res.status >= 500) {
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new RetryableError(detail, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
  }
  if (res.status === 401) throw new AuthError(detail);
  // Meta Graph signals expired tokens (code 190) and transient faults (is_transient) inside 400 bodies.
  const graphError = parseGraphError(text);
  if (graphError?.code === 190) throw new AuthError(detail);
  if (graphError?.is_transient || [1, 2, 4, 17, 32, 341].includes(graphError?.code ?? -1)) {
    throw new RetryableError(detail);
  }
  throw new FatalError(detail);
}

export async function requestJson<T = any>(url: string, opts: RequestOptions = {}): Promise<T> {
  const res = await request(url, opts);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

function parseGraphError(text: string): { code?: number; is_transient?: boolean } | undefined {
  try {
    return JSON.parse(text)?.error;
  } catch {
    return undefined;
  }
}

const host = (url: string) => {
  const u = new URL(url);
  return `${u.host}${u.pathname}`;
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
