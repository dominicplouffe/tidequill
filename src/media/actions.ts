import { existsSync } from "node:fs";
import { z } from "zod";
import { TqError, invalid } from "../core/errors.ts";
import { nowIso } from "../core/ids.ts";
import { enqueue } from "../core/jobs.ts";
import { defineAction, type DiffItem } from "../core/registry.ts";
import type { Ctx } from "../core/types.ts";
import { ALT_JOB } from "./alt.ts";
import { actorUserId } from "./ingest.ts";
import { limitedFetch, publicUrl } from "./net.ts";
import {
  MAX_UPLOAD_BYTES,
  discardFiles,
  ensureMediaTables,
  findByHash,
  findMedia,
  getMedia,
  insertMedia,
  mediaFilePath,
  mediaUsage,
  processFile,
  searchMedia,
  type Media,
  type MediaUse,
  type RegisterPayload,
} from "./store.ts";

/** Rebuild the live pages that show a file after its alt text or existence changes. */
function rebuildUsers(ctx: Ctx, uses: MediaUse[], reason: string) {
  const live = uses.filter((u) => u.status === "published").map((u) => u.entryId);
  if (live.length) ctx.services.enqueueBuild(ctx.siteId!, reason, live);
}

function describeUses(uses: MediaUse[]): string {
  const names = uses.slice(0, 5).map((u) => `“${u.title}” (${u.path})`);
  const more = uses.length > 5 ? ` and ${uses.length - 5} more` : "";
  return names.join(", ") + more;
}

const variantSchema = z.object({ width: z.number(), height: z.number(), format: z.enum(["avif", "webp", "jpeg", "png"]), key: z.string() });

