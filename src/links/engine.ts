import { docLinks } from "../content/blocks.ts";
import { plainInline } from "../content/blocks.ts";
import { entryPath, findEntry, listEntries, type Entry } from "../core/entries.ts";
import { invoke } from "../core/registry.ts";
import type { AgentRole, Ctx } from "../core/types.ts";
import { findAnchor, related, type DocInfo } from "./related.ts";

/**
 * The link graph (one row per inline link) and the internal linking engine
 * that runs when a post is published.
 */

/** Rebuilds the `links` rows of one entry, keeping check results for URLs that are still there. */
export function rebuildLinks(ctx: Ctx, entry: Entry) {
  const db = ctx.db;
  const previous = new Map(
    db
      .query<{ url: string; status: string; checked_at: string | null }, [string]>("SELECT url, status, checked_at FROM links WHERE from_entry_id = ? AND url IS NOT NULL")
      .all(entry.id)
      .map((r) => [r.url, r]),
  );
  db.transaction(() => {
    db.query("DELETE FROM links WHERE from_entry_id = ?").run(entry.id);
    if (entry.deletedAt) return;
    const insert = db.query("INSERT INTO links (site_id, from_entry_id, block_id, to_entry_id, url, anchor, status, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const l of docLinks(entry.body)) {
      if (l.entryId) insert.run(entry.siteId, entry.id, l.blockId, l.entryId, null, plainInline(l.anchor), "internal", null);
      else if (/^https?:\/\//i.test(l.href)) {
        const prev = previous.get(l.href);
        insert.run(entry.siteId, entry.id, l.blockId, null, l.href, plainInline(l.anchor), prev?.status ?? "unchecked", prev?.checked_at ?? null);
      }
    }
  })();
}

function headingsOf(e: Entry): string[] {
  return e.body.blocks.filter((b) => b.type === "heading").map((b) => plainInline((b as { text: string }).text));
}

export function docInfo(e: Entry): DocInfo {
  return { id: e.id, title: e.title, headings: headingsOf(e), categoryId: e.categoryId, tags: e.tags };
}

/** Published posts and pages that can be linked to: not the home page, not redirected away. */
export function linkableEntries(ctx: Ctx, siteId: string): Entry[] {
  const redirected = new Set(ctx.db.query<{ from_path: string }, [string]>("SELECT from_path FROM redirects WHERE site_id = ?").all(siteId).map((r) => r.from_path));
  return listEntries(ctx.db, siteId, { status: "published", limit: 2000 }).filter((e) => !(e.type === "page" && e.slug === "home") && !redirected.has(entryPath(e)));
}

/** Blocks a link may be added to: running text, not headings, tables or FAQs. */
export function linkableBlocks(e: Entry): { blockId: string; raw: string }[] {
  const out: { blockId: string; raw: string }[] = [];
  for (const b of e.body.blocks) {
    if (b.type === "paragraph") out.push({ blockId: b.id, raw: b.text });
    else if (b.type === "list") for (const item of b.items) out.push({ blockId: b.id, raw: item });
  }
  return out;
}

function linksTo(e: Entry, targetId: string): boolean {
  return docLinks(e.body).some((l) => l.entryId === targetId);
}

export interface OutgoingSuggestion {
  targetId: string;
  title: string;
  path: string;
  anchor: string;
  blockId: string;
  score: number;
}

export interface IncomingSuggestion {
  sourceId: string;
  title: string;
  path: string;
  anchor: string;
  blockId: string;
  score: number;
}

/** Links this entry could add to its most related published pages (one new link per paragraph). */
export function suggestOutgoing(ctx: Ctx, entry: Entry, limit = 3, pool?: Entry[]): OutgoingSuggestion[] {
  const candidates = (pool ?? linkableEntries(ctx, entry.siteId)).filter((e) => e.id !== entry.id && e.type === "post");
  if (!candidates.length) return [];
  const byId = new Map(candidates.map((e) => [e.id, e]));
  const ranked = related([docInfo(entry), ...candidates.map(docInfo)], entry.id, { limit: 20 });
  const blocks = linkableBlocks(entry);
  const usedBlocks = new Set<string>();
  const out: OutgoingSuggestion[] = [];
  for (const r of ranked) {
    if (out.length >= limit) break;
    const target = byId.get(r.id)!;
    if (linksTo(entry, target.id)) continue;
    const anchor = findAnchor(blocks, docInfo(target), { sourceTitle: entry.title, skipBlocks: usedBlocks });
    if (!anchor) continue;
    usedBlocks.add(anchor.blockId);
    out.push({ targetId: target.id, title: target.title, path: entryPath(target), anchor: anchor.anchor, blockId: anchor.blockId, score: Math.round(r.score * 1000) / 1000 });
  }
  return out;
}

