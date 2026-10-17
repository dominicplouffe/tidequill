import type { Config } from "../config.ts";
import { TqError } from "../core/errors.ts";
import type { Ctx } from "../core/types.ts";

/**
 * The model adapter every module uses. One interface, four providers:
 * Anthropic (Messages API over fetch), any OpenAI-compatible endpoint, Ollama,
 * and `offline` (deterministic, never touches the network).
 *
 * A client returned by `modelFor(ctx)` wraps a chain of providers: the primary
 * first, then every other configured provider as a backup. Each provider gets
 * retries with backoff; on a hard error or timeout the chain fails over to the
 * next one and says so in the response (`failover`), which run history records.
 */

export interface ModelRequest {
  tier: "frontier" | "fast";
  system?: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
  json?: boolean;
  /**
   * Optional stable prefix (Site Brain, voice profile). Sent before `system`
   * and marked for prompt caching where the provider supports it, so repeat
   * calls for the same site pay a fraction of the input price.
   */
  cachePrefix?: string;
}

export interface ModelResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  model: string;
  provider: string;
  /** Providers that failed before this one answered, e.g. ["anthropic: timeout"]. */
  failover?: string[];
}

export interface ModelClient {
  offline: boolean;
  complete(req: ModelRequest): Promise<ModelResponse>;
}

export type ProviderName = "anthropic" | "openai" | "ollama" | "offline";

/** Thrown when every configured provider failed. Jobs treat it as "try again later". */
export class ModelUnavailableError extends TqError {
  constructor(public attempts: string[]) {
    super("failed", `The writing model isn't answering right now (${attempts.join("; ")}). Nothing was changed; I'll try again shortly.`);
  }
}

class ProviderError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}

// ---------- Pricing (USD per million tokens) ----------

interface Price {
  input: number;
  output: number;
  /** Price of a cache read; cache writes are billed at 1.25x input. */
  cacheRead?: number;
}

/** Anthropic first-party prices (cached 2026-10). Unknown remote models use CONSERVATIVE_PRICE so budgets still bite. */
export const PRICES: Record<string, Price> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
  "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125 },
  "gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025 },
  "gpt-4.1": { input: 2, output: 8, cacheRead: 0.5 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cacheRead: 0.1 },
  "gpt-4o": { input: 2.5, output: 10, cacheRead: 1.25 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cacheRead: 0.075 },
};
const CONSERVATIVE_PRICE: Price = { input: 5, output: 25 };
const FREE: Price = { input: 0, output: 0 };

export function priceFor(provider: ProviderName, model: string): Price {
  if (provider === "offline" || provider === "ollama") return FREE;
  if (PRICES[model]) return PRICES[model]!;
  // Dated or suffixed ids ("gpt-4o-2024-08-06") price like their family.
  const family = Object.keys(PRICES)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return family ? PRICES[family]! : CONSERVATIVE_PRICE;
}

