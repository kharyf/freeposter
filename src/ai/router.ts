// The AI providers the user connected, their order for each job, and asking down that order until one answers.
import { askClaude } from "../claude.ts";
import type { Store } from "../db.ts";
import type { ProgramRun } from "./cli.ts";
import * as openrouter from "./openrouter.ts";
import { AI_JOBS, JOB_LABELS, PROVIDER_IDS, PROVIDERS, type AiJob, type Answer, type ProviderId, type Question } from "./providers.ts";

interface Saved { plan: string | null; path?: string; connectedAt: number }
type SavedProviders = Partial<Record<ProviderId, Saved>>;

const PROVIDERS_PREF = "ai.providers";
const RANKING_PREF = "ai.ranking";
const KEY_PREF = "ai.openrouter.key";
const MODEL_PREF = "ai.openrouter.model";

/** The question Connect and Test ask: tiny, so it costs next to nothing on any plan. */
const PROBE: Question = {
  system: "You are checking that a connection works.",
  prompt: 'Answer with {"answer": "ok"}.',
  schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
};

export interface AiOptions {
  /** runs provider programs (a stand-in in tests) */
  run?: ProgramRun;
  /** OpenRouter's HTTP (a stand-in in tests) */
  fetch?: openrouter.Fetch;
  /** finds a provider's program (a stand-in in tests) */
  find?: (id: ProviderId, override?: string) => string;
}

export class AiService {
  store: Store;
  opts: AiOptions;
  private balanceCache?: { at: number; value: openrouter.Balance };

  constructor(store: Store, opts: AiOptions = {}) {
    this.store = store;
    this.opts = opts;
    // Before providers could be chosen, Claude Code was used whenever it was installed: keep that working.
    if (store.pref(PROVIDERS_PREF) === undefined) {
      store.setPref(PROVIDERS_PREF, this.find("claude") ? { claude: { plan: null, connectedAt: Date.now() } } : {});
    }
  }

  private saved(): SavedProviders {
    return this.store.pref<SavedProviders>(PROVIDERS_PREF) ?? {};
  }

  private find(id: ProviderId, override?: string): string {
    if (id === "openrouter") return "";
    return this.opts.find ? this.opts.find(id, override) : PROVIDERS[id].find!(override);
  }

  private key(): string | undefined {
    return this.store.secretPref(KEY_PREF);
  }

  model(): string {
    return this.store.pref<string>(MODEL_PREF) || openrouter.DEFAULT_MODEL;
  }

  /** Connected providers, in the order they were connected. */
  connected(): ProviderId[] {
    const saved = this.saved();
    return PROVIDER_IDS.filter((id) => saved[id] && (id !== "openrouter" || this.key()))
      .sort((a, b) => saved[a]!.connectedAt - saved[b]!.connectedAt);
  }

  /** Whether a provider can do the job: only some can look at the still frames. */
  canDo(id: ProviderId, job: AiJob): boolean {
    if (job !== "frames") return true;
    if (id === "openrouter") return this.modelInfo()?.images ?? true;
    return PROVIDERS[id].images;
  }

  private modelInfo(): openrouter.ModelInfo | undefined {
    return modelList?.find((m) => m.id === this.model());
  }

  /** The job's connected providers, in the user's order; ones connected since go last. */
  ranking(job: AiJob): ProviderId[] {
    const connected = this.connected();
    const saved = (this.store.pref<Record<string, ProviderId[]>>(RANKING_PREF) ?? {})[job] ?? [];
    return [...saved.filter((id) => connected.includes(id)), ...connected.filter((id) => !saved.includes(id))];
  }

  setRanking(job: AiJob, order: ProviderId[]) {
    const all = this.store.pref<Record<string, ProviderId[]>>(RANKING_PREF) ?? {};
    all[job] = [...new Set(order.filter((id) => (PROVIDER_IDS as readonly string[]).includes(id)))];
    this.store.setPref(RANKING_PREF, all);
  }

