// The AI providers the user connected, their order for each job, and asking down that order until one answers.
import { checkBudget } from "./budget.ts";
import { askClaude, CLAUDE_MODELS } from "../claude.ts";
import type { Store } from "../db.ts";
import type { ProgramRun } from "./cli.ts";
import * as lmstudio from "./lmstudio.ts";
import * as openrouter from "./openrouter.ts";
import { AI_JOBS, answersQuestions, JOB_LABELS, PROVIDER_IDS, PROVIDERS, type AiJob, type Answer, type ProviderId, type Question } from "./providers.ts";
import { wangpDir, wangpModel, wangpModels } from "../produce/tools.ts";

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
  /** LM Studio's HTTP (a stand-in in tests) */
  lmFetch?: lmstudio.Fetch;
  /** the WanGP install: its folder ("" when not found), the video models in it, and the one Setup uses (a stand-in in tests) */
  wangp?: { dir(): string; video(dir: string): string[]; current(): string };
}

/** How long LM Studio's model list is trusted before it's asked again (models get downloaded and deleted). */
const LM_LIST_MS = 60_000;

export class AiService {
  store: Store;
  opts: AiOptions;
  private balanceCache?: { at: number; value: openrouter.Balance };
  /** LM Studio's chat models as last listed, and when; `error` is why the last listing failed */
  private lm: { at: number; models: lmstudio.LmModel[]; error?: string } = { at: 0, models: [] };
  private lmLoading?: Promise<void>;

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
    // LM Studio's models are listed in the background, so the Campaigns tab has them the first time it asks.
    if (this.saved().lmstudio) void this.refreshLm();
  }

  private wangp() {
    return this.opts.wangp ?? { dir: wangpDir, video: (dir: string) => wangpModels(dir).video, current: wangpModel };
  }

  /** The LM Studio server FreePoster asks: the address given when connecting, else LM Studio's default. */
  private lmServer(): string {
    return lmstudio.serverOf(this.saved().lmstudio?.path);
  }

  /** Lists LM Studio's models again (one listing at a time); a failure keeps the last list and says why. */
  private refreshLm(): Promise<void> {
    this.lmLoading ??= lmstudio.models(this.lmServer(), this.opts.lmFetch)
      .then((models) => { this.lm = { at: Date.now(), models }; })
      .catch((err) => { this.lm = { ...this.lm, at: Date.now(), error: (err as Error).message }; })
      .finally(() => { this.lmLoading = undefined; });
    return this.lmLoading;
  }

  /** LM Studio's models, listing them again first when the list is old. */
  private async lmModels(): Promise<lmstudio.LmModel[]> {
    if (Date.now() - this.lm.at > LM_LIST_MS) await this.refreshLm();
    return this.lm.models;
  }

  /** LM Studio's models as last listed, without waiting (lists them again in the background when the list is old). */
  private lmList(): lmstudio.LmModel[] {
    if (Date.now() - this.lm.at > LM_LIST_MS) void this.refreshLm();
    return this.lm.models;
  }

  /** The LM Studio model a question goes to when none is named: one already loaded, else the first downloaded. */
  private async lmDefault(): Promise<string> {
    const list = await this.lmModels();
    if (!list.length) throw new Error(this.lm.error ?? "LM Studio has no chat model downloaded");
    return list[0].id;
  }

  /** The video models the WanGP install has (none when it isn't found). */
  private wangpList(): string[] {
    const w = this.wangp();
    const dir = w.dir();
    return dir ? w.video(dir) : [];
  }

  private saved(): SavedProviders {
    return this.store.pref<SavedProviders>(PROVIDERS_PREF) ?? {};
  }

  private find(id: ProviderId, override?: string): string {
    if (id === "openrouter" || id === "lmstudio") return "";
    if (id === "wangp") return this.wangp().dir();
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

  /** Whether a provider can do the job: WanGP does none (it makes video), and only some can look at the still frames. */
  canDo(id: ProviderId, job: AiJob): boolean {
    if (!answersQuestions(id)) return false;
    if (job !== "frames") return true;
    if (id === "openrouter") return this.modelInfo()?.images ?? true;
    if (id === "lmstudio") return this.lm.models[0]?.vision ?? false;
    return PROVIDERS[id].images;
  }

  private modelInfo(): openrouter.ModelInfo | undefined {
    return modelList?.find((m) => m.id === this.model());
  }

  /** The job's connected providers, in the user's order; ones connected since go last. WanGP is never in it. */
  ranking(job: AiJob): ProviderId[] {
    const connected = this.connected().filter(answersQuestions);
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
      : provider === "lmstudio" ? this.lmList().map((m) => ({ id: `lmstudio:${m.id}`, name: m.id }))
      : provider === "wangp" ? this.wangpList().map((id) => ({ id: `wangp:${id}`, name: id }))
      : [{ id: `${provider}:default`, name: `${PROVIDERS[provider].label} default` }];
  }

  /**
   * The video models a generated campaign row can be made with (WanGP's, left in use, while it's connected), and the one
   * a row without its own uses: the WanGP model set in Setup (or last used in WanGP), "" when there's none.
   */
  videoChoices(): { models: { id: string; name: string }[]; fallback: string } {
    const off = this.offModels();
    const models = this.connected().includes("wangp") ? this.modelsOf("wangp").filter((m) => !off.has(m.id)) : [];
    return { models, fallback: this.wangp().current() };
  }

  /** The models that can write a campaign row (each connected provider that answers questions), left in use, with full `provider:model` ids. */
  modelChoices(): { provider: ProviderId; label: string; models: { id: string; name: string }[] }[] {
    const off = this.offModels();
    return this.connected()
      .filter(answersQuestions)
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
    if (id === "lmstudio") return lmstudio.ask<T>(q, this.lmServer(), model || (await this.lmDefault()), this.opts.lmFetch);
    if (!answersQuestions(id)) throw new Error(`${PROVIDERS[id].label} makes video; it can't write`);
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

  /**
   * Connects a provider: a plan provider's program must be installed and answer a tiny question; LM Studio's server
   * (at `path`, its address, blank for the default) must list a model that answers it; WanGP must be installed.
   */
  async connect(id: ProviderId, opts: { plan?: string | null; path?: string } = {}) {
    if (id === "openrouter") throw new Error("OpenRouter connects through its sign-in page");
    const def = PROVIDERS[id];
    if (id === "lmstudio") {
      const server = lmstudio.serverOf(opts.path);
      const list = await lmstudio.models(server, this.opts.lmFetch);
      if (!list.length) throw new Error(`LM Studio has no chat model downloaded. ${def.setup}`);
      try {
        await lmstudio.ask(PROBE, server, list[0].id, this.opts.lmFetch);
      } catch (err) {
        throw new Error(`${list[0].id} didn't answer: ${(err as Error).message}`);
      }
      this.lm = { at: Date.now(), models: list };
      return this.save(id, null, server === lmstudio.DEFAULT_SERVER ? undefined : server);
    }
    if (id === "wangp") {
      if (!this.find(id)) throw new Error(`WanGP wasn't found on this computer. ${def.setup}`);
      if (!this.wangpList().length) throw new Error("WanGP has no video models; open WanGP once so it writes its model list");
      return this.save(id, null);
    }
    const path = this.find(id, opts.path?.trim() || undefined);
    if (!path) throw new Error(`${def.program} isn't installed on this computer. ${def.setup}`);
    try {
      await def.ask!(PROBE, { path, run: this.opts.run });
    } catch (err) {
      throw new Error(`${def.program} didn't answer: ${(err as Error).message}. ${def.setup}`);
    }
    this.save(id, opts.plan ?? null, opts.path?.trim() || undefined);
  }

  /** Saves a provider as connected (keeping when it was first connected, and its plan when none is given). */
  private save(id: ProviderId, plan: string | null, path?: string) {
    const saved = this.saved();
    saved[id] = { plan: plan ?? saved[id]?.plan ?? null, ...(path ? { path } : {}), connectedAt: saved[id]?.connectedAt ?? Date.now() };
    this.store.setPref(PROVIDERS_PREF, saved);
  }

  /** Asks the tiny question again, through the same path a real job takes (WanGP, which answers none, is looked for). */
  async test(id: ProviderId) {
    try {
      if (id === "wangp") {
        if (!this.find(id)) throw new Error(`WanGP wasn't found on this computer. ${PROVIDERS.wangp.setup}`);
        if (!this.wangpList().length) throw new Error("WanGP has no video models");
      } else await this.askOne(id, PROBE);
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
    if (connected.includes("lmstudio")) await this.lmModels();
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
        pricing: def.billing === "credits" ? "Pay per use, from your OpenRouter credits"
          : def.billing === "local" ? "Free: runs on this computer"
          : `Monthly plan${plan ? `: ${plan.label}${plan.price ? ` (${plan.price})` : ""}` : ""}`,
        plans: def.plans,
        plan: plan?.id ?? null,
        connected: connected.includes(id),
        installed: id === "openrouter" || id === "lmstudio" ? null : Boolean(this.find(id, saved[id]?.path)),
        path: saved[id]?.path ?? "",
        images: id === "openrouter" || id === "lmstudio" ? this.canDo(id, "frames") : def.images,
        /** answers FreePoster's questions (WanGP doesn't: it makes the video) */
        writes: answersQuestions(id),
        /** why LM Studio's model list couldn't be read, while there's no list to show */
        listError: id === "lmstudio" && connected.includes(id) && !this.lm.models.length ? this.lm.error ?? null : null,
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
