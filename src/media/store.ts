import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { docMedia } from "../content/blocks.ts";
import type { Db } from "../core/db.ts";
import { json } from "../core/db.ts";
import { entryPath, rowToEntry } from "../core/entries.ts";
import { TqError } from "../core/errors.ts";
import { id, nowIso } from "../core/ids.ts";
import { formatBytes } from "./net.ts";

/**
 * The media library on disk and in the database.
 *
 * Files live at <dataDir>/media/<siteId>/<mediaId>/: `original.<ext>` (EXIF
 * stripped for images) plus responsive variants `w<width>.<format>`. The edge
 * serves `/media/<key>` straight from that folder; the admin previews
 * `/media/<siteId>/<key>`.
 */

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const VARIANT_WIDTHS = [480, 960, 1600] as const;

export type MediaKind = "image" | "video" | "audio" | "document";

export interface Variant {
  width: number;
  height: number;
  format: "avif" | "webp" | "jpeg" | "png";
  key: string;
}

export interface Media {
  id: string;
  siteId: string;
  kind: MediaKind;
  fileKey: string;
  mime: string;
  width: number | null;
  height: number | null;
  bytes: number;
  alt: string;
  caption: string;
  filename: string;
  sourceUrl: string | null;
  variants: Variant[];
  /** Public URL on the site's own domain. */
  url: string;
  /** Preview URL on the admin host (signed-in members only). */
  previewUrl: string;
  createdAt: string;
}

/** What the processing pipeline produced, before the row is registered. */
export interface ProcessedFile {
  id: string;
  fileKey: string;
  mime: string;
  width: number | null;
  height: number | null;
  bytes: number;
  variants: Variant[];
  filename: string;
  sha256: string;
  /** Date the photo was taken, read from EXIF before it was stripped. */
  takenAt: string | null;
}

// ---------- Module-owned table (filename, source, hash) ----------

const ready = new WeakSet<Db>();

/** Creates the media module's own side table. Idempotent and cheap after the first call per database. */
export function ensureMediaTables(db: Db) {
  if (ready.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS media_meta (
    media_id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    filename TEXT NOT NULL DEFAULT '',
    source_url TEXT,
    sha256 TEXT,
    uploaded_by TEXT,
    taken_at TEXT
  );
  CREATE INDEX IF NOT EXISTS media_meta_hash ON media_meta(site_id, sha256);`);
  ready.add(db);
}

// ---------- Paths and URLs ----------

export function siteMediaDir(dataDir: string, siteId: string): string {
  return join(dataDir, "media", siteId);
}

/** Resolves a key inside a site's media folder, refusing anything that escapes it. */
export function mediaFilePath(dataDir: string, siteId: string, key: string): string | null {
  const root = resolve(siteMediaDir(dataDir, siteId));
  const full = resolve(root, key);
  if (!full.startsWith(root + sep)) return null;
  return full;
}

export const publicMediaUrl = (key: string) => `/media/${key}`;
export const previewMediaUrl = (siteId: string, key: string) => `/media/${siteId}/${key}`;

// ---------- Types of files ----------

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/tiff": "tiff",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "weba",
  "audio/flac": "flac",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/ogg": "ogv",
  "video/x-msvideo": "avi",
};

const BY_EXT: Record<string, string> = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));
Object.assign(BY_EXT, { jpeg: "image/jpeg", jpe: "image/jpeg", tif: "image/tiff", webm: "video/webm", m4v: "video/mp4", oga: "audio/ogg", weba: "audio/webm" });

export function kindOf(mime: string): MediaKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

export function extFor(mime: string): string {
  return EXT[mime] ?? "bin";
}

function ascii(bytes: Uint8Array, start: number, len: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + len));
}

/** Detects the real file type from its first bytes; the browser's claim is only a fallback. */
export function sniffMime(bytes: Uint8Array, declared = "", filename = ""): string | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG") return "image/png";
  if (ascii(b, 0, 4) === "GIF8") return "image/gif";
  if (ascii(b, 0, 4) === "RIFF") {
    const t = ascii(b, 8, 4);
    if (t === "WEBP") return "image/webp";
    if (t === "WAVE") return "audio/wav";
    if (t === "AVI ") return "video/x-msvideo";
  }
  if (ascii(b, 4, 4) === "ftyp") {
    const brand = ascii(b, 8, 4).toLowerCase();
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (["heic", "heix", "hevc", "mif1", "msf1", "heif"].includes(brand)) return "image/heic";
    if (brand.startsWith("m4a") || brand === "m4b ") return "audio/mp4";
    if (brand === "qt  ") return "video/quicktime";
    return declared.startsWith("audio/") ? "audio/mp4" : "video/mp4";
  }
  if (ascii(b, 0, 5) === "%PDF-") return "application/pdf";
  if (ascii(b, 0, 3) === "ID3" || (b[0] === 0xff && b.length > 1 && (b[1]! & 0xe0) === 0xe0 && !declared.startsWith("image/"))) return "audio/mpeg";
  if (ascii(b, 0, 4) === "OggS") return declared.startsWith("video/") ? "video/ogg" : "audio/ogg";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return declared.startsWith("audio/") ? "audio/webm" : "video/webm";
  if (ascii(b, 0, 4) === "fLaC") return "audio/flac";
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a)) return "image/tiff";
  const head = new TextDecoder().decode(b.subarray(0, 512)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  const fromExt = BY_EXT[filename.toLowerCase().split(".").pop() ?? ""];
  const claim = declared.split(";")[0]!.trim().toLowerCase();
  if (claim && EXT[claim] && !claim.startsWith("image/")) return claim;
  if (fromExt && !fromExt.startsWith("image/")) return fromExt;
  return null;
}

export function assertAllowed(mime: string | null, filename: string): asserts mime is string {
  if (!mime) {
    throw new TqError("invalid", `I can't use “${filename || "that file"}”. Upload a photo (JPEG, PNG, WebP, AVIF, HEIC, GIF), a PDF, an audio file or a video.`);
  }
}

