import { z } from "zod";
import { asDoc, docText, wordCount, type Doc } from "../../content/blocks.ts";
import { fromMarkdown, toMarkdown } from "../../content/markdown.ts";
import { findAuthor } from "../authors.ts";
import {
  entryBySlug,
  entryPath,
  findEntry,
  getEntry,
  listEntries,
  newEntry,
  saveEntry,
  uniqueSlug,
  undoEntryChange,
  type Entry,
  type EntryUndo,
} from "../entries.ts";
import { TqError, invalid } from "../errors.ts";
import { readiness, runEntrySaved, runPublished } from "../hooks.ts";
import { id, nowIso, slugify } from "../ids.ts";
import { defineAction, type DiffItem } from "../registry.ts";
import { getSite } from "../sites.ts";
import type { Ctx, Site } from "../types.ts";

const entryType = z.enum(["post", "page"]);

export function entrySummary(ctx: Ctx, e: Entry) {
  const authors = e.authorIds.map((a) => findAuthor(ctx.db, e.siteId, a)).filter(Boolean);
  return {
    id: e.id,
    type: e.type,
    slug: e.slug,
    path: entryPath(e),
    title: e.title,
    description: e.description,
    status: e.status,
    authors: authors.map((a) => ({ id: a!.id, name: a!.name, slug: a!.slug })),
    categoryId: e.categoryId,
    publishAt: e.publishAt,
    publishedAt: e.publishedAt,
    updatedAt: e.updatedAt,
    modifiedAt: e.modifiedAt,
    words: wordCount(e.body),
  };
}

function resolveAuthorIds(ctx: Ctx, keys: string[] | undefined): string[] | undefined {
  if (!keys) return undefined;
  return keys.map((k) => {
    const a = findAuthor(ctx.db, ctx.siteId!, k);
    if (!a) throw invalid(`There's no author called "${k}" on this site. Add them first, or pick one of the existing authors.`);
    return a.id;
  });
}

function resolveCategory(ctx: Ctx, key: string | null | undefined): string | null | undefined {
  if (key === undefined) return undefined;
  if (key === null || key === "") return null;
  const r = ctx.db
    .query<{ id: string }, [string, string, string, string]>("SELECT id FROM categories WHERE site_id = ? AND deleted_at IS NULL AND (id = ? OR slug = ? OR lower(name) = lower(?))")
    .get(ctx.siteId!, key, slugify(key), key);
  if (!r) throw invalid(`There's no category called "${key}". Ask me to create it first.`);
  return r.id;
}

function bodyFrom(input: { markdown?: string; body?: unknown }, previous?: Doc): Doc | undefined {
  if (input.body !== undefined) return asDoc(input.body);
  if (input.markdown !== undefined) return fromMarkdown(input.markdown, previous);
  return undefined;
}

/** The next free publishing slot from the site's cadence, e.g. Tue 09:00. */
export function nextSlot(ctx: Ctx, site: Site, after = new Date()): string {
  const { days, time } = site.settings.cadence;
  const [hh, mm] = time.split(":").map(Number);
  const taken = new Set(
    ctx.db
      .query<{ publish_at: string }, [string]>("SELECT publish_at FROM entries WHERE site_id = ? AND status = 'scheduled' AND deleted_at IS NULL AND publish_at IS NOT NULL")
      .all(site.id)
      .map((r) => r.publish_at.slice(0, 13)),
  );
  const useDays = days.length ? days : [0, 1, 2, 3, 4, 5, 6];
  for (let i = 0; i < 120; i++) {
    const d = new Date(after.getTime() + i * 86_400_000);
    d.setUTCHours(hh ?? 9, mm ?? 0, 0, 0);
    if (d.getTime() <= after.getTime()) continue;
    if (!useDays.includes(d.getUTCDay())) continue;
    const iso = d.toISOString();
    if (!taken.has(iso.slice(0, 13))) return iso;
  }
  return new Date(after.getTime() + 86_400_000).toISOString();
}

