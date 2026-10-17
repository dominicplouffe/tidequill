import { existsSync, statSync } from "node:fs";
import type { Hono } from "hono";
import { effectiveRole } from "../auth/auth.ts";
import { TqError, invalid } from "../core/errors.ts";
import type { Runtime } from "../core/runtime.ts";
import { requestCtx, requireAuth, type Env } from "../server/app.ts";
import { ingest } from "./ingest.ts";
import { formatBytes } from "./net.ts";
import { MAX_UPLOAD_BYTES, mediaFilePath } from "./store.ts";

const PREVIEW_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  heic: "image/heic",
  tiff: "image/tiff",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  wav: "audio/wav",
  weba: "audio/webm",
  flac: "audio/flac",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  ogv: "video/ogg",
  avi: "video/x-msvideo",
};

export function mediaRoutes(app: Hono<Env>, _rt: Runtime) {
  /** Upload: multipart `file`, optional `alt` and `caption` → `{ media, duplicate }`. */
  app.post("/api/media", async (c) => {
    const ctx = requestCtx(c);
    if (!ctx.siteId) throw invalid("Pick a site first.");
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > MAX_UPLOAD_BYTES + 1024 * 1024) throw new TqError("invalid", `That upload is ${formatBytes(declared)}; the limit is ${formatBytes(MAX_UPLOAD_BYTES)}.`);
    const form = await c.req.formData().catch(() => {
      throw invalid("Send the file as a form upload (multipart/form-data) in a field called “file”.");
    });
    const file = form.get("file");
    if (!file || typeof file === "string") throw invalid("Choose a file to upload.");
    if (file.size > MAX_UPLOAD_BYTES) throw new TqError("invalid", `That file is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_UPLOAD_BYTES)}.`);
    const text = (name: string) => {
      const v = form.get(name);
      return typeof v === "string" ? v : undefined;
    };
    const { media, duplicate } = await ingest(ctx, { bytes: new Uint8Array(await file.arrayBuffer()), filename: file.name, mime: file.type, alt: text("alt"), caption: text("caption") });
    return c.json({ media, duplicate });
  });

  /** Admin preview of any file in a site's media folder, for signed-in members of that site. */
  app.get("/media/:siteId/*", (c) => {
    const auth = requireAuth(c);
    const rt = c.get("rt");
    const siteId = c.req.param("siteId");
    if (!effectiveRole(rt.db, auth, siteId)) throw new TqError("forbidden", "You don't have access to that site.");
    const prefix = `/media/${siteId}/`;
    let key: string;
    try {
      key = decodeURIComponent(c.req.path.slice(c.req.path.indexOf(prefix) + prefix.length));
    } catch {
      throw new TqError("not_found", "That file was not found.");
    }
    const path = key && !key.includes("\0") ? mediaFilePath(rt.config.dataDir, siteId, key) : null;
    if (!path || !existsSync(path) || !statSync(path).isFile()) throw new TqError("not_found", "That file was not found.");
    const ext = key.split(".").pop()!.toLowerCase();
    const headers: Record<string, string> = {
      "content-type": PREVIEW_TYPES[ext] ?? "application/octet-stream",
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
    };
    // Uploaded SVGs can carry scripts; never let them run on the admin host.
    if (ext === "svg") headers["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    if (!PREVIEW_TYPES[ext]) headers["content-disposition"] = "attachment";
    return new Response(Bun.file(path), { headers });
  });
}
