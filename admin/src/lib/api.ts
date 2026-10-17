import type { AskContext, AskMessage, CommandResult, InvokeOptions, InvokeResult, RunStatus } from "./types.ts";

/**
 * The one HTTP client. Every change goes through POST /api/actions/:name.
 * Server error messages are written for people, so they are shown verbatim.
 */

export class ApiError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(code: string, message: string, status = 0, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
  get offline() {
    return this.code === "offline";
  }
}

const SITE_KEY = "tq.site";
let siteId: string | null = readSite();
let unauthorizedHandler: (() => void) | null = null;

function readSite(): string | null {
  try {
    return localStorage.getItem(SITE_KEY);
  } catch {
    return null;
  }
}

export function getSiteId() {
  return siteId;
}

export function setSiteId(id: string | null) {
  siteId = id;
  try {
    if (id) localStorage.setItem(SITE_KEY, id);
    else localStorage.removeItem(SITE_KEY);
  } catch {
    /* private mode */
  }
}

export function onUnauthorized(fn: () => void) {
  unauthorizedHandler = fn;
}

function headers(json: boolean, site: string | null | undefined): HeadersInit {
  const h: Record<string, string> = { accept: "application/json" };
  if (json) h["content-type"] = "application/json";
  if (site) h["x-tq-site"] = site;
  return h;
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    if (res.status === 401) unauthorizedHandler?.();
    const err = body?.error;
    if (err?.message) throw new ApiError(err.code ?? "failed", err.message, res.status, err.details);
    if (res.status === 404) throw new ApiError("not_found", "That isn't available on this server yet.", 404);
    throw new ApiError("failed", "Something went wrong on our side. Nothing was changed. Try again.", res.status);
  }
  return body as T;
}

export interface RequestOptions {
  site?: string | null;
  signal?: AbortSignal;
  keepalive?: boolean;
}

export async function request<T = any>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const site = opts.site === undefined ? siteId : opts.site;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: headers(body !== undefined && !(body instanceof FormData), site),
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      signal: opts.signal,
      keepalive: opts.keepalive,
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    throw new ApiError("offline", "Can't reach Tidequill right now. Check your connection; nothing was changed.");
  }
  return parse<T>(res);
}

export const get = <T = any>(path: string, opts?: RequestOptions) => request<T>("GET", path, undefined, opts);
export const post = <T = any>(path: string, body?: unknown, opts?: RequestOptions) => request<T>("POST", path, body ?? {}, opts);
export const del = <T = any>(path: string, opts?: RequestOptions) => request<T>("DELETE", path, undefined, opts);

/** Runs any action. */
export function action<R = any>(name: string, input: unknown = {}, options: InvokeOptions & RequestOptions = {}): Promise<InvokeResult<R>> {
  const { site, signal, keepalive, ...invokeOpts } = options;
  return post<InvokeResult<R>>(`/api/actions/${encodeURIComponent(name)}`, { input, options: invokeOpts }, { site, signal, keepalive });
}

/** Runs a read or command action and returns its result. */
export async function read<R = any>(name: string, input: unknown = {}, options: RequestOptions = {}): Promise<R> {
  const res = await action<R>(name, input, options);
  if (res.status === "done" || res.status === "applied") return res.result;
  return res as unknown as R;
}

// ---------- Auth ----------

export const auth = {
  setupStatus: () => get<{ needsSetup: boolean }>("/api/setup", { site: null }),
  setup: (email: string, name: string, password: string) => post<{ user: any }>("/api/setup", { email, name, password }, { site: null }),
  login: (email: string, password: string) => post<{ user: any }>("/api/auth/login", { email, password }, { site: null }),
  logout: () => post("/api/auth/logout", {}, { site: null }),
  acceptInvite: (token: string, password: string, name?: string) => post<{ user: any }>("/api/auth/accept-invite", { token, password, name }, { site: null }),
  me: () => get<{ user: any; sites: any[] }>("/api/me", { site: null }),
};

// ---------- Ask ----------

export function ask(message: string, opts: { conversationId?: string; context?: AskContext; signal?: AbortSignal } = {}) {
  return post<{ conversationId: string; messages: AskMessage[] }>(
    "/api/ask",
    { conversationId: opts.conversationId, message, context: opts.context },
    { signal: opts.signal },
  );
}

export function conversation(id: string) {
  return get<{ conversationId: string; messages: AskMessage[] }>(`/api/ask/${encodeURIComponent(id)}`);
}

export function command(query: string, signal?: AbortSignal) {
  return post<CommandResult>("/api/command", { query }, { signal });
}

export function run(runId: string, signal?: AbortSignal) {
  return get<RunStatus>(`/api/runs/${encodeURIComponent(runId)}`, { signal });
}

/**
 * Polls a run until it is done, failed or paused. Backs off from 1 s to 4 s.
 * Resolves with the final status; calls `onUpdate` on every poll.
 */
export async function pollRun(runId: string, onUpdate: (r: RunStatus) => void, signal?: AbortSignal): Promise<RunStatus> {
  let delay = 1000;
  for (;;) {
    const r = await run(runId, signal);
    onUpdate(r);
    if (r.status === "done" || r.status === "failed" || r.status === "paused") return r;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, delay);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
    delay = Math.min(4000, delay * 1.5);
  }
}

// ---------- Uploads ----------

export function uploadMedia(file: Blob, meta: { alt?: string; caption?: string; filename?: string } = {}) {
  const fd = new FormData();
  fd.append("file", file, meta.filename ?? (file as File).name ?? "upload");
  if (meta.alt) fd.append("alt", meta.alt);
  if (meta.caption) fd.append("caption", meta.caption);
  return request<{ media: any }>("POST", "/api/media", fd);
}

export interface EvidenceInput {
  file?: Blob | null;
  filename?: string;
  kind: string;
  text?: string;
  authorId?: string;
  topic?: string;
}

export function uploadEvidence(ev: EvidenceInput, site?: string | null) {
  const fd = new FormData();
  if (ev.file) fd.append("file", ev.file, ev.filename ?? (ev.file as File).name ?? "capture");
  fd.append("kind", ev.kind);
  if (ev.text) fd.append("text", ev.text);
  if (ev.authorId) fd.append("authorId", ev.authorId);
  if (ev.topic) fd.append("topic", ev.topic);
  return request<{ evidence: any }>("POST", "/api/evidence", fd, { site });
}

/** Admin URL for a media file: /media/<siteId>/<key>. */
export function mediaUrl(media: any, site = siteId): string | null {
  if (!media) return null;
  if (typeof media.previewUrl === "string") return media.previewUrl;
  const key = media.fileKey ?? media.file_key ?? media.key;
  if (key && site) return `/media/${site}/${key}`;
  return typeof media.url === "string" ? media.url : null;
}

// ---------- Tokens (MCP) ----------

export const tokens = {
  list: () => get<any[]>("/api/tokens", { site: null }),
  create: (name: string, siteId?: string | null, role?: string | null) => post<{ token: string; note: string }>("/api/tokens", { name, siteId, role }, { site: null }),
  remove: (id: string) => del(`/api/tokens/${encodeURIComponent(id)}`, { site: null }),
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if ((err as Error)?.message) return (err as Error).message;
  return "Something went wrong. Nothing was changed.";
}