defineAction({
  name: "posts.list",
  title: "List posts and pages",
  description: "Lists posts or pages with status, authors and dates. Filter by status, author, category or text.",
  permission: "read",
  risk: "read",
  input: z.object({
    type: entryType.optional(),
    status: z.enum(["draft", "scheduled", "published", "unpublished"]).optional(),
    author: z.string().optional().describe("Author id, slug or name"),
    category: z.string().optional(),
    search: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  run(ctx, input) {
    const authorId = input.author ? findAuthor(ctx.db, ctx.siteId!, input.author)?.id ?? "__none__" : undefined;
    const categoryId = input.category ? resolveCategory(ctx, input.category) ?? undefined : undefined;
    return listEntries(ctx.db, ctx.siteId!, { type: input.type, status: input.status, authorId, categoryId, search: input.search, limit: input.limit ?? 100 }).map((e) => entrySummary(ctx, e));
  },
});

defineAction({
  name: "posts.get",
  title: "Read a post or page",
  description: "Returns one post or page as markdown, with its Ready light (Human, SEO and answer-ready scores and fixes).",
  permission: "read",
  risk: "read",
  input: z.object({ id: z.string().optional(), slug: z.string().optional(), includeBlocks: z.boolean().optional() }).refine((v) => v.id || v.slug, "Give an id or a slug"),
  async run(ctx, input) {
    const e = input.id ? getEntry(ctx.db, ctx.siteId!, input.id) : entryBySlug(ctx.db, ctx.siteId!, slugify(input.slug!));
    if (!e) throw new TqError("not_found", "That post or page was not found.");
    return {
      ...entrySummary(ctx, e),
      markdown: toMarkdown(e.body),
      blocks: input.includeBlocks ? e.body.blocks : undefined,
      tags: e.tags,
      heroMediaId: e.heroMediaId,
      ready: await readiness(ctx, e),
    };
  },
});

const createInput = z.object({
  type: entryType.default("post"),
  title: z.string().min(1).max(300),
  markdown: z.string().optional().describe("Body as markdown"),
  body: z.any().optional().describe("Body as block JSON (alternative to markdown)"),
  description: z.string().max(300).optional(),
  slug: z.string().optional(),
  authors: z.array(z.string()).optional().describe("Author ids, slugs or names"),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  heroMediaId: z.string().optional(),
});

defineAction({
  name: "posts.create",
  title: "Start a draft",
  description: "Creates a new draft post or page. Drafts are invisible to readers until published, so this never needs approval.",
  permission: "write",
  risk: "reversible",
  trust: "new_post",
  input: createInput,
  prepare(ctx, input) {
    const slug = uniqueSlug(ctx.db, ctx.siteId!, slugify(input.slug || input.title));
    const authorIds = resolveAuthorIds(ctx, input.authors) ?? [];
    const categoryId = resolveCategory(ctx, input.category) ?? null;
    const body = bodyFrom(input) ?? { v: 1, blocks: [] };
    return {
      summary: `New ${input.type === "page" ? "page" : "draft"}: “${input.title}”`,
      invisible: true,
      payload: { id: id("ent"), type: input.type, title: input.title, slug, description: input.description ?? "", body, authorIds, categoryId, tags: input.tags ?? [], heroMediaId: input.heroMediaId ?? null },
    };
  },
  async apply(ctx, p) {
    const e = newEntry(ctx.siteId!, { ...p, status: "draft" });
    saveEntry(ctx.db, e, ctx.actor, ctx.actionId);
    await runEntrySaved(ctx, e);
    ctx.services.emit({ type: "entry.changed", siteId: e.siteId, entryId: e.id });
    return { result: { id: e.id, slug: e.slug, path: entryPath(e), status: e.status }, undo: { entryId: e.id, revisionId: null } satisfies EntryUndo };
  },
  undo: undoEntryChange,
});

const updateInput = z.object({
  id: z.string(),
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(300).optional(),
  markdown: z.string().optional(),
  body: z.any().optional(),
  slug: z.string().optional(),
  authors: z.array(z.string()).optional(),
  category: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  heroMediaId: z.string().nullable().optional(),
  substantive: z.boolean().optional().describe("True when the change matters to readers; moves the visible 'updated' date. Typo fixes are not substantive."),
  reason: z.string().optional().describe("Why, in one line, shown on the proposal"),
});

interface UpdatePayload {
  id: string;
  baseRevisionId: string | null;
  changes: Partial<Pick<Entry, "title" | "description" | "slug" | "body" | "authorIds" | "categoryId" | "tags" | "heroMediaId">>;
  substantive: boolean;
}

function changedDiff(before: Entry, changes: UpdatePayload["changes"]): DiffItem[] {
  const diff: DiffItem[] = [];
  if (changes.title !== undefined && changes.title !== before.title) diff.push({ label: "Title", before: before.title, after: changes.title });
  if (changes.description !== undefined && changes.description !== before.description) diff.push({ label: "Description", before: before.description, after: changes.description });
  if (changes.slug !== undefined && changes.slug !== before.slug) diff.push({ label: "Address", before: entryPath(before), after: entryPath({ ...before, slug: changes.slug }), format: "url" });
  if (changes.body !== undefined) {
    const a = toMarkdown(before.body);
    const b = toMarkdown(changes.body);
    if (a !== b) diff.push({ label: "Text", before: a, after: b, format: "markdown" });
  }
  if (changes.tags !== undefined) diff.push({ label: "Tags", before: before.tags.join(", "), after: changes.tags.join(", ") });
  return diff;
}

/** Shared by posts.update and posts.update_block. */
function prepareUpdate(ctx: Ctx, before: Entry, changes: UpdatePayload["changes"], substantive: boolean | undefined, reason?: string) {
  const diff = changedDiff(before, changes);
  const live = before.status === "published" || before.status === "scheduled";
  const isSubstantive = substantive ?? (changes.body !== undefined && Math.abs(wordCount(changes.body) - wordCount(before.body)) > 20);
  return {
    summary: reason ?? (diff.length ? `Edit “${before.title}”: ${diff.map((d) => d.label.toLowerCase()).join(", ")}` : `No changes to “${before.title}”`),
    detail: reason,
    diff,
    entryId: before.id,
    invisible: !live,
    trustKind: live ? ("refresh" as const) : ("new_post" as const),
    payload: { id: before.id, baseRevisionId: before.currentRevisionId, changes, substantive: isSubstantive } satisfies UpdatePayload,
  };
}

async function applyUpdate(ctx: Ctx & { actionId: string }, p: UpdatePayload) {
  const current = getEntry(ctx.db, ctx.siteId!, p.id);
  if (p.baseRevisionId && current.currentRevisionId !== p.baseRevisionId && p.changes.body !== undefined) {
    const base = ctx.db.query<{ snapshot: string }, [string]>("SELECT snapshot FROM revisions WHERE id = ?").get(p.baseRevisionId);
    const baseBody = base ? JSON.stringify(asDoc(JSON.parse(base.snapshot).body)) : null;
    if (baseBody !== JSON.stringify(current.body)) {
      throw new TqError("conflict", `“${current.title}” changed after this was proposed. Ask me to redo it on the latest version.`);
    }
  }
  const next: Entry = { ...current, ...p.changes };
  if (p.changes.slug !== undefined && p.changes.slug !== current.slug) {
    next.slug = uniqueSlug(ctx.db, ctx.siteId!, slugify(p.changes.slug), current.id);
    if (current.status === "published") {
      // Slug changes on live pages always leave a redirect behind.
      ctx.db
        .query("INSERT INTO redirects (site_id, from_path, to_path, code, created_at) VALUES (?, ?, ?, 301, ?) ON CONFLICT(site_id, from_path) DO UPDATE SET to_path = excluded.to_path")
        .run(ctx.siteId!, entryPath(current), entryPath(next), nowIso());
    }
  }
  if (p.substantive && current.status === "published") next.updatedAt = nowIso();
  saveEntry(ctx.db, next, ctx.actor, ctx.actionId);
  await runEntrySaved(ctx, next);
  ctx.services.emit({ type: "entry.changed", siteId: next.siteId, entryId: next.id });
  if (current.status === "published") ctx.services.enqueueBuild(next.siteId, "edit", [next.id]);
  return { result: entrySummary(ctx, next), undo: { entryId: current.id, revisionId: current.currentRevisionId } satisfies EntryUndo };
}

defineAction({
  name: "posts.update",
  title: "Edit a post or page",
  description: "Changes the title, text, address, authors, category or tags. On a live post this is a refresh and shows a diff; the address keeps working through a redirect.",
  permission: "write",
  risk: "reversible",
  trust: "refresh",
  input: updateInput,
  prepare(ctx, input) {
    const before = getEntry(ctx.db, ctx.siteId!, input.id);
    const changes: UpdatePayload["changes"] = {};
    if (input.title !== undefined) changes.title = input.title;
    if (input.description !== undefined) changes.description = input.description;
    if (input.slug !== undefined) changes.slug = slugify(input.slug);
    const body = bodyFrom(input, before.body);
    if (body) changes.body = body;
    const authorIds = resolveAuthorIds(ctx, input.authors);
    if (authorIds) changes.authorIds = authorIds;
    const categoryId = resolveCategory(ctx, input.category);
    if (categoryId !== undefined) changes.categoryId = categoryId;
    if (input.tags) changes.tags = input.tags;
    if (input.heroMediaId !== undefined) changes.heroMediaId = input.heroMediaId;
    return prepareUpdate(ctx, before, changes, input.substantive, input.reason);
  },
  apply: applyUpdate,
  undo: undoEntryChange,
});

defineAction({
  name: "posts.update_block",
  title: "Edit one section",
  description: "Replaces one block of a post or page with new markdown (which may be several blocks, or empty to remove it). Used by live-site editing.",
  permission: "write",
  risk: "reversible",
  trust: "refresh",
  input: z.object({ id: z.string(), blockId: z.string(), markdown: z.string(), reason: z.string().optional(), substantive: z.boolean().optional() }),
  prepare(ctx, input) {
    const before = getEntry(ctx.db, ctx.siteId!, input.id);
    const index = before.body.blocks.findIndex((b) => b.id === input.blockId);
    if (index < 0) throw invalid("That section isn't in this post any more. Reload the page and try again.");
    const old = before.body.blocks[index]!;
    const replacement = fromMarkdown(input.markdown, { v: 1, blocks: [old] }).blocks;
    const blocks = [...before.body.blocks.slice(0, index), ...replacement, ...before.body.blocks.slice(index + 1)];
    return prepareUpdate(ctx, before, { body: { v: 1, blocks } }, input.substantive ?? false, input.reason);
  },
  apply: applyUpdate,
  undo: undoEntryChange,
});

defineAction({
  name: "posts.publish",
  title: "Publish or schedule",
  description: "Publishes a draft now, or schedules it (at: an ISO time, or 'next_slot' for the site's next publishing slot). Needs the Ready light unless an owner gives an override reason.",
  permission: "write",
  risk: "reversible",
  trust: "new_post",
  input: z.object({
    id: z.string(),
    at: z.string().optional().describe("ISO date-time, or 'next_slot'"),
    override: z.string().optional().describe("Reason to publish even though it isn't Ready (logged)"),
  }),
  async prepare(ctx, input) {
    const e = getEntry(ctx.db, ctx.siteId!, input.id);
    if (e.status === "published") throw new TqError("conflict", `“${e.title}” is already live.`);
    const site = getSite(ctx.db, ctx.siteId!);
    let at: string | null = null;
    if (input.at === "next_slot") at = nextSlot(ctx, site);
    else if (input.at) {
      const t = Date.parse(input.at);
      if (Number.isNaN(t)) throw invalid("I couldn't read that date. Use a full date and time, like 2026-10-20T09:00.");
      at = t > Date.now() + 60_000 ? new Date(t).toISOString() : null;
    }
    const ready = await readiness(ctx, e);
    const when = at ? `on ${new Date(at).toUTCString().slice(0, 22)} UTC` : "now";
    return {
      summary: `${at ? "Schedule" : "Publish"} “${e.title}” ${when}`,
      detail: ready ? ready.headline : undefined,
      entryId: e.id,
      trustKind: e.publishedAt ? "other" : "new_post",
      diff: [{ label: "Status", before: e.status, after: at ? "scheduled" : "published" }],
      payload: { id: e.id, at, override: input.override ?? null },
    };
  },
  async apply(ctx, p: { id: string; at: string | null; override: string | null }) {
    const e = getEntry(ctx.db, ctx.siteId!, p.id);
    const ready = await readiness(ctx, e);
    if (ready && !ready.ready && !p.override) {
      throw new TqError("invalid", `“${e.title}” isn't Ready yet (${ready.headline.toLowerCase()}). Fix that first, or publish anyway with a reason.`, ready);
    }
    if (p.override && ctx.role !== "owner" && ctx.actor.kind === "human") throw new TqError("forbidden", "Only an owner can publish something that isn't Ready.");
    const before = e.currentRevisionId;
    const now = nowIso();
    const next: Entry = p.at ? { ...e, status: "scheduled", publishAt: p.at } : { ...e, status: "published", publishAt: null, publishedAt: e.publishedAt ?? now, updatedAt: e.updatedAt ?? now };
    saveEntry(ctx.db, next, ctx.actor, ctx.actionId);
    if (!p.at) await goLive(ctx, next);
    return {
      result: { ...entrySummary(ctx, next), override: p.override },
      summary: p.at ? `Scheduled “${e.title}”` : `Published “${e.title}”`,
      undo: { entryId: e.id, revisionId: before } satisfies EntryUndo,
    };
  },
  async undo(ctx, u: EntryUndo) {
    undoEntryChange(ctx, u);
    ctx.services.emit({ type: "entry.unpublished", siteId: ctx.siteId!, entryId: u.entryId });
  },
});

async function goLive(ctx: Ctx, e: Entry) {
  ctx.services.emit({ type: "entry.published", siteId: e.siteId, entryId: e.id });
  ctx.services.enqueueBuild(e.siteId, "publish", [e.id]);
  await runPublished(ctx, e);
}

/** Called by the scheduler: publishes scheduled entries whose time has come. */
export async function publishDue(ctx: Ctx): Promise<number> {
  const due = ctx.db.query("SELECT * FROM entries WHERE status = 'scheduled' AND publish_at <= ? AND deleted_at IS NULL").all(nowIso());
  let n = 0;
  for (const r of due as any[]) {
    const e = findEntry(ctx.db, r.site_id, r.id)!;
    const now = nowIso();
    const next: Entry = { ...e, status: "published", publishedAt: e.publishedAt ?? now, updatedAt: e.updatedAt ?? now, publishAt: null };
    saveEntry(ctx.db, next, { kind: "system" }, null);
    await goLive({ ...ctx, siteId: e.siteId }, next);
    n++;
  }
  return n;
}

defineAction({
  name: "posts.unpublish",
  title: "Take a page off the site",
  description: "Takes a live post or page off the site. Its address starts returning 410 Gone. Undo puts it back.",
  permission: "write",
  risk: "reversible",
  trust: "other",
  input: z.object({ id: z.string() }),
  prepare(ctx, input) {
    const e = getEntry(ctx.db, ctx.siteId!, input.id);
    return { summary: `Take “${e.title}” off the site`, entryId: e.id, diff: [{ label: "Status", before: e.status, after: "unpublished" }], payload: { id: e.id } };
  },
  apply(ctx, p: { id: string }) {
    const e = getEntry(ctx.db, ctx.siteId!, p.id);
    const next: Entry = { ...e, status: "unpublished", publishAt: null };
    saveEntry(ctx.db, next, ctx.actor, ctx.actionId);
    ctx.services.emit({ type: "entry.unpublished", siteId: e.siteId, entryId: e.id });
    ctx.services.enqueueBuild(e.siteId, "unpublish", [e.id]);
    return { result: entrySummary(ctx, next), undo: { entryId: e.id, revisionId: e.currentRevisionId } satisfies EntryUndo };
  },
  async undo(ctx, u: EntryUndo) {
    undoEntryChange(ctx, u);
    const e = findEntry(ctx.db, ctx.siteId!, u.entryId);
    if (e?.status === "published") await goLive(ctx, e);
  },
});

defineAction({
  name: "posts.delete",
  title: "Delete a post or page",
  description: "Deletes a post or page. Always asks first. It can be restored for 90 days.",
  permission: "write",
  risk: "destructive",
  trust: "delete",
  input: z.object({ id: z.string() }),
  prepare(ctx, input) {
    const e = getEntry(ctx.db, ctx.siteId!, input.id);
    return { summary: `Delete “${e.title}”`, detail: e.status === "published" ? "It is live; its address will return 410 Gone." : undefined, entryId: e.id, payload: { id: e.id } };
  },
  apply(ctx, p: { id: string }) {
    const e = getEntry(ctx.db, ctx.siteId!, p.id);
    saveEntry(ctx.db, { ...e, deletedAt: nowIso(), status: e.status === "published" ? "unpublished" : e.status }, ctx.actor, ctx.actionId);
    if (e.status === "published") {
      ctx.services.emit({ type: "entry.unpublished", siteId: e.siteId, entryId: e.id });
      ctx.services.enqueueBuild(e.siteId, "delete", [e.id]);
    }
    return { result: { id: e.id, deleted: true }, undo: { entryId: e.id, revisionId: e.currentRevisionId } satisfies EntryUndo };
  },
  async undo(ctx, u: EntryUndo) {
    ctx.db.query("UPDATE entries SET deleted_at = NULL WHERE id = ? AND site_id = ?").run(u.entryId, ctx.siteId);
    undoEntryChange(ctx, u);
    const e = findEntry(ctx.db, ctx.siteId!, u.entryId);
    if (e?.status === "published") await goLive(ctx, e);
  },
});

/** Exposed for the quality module and agents. */
export function entryPlainText(e: Entry): string {
  return docText(e.body);
}
