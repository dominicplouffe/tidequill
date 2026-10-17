import type { Doc } from "../content/blocks.ts";
import { asDoc } from "../content/blocks.ts";
import type { Db } from "./db.ts";
import { json } from "./db.ts";
import { notFound } from "./errors.ts";
import { id, nowIso } from "./ids.ts";
import type { Actor, Ctx } from "./types.ts";

export type EntryType = "post" | "page";
export type EntryStatus = "draft" | "scheduled" | "published" | "unpublished";

export interface Entry {
  id: string;
  siteId: string;
  type: EntryType;
  slug: string;
  status: EntryStatus;
  title: string;
  description: string;
  body: Doc;
  authorIds: string[];
  categoryId: string | null;
  tags: string[];
  heroMediaId: string | null;
  publishAt: string | null;
  publishedAt: string | null;
  /** The visible "updated" date; only changes for substantive edits. */
  updatedAt: string | null;
  createdAt: string;
  modifiedAt: string;
  deletedAt: string | null;
  currentRevisionId: string | null;
}

export function rowToEntry(r: any): Entry {
  return {
    id: r.id,
    siteId: r.site_id,
    type: r.type,
    slug: r.slug,
    status: r.status,
    title: r.title,
    description: r.description,
    body: asDoc(r.body),
    authorIds: json(r.author_ids, []),
    categoryId: r.category_id,
    tags: json(r.tags, []),
    heroMediaId: r.hero_media_id,
    publishAt: r.publish_at,
    publishedAt: r.published_at,
    updatedAt: r.updated_at,
    createdAt: r.created_at,
    modifiedAt: r.modified_at,
    deletedAt: r.deleted_at,
    currentRevisionId: r.current_revision_id,
  };
}

export function findEntry(db: Db, siteId: string, entryId: string, includeDeleted = false): Entry | null {
  const r = db.query(`SELECT * FROM entries WHERE id = ? AND site_id = ?${includeDeleted ? "" : " AND deleted_at IS NULL"}`).get(entryId, siteId);
  return r ? rowToEntry(r) : null;
}

export function getEntry(db: Db, siteId: string, entryId: string): Entry {
  const e = findEntry(db, siteId, entryId);
  if (!e) throw notFound("That post or page");
  return e;
}

export function entryBySlug(db: Db, siteId: string, slug: string): Entry | null {
  const r = db.query("SELECT * FROM entries WHERE site_id = ? AND slug = ? AND deleted_at IS NULL ORDER BY type = 'page' DESC LIMIT 1").get(siteId, slug);
  return r ? rowToEntry(r) : null;
}