export function costOf(provider: ProviderName, model: string, usage: { input: number; output: number; cacheWrite?: number; cacheRead?: number }): number {
  const p = priceFor(provider, model);
  const usd =
    (usage.input * p.input + (usage.cacheWrite ?? 0) * p.input * 1.25 + (usage.cacheRead ?? 0) * (p.cacheRead ?? p.input) + usage.output * p.output) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/** Rough cost of a call before making it (for estimates on plan cards). */
export function estimateCost(provider: ProviderName, model: string, tokensIn: number, tokensOut: number): number {
  return costOf(provider, model, { input: tokensIn, output: tokensOut });
}

// ---------- Provider selection ----------

export const DEFAULT_MODELS: Record<Exclude<ProviderName, "offline">, { frontier: string; fast: string }> = {
  anthropic: { frontier: "claude-opus-5-5", fast: "claude-haiku-5-5" },
  openai: { frontier: "gpt-5", fast: "gpt-5-mini" },
  ollama: { frontier: "llama3.1", fast: "llama3.2" },
};

export interface ProviderSpec {
  name: ProviderName;
  frontier: string;
  fast: string;
}

/** Model overrides apply to the providers they plausibly belong to: claude-* to Anthropic, anything else to OpenAI/Ollama. */
function modelsFor(name: Exclude<ProviderName, "offline">, models: Config["models"]) {
  const base = DEFAULT_MODELS[name];
  const fits = (m: string | undefined) => !!m && (name === "anthropic" ? m.startsWith("claude") : !m.startsWith("claude"));
  return { frontier: fits(models.frontierModel) ? models.frontierModel! : base.frontier, fast: fits(models.fastModel) ? models.fastModel! : base.fast };
}

/** The provider chain: the primary first, then every other configured provider as a backup. */
export function providerChain(models: Config["models"]): ProviderSpec[] {
  const available: Exclude<ProviderName, "offline">[] = [];
  if (models.anthropicKey) available.push("anthropic");
  if (models.openaiKey || models.openaiBaseUrl) available.push("openai");
  if (models.ollamaUrl) available.push("ollama");
  if (models.provider === "offline") return [{ name: "offline", frontier: "offline", fast: "offline" }];
  let order = available;
  if (models.provider !== "auto") {
    order = available.includes(models.provider) ? [models.provider, ...available.filter((p) => p !== models.provider)] : available;
  }
  if (!order.length) return [{ name: "offline", frontier: "offline", fast: "offline" }];
  return order.map((name) => ({ name, ...modelsFor(name, models) }));
}

// ---------- Providers ----------

interface CallOpts {
  model: string;
  timeoutMs: number;
}

type ProviderCall = (req: ModelRequest, opts: CallOpts) => Promise<Omit<ModelResponse, "provider" | "failover">>;

function jsonInstruction(req: ModelRequest): string {
  return req.json ? "\n\nReply with a single JSON object and nothing else: no prose, no code fences." : "";
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = (err as Error)?.name;
    throw new ProviderError(name === "TimeoutError" || name === "AbortError" ? "timeout" : `network error (${(err as Error)?.message ?? err})`, true);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const retryAfter = Number(res.headers.get("retry-after"));
    const retryable = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
    throw new ProviderError(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`, retryable, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
  }
  return res.json();
}

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const SERVER_FALLBACK_MODELS = ["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"];

function anthropicProvider(apiKey: string): ProviderCall {
  return async (req, { model, timeoutMs }) => {
    const system: { type: "text"; text: string; cache_control?: { type: "ephemeral" } }[] = [];
    // Stable prefix first, marked for caching; per-call instructions after it.
    if (req.cachePrefix) system.push({ type: "text", text: req.cachePrefix, cache_control: { type: "ephemeral" } });
    const sys = (req.system ?? "") + jsonInstruction(req);
    if (sys.trim()) system.push({ type: "text", text: sys });
    const useFallback = SERVER_FALLBACK_MODELS.includes(model);
    const body: Record<string, unknown> = {
      model,
      max_tokens: req.maxTokens ?? (req.tier === "frontier" ? 16000 : 4000),
      messages: req.messages,
      output_config: { effort: req.tier === "frontier" ? "medium" : "low" },
    };
    if (system.length) body.system = system;
    if (useFallback) body.fallbacks = "default";
    const headers: Record<string, string> = { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
    if (useFallback) headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    const data = await postJson("https://api.anthropic.com/v1/messages", headers, body, timeoutMs);
    if (data.stop_reason === "refusal") throw new ProviderError(`declined (${data.stop_details?.category ?? "policy"})`, false);
    const text = (data.content ?? [])
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text)
      .join("");
    const u = data.usage ?? {};
    const served = String(data.model ?? model);
    const usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0 };
    return { text, tokensIn: usage.input + usage.cacheWrite + usage.cacheRead, tokensOut: usage.output, costUsd: costOf("anthropic", served, usage), model: served };
  };
}

function openaiProvider(apiKey: string | undefined, baseUrl: string | undefined): ProviderCall {
  const base = (baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const isOpenAi = /api\.openai\.com/.test(base);
  return async (req, { model, timeoutMs }) => {
    const system = [req.cachePrefix, (req.system ?? "") + jsonInstruction(req)].filter((s) => s && s.trim()).join("\n\n");
    const messages = [...(system ? [{ role: "system", content: system }] : []), ...req.messages];
    const maxTokens = req.maxTokens ?? (req.tier === "frontier" ? 16000 : 4000);
    const body: Record<string, unknown> = { model, messages, ...(isOpenAi ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }) };
    if (req.json) body.response_format = { type: "json_object" };
    const data = await postJson(`${base}/chat/completions`, apiKey ? { authorization: `Bearer ${apiKey}` } : {}, body, timeoutMs);
    const text = data.choices?.[0]?.message?.content ?? "";
    const u = data.usage ?? {};
    const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
    const usage = { input: Math.max(0, (u.prompt_tokens ?? 0) - cached), output: u.completion_tokens ?? 0, cacheRead: cached };
    const served = String(data.model ?? model);
    return { text, tokensIn: u.prompt_tokens ?? 0, tokensOut: usage.output, costUsd: costOf("openai", served, usage), model: served };
  };
}

function ollamaProvider(url: string): ProviderCall {
  const base = url.replace(/\/+$/, "");
  return async (req, { model, timeoutMs }) => {
    const system = [req.cachePrefix, (req.system ?? "") + jsonInstruction(req)].filter((s) => s && s.trim()).join("\n\n");
    const body: Record<string, unknown> = {
      model,
      stream: false,
      messages: [...(system ? [{ role: "system", content: system }] : []), ...req.messages],
      options: { num_predict: req.maxTokens ?? (req.tier === "frontier" ? 8000 : 2000) },
    };
    if (req.json) body.format = "json";
    const data = await postJson(`${base}/api/chat`, {}, body, timeoutMs);
    return { text: data.message?.content ?? "", tokensIn: data.prompt_eval_count ?? 0, tokensOut: data.eval_count ?? 0, costUsd: 0, model };
  };
}

/**
 * The offline provider: no network, fully deterministic. Agent code checks
 * `client.offline` and uses its own template and heuristic generators instead
 * of prompting; this `complete` is the safety net for modules that call it
 * anyway: JSON requests get `{}`, text requests get an extractive summary of
 * the last user message (its most informative sentences).
 */
export function offlineComplete(req: ModelRequest): ModelResponse {
  const last = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  let text: string;
  if (req.json) text = "{}";
  else {
    const sentences = last
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 20 && s.length < 400);
    const score = (s: string) => (s.match(/\d/g)?.length ?? 0) * 2 + new Set(s.toLowerCase().match(/[a-z]{5,}/g) ?? []).size;
    const budgetWords = Math.max(20, Math.min(120, Math.floor((req.maxTokens ?? 200) * 0.7)));
    const picked: string[] = [];
    let words = 0;
    for (const s of [...sentences].sort((a, b) => score(b) - score(a))) {
      const n = s.split(" ").length;
      if (words + n > budgetWords && picked.length) break;
      picked.push(s);
      words += n;
    }
    // Keep original order so the summary reads naturally.
    text = picked.sort((a, b) => sentences.indexOf(a) - sentences.indexOf(b)).join(" ") || last.slice(0, 280);
  }
  return { text, tokensIn: 0, tokensOut: 0, costUsd: 0, model: "offline", provider: "offline" };
}

// ---------- Client with retries and failover ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ChainOptions {
  /** Retries per provider for retryable errors (429, 5xx, timeouts). */
  retries?: number;
  baseDelayMs?: number;
  timeoutMs?: { frontier: number; fast: number };
  /** Test seam: replace the HTTP calls. */
  calls?: Partial<Record<ProviderName, ProviderCall>>;
}

export function createClient(models: Config["models"], opts: ChainOptions = {}): ModelClient {
  const chain = providerChain(models);
  if (chain[0]!.name === "offline") return { offline: true, complete: async (req) => offlineComplete(req) };
  const calls: Partial<Record<ProviderName, ProviderCall>> = {
    anthropic: models.anthropicKey ? anthropicProvider(models.anthropicKey) : undefined,
    openai: models.openaiKey || models.openaiBaseUrl ? openaiProvider(models.openaiKey, models.openaiBaseUrl) : undefined,
    ollama: models.ollamaUrl ? ollamaProvider(models.ollamaUrl) : undefined,
    ...opts.calls,
  };
  const retries = opts.retries ?? 2;
  const baseDelay = opts.baseDelayMs ?? 400;
  const timeouts = opts.timeoutMs ?? { frontier: 180_000, fast: 45_000 };
  return {
    offline: false,
    async complete(req) {
      const failed: string[] = [];
      for (const spec of chain) {
        const call = calls[spec.name];
        if (!call) continue;
        const model = req.tier === "frontier" ? spec.frontier : spec.fast;
        for (let attempt = 0; ; attempt++) {
          try {
            const r = await call(req, { model, timeoutMs: timeouts[req.tier] });
            return { ...r, provider: spec.name, ...(failed.length ? { failover: failed } : {}) };
          } catch (err) {
            const e = err instanceof ProviderError ? err : new ProviderError(String((err as Error)?.message ?? err), false);
            if (e.retryable && attempt < retries) {
              const backoff = Math.min(e.retryAfterMs ?? baseDelay * 2 ** attempt, 20_000);
              await sleep(backoff + Math.floor(Math.random() * 100));
              continue;
            }
            failed.push(`${spec.name}: ${e.message.slice(0, 120)}`);
            break;
          }
        }
      }
      throw new ModelUnavailableError(failed);
    },
  };
}

// ---------- modelFor(ctx) ----------

let installedModels: Config["models"] | null = null;
let cached: ModelClient | null = null;
let override: ((ctx: Ctx) => ModelClient) | null = null;

/** Called once at install with the runtime's config. */
export function configureModels(models: Config["models"]) {
  installedModels = models;
  cached = null;
}

/** Test seam: make modelFor return a fake client (pass null to restore). */
export function setModelClientForTests(fn: ((ctx: Ctx) => ModelClient) | null) {
  override = fn;
}

/** The model client for a call. Works from any Ctx; with no config or keys it is the offline provider. */
export function modelFor(ctx: Ctx): ModelClient {
  if (override) return override(ctx);
  if (!installedModels) return { offline: true, complete: async (req) => offlineComplete(req) };
  cached ??= createClient(installedModels);
  return cached;
}

/** Which provider and models the install would use, for estimates and the run timeline. */
export function primaryProvider(): ProviderSpec {
  return installedModels ? providerChain(installedModels)[0]! : { name: "offline", frontier: "offline", fast: "offline" };
}

/** Estimated cost of one call for this ctx's client (0 when offline). */
export function estimateCall(ctx: Ctx, tier: "frontier" | "fast", tokensIn: number, tokensOut: number): number {
  if (modelFor(ctx).offline) return 0;
  // A client injected for tests has no configured provider: price it like the Anthropic defaults.
  const p = primaryProvider();
  const spec: ProviderSpec = p.name === "offline" ? { name: "anthropic", ...DEFAULT_MODELS.anthropic } : p;
  return estimateCost(spec.name, tier === "frontier" ? spec.frontier : spec.fast, tokensIn, tokensOut);
}

/** Pulls the first JSON object out of a model reply (tolerates code fences and prose around it). */
export function parseJson<T = any>(text: string): T | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    /* fall through */
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as T;
    } catch {
      return null;
    }
  }
  return null;
}
