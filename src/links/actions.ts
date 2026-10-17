import { z } from "zod";
import { docLinks, type Block, type Doc } from "../content/blocks.ts";
import { entryPath, findEntry, getEntry, type Entry } from "../core/entries.ts";
import { TqError, invalid } from "../core/errors.ts";
import { nowIso } from "../core/ids.ts";
import { defineAction, invoke } from "../core/registry.ts";
import type { Ctx } from "../core/types.ts";
import { applyPatch, preparePatch, replaceInBlock, undoPatch } from "../quality/patch.ts";
import { findUnprotected } from "../quality/text.ts";
import { agentCtx, linkableEntries, orphans, pendingProposalExists, suggestIncoming, suggestOutgoing } from "./engine.ts";
import { checkUrl, type UrlCheck } from "./http.ts";

/** Blocks a link can live in, in document order. */
const TEXT_BLOCKS = new Set<Block["type"]>(["paragraph", "list", "answer", "callout", "quote"]);

function inlineTexts(b: Block): string[] {
  if (b.type === "list") return b.items;
  if ("text" in b && typeof b.text === "string" && b.type !== "code" && b.type !== "heading") return [b.text];
  return [];
}

/** The section (heading to heading) a block belongs to. */
function sectionOf(d: Doc, blockId: string): Block[] {
  const i = d.blocks.findIndex((b) => b.id === blockId);
  if (i < 0) return [];
  let start = i;
  while (start > 0 && d.blocks[start]!.type !== "heading") start--;
  let end = i + 1;
  while (end < d.blocks.length && d.blocks[end]!.type !== "heading") end++;
  return d.blocks.slice(start, end);
}

function assertLinkable(ctx: Ctx, target: Entry) {
  if (target.status !== "published") throw invalid(`“${target.title}” isn't live, so nothing should link to it yet; publish it first.`);
  const redirected = ctx.db.query("SELECT 1 FROM redirects WHERE site_id = ? AND from_path = ?").get(target.siteId, entryPath(target));
  if (redirected) throw invalid(`“${target.title}” redirects somewhere else; link to the page it redirects to instead.`);
}

defineAction({
  name: "links.add",
  title: "Add an internal link",
  description: "Turns existing words in a post into a link to another live page on the site (descriptive anchor, at most one link to the same page per section).",
  permission: "write",
  risk: "reversible",
  trust: "links",
  input: z.object({
    id: z.string().describe("The post to add the link to"),
    targetId: z.string().describe("The live page to link to"),
    anchor: z.string().min(2).max(120).describe("Words already in the post that become the link"),
    blockId: z.string().optional(),
  }),
  prepare(ctx, input) {
    const entry = getEntry(ctx.db, ctx.siteId!, input.id);
    const target = getEntry(ctx.db, ctx.siteId!, input.targetId);
    if (entry.id === target.id) throw invalid("A page can't link to itself.");
    assertLinkable(ctx, target);
    if (/^(?:here|click here|this|read more|this post|link)$/i.test(input.anchor.trim())) throw invalid("Use words that say where the link goes, not “click here”.");
    const candidates = entry.body.blocks.filter((b) => TEXT_BLOCKS.has(b.type) && (!input.blockId || b.id === input.blockId));
    const block = candidates.find((b) => inlineTexts(b).some((t) => findUnprotected(t, input.anchor, true) >= 0));
    if (!block) throw invalid(`I couldn't find “${input.anchor}” as plain text in “${entry.title}”; pick words that are already there.`);
    if (sectionOf(entry.body, block.id).some((b) => inlineTexts(b).some((t) => t.includes(`(tq:${target.id})`)))) {
      throw invalid(`That section of “${entry.title}” already links to “${target.title}”; one link per section is enough.`);
    }
    const raw = inlineTexts(block).find((t) => findUnprotected(t, input.anchor, true) >= 0)!;
    const at = findUnprotected(raw, input.anchor, true);
    const actual = raw.slice(at, at + input.anchor.length);
    const after = replaceInBlock(entry.body, block.id, actual, `[${actual}](tq:${target.id})`, (t, n) => findUnprotected(t, n));
    if (!after) throw invalid(`I couldn't find “${input.anchor}” as plain text in “${entry.title}”; pick words that are already there.`);
    return preparePatch(entry, after, {
      summary: `Link “${actual}” in “${entry.title}” to “${target.title}”`,
      liveTrust: "links",
    });
  },
  apply: applyPatch,
  undo: undoPatch,
});

defineAction({
  name: "links.remove",
  title: "Remove a link",
  description: "Unlinks a link in a post and keeps its words. Give the page it points to (targetId) or the web address (url).",
  permission: "write",
  risk: "reversible",
  trust: "links",
  input: z
    .object({ id: z.string(), targetId: z.string().optional(), url: z.string().optional(), blockId: z.string().optional(), reason: z.string().optional() })
    .refine((v) => v.targetId || v.url, "Say which link: the page it points to or its web address"),
  prepare(ctx, input) {
    const entry = getEntry(ctx.db, ctx.siteId!, input.id);
    const href = input.targetId ? `tq:${input.targetId}` : input.url!;
    const matches = docLinks(entry.body).filter((l) => l.href === href && (!input.blockId || l.blockId === input.blockId));
    if (!matches.length) throw invalid(`“${entry.title}” doesn't have that link any more.`);
    let body: Doc = entry.body;
    for (const l of matches) {
      const pattern = new RegExp(`(?<!!)\\[([^\\]]+)\\]\\(${href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s+"[^"]*")?\\)`, "g");
      body = {
        v: 1,
        blocks: body.blocks.map((b) => (b.id !== l.blockId ? b : unlink(b, pattern))),
      };
    }
    const anchors = [...new Set(matches.map((m) => m.anchor))];
    return preparePatch(entry, body, {
      summary: `Unlink “${anchors[0]}” in “${entry.title}”${input.url ? " (the page it pointed to is gone)" : ""}`,
      detail: input.reason,
      liveTrust: "links",
    });
  },
  apply: applyPatch,
  undo: undoPatch,
});