// ---------- The processing pipeline ----------

type Sharp = typeof import("sharp").default;
let sharpPromise: Promise<Sharp | null> | null = null;

/** sharp is a native module; if it can't load, uploads still work, just without variants. */
export function loadSharp(): Promise<Sharp | null> {
  sharpPromise ??= import("sharp")
    .then((m) => ((m as any).default ?? m) as Sharp)
    .catch((err) => {
      console.error("[tidequill] image processing is unavailable (sharp failed to load):", (err as Error).message);
      return null;
    });
  return sharpPromise;
}

const RASTER = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/heic", "image/heif", "image/tiff"]);

function exifDate(exif: Buffer | undefined): string | null {
  if (!exif) return null;
  const m = exif.toString("latin1").match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m || m[1] === "0000") return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * Stores a file and makes its variants. Writes only inside the new media
 * folder; if anything fails, the folder is removed.
 */
export async function processFile(dataDir: string, siteId: string, input: { bytes: Uint8Array; filename: string; mime?: string }): Promise<ProcessedFile> {
  if (input.bytes.byteLength === 0) throw new TqError("invalid", "That file is empty.");
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) throw new TqError("invalid", `That file is ${formatBytes(input.bytes.byteLength)}; the limit is ${formatBytes(MAX_UPLOAD_BYTES)}.`);
  const filename = cleanFilename(input.filename);
  const mime = sniffMime(input.bytes, input.mime ?? "", filename);
  assertAllowed(mime, filename);

  const mediaId = id("med");
  const dir = join(siteMediaDir(dataDir, siteId), mediaId);
  mkdirSync(dir, { recursive: true });
  const sha256 = new Bun.CryptoHasher("sha256").update(input.bytes).digest("hex");
  try {
    const sharp = RASTER.has(mime) ? await loadSharp() : null;
    if (sharp) {
      const image = await processImage(sharp, input.bytes, mime, mediaId, dir);
      if (image) return { ...image, id: mediaId, filename, sha256 };
    }
    // Everything else (and images sharp can't read) is stored as-is.
    let width: number | null = null;
    let height: number | null = null;
    if (mime.startsWith("image/") && mime !== "image/svg+xml") {
      const s = await loadSharp();
      const meta = s ? await s(input.bytes).metadata().catch(() => null) : null;
      width = meta?.width ?? null;
      height = meta?.height ?? null;
    }
    const key = `${mediaId}/original.${extFor(mime)}`;
    writeFileSync(join(dir, `original.${extFor(mime)}`), input.bytes);
    return { id: mediaId, fileKey: key, mime, width, height, bytes: input.bytes.byteLength, variants: [], filename, sha256, takenAt: null };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    if (err instanceof TqError) throw err;
    throw new TqError("invalid", `I couldn't read “${filename}” as ${kindOf(mime) === "image" ? "an image" : "a file"}. It may be damaged; try exporting it again.`);
  }
}