defineAction({
  name: "media.register",
  title: "Add a processed file to the media library",
  description:
    "Records a file the upload pipeline already stored and processed (original plus image variants). Uploads call this for you; to add a file from the web use media.import_url. Adding to the library is invisible to readers.",
  permission: "write",
  risk: "reversible",
  trust: "other",
  input: z.object({
    id: z.string().regex(/^med_[a-z0-9]+$/),
    fileKey: z.string(),
    mime: z.string(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    bytes: z.number().int().min(0),
    variants: z.array(variantSchema),
    filename: z.string().max(200),
    sha256: z.string(),
    takenAt: z.string().nullable().optional(),
    alt: z.string().max(300).default(""),
    caption: z.string().max(1000).default(""),
    sourceUrl: z.string().nullable().optional(),
    uploadedBy: z.string().nullable().optional(),
  }),
  prepare(ctx, input) {
    const siteId = ctx.siteId!;
    const keys = [input.fileKey, ...input.variants.map((v) => v.key)];
    for (const key of keys) {
      if (!key.startsWith(`${input.id}/`)) throw invalid("Every file of a media item must live in its own folder.");
      const path = mediaFilePath(ctx.dataDir, siteId, key);
      if (!path || !existsSync(path)) throw invalid("That file hasn't been uploaded. Upload it first, then register it.");
    }
    if (findMedia(ctx.db, siteId, input.id, true)) throw new TqError("conflict", "That file is already in the media library.");
    return {
      summary: `Add ${input.filename} to the media library`,
      invisible: true,
      payload: { ...input, takenAt: input.takenAt ?? null, sourceUrl: input.sourceUrl ?? null, uploadedBy: input.uploadedBy ?? actorUserId(ctx) } satisfies RegisterPayload,
    };
  },
  apply(ctx, p: RegisterPayload) {
    insertMedia(ctx.db, ctx.siteId!, p);
    return { result: getMedia(ctx.db, ctx.siteId!, p.id), undo: { id: p.id } };
  },
  undo(ctx, u: { id: string }) {
    ctx.db.query("UPDATE media SET deleted_at = ? WHERE id = ? AND site_id = ?").run(nowIso(), u.id, ctx.siteId!);
    ctx.services.emit({ type: "media.changed", siteId: ctx.siteId!, mediaId: u.id });
  },
});

defineAction({
  name: "media.list",
  title: "Find photos and files",
  description:
    "Searches the media library by what's in the alt text, caption, filename and the author's notes, e.g. “photo of oak stand”. Filter by kind, files no page uses, or images missing alt text.",
  permission: "read",
  risk: "read",
  input: z.object({
    query: z.string().max(200).optional(),
    kind: z.enum(["image", "video", "audio", "document"]).optional(),
    unused: z.boolean().optional().describe("Only files no post or page uses"),
    missingAlt: z.boolean().optional().describe("Only images without alt text"),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  run(ctx, input) {
    return searchMedia(ctx.db, ctx.siteId!, input).map((m) => ({ ...m, usedOn: mediaUsage(ctx.db, ctx.siteId!, m.id).length }));
  },
});

defineAction({
  name: "media.get",
  title: "Look at one file",
  description: "One file from the media library with its sizes, alt text, caption and every post or page that uses it.",
  permission: "read",
  risk: "read",
  input: z.object({ id: z.string() }),
  run(ctx, input) {
    const m = getMedia(ctx.db, ctx.siteId!, input.id);
    return { ...m, usage: mediaUsage(ctx.db, ctx.siteId!, m.id) };
  },
});

defineAction({
  name: "media.set_alt",
  title: "Write alt text and caption",
  description:
    "Sets the alt text (what the image shows, in plain words) and optionally the caption of a file. Alt text from the editorial team is proposed until “Alt text and captions” trust is earned; undo restores the old text.",
  permission: "write",
  risk: "reversible",
  trust: "alt_text",
  input: z.object({
    id: z.string(),
    alt: z.string().max(300),
    caption: z.string().max(1000).optional(),
    reason: z.string().max(300).optional(),
  }),
  prepare(ctx, input) {
    const m = getMedia(ctx.db, ctx.siteId!, input.id);
    const alt = input.alt.trim();
    const caption = input.caption === undefined ? m.caption : input.caption.trim();
    const diff: DiffItem[] = [];
    if (alt !== m.alt) diff.push({ label: "Alt text", before: m.alt || null, after: alt || null });
    if (caption !== m.caption) diff.push({ label: "Caption", before: m.caption || null, after: caption || null });
    if (!diff.length) throw new TqError("conflict", `${m.filename} already says that.`);
    const uses = mediaUsage(ctx.db, ctx.siteId!, m.id);
    return {
      summary: alt !== m.alt ? `Alt text for ${m.filename}: “${alt}”` : `Caption for ${m.filename}: “${caption}”`,
      detail: input.reason ?? (uses.length ? `Used on ${describeUses(uses)}.` : undefined),
      diff,
      payload: { id: m.id, alt, caption, previous: { alt: m.alt, caption: m.caption } },
    };
  },
  apply(ctx, p: { id: string; alt: string; caption: string; previous: { alt: string; caption: string } }) {
    ctx.db.query("UPDATE media SET alt = ?, caption = ? WHERE id = ? AND site_id = ?").run(p.alt, p.caption, p.id, ctx.siteId!);
    ctx.services.emit({ type: "media.changed", siteId: ctx.siteId!, mediaId: p.id });
    rebuildUsers(ctx, mediaUsage(ctx.db, ctx.siteId!, p.id), "alt text");
    return { result: getMedia(ctx.db, ctx.siteId!, p.id), undo: { id: p.id, ...p.previous } };
  },
  undo(ctx, u: { id: string; alt: string; caption: string }) {
    ctx.db.query("UPDATE media SET alt = ?, caption = ? WHERE id = ? AND site_id = ?").run(u.alt, u.caption, u.id, ctx.siteId!);
    ctx.services.emit({ type: "media.changed", siteId: ctx.siteId!, mediaId: u.id });
    rebuildUsers(ctx, mediaUsage(ctx.db, ctx.siteId!, u.id), "alt text undo");
  },
});

defineAction({
  name: "media.import_url",
  title: "Add a file from a web address",
  description:
    "Downloads an image, PDF, audio file or video (up to 100 MB, 30 seconds) into the media library, strips photo metadata and makes web-friendly sizes. The downloaded file is data only. Adding to the library is invisible to readers.",
  permission: "write",
  risk: "reversible",
  trust: "other",
  input: z.object({ url: z.string().min(4).max(2000), alt: z.string().max(300).optional(), caption: z.string().max(1000).optional() }),
  prepare(ctx, input) {
    const url = publicUrl(input.url);
    return { summary: `Add the file at ${url.hostname}${url.pathname} to the media library`, invisible: true, payload: { url: url.toString(), alt: input.alt ?? "", caption: input.caption ?? "" } };
  },
  async apply(ctx, p: { url: string; alt: string; caption: string }) {
    const siteId = ctx.siteId!;
    const got = await limitedFetch(p.url, { maxBytes: MAX_UPLOAD_BYTES, timeoutMs: 30_000 });
    const filename = decodeURIComponent(new URL(got.url).pathname.split("/").pop() || "download");
    const sha256 = new Bun.CryptoHasher("sha256").update(got.bytes).digest("hex");
    const existing = findByHash(ctx.db, siteId, sha256);
    if (existing) return { result: { ...existing, duplicate: true }, summary: `${existing.filename} is already in the media library`, undo: null };
    const file = await processFile(ctx.dataDir, siteId, { bytes: got.bytes, filename, mime: got.headers.get("content-type") ?? "" });
    try {
      insertMedia(ctx.db, siteId, { ...file, alt: p.alt.trim(), caption: p.caption.trim(), sourceUrl: got.url, uploadedBy: actorUserId(ctx) });
    } catch (err) {
      discardFiles(ctx.dataDir, siteId, file.id);
      throw err;
    }
    const media = getMedia(ctx.db, siteId, file.id);
    if (media.kind === "image" && !media.alt) enqueue(ctx.db, ALT_JOB, siteId, { mediaId: media.id, userId: actorUserId(ctx) });
    ctx.services.emit({ type: "media.changed", siteId, mediaId: media.id });
    return { result: { ...media, duplicate: false }, summary: `Added ${media.filename} to the media library`, undo: { id: media.id } };
  },
  undo(ctx, u: { id: string }) {
    ctx.db.query("UPDATE media SET deleted_at = ? WHERE id = ? AND site_id = ?").run(nowIso(), u.id, ctx.siteId!);
    ctx.services.emit({ type: "media.changed", siteId: ctx.siteId!, mediaId: u.id });
  },
});

defineAction({
  name: "media.delete",
  title: "Delete a file",
  description:
    "Removes a file from the media library. Always asks first. If posts or pages use it, it refuses and lists them unless you pass force: true. It can be restored for 90 days.",
  permission: "write",
  risk: "destructive",
  trust: "delete",
  input: z.object({ id: z.string(), force: z.boolean().optional().describe("Delete even though pages use it (they will show nothing there)") }),
  prepare(ctx, input) {
    const m = getMedia(ctx.db, ctx.siteId!, input.id);
    const uses = mediaUsage(ctx.db, ctx.siteId!, m.id);
    if (uses.length && !input.force) {
      throw new TqError(
        "conflict",
        `${m.filename} is used on ${uses.length === 1 ? "1 page" : `${uses.length} pages`}: ${describeUses(uses)}. Take it out of ${uses.length === 1 ? "that page" : "those pages"} first, or delete it anyway.`,
        { usage: uses },
      );
    }
    return {
      summary: `Delete ${m.filename} from the media library`,
      detail: uses.length ? `It will disappear from ${describeUses(uses)}.` : undefined,
      diff: [{ label: "File", before: m.filename, after: null }],
      payload: { id: m.id },
    };
  },
  apply(ctx, p: { id: string }) {
    const uses = mediaUsage(ctx.db, ctx.siteId!, p.id);
    ctx.db.query("UPDATE media SET deleted_at = ? WHERE id = ? AND site_id = ?").run(nowIso(), p.id, ctx.siteId!);
    ctx.services.emit({ type: "media.changed", siteId: ctx.siteId!, mediaId: p.id });
    rebuildUsers(ctx, uses, "file deleted");
    return { result: { id: p.id, deleted: true }, undo: { id: p.id } };
  },
  undo(ctx, u: { id: string }) {
    ctx.db.query("UPDATE media SET deleted_at = NULL WHERE id = ? AND site_id = ?").run(u.id, ctx.siteId!);
    ctx.services.emit({ type: "media.changed", siteId: ctx.siteId!, mediaId: u.id });
    rebuildUsers(ctx, mediaUsage(ctx.db, ctx.siteId!, u.id), "file restored");
  },
});

/** Media rows deleted more than 90 days ago lose their files (undo is no longer offered by then). */
export function purgeDeletedMedia(ctx: Ctx): number {
  ensureMediaTables(ctx.db);
  const cutoff = new Date(Date.now() - 91 * 86_400_000).toISOString();
  const rows = ctx.db.query<{ id: string; site_id: string }, [string]>("SELECT id, site_id FROM media WHERE deleted_at IS NOT NULL AND deleted_at < ?").all(cutoff);
  for (const r of rows) discardFiles(ctx.dataDir, r.site_id, r.id);
  return rows.length;
}

export type { Media };