export interface ListEntriesQuery {
  type?: EntryType;
  status?: EntryStatus | EntryStatus[];
  authorId?: string;
  categoryId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export function listEntries(db: Db, siteId: string, q: ListEntriesQuery = {}): Entry[] {
  const where = ["site_id = ?", "deleted_at IS NULL"];
  const args: (string | number)[] = [siteId];
  if (q.type) {
    where.push("type = ?");
    args.push(q.type);
  }
  if (q.status) {
    const st = Array.isArray(q.status) ? q.status : [q.status];
    where.push(`status IN (${st.map(() => "?").join(",")})`);
    args.push(...st);
  }
  if (q.authorId) {
    where.push("EXISTS (SELECT 1 FROM json_each(author_ids) WHERE value = ?)");
    args.push(q.authorId);
  }
  if (q.categoryId) {
    where.push("category_id = ?");
    args.push(q.categoryId);
  }
  if (q.search) {
    where.push("(title LIKE ? OR body LIKE ?)");
    args.push(`%${q.search}%`, `%${q.search}%`);
  }
  args.push(q.limit ?? 500, q.offset ?? 0);
  return db
    .query(`SELECT * FROM entries WHERE ${where.join(" AND ")} ORDER BY COALESCE(published_at, publish_at, created_at) DESC LIMIT ? OFFSET ?`)
    .all(...args)
    .map(rowToEntry);
}

/** Slugs are unique per site across posts and pages, because both live at /<slug>/. */
export function uniqueSlug(db: Db, siteId: string, base: string, exceptId?: string): string {
  const clean = base || "untitled";
  let slug = clean;
  for (let n = 2; ; n++) {
    const taken = db.query("SELECT 1 FROM entries WHERE site_id = ? AND slug = ? AND id != ? AND deleted_at IS NULL").get(siteId, slug, exceptId ?? "");
    const reserved = ["topics", "authors", "search", "feed.xml", "sitemap.xml", "llms.txt", "robots.txt", "media", "go", "mcp", "_tq"].includes(slug);
    if (!taken && !reserved) return slug;
    slug = `${clean}-${n}`;
  }
}

function snapshotOf(e: Entry) {
  const { currentRevisionId: _r, ...rest } = e;
  return rest;
}

/** Inserts or updates an entry and appends a revision. Returns the revision id. */
export function saveEntry(db: Db, e: Entry, actor: Actor, actionId: string | null): string {
  const revId = id("rev");
  const now = nowIso();
  db.transaction(() => {
    db.query(
      `INSERT INTO entries (id, site_id, type, slug, status, title, description, body, author_ids, category_id, tags, hero_media_id, publish_at, published_at, updated_at, created_at, modified_at, deleted_at, current_revision_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET type = excluded.type, slug = excluded.slug, status = excluded.status, title = excluded.title, description = excluded.description,
         body = excluded.body, author_ids = excluded.author_ids, category_id = excluded.category_id, tags = excluded.tags, hero_media_id = excluded.hero_media_id,
         publish_at = excluded.publish_at, published_at = excluded.published_at, updated_at = excluded.updated_at, modified_at = excluded.modified_at,
         deleted_at = excluded.deleted_at, current_revision_id = excluded.current_revision_id`,
    ).run(
      e.id,
      e.siteId,
      e.type,
      e.slug,
      e.status,
      e.title,
      e.description,
      JSON.stringify(e.body),
      JSON.stringify(e.authorIds),
      e.categoryId,
      JSON.stringify(e.tags),
      e.heroMediaId,
      e.publishAt,
      e.publishedAt,
      e.updatedAt,
      e.createdAt,
      now,
      e.deletedAt,
      revId,
    );
    db.query("INSERT INTO revisions (id, site_id, entry_id, snapshot, actor, action_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      revId,
      e.siteId,
      e.id,
      JSON.stringify(snapshotOf({ ...e, modifiedAt: now })),
      JSON.stringify(actor),
      actionId,
      now,
    );
  })();
  return revId;
}

export function newEntry(siteId: string, fields: Partial<Entry> & { title: string; slug: string }): Entry {
  const now = nowIso();
  return {
    id: id("ent"),
    siteId,
    type: "post",
    status: "draft",
    description: "",
    body: { v: 1, blocks: [] },
    authorIds: [],
    categoryId: null,
    tags: [],
    heroMediaId: null,
    publishAt: null,
    publishedAt: null,
    updatedAt: null,
    createdAt: now,
    modifiedAt: now,
    deletedAt: null,
    currentRevisionId: null,
    ...fields,
  };
}

export interface EntryUndo {
  entryId: string;
  /** Revision to restore; null means the entry was created by the action and should be removed. */
  revisionId: string | null;
}

/** Standard undo for entry changes: restore the revision before the action. */
export function undoEntryChange(ctx: Ctx & { actionId: string }, undo: EntryUndo) {
  const siteId = ctx.siteId!;
  const current = findEntry(ctx.db, siteId, undo.entryId, true);
  if (!current) return;
  if (!undo.revisionId) {
    saveEntry(ctx.db, { ...current, deletedAt: nowIso(), status: current.status === "published" ? "unpublished" : current.status }, ctx.actor, ctx.actionId);
  } else {
    const rev = ctx.db.query<{ snapshot: string }, [string]>("SELECT snapshot FROM revisions WHERE id = ?").get(undo.revisionId);
    if (!rev) throw notFound("The earlier version");
    const snap = json<Entry>(rev.snapshot, current);
    saveEntry(ctx.db, { ...current, ...snap, body: asDoc(snap.body), id: current.id, siteId }, ctx.actor, ctx.actionId);
  }
  ctx.services.emit({ type: "entry.changed", siteId, entryId: undo.entryId });
  ctx.services.enqueueBuild(siteId, "undo", [undo.entryId]);
}

/** Public path of an entry. Posts and pages live at /<slug>/; the home page is a page with slug "home". */
export function entryPath(e: Pick<Entry, "slug" | "type">): string {
  if (e.type === "page" && e.slug === "home") return "/";
  return `/${e.slug}/`;
}