async function processImage(sharp: Sharp, bytes: Uint8Array, mime: string, mediaId: string, dir: string) {
  const meta = await sharp(bytes, { failOn: "none" }).metadata();
  const takenAt = exifDate(meta.exif);
  const hasAlpha = !!meta.hasAlpha;
  // Formats browsers show natively stay as they are; HEIC and TIFF become JPEG (or PNG with transparency).
  const keepFormat = mime === "image/jpeg" || mime === "image/png" || mime === "image/webp" || mime === "image/avif";
  const originalFormat: "jpeg" | "png" | "webp" | "avif" = keepFormat ? (mime.split("/")[1] as any) : hasAlpha ? "png" : "jpeg";
  const outMime = `image/${originalFormat}`;

  // rotate() applies the EXIF orientation; sharp writes no metadata unless asked, so EXIF and GPS are gone.
  const base = sharp(bytes, { failOn: "none" }).rotate();
  const original = await encode(base.clone(), originalFormat, 92).toBuffer({ resolveWithObject: true });
  const width = original.info.width;
  const height = original.info.height;
  const ext = extFor(outMime);
  writeFileSync(join(dir, `original.${ext}`), original.data);

  const fallback: "jpeg" | "png" = originalFormat === "png" || hasAlpha ? "png" : "jpeg";
  const widths = VARIANT_WIDTHS.filter((w) => w <= width);
  if (!widths.length) widths.push(width as (typeof VARIANT_WIDTHS)[number]);
  const variants: Variant[] = [];
  for (const w of widths) {
    const resized = base.clone().resize({ width: w, withoutEnlargement: true });
    for (const format of ["avif", "webp", fallback] as const) {
      const out = await encode(resized.clone(), format, format === "avif" ? 55 : 80).toBuffer({ resolveWithObject: true });
      const name = `w${w}.${format === "jpeg" ? "jpg" : format}`;
      writeFileSync(join(dir, name), out.data);
      variants.push({ width: out.info.width, height: out.info.height, format, key: `${mediaId}/${name}` });
    }
  }
  return { fileKey: `${mediaId}/original.${ext}`, mime: outMime, width, height, bytes: original.data.byteLength, variants, takenAt };
}

function encode(img: import("sharp").Sharp, format: "jpeg" | "png" | "webp" | "avif", quality: number) {
  switch (format) {
    case "jpeg":
      return img.jpeg({ quality, mozjpeg: true });
    case "png":
      return img.png({ compressionLevel: 9 });
    case "webp":
      return img.webp({ quality });
    case "avif":
      return img.avif({ quality, effort: 3 });
  }
}

export function cleanFilename(name: string): string {
  const base = (name || "file").split(/[\\/]/).pop()!.replace(/[\u0000-\u001f]/g, "").trim();
  return base.slice(0, 200) || "file";
}

/** Removes the files of a media item that was never registered. */
export function discardFiles(dataDir: string, siteId: string, mediaId: string) {
  if (!/^med_[a-z0-9]+$/.test(mediaId)) return;
  rmSync(join(siteMediaDir(dataDir, siteId), mediaId), { recursive: true, force: true });
}

// ---------- Rows ----------

export function rowToMedia(r: any): Media {
  return {
    id: r.id,
    siteId: r.site_id,
    kind: kindOf(r.mime),
    fileKey: r.file_key,
    mime: r.mime,
    width: r.width,
    height: r.height,
    bytes: r.bytes,
    alt: r.alt,
    caption: r.caption,
    filename: r.filename ?? r.file_key.split("/").pop(),
    sourceUrl: r.source_url ?? null,
    variants: json<Variant[]>(r.variants, []),
    url: publicMediaUrl(r.file_key),
    previewUrl: previewMediaUrl(r.site_id, r.file_key),
    createdAt: r.created_at,
  };
}

const SELECT = "SELECT m.*, mm.filename, mm.source_url, mm.sha256 FROM media m LEFT JOIN media_meta mm ON mm.media_id = m.id";

export function findMedia(db: Db, siteId: string, mediaId: string, includeDeleted = false): Media | null {
  ensureMediaTables(db);
  const r = db.query(`${SELECT} WHERE m.id = ? AND m.site_id = ?${includeDeleted ? "" : " AND m.deleted_at IS NULL"}`).get(mediaId, siteId);
  return r ? rowToMedia(r) : null;
}

export function getMedia(db: Db, siteId: string, mediaId: string): Media {
  const m = findMedia(db, siteId, mediaId.replace(/^media:/, ""));
  if (!m) throw new TqError("not_found", "That file isn't in the media library.");
  return m;
}

export function findByHash(db: Db, siteId: string, sha256: string): Media | null {
  ensureMediaTables(db);
  const r = db.query(`${SELECT} WHERE m.site_id = ? AND mm.sha256 = ? AND m.deleted_at IS NULL LIMIT 1`).get(siteId, sha256);
  return r ? rowToMedia(r) : null;
}

export interface RegisterPayload extends ProcessedFile {
  alt: string;
  caption: string;
  sourceUrl: string | null;
  uploadedBy: string | null;
}