function unlink(b: Block, pattern: RegExp): Block {
  const fix = (t: string) => t.replace(pattern, "$1");
  switch (b.type) {
    case "list":
      return { ...b, items: b.items.map(fix) };
    case "faq":
      return { ...b, items: b.items.map((i) => ({ q: fix(i.q), a: fix(i.a) })) };
    case "table":
      return { ...b, header: b.header.map(fix), rows: b.rows.map((r) => r.map(fix)) };
    case "image":
      return b.caption ? { ...b, caption: fix(b.caption) } : b;
    case "divider":
    case "code":
      return b;
    default:
      return { ...b, text: fix(b.text) } as Block;
  }
}

defineAction({
  name: "links.suggest",
  title: "Suggest internal links",
  description: "Finds the most related live posts this one could link to (with anchors already in the text), and older posts that could link to it.",
  permission: "read",
  risk: "read",
  input: z.object({ id: z.string(), limit: z.number().int().min(1).max(10).optional() }),
  run(ctx, input) {
    const entry = getEntry(ctx.db, ctx.siteId!, input.id);
    const pool = linkableEntries(ctx, entry.siteId);
    return { outgoing: suggestOutgoing(ctx, entry, input.limit ?? 3, pool), incoming: entry.status === "published" ? suggestIncoming(ctx, entry, input.limit ?? 5, pool) : [] };
  },
});

defineAction({
  name: "links.orphans",
  title: "Find orphan pages",
  description: "Lists live posts that no other live page links to, so readers and search engines can't find them by browsing.",
  permission: "read",
  risk: "read",
  input: z.object({}),
  run(ctx) {
    return orphans(ctx, ctx.siteId!).map((e) => ({ id: e.id, title: e.title, path: entryPath(e), publishedAt: e.publishedAt }));
  },
});

export interface LinkCheckResult extends UrlCheck {
  pages: { id: string; title: string }[];
}

/** Checks up to `limit` external links (least recently checked first) and records the results. */
export async function checkExternalLinks(ctx: Ctx, opts: { entryId?: string; limit?: number } = {}): Promise<LinkCheckResult[]> {
  const siteId = ctx.siteId!;
  const limit = Math.min(50, opts.limit ?? 50);
  const urls = opts.entryId
    ? ctx.db.query<{ url: string }, [string, string, number]>("SELECT DISTINCT url FROM links WHERE site_id = ? AND from_entry_id = ? AND url IS NOT NULL LIMIT ?").all(siteId, opts.entryId, limit)
    : ctx.db
        .query<{ url: string }, [string, number]>(
          `SELECT l.url FROM links l JOIN entries e ON e.id = l.from_entry_id
           WHERE l.site_id = ? AND l.url IS NOT NULL AND e.status = 'published' AND e.deleted_at IS NULL
           GROUP BY l.url ORDER BY MIN(COALESCE(l.checked_at, '')) LIMIT ?`,
        )
        .all(siteId, limit);
  const results: LinkCheckResult[] = [];
  for (const { url } of urls) {
    const check = await checkUrl(url, 8000);
    const status = check.status === "skipped" ? "unchecked" : check.status;
    ctx.db.query("UPDATE links SET status = ?, checked_at = ? WHERE site_id = ? AND url = ?").run(status, nowIso(), siteId, url);
    const pages = ctx.db
      .query<{ id: string; title: string }, [string, string]>("SELECT DISTINCT e.id, e.title FROM links l JOIN entries e ON e.id = l.from_entry_id WHERE l.site_id = ? AND l.url = ? AND e.deleted_at IS NULL")
      .all(siteId, url);
    results.push({ ...check, pages });
  }
  return results;
}

defineAction({
  name: "links.check",
  title: "Check external links",
  description: "Checks up to 50 links to other websites (one post, or the least recently checked across the site) and says which are broken.",
  permission: "read",
  risk: "read",
  input: z.object({ id: z.string().optional().describe("Only this post's links"), limit: z.number().int().min(1).max(50).optional() }),
  async run(ctx, input) {
    if (input.id) getEntry(ctx.db, ctx.siteId!, input.id);
    const results = await checkExternalLinks(ctx, { entryId: input.id, limit: input.limit });
    const broken = results.filter((r) => r.status === "broken");
    return {
      summary: results.length ? (broken.length ? `${broken.length} of ${results.length} links are broken.` : `All ${results.length} links work.`) : "There are no links to other websites to check.",
      results,
    };
  },
});

/** Daily job: check external links and propose unlinking the broken ones. */
export async function linkCheckJob(ctx: Ctx) {
  if (!ctx.siteId) return;
  const steward = agentCtx({ ...ctx, role: ctx.role ?? "owner" }, "steward");
  for (const r of await checkExternalLinks(ctx, { limit: 50 })) {
    if (r.status !== "broken") continue;
    for (const page of r.pages) {
      const e = findEntry(ctx.db, ctx.siteId, page.id);
      if (!e || e.status !== "published") continue;
      if (pendingProposalExists(ctx, "links.remove", { id: e.id, url: r.url })) continue;
      try {
        await invoke(steward, "links.remove", { id: e.id, url: r.url, reason: r.reason });
      } catch (err) {
        if (!(err instanceof TqError)) throw err;
      }
    }
  }
}