  /** Asks one provider, without falling back. */
  async askOne<T>(id: ProviderId, q: Question): Promise<Answer<T>> {
    if (id === "openrouter") {
      const key = this.key();
      if (!key) throw new Error("OpenRouter isn't connected");
      return openrouter.ask<T>(q, key, this.model(), this.opts.fetch);
    }
    const def = PROVIDERS[id];
    const path = this.find(id, this.saved()[id]?.path);
    if (!path) throw new Error(`${def.program} isn't installed`);
    return def.ask!<T>(q, { path, run: this.opts.run });
  }

  /** Asks the job's providers in order until one answers; says what each one said when none does. */
  async ask<T>(job: AiJob, q: Question): Promise<T> {
    const order = this.ranking(job);
    if (!order.length) throw new Error("no AI provider is connected (connect one under AI Providers)");
    const able = order.filter((id) => this.canDo(id, job));
    if (!able.length) throw new Error("none of your connected AI providers can look at images");
    const failed: string[] = [];
    for (const id of able) {
      try {
        const out = await this.askOne<T>(id, q);
        this.store.recordAiUse({ provider: id, job, ok: true, cost: out.cost, promptTokens: out.promptTokens, completionTokens: out.completionTokens, model: out.model });
        return out.answer;
      } catch (err) {
        const msg = (err as Error).message;
        this.store.recordAiUse({ provider: id, job, ok: false, error: msg.slice(0, 500) });
        failed.push(`${PROVIDERS[id].label}: ${msg}`);
      }
    }
    throw new Error(failed.join("; "));
  }

  /** Connects a plan provider: its program must be installed and answer a tiny question. */
  async connect(id: ProviderId, opts: { plan?: string | null; path?: string } = {}) {
    if (id === "openrouter") throw new Error("OpenRouter connects through its sign-in page");
    const def = PROVIDERS[id];
    const path = this.find(id, opts.path?.trim() || undefined);
    if (!path) throw new Error(`${def.program} isn't installed on this computer. ${def.setup}`);
    try {
      await def.ask!(PROBE, { path, run: this.opts.run });
    } catch (err) {
      throw new Error(`${def.program} didn't answer: ${(err as Error).message}. ${def.setup}`);
    }
    const saved = this.saved();
    saved[id] = { plan: opts.plan ?? saved[id]?.plan ?? null, ...(opts.path?.trim() ? { path: opts.path.trim() } : {}), connectedAt: saved[id]?.connectedAt ?? Date.now() };
    this.store.setPref(PROVIDERS_PREF, saved);
  }

  /** Asks the tiny question again, through the same path a real job takes. */
  async test(id: ProviderId) {
    try {
      await this.askOne(id, PROBE);
      this.store.recordAiUse({ provider: id, job: "test", ok: true });
    } catch (err) {
      this.store.recordAiUse({ provider: id, job: "test", ok: false, error: (err as Error).message.slice(0, 500) });
      throw err;
    }
  }

  saveOpenRouterKey(key: string) {
    this.store.setSecretPref(KEY_PREF, key);
    const saved = this.saved();
    saved.openrouter = { plan: null, connectedAt: saved.openrouter?.connectedAt ?? Date.now() };
    this.store.setPref(PROVIDERS_PREF, saved);
    this.balanceCache = undefined;
  }

  disconnect(id: ProviderId) {
    const saved = this.saved();
    delete saved[id];
    this.store.setPref(PROVIDERS_PREF, saved);
    if (id === "openrouter") {
      this.store.deletePref(KEY_PREF);
      this.balanceCache = undefined;
    }
  }

  setPlan(id: ProviderId, plan: string | null) {
    const saved = this.saved();
    if (!saved[id]) throw new Error(`${PROVIDERS[id].label} isn't connected`);
    if (plan && !PROVIDERS[id].plans.some((p) => p.id === plan)) throw new Error(`${PROVIDERS[id].label} has no plan ${plan}`);
    saved[id]!.plan = plan;
    this.store.setPref(PROVIDERS_PREF, saved);
  }

  async setModel(model: string) {
    const list = await loadModels(this.opts.fetch);
    if (!list.some((m) => m.id === model)) throw new Error(`OpenRouter has no model ${model} that can follow FreePoster's answer format`);
    this.store.setPref(MODEL_PREF, model);
  }