/** Older published posts that could link to this entry, with the anchor each would use. */
export function suggestIncoming(ctx: Ctx, entry: Entry, limit = 5, pool?: Entry[]): IncomingSuggestion[] {
  const candidates = (pool ?? linkableEntries(ctx, entry.siteId)).filter((e) => e.id !== entry.id && e.type === "post");
  if (!candidates.length) return [];
  const byId = new Map(candidates.map((e) => [e.id, e]));
  const ranked = related([docInfo(entry), ...candidates.map(docInfo)], entry.id, { limit: 30 });
  const target = docInfo(entry);
  const out: IncomingSuggestion[] = [];
  for (const r of ranked) {
    if (out.length >= limit) break;
    const source = byId.get(r.id)!;
    if (linksTo(source, entry.id)) continue;
    const anchor = findAnchor(linkableBlocks(source), target, { sourceTitle: source.title });
    if (!anchor) continue;
    out.push({ sourceId: source.id, title: source.title, path: entryPath(source), anchor: anchor.anchor, blockId: anchor.blockId, score: Math.round(r.score * 1000) / 1000 });
  }
  return out;
}

/** A context acting as one of the editorial team's agents, on behalf of whoever triggered the work. */
export function agentCtx(ctx: Ctx, role: AgentRole): Ctx {
  const onBehalfOf = ctx.actor.kind === "human" ? ctx.actor.userId : ctx.actor.kind === "agent" ? ctx.actor.onBehalfOf : null;
  return { ...ctx, actor: { kind: "agent", role, onBehalfOf, runId: ctx.runId }, role: ctx.role ?? "writer" };
}

/** True when an identical change is already waiting on Today. */
export function pendingProposalExists(ctx: Ctx, actionName: string, match: Record<string, string>): boolean {
  const rows = ctx.db
    .query<{ input: string }, [string, string]>("SELECT input FROM proposals WHERE site_id = ? AND action_name = ? AND status = 'pending'")
    .all(ctx.siteId!, actionName);
  return rows.some((r) => {
    try {
      const input = JSON.parse(r.input) as Record<string, unknown>;
      return Object.entries(match).every(([k, v]) => input[k] === v);
    } catch {
      return false;
    }
  });
}

/**
 * After a first publish: link the new post to its closest relatives when it has
 * fewer than two internal links, and propose links to it from older posts.
 */
export async function linkOnPublish(ctx: Ctx, published: Entry) {
  if (published.type !== "post") return;
  const siteCtx = { ...ctx, siteId: published.siteId };
  const entry = findEntry(ctx.db, published.siteId, published.id) ?? published;
  const pool = linkableEntries(siteCtx, entry.siteId);
  const seo = agentCtx(siteCtx, "seo");

  const internal = docLinks(entry.body).filter((l) => l.entryId).length;
  if (internal < 2) {
    for (const s of suggestOutgoing(siteCtx, entry, Math.min(3, Math.max(1, 3 - internal)), pool)) {
      if (pendingProposalExists(siteCtx, "links.add", { id: entry.id, targetId: s.targetId })) continue;
      try {
        await invoke(seo, "links.add", { id: entry.id, targetId: s.targetId, anchor: s.anchor, blockId: s.blockId });
      } catch (err) {
        console.error("[tidequill] couldn't add a link:", (err as Error)?.message ?? err);
      }
    }
  }

  const older = pool.filter((e) => e.id !== entry.id && (!entry.publishedAt || !e.publishedAt || e.publishedAt <= entry.publishedAt));
  for (const s of suggestIncoming(siteCtx, entry, 5, older)) {
    if (pendingProposalExists(siteCtx, "links.add", { id: s.sourceId, targetId: entry.id })) continue;
    try {
      await invoke(seo, "links.add", { id: s.sourceId, targetId: entry.id, anchor: s.anchor, blockId: s.blockId });
    } catch (err) {
      console.error("[tidequill] couldn't propose a link:", (err as Error)?.message ?? err);
    }
  }
}

/** Published posts no other published page links to. */
export function orphans(ctx: Ctx, siteId: string): Entry[] {
  const linked = new Set(
    ctx.db
      .query<{ to_entry_id: string }, [string]>(
        `SELECT DISTINCT l.to_entry_id FROM links l JOIN entries e ON e.id = l.from_entry_id
         WHERE l.site_id = ? AND l.to_entry_id IS NOT NULL AND l.to_entry_id != l.from_entry_id AND e.status = 'published' AND e.deleted_at IS NULL`,
      )
      .all(siteId)
      .map((r) => r.to_entry_id),
  );
  return listEntries(ctx.db, siteId, { status: "published", type: "post", limit: 2000 }).filter((e) => !linked.has(e.id));
}
