import { docLinks } from "../content/blocks.ts";
import { findAuthor } from "../core/authors.ts";
import { entryPath, type Entry } from "../core/entries.ts";
import type { Readiness } from "../core/hooks.ts";
import { getSite } from "../core/sites.ts";
import type { Ctx } from "../core/types.ts";
import { finalize, scoreEntry, type Check, type LinkTarget, type ScoreInput, type Scored } from "./score.ts";

/**
 * Loads what the scorers need from the database and adds the render module's
 * publish checks when that module is installed.
 */

export function factValues(ctx: Ctx, siteId: string): Record<string, string> {
  const rows = ctx.db.query<{ key: string; value: string }, [string]>("SELECT key, value FROM facts WHERE site_id = ? AND deleted_at IS NULL").all(siteId);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function scoreInput(ctx: Ctx, entry: Entry): ScoreInput {
  const db = ctx.db;
  const site = getSite(db, entry.siteId);
  const authors = entry.authorIds.map((a) => findAuthor(db, entry.siteId, a)).filter((a) => !!a);
  const inbound =
    db
      .query<{ n: number }, [string, string, string]>(
        `SELECT COUNT(DISTINCT l.from_entry_id) AS n FROM links l JOIN entries e ON e.id = l.from_entry_id
         WHERE l.site_id = ? AND l.to_entry_id = ? AND l.from_entry_id != ? AND e.status = 'published' AND e.deleted_at IS NULL`,
      )
      .get(entry.siteId, entry.id, entry.id)?.n ?? 0;
  const others = db
    .query<{ id: string; title: string }, [string, string]>("SELECT id, title FROM entries WHERE site_id = ? AND id != ? AND deleted_at IS NULL AND status != 'unpublished' AND type = 'post' LIMIT 1000")
    .all(entry.siteId, entry.id);

  const linkTargets: Record<string, LinkTarget> = {};
  const targetIds = [...new Set(docLinks(entry.body).map((l) => l.entryId).filter((x): x is string => !!x))];
  if (targetIds.length) {
    const rows = db
      .query<{ id: string; title: string; status: string; slug: string; type: string; deleted_at: string | null }, [string, string]>(
        "SELECT id, title, status, slug, type, deleted_at FROM entries WHERE site_id = ? AND id IN (SELECT value FROM json_each(?))",
      )
      .all(entry.siteId, JSON.stringify(targetIds));
    const redirected = new Set(db.query<{ from_path: string }, [string]>("SELECT from_path FROM redirects WHERE site_id = ?").all(entry.siteId).map((r) => r.from_path));
    for (const r of rows) {
      linkTargets[r.id] = r.deleted_at
        ? { status: "missing" }
        : { status: r.status as LinkTarget["status"], title: r.title, redirected: redirected.has(entryPath({ slug: r.slug, type: r.type as Entry["type"] })) };
    }
  }

  const mediaIds = entry.body.blocks.filter((b) => b.type === "image" && b.src.startsWith("media:")).map((b) => (b as { src: string }).src.slice(6));
  const mediaAlt = mediaIds.length
    ? Object.fromEntries(
        db
          .query<{ id: string; alt: string }, [string, string]>("SELECT id, alt FROM media WHERE site_id = ? AND id IN (SELECT value FROM json_each(?))")
          .all(entry.siteId, JSON.stringify(mediaIds))
          .map((r) => [r.id, r.alt]),
      )
    : undefined;

  return {
    entry,
    authors: authors.map((a) => ({ name: a!.name, bio: a!.bio, isPersona: a!.isPersona, voice: a!.voice })),
    minimums: site.settings.readyMinimums,
    facts: factValues(ctx, entry.siteId),
    inboundLinks: inbound,
    others,
    linkTargets,
    mediaAlt,
  };
}

type RenderChecks = (ctx: Ctx, entryId: string) => unknown;
let renderChecks: RenderChecks | null | undefined;

/** The render module's publish checks, if it's installed (loaded lazily so quality works without it). */
async function loadRenderChecks(): Promise<RenderChecks | null> {
  if (renderChecks !== undefined) return renderChecks;
  try {
    const mod = await import(new URL("../render/checks.ts", import.meta.url).href);
    renderChecks = typeof mod.checkRenderedEntry === "function" ? mod.checkRenderedEntry : null;
  } catch {
    renderChecks = null;
  }
  return renderChecks ?? null;
}

/** Test hook: replace (or clear) the render checks. */
export function setRenderChecksForTests(fn: RenderChecks | null | undefined) {
  renderChecks = fn;
}

function normalizeChecks(raw: unknown): Check[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { checks?: unknown }).checks) ? (raw as { checks: unknown[] }).checks : [];
  return list
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object" && typeof (c as { name?: unknown }).name === "string")
    .map((c) => ({ name: String(c.name), passed: !!c.passed, message: String(c.message ?? ""), blocking: !!c.blocking }));
}

export async function computeReadiness(ctx: Ctx, entry: Entry, opts: { renderChecks?: boolean } = {}): Promise<Scored> {
  const scored = scoreEntry(scoreInput(ctx, entry));
  if (opts.renderChecks === false) return scored;
  const fn = await loadRenderChecks();
  if (!fn) return scored;
  let extra: Check[] = [];
  try {
    extra = normalizeChecks(await fn(ctx, entry.id));
  } catch (err) {
    extra = [{ name: "Rendered page", passed: false, blocking: false, message: "The rendered page couldn't be checked; try again in a minute." }];
    console.error("[tidequill] render checks failed:", (err as Error)?.message ?? err);
  }
  if (!extra.length) return scored;
  return finalize(scored.scores, scored.minimums, scored.findings, [...scored.checks, ...extra], scored.passed);
}

/** What core's `setReadinessCheck` gets: the Readiness shape plus per-area "passed" notes for the details panel. */
export function readinessFor(ctx: Ctx, entry: Entry): Promise<Readiness> {
  return computeReadiness(ctx, entry);
}
