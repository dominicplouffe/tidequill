import { enqueue } from "../core/jobs.ts";
import { invoke } from "../core/registry.ts";
import type { Ctx } from "../core/types.ts";
import { ALT_JOB } from "./alt.ts";
import { discardFiles, findByHash, getMedia, insertMedia, processFile, type Media, type RegisterPayload } from "./store.ts";

/** The user a call is made for: the person, or the person an agent works for. */
export function actorUserId(ctx: Ctx): string | null {
  if (ctx.actor.kind === "human") return ctx.actor.userId;
  if (ctx.actor.kind === "agent") return ctx.actor.onBehalfOf;
  return null;
}

export interface IngestInput {
  bytes: Uint8Array;
  filename: string;
  mime?: string;
  alt?: string;
  caption?: string;
  sourceUrl?: string | null;
}

export interface IngestOptions {
  /** Insert the row directly instead of through `media.register` (used inside another action's apply or a job that records its own changes). */
  direct?: boolean;
  /** Queue AI alt text when an image arrives without it (default true). */
  altText?: boolean;
}

/**
 * The one upload pipeline: dedupe by content, store and strip, make variants,
 * register the row, and queue alt text. Used by uploads, evidence capture,
 * URL imports and WordPress migration.
 */
export async function ingest(ctx: Ctx, input: IngestInput, opts: IngestOptions = {}): Promise<{ media: Media; duplicate: boolean }> {
  const siteId = ctx.siteId;
  if (!siteId) throw new Error("ingest needs a site");
  const sha256 = new Bun.CryptoHasher("sha256").update(input.bytes).digest("hex");
  const existing = findByHash(ctx.db, siteId, sha256);
  if (existing) return { media: existing, duplicate: true };

  const file = await processFile(ctx.dataDir, siteId, { bytes: input.bytes, filename: input.filename, mime: input.mime });
  const payload: RegisterPayload = {
    ...file,
    alt: (input.alt ?? "").trim(),
    caption: (input.caption ?? "").trim(),
    sourceUrl: input.sourceUrl ?? null,
    uploadedBy: actorUserId(ctx),
  };
  try {
    if (opts.direct) insertMedia(ctx.db, siteId, payload);
    else await invoke(ctx, "media.register", payload);
  } catch (err) {
    discardFiles(ctx.dataDir, siteId, file.id);
    throw err;
  }
  const media = getMedia(ctx.db, siteId, file.id);
  if (opts.altText !== false && media.kind === "image" && !media.alt) {
    enqueue(ctx.db, ALT_JOB, siteId, { mediaId: media.id, userId: actorUserId(ctx) });
  }
  ctx.services.emit({ type: "media.changed", siteId, mediaId: media.id });
  return { media, duplicate: false };
}
