// The AI providers the user connected, their order for each job, and asking down that order until one answers.
import { checkBudget } from "./budget.ts";
import { askClaude, CLAUDE_MODELS } from "../claude.ts";
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
/** A custom OpenAI-compatible endpoint (like FreeLLMAPI) instead of OpenRouter's own API. */
const ENDPOINT_PREF = "ai.openrouter.endpoint";
/** The models the user turned off under AI Providers (`provider:model` ids): nothing offers them any more. */
const MODELS_OFF_PREF = "ai.models.off";

/**
 * Whether Claude is connected under AI Providers. With Google AI (below), that alone turns on FreePoster starting a film
 * agent for campaign films: a row can only pick a Lemo style with a film-agent model, and only connected providers' models are offered.
 */
export const claudeConnected = (store: Store): boolean => Boolean(store.pref<SavedProviders>(PROVIDERS_PREF)?.claude);
/** Whether Google AI is connected: FreePoster can then start the Antigravity CLI (Gemini) for campaign films. */
export const googleConnected = (store: Store): boolean => Boolean(store.pref<SavedProviders>(PROVIDERS_PREF)?.google);
/** Whether any film agent (Claude Code or the Antigravity CLI) is connected, so FreePoster makes campaign films itself. */
export const filmAgentConnected = (store: Store): boolean => claudeConnected(store) || googleConnected(store);
/** The program path the user set for a provider when connecting it, if any. */
export const providerPath = (store: Store, id: ProviderId): string | undefined => store.pref<SavedProviders>(PROVIDERS_PREF)?.[id]?.path;

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
    // Apply a saved custom endpoint (like FreeLLMAPI) so the first model fetch already goes through it.
    const savedEndpoint = store.pref<string>(ENDPOINT_PREF);
    if (savedEndpoint) openrouter.setApiBase(savedEndpoint);
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

  /**
   * The custom OpenAI-compatible endpoint for OpenRouter, or "" for OpenRouter's own API. A compatible
   * proxy like FreeLLMAPI can be pointed at here: models and chat/completions go through it; OAuth, balance
   * and key info always go through OpenRouter itself.
   */
  endpoint(): string {
    return this.store.pref<string>(ENDPOINT_PREF) || "";
  }

  /** Points OpenRouter's model and chat calls at a custom endpoint, or back at OpenRouter when empty. */
  setEndpoint(url: string) {
    const trimmed = url.trim().replace(/\/+$/, "");
    if (trimmed && !/^https?:\/\/\S+$/.test(trimmed)) throw new Error("endpoint must be an HTTP or HTTPS URL");
    this.store.setPref(ENDPOINT_PREF, trimmed || null);
    openrouter.setApiBase(trimmed);
    // The model list is different on a new endpoint: drop the cache so it's fetched fresh.
    openrouter.clearModelCache();
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

  /** The models the user turned off under AI Providers: no list in FreePoster offers them, and a save refuses them. */
  offModels(): Set<string> {
    return new Set(this.store.pref<string[]>(MODELS_OFF_PREF) ?? []);
  }

  /** Every model a provider offers, whether or not the user has it in use, with full `provider:model` ids. */
  private modelsOf(provider: ProviderId): { id: string; name: string }[] {
    return provider === "claude" ? CLAUDE_MODELS.map((m) => ({ id: `claude:${m.id}`, name: m.name }))
      : provider === "openrouter" ? (modelList ?? []).map((m) => ({ id: `openrouter:${m.id}`, name: m.name }))
      : [{ id: `${provider}:default`, name: `${PROVIDERS[provider].label} default` }];
  }

  /** The models each connected provider offers that the user left in use, with full `provider:model` ids. */
  modelChoices(): { provider: ProviderId; label: string; models: { id: string; name: string }[] }[] {
    const off = this.offModels();
    return this.connected()
      .map((provider) => ({ provider, label: PROVIDERS[provider].label, models: this.modelsOf(provider).filter((m) => !off.has(m.id)) }))
      .filter((g) => g.models.length); // a provider with nothing left in use isn't offered at all
  }

  /**
   * Turns one of a connected provider's models on or off under AI Providers. Off means nothing offers it any more, so
   * the caller checks first that no campaign row still picks it.
   */
  setModelEnabled(model: string, enabled: boolean) {
    const cut = model.indexOf(":");
    const provider = model.slice(0, cut) as ProviderId;
    if (cut < 0 || !(PROVIDER_IDS as readonly string[]).includes(provider) || !this.connected().includes(provider)) throw new Error(`unknown model ${model}`);
    if (!this.modelsOf(provider).some((m) => m.id === model)) throw new Error(`unknown model ${model}`);
    const off = this.offModels();
    if (enabled) off.delete(model);
    else off.add(model);
    this.store.setPref(MODELS_OFF_PREF, [...off]);
  }

  /** Asks one provider, without falling back. `model` is the provider's own model id; undefined means its default. */
  async askOne<T>(id: ProviderId, q: Question, model?: string): Promise<Answer<T>> {
    if (id === "openrouter") {
      const key = this.key();
      if (!key) throw new Error("OpenRouter isn't connected");
      return openrouter.ask<T>(q, key, model || this.model(), this.opts.fetch);
    }
    const def = PROVIDERS[id];
    const path = this.find(id, this.saved()[id]?.path);
    if (!path) throw new Error(`${def.program} isn't installed`);
    return def.ask!<T>(q, { path, run: this.opts.run, model });
  }

  /**
   * Asks the job's providers in order until one answers; says what each one said when none does. With a
   * `provider:model` id it asks only that provider, with no fallback.
   */
  async ask<T>(job: AiJob, q: Question, opts: { model?: string | null } = {}): Promise<T> {
    checkBudget(this.store, job);
    if (opts.model) return this.askModel<T>(job, q, opts.model);
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

  private async askModel<T>(job: AiJob, q: Question, id: string): Promise<T> {
    const cut = id.indexOf(":");
    const provider = id.slice(0, cut) as ProviderId;
    const model = id.slice(cut + 1);
    if (cut < 0 || !(PROVIDER_IDS as readonly string[]).includes(provider)) throw new Error(`unknown model ${id}`);
    if (!this.connected().includes(provider)) throw new Error(`${PROVIDERS[provider].label} isn't connected`);
    try {
      const out = await this.askOne<T>(provider, q, model === "default" ? undefined : model);
      this.store.recordAiUse({ provider, job, ok: true, cost: out.cost, promptTokens: out.promptTokens, completionTokens: out.completionTokens, model: out.model });
      return out.answer;
    } catch (err) {
      const msg = (err as Error).message;
      this.store.recordAiUse({ provider, job, ok: false, error: msg.slice(0, 500) });
      throw new Error(`${PROVIDERS[provider].label}: ${msg}`);
    }
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

  /**
   * Everything the AI Providers panel shows. `inUse` counts the campaign rows that pick each model (`provider:model`),
   * so a model still in use can be shown as such and refused when the user turns it off.
   */
  async view(inUse: Record<string, number> = {}) {
    const saved = this.saved();
    const connected = this.connected();
    // OpenRouter's models come over the wire: load them before its section and the In Use lists are built.
    const openrouter = connected.includes("openrouter") ? await this.openRouterView() : null;
    const off = this.offModels();
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
        /** Its models, each with whether the user has it in use and how many campaign rows pick it (only when connected) */
        models: connected.includes(id) ? this.modelsOf(id).map((m) => ({ ...m, enabled: !off.has(m.id), usedBy: inUse[m.id] ?? 0 })) : [],
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
    return { providers, jobs, openrouter };
  }

  private async openRouterView() {
    const [list, balance] = await Promise.all([loadModels(this.opts.fetch).catch(() => modelList ?? []), this.balance()]);
    const model = this.model();
    const off = this.offModels();
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
      endpoint: this.endpoint(),
      models: list.map((m) => ({ id: m.id, name: m.name, images: m.images, promptPerM: m.prompt * 1e6, completionPerM: m.completion * 1e6, enabled: !off.has(`openrouter:${m.id}`) })),
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
