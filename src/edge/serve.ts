import { readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { brotliCompressSync, constants as zlib } from "node:zlib";
import { prefixUrls } from "../render/rewrite.ts";
import { ByteLru } from "./cache.ts";

/**
 * Serving one file: content type, ETag / If-None-Match, cache headers,
 * on-the-fly gzip or brotli (cached in memory), HEAD, and the optional
 * /_site/<id> prefix rewrite for previews.
 */

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".vtt": "text/vtt; charset=utf-8",
};

export function contentType(file: string): string {
  if (file.endsWith("feed.xml")) return "application/rss+xml; charset=utf-8";
  return TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}

const compressible = (type: string) => /^(text\/|application\/(json|xml|rss\+xml|javascript)|image\/svg)/.test(type);

const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "public, max-age=0, must-revalidate";

export function statFile(file: string): { size: number; mtimeMs: number } | null {
  try {
    const st = statSync(file);
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

function etagOf(st: { size: number; mtimeMs: number }, variant: string): string {
  return `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}${variant}"`;
}

function notModified(req: Request, etag: string): boolean {
  const inm = req.headers.get("if-none-match");
  if (!inm) return false;
  return inm.trim() === "*" || inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag.replace(/^W\//, ""));
}

function pickEncoding(req: Request): "br" | "gzip" | null {
  const accepted = new Set(
    (req.headers.get("accept-encoding") ?? "")
      .toLowerCase()
      .split(",")
      .map((part) => part.trim().split(";"))
      .filter(([, q]) => !q || Number(q.trim().replace(/^q=/, "")) > 0)
      .map(([name]) => name!.trim()),
  );
  const allowed = (name: string) => accepted.has(name) || accepted.has("*");
  if (allowed("br")) return "br";
  if (allowed("gzip")) return "gzip";
  return null;
}

const bodies = new ByteLru(96 * 1024 * 1024);

function compress(data: Uint8Array, enc: "br" | "gzip"): Uint8Array {
  if (enc === "gzip") return Bun.gzipSync(data as Uint8Array<ArrayBuffer>, { level: 9 });
  return new Uint8Array(brotliCompressSync(data, { params: { [zlib.BROTLI_PARAM_QUALITY]: 9, [zlib.BROTLI_PARAM_SIZE_HINT]: data.length } }));
}

export interface ServeOptions {
  status?: number;
  /** Preview mode: root-relative URLs in HTML get this prefix. */
  basePath?: string;
  immutable?: boolean;
  extraHeaders?: Record<string, string>;
}

export function serveFile(req: Request, file: string, st: { size: number; mtimeMs: number }, opts: ServeOptions = {}): Response {
  const type = contentType(file);
  const rewrite = !!opts.basePath && type.startsWith("text/html");
  const etag = etagOf(st, rewrite ? "-p" : "");
  const status = opts.status ?? 200;
  const headers: Record<string, string> = {
    "content-type": type,
    "cache-control": opts.immutable ? IMMUTABLE : REVALIDATE,
    etag,
    "x-content-type-options": "nosniff",
    ...opts.extraHeaders,
  };
  if (type.startsWith("text/html")) headers["referrer-policy"] = "strict-origin-when-cross-origin";
  const canCompress = compressible(type) && st.size > 256;
  if (canCompress) headers.vary = "Accept-Encoding";

  if (status === 200 && notModified(req, etag)) return new Response(null, { status: 304, headers });

  const enc = canCompress ? pickEncoding(req) : null;
  if (!enc && !rewrite) {
    // Straight from disk.
    headers["content-length"] = String(st.size);
    return new Response(req.method === "HEAD" ? null : Bun.file(file), { status, headers });
  }
  const key = `${file}|${etag}|${enc ?? "id"}|${opts.basePath ?? ""}`;
  let body = bodies.get(key);
  if (!body) {
    let raw: Uint8Array = readFileSync(file);
    if (rewrite) raw = Buffer.from(prefixUrls(raw.toString(), opts.basePath!));
    body = enc ? compress(raw, enc) : raw;
    bodies.set(key, body);
  }
  if (enc) headers["content-encoding"] = enc;
  headers["content-length"] = String(body.length);
  return new Response(req.method === "HEAD" ? null : (body as Uint8Array<ArrayBuffer>), { status, headers });
}

/**
 * Maps a request path to a file under `root`. Returns `{ redirect }` for a
 * directory requested without its trailing slash.
 */
export function resolvePath(root: string, path: string): { file: string; st: { size: number; mtimeMs: number } } | { redirect: string } | null {
  if (path.includes("\0") || path.includes("\\")) return null;
  const segments = path.split("/");
  if (segments.some((s) => s === ".." || (s.startsWith(".") && s !== ".well-known") || s.endsWith(".tmp"))) return null;
  if (path.endsWith("/")) {
    const file = join(root, path, "index.html");
    const st = statFile(file);
    return st ? { file, st } : null;
  }
  const file = join(root, path);
  const st = statFile(file);
  if (st) return { file, st };
  if (!extname(path) && statFile(join(root, path, "index.html"))) return { redirect: `${path}/` };
  return null;
}