export function insertMedia(db: Db, siteId: string, p: RegisterPayload) {
  ensureMediaTables(db);
  db.transaction(() => {
    db.query("INSERT INTO media (id, site_id, file_key, mime, width, height, bytes, alt, caption, variants, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      p.id,
      siteId,
      p.fileKey,
      p.mime,
      p.width,
      p.height,
      p.bytes,
      p.alt,
      p.caption,
      JSON.stringify(p.variants),
      nowIso(),
    );
    db.query("INSERT OR REPLACE INTO media_meta (media_id, site_id, filename, source_url, sha256, uploaded_by, taken_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      p.id,
      siteId,
      p.filename,
      p.sourceUrl,
      p.sha256,
      p.uploadedBy,
      p.takenAt,
    );
  })();
}

// ---------- Usage ----------

export interface MediaUse {
  entryId: string;
  title: string;
  path: string;
  status: string;
  as: "image" | "hero" | "evidence";
}

/** Which posts and pages use a file (image blocks, evidence blocks and hero images). */
export function mediaUsage(db: Db, siteId: string, mediaId: string): MediaUse[] {
  const rows = db
    .query("SELECT * FROM entries WHERE site_id = ? AND deleted_at IS NULL AND (hero_media_id = ? OR instr(body, ?) > 0)")
    .all(siteId, mediaId, mediaId)
    .map(rowToEntry);
  const out: MediaUse[] = [];
  for (const e of rows) {
    const inBody = docMedia(e.body).includes(mediaId);
    if (!inBody && e.heroMediaId !== mediaId) continue;
    const asEvidence = e.body.blocks.some((b) => b.type === "evidence" && b.media === mediaId);
    out.push({ entryId: e.id, title: e.title, path: entryPath(e), status: e.status, as: e.heroMediaId === mediaId ? "hero" : asEvidence ? "evidence" : "image" });
  }
  return out;
}

// ---------- Search ----------

const STOP = new Set(["a", "an", "the", "of", "in", "on", "at", "for", "with", "and", "or", "to", "my", "our", "some", "that", "this", "photo", "photos", "picture", "pictures", "image", "images", "pic", "shot", "file", "files", "show", "find", "me"]);
const KIND_WORDS: Record<string, MediaKind> = { photo: "image", photos: "image", picture: "image", pictures: "image", image: "image", images: "image", video: "video", videos: "video", clip: "video", audio: "audio", recording: "audio", pdf: "document", document: "document" };

function stem(w: string): string {
  return w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w;
}

/** Turns "IMG_2041-oak-stand.jpg" into searchable words. */
export function filenameWords(name: string): string {
  return name
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-.+]+/g, " ")
    .toLowerCase();
}

export interface MediaSearch {
  query?: string;
  kind?: MediaKind;
  unused?: boolean;
  missingAlt?: boolean;
  limit?: number;
}

/** Keyword search over alt text, captions, filenames and the evidence each file came with. */
export function searchMedia(db: Db, siteId: string, q: MediaSearch = {}): (Media & { score: number })[] {
  ensureMediaTables(db);
  const raw = (q.query ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let kind = q.kind;
  if (!kind) for (const w of raw) if (KIND_WORDS[w] && raw.length > 1) kind = KIND_WORDS[w];
  const words = raw.filter((w) => !STOP.has(w)).map(stem);
  const rows = db
    .query<any, [string]>(`${SELECT.replace("SELECT m.*", "SELECT m.*, (SELECT group_concat(e.text || ' ' || e.topic, ' ') FROM evidence e WHERE e.media_id = m.id AND e.deleted_at IS NULL) AS evidence_text")} WHERE m.site_id = ? AND m.deleted_at IS NULL ORDER BY m.created_at DESC`)
    .all(siteId);
  const out: (Media & { score: number })[] = [];
  for (const r of rows) {
    const m = rowToMedia(r);
    if (kind && m.kind !== kind) continue;
    if (q.missingAlt && (m.kind !== "image" || m.alt.trim())) continue;
    let score = 1;
    if (words.length) {
      const fields = [
        { text: m.alt.toLowerCase(), weight: 3 },
        { text: m.caption.toLowerCase(), weight: 2 },
        { text: filenameWords(m.filename), weight: 2 },
        { text: String(r.evidence_text ?? "").toLowerCase(), weight: 1 },
      ];
      score = 0;
      let matched = 0;
      for (const w of words) {
        const hit = fields.reduce((s, f) => s + (f.text.split(/[^a-z0-9]+/).some((t) => stem(t) === w || t.startsWith(w)) ? f.weight : 0), 0);
        if (hit) matched++;
        score += hit;
      }
      if (!matched) continue;
      // Files matching every word come first.
      score += matched === words.length ? 10 : 0;
    }
    out.push({ ...m, score });
  }
  let result = out.sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt));
  if (q.unused) result = result.filter((m) => mediaUsage(db, siteId, m.id).length === 0);
  return result.slice(0, q.limit ?? 50);
}
