import { TqError } from "../core/errors.ts";

/**
 * Outbound HTTP for media imports, WordPress migration and the free audit.
 * Everything fetched is data: it is size- and time-limited, never executed,
 * and never treated as instructions to an agent.
 */

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

let fetchImpl: FetchFn = (input, init) => fetch(input, init);

/** Replaces the fetch used by media, migrate and audit (tests inject a fake; nothing touches the network). */
export function setFetch(fn: FetchFn | null) {
  fetchImpl = fn ?? ((input, init) => fetch(input, init));
}

export function currentFetch(): FetchFn {
  return fetchImpl;
}

export const USER_AGENT = "Tidequill/0.1 (+https://tidequill.com/bot)";

/** Hostnames we refuse to fetch from: this machine and private networks. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h.includes(":")) {
    if (h.startsWith("::ffff:")) return isPrivateHost(h.slice(7));
    return h === "::1" || h === "::" || /^f[cd][0-9a-f]{0,2}:/.test(h) || h.startsWith("fe80:");
  }
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** Parses and checks a URL someone gave us. Only http(s) to public hosts. */
export function publicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim().match(/^https?:\/\//i) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    throw new TqError("invalid", `“${raw}” isn't a web address I can read. Use a full address like https://example.com/photo.jpg.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TqError("invalid", "Only http and https addresses can be fetched.");
  if (process.env.TQ_ALLOW_PRIVATE_FETCH !== "1" && isPrivateHost(url.hostname)) {
    throw new TqError("invalid", `${url.hostname} is a private address, so Tidequill won't fetch from it.`);
  }
  url.hash = "";
  return url;
}

export interface FetchedBody {
  url: string;
  status: number;
  headers: Headers;
  bytes: Uint8Array;
  /** Milliseconds until the response headers arrived. */
  ttfbMs: number;
}

export interface LimitedFetchOptions {
  maxBytes: number;
  timeoutMs: number;
  headers?: Record<string, string>;
  method?: string;
  /** Throw on non-2xx (default true). */
  requireOk?: boolean;
}

/** Fetches a URL with a byte cap and a timeout. Follows redirects (re-checking each hop is left to the platform's fetch). */
export async function limitedFetch(raw: string | URL, opts: LimitedFetchOptions): Promise<FetchedBody> {
  const url = typeof raw === "string" ? publicUrl(raw) : raw;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const started = performance.now();
  try {
    let res: Response;
    try {
      res = await fetchImpl(url.toString(), {
        method: opts.method ?? "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: { "user-agent": USER_AGENT, ...(opts.headers ?? {}) },
      });
    } catch (err) {
      if (controller.signal.aborted) throw new TqError("failed", `${url.hostname} took longer than ${Math.round(opts.timeoutMs / 1000)} seconds to answer.`);
      throw new TqError("failed", `I couldn't reach ${url.hostname} (${(err as Error).message ?? "network error"}).`);
    }
    const ttfbMs = Math.round(performance.now() - started);
    if (opts.requireOk !== false && !res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new TqError("failed", `${url.toString()} answered ${res.status}${res.statusText ? ` ${res.statusText}` : ""}.`, { status: res.status });
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > opts.maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new TqError("invalid", `That file is ${formatBytes(declared)}; the limit is ${formatBytes(opts.maxBytes)}.`);
    }
    const bytes = await readCapped(res, opts.maxBytes, controller);
    return { url: res.url || url.toString(), status: res.status, headers: res.headers, bytes, ttfbMs };
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res: Response, maxBytes: number, controller: AbortController): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let next: Awaited<ReturnType<typeof reader.read>>;
    try {
      next = await reader.read();
    } catch (err) {
      if (controller.signal.aborted) throw new TqError("failed", "The download took too long and was stopped.");
      throw err;
    }
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      controller.abort();
      throw new TqError("invalid", `That file is larger than ${formatBytes(maxBytes)}, the limit.`);
    }
    chunks.push(next.value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