  private async balance(): Promise<openrouter.Balance | null> {
    const key = this.key();
    if (!key) return null;
    if (this.balanceCache && Date.now() - this.balanceCache.at < 60_000) return this.balanceCache.value;
    const value = await openrouter.balance(key, this.opts.fetch);
    this.balanceCache = { at: Date.now(), value };
    return value;
  }

  /** Everything the AI Providers panel shows. */
  async view() {
    const saved = this.saved();
    const connected = this.connected();
    const last = this.store.aiLastUses();
    const lastOf = (id: string, ok: number) => last.find((u) => u.provider === id && u.ok === ok);
    const providers = PROVIDER_IDS.map((id) => {
      const def = PROVIDERS[id];
      const plan = def.plans.find((p) => p.id === saved[id]?.plan) ?? null;
      const good = lastOf(id, 1);
      const bad = lastOf(id, 0);
      return {
        id,
        label: def.label,
        program: def.program ?? null,
        billing: def.billing,
        pricing: def.billing === "credits"
          ? "Pay per use, from your OpenRouter credits"
          : `Monthly plan${plan ? `: ${plan.label}${plan.price ? ` (${plan.price})` : ""}` : ""}`,
        plans: def.plans,
        plan: plan?.id ?? null,
        connected: connected.includes(id),
        installed: id === "openrouter" ? null : Boolean(this.find(id, saved[id]?.path)),
        path: saved[id]?.path ?? "",
        images: id === "openrouter" ? this.canDo(id, "frames") : def.images,
        experimental: Boolean(def.experimental),
        setupUrl: def.setupUrl,
        setup: def.setup,
        lastAnswerAt: good?.created_at ?? null,
        // Only a failure since the last answer is worth showing.
        lastError: bad && (!good || bad.created_at > good.created_at) ? bad.error : null,
      };
    });
    const jobs = AI_JOBS.map((job) => ({
      id: job,
      label: JOB_LABELS[job],
      order: this.ranking(job).map((id) => ({ id, label: PROVIDERS[id].label, canDo: this.canDo(id, job) })),
    }));
    return { providers, jobs, openrouter: connected.includes("openrouter") ? await this.openRouterView() : null };
  }

  private async openRouterView() {
    const [list, balance] = await Promise.all([loadModels(this.opts.fetch).catch(() => modelList ?? []), this.balance()]);
    const model = this.model();
    const info = list.find((m) => m.id === model);
    const costs = Object.fromEntries(AI_JOBS.map((job) => {
      const seen = this.store.aiCosts("openrouter", job);
      const [p, c, images] = openrouter.TYPICAL_TOKENS[job];
      const measured = seen.uses > 0 && seen.promptTokens !== null;
      const est = info ? openrouter.estimate(info, {
        promptTokens: measured ? seen.promptTokens! : p,
        completionTokens: measured && seen.completionTokens !== null ? seen.completionTokens : c,
        images,
        measured,
      }) : null;
      return [job, { estimate: est, last: seen.last, average: seen.average, uses: seen.uses }];
    }));
    return {
      model,
      models: list.map((m) => ({ id: m.id, name: m.name, images: m.images, promptPerM: m.prompt * 1e6, completionPerM: m.completion * 1e6 })),
      balance,
      costs,
    };
  }
}

let modelList: openrouter.ModelInfo[] | undefined;
async function loadModels(f?: openrouter.Fetch) {
  modelList = await openrouter.models(f);
  return modelList;
}

// ---- the one the app runs ----

let current: AiService | undefined;
export const setAi = (service: AiService | undefined) => { current = service; };
export const currentAi = () => current;

/**
 * Asks the job's providers in the user's order. Without a running app (some tests, scripts) it asks Claude
 * Code directly, as FreePoster did before providers could be chosen.
 */
export function askAi<T>(job: AiJob, q: Question): Promise<T> {
  return current ? current.ask<T>(job, q) : askClaude<T>(q);
}
