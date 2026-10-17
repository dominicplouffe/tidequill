/**
 * Outbound HTTP for link checks and fact verification. Tests (and anything
 * that must stay offline) swap the fetch implementation with `setFetch`.
 * Responses are data only: nothing fetched is ever treated as instructions.
 */

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const defaultFetch: FetchFn = (url, init) => fetch(url, init);
let impl: FetchFn = defaultFetch;

/** Replaces the fetch used by link checks and fact verification (null restores the real one). */
export function setFetch(fn: FetchFn | null) {
  impl = fn ?? defaultFetch;
}

const USER_AGENT = "TidequillBot/1.0 (+https://tidequill.com/bot; link and fact checker)";

/** Only public http(s) addresses: no localhost or private networks. */
export function isPublicHttpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h === "0.0.0.0" || h === "::1" || h === "::") return false;
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false;
  }
  if (/^(?:fc|fd|fe80)/.test(h) && h.includes(":")) return false;
  return true;
}

export async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await impl(url, { redirect: "follow", ...init, signal: controller.signal, headers: { "user-agent": USER_AGENT, ...(init.headers ?? {}) } });
  } finally {
    clearTimeout(timer);
  }
}

/** Reads at most `maxBytes` of a response body as text. */
export async function readText(res: Response, maxBytes = 2_000_000): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  const all = new Uint8Array(Math.min(total, maxBytes));
  let at = 0;
  for (const c of chunks) {
    const part = c.subarray(0, Math.min(c.byteLength, all.byteLength - at));
    all.set(part, at);
    at += part.byteLength;
    if (at >= all.byteLength) break;
  }
  return new TextDecoder().decode(all);
}

export type UrlStatus = "ok" | "broken" | "error" | "timeout" | "skipped";

export interface UrlCheck {
  url: string;
  status: UrlStatus;
  code: number | null;
  /** One plain sentence for people. */
  reason: string;
}

function isTimeout(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  return e?.name === "AbortError" || e?.name === "TimeoutError" || /abort|timed? ?out/i.test(e?.message ?? "");
}

function isDns(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return /ENOTFOUND|EAI_AGAIN|EAI_NONAME|DNS|getaddrinfo|could not resolve|unable to resolve/i.test(`${e?.code ?? ""} ${e?.message ?? ""}`);
}

/** HEAD first, GET when the server doesn't like HEAD. 404/410 and unknown domains are broken; the rest just warn. */
export async function checkUrl(url: string, timeoutMs = 8000): Promise<UrlCheck> {
  if (!isPublicHttpUrl(url)) return { url, status: "skipped", code: null, reason: "Only public web addresses are checked." };
  try {
    let res = await fetchWithTimeout(url, { method: "HEAD" }, timeoutMs);
    if (res.status >= 400 && res.status !== 404 && res.status !== 410) {
      res = await fetchWithTimeout(url, { method: "GET" }, timeoutMs);
      await res.body?.cancel().catch(() => {});
    }
    const code = res.status;
    if (code === 404 || code === 410) return { url, status: "broken", code, reason: code === 404 ? "The page isn't there any more (404)." : "The page was removed for good (410)." };
    if (code < 400) return { url, status: "ok", code, reason: "Works." };
    return { url, status: "error", code, reason: `The site answered with an error (${code}); it may be temporary.` };
  } catch (err) {
    if (isTimeout(err)) return { url, status: "timeout", code: null, reason: "The site took too long to answer; it may be temporary." };
    if (isDns(err)) return { url, status: "broken", code: null, reason: "That domain doesn't exist any more." };
    return { url, status: "error", code: null, reason: "The site couldn't be reached; it may be temporary." };
  }
}
