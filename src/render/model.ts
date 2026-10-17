import { docLinks } from "../content/blocks.ts";
import { listAuthors, type Author } from "../core/authors.ts";
import type { Db } from "../core/db.ts";
import { json } from "../core/db.ts";
import { entryPath, rowToEntry, type Entry } from "../core/entries.ts";
import { getSite, siteBaseUrl } from "../core/sites.ts";
import type { Site } from "../core/types.ts";
import { asOverrides, houseDesign, resolveTokenSet, type DesignName, type TokenOverrides, type TokenSet } from "./tokens.ts";

/**
 * Everything a build needs, loaded in a handful of queries. Rendering is pure
 * over this model, so a 1,000-page build never goes back to the database.
 */

export interface Category {
  id: string;
  slug: string;
  name: string;
  description: string;
  position: number;
}

export interface MediaRow {
  id: string;
  fileKey: string;
  mime: string;
  width: number | null;
  height: number | null;
  alt: string;
  caption: string;
  variants: { width: number; height: number; format: string; key: string }[];
}

export interface FactRow {
  key: string;
  label: string;
  value: string;
  kind: string;
  sourceUrl: string | null;
  verifiedAt: string | null;
  updatedAt: string;
}

export interface RedirectRow {
  from: string;
  to: string;
  code: number;
}

export interface SiteModel {
  site: Site;
  design: DesignName;
  tokens: TokenSet;
  baseUrl: string;
  categories: Category[];
  categoryById: Map<string, Category>;
  authors: Author[];
  authorById: Map<string, Author>;
  /** Published, not deleted, newest first. */
  entries: Entry[];
  byId: Map<string, Entry>;
  /** Published posts only, newest first. */
  posts: Entry[];
  facts: Map<string, FactRow>;
  media: Map<string, MediaRow>;
  redirects: RedirectRow[];
  /** Entries an agent helped write (for the AI disclosure line). */
  aiAssisted: Set<string>;
  /** Published entries that link to each entry id (from bodies, plus the links table). */
  linksIn: Map<string, Set<string>>;
  linksOut: Map<string, Set<string>>;
  /** Paths of entries that were live once and aren't any more: they answer 410. */
  gone: string[];
}

export function loadSiteModel(db: Db, siteId: string, overrides?: { design?: string; tokens?: TokenOverrides }): SiteModel {
  const site = getSite(db, siteId);
  const design = houseDesign(overrides?.design ?? site.design).name;
  const tokens = resolveTokenSet(design, overrides?.tokens ?? asOverrides(site.tokens));

  const categories = db
    .query<any, [string]>("SELECT id, slug, name, description, position FROM categories WHERE site_id = ? AND deleted_at IS NULL ORDER BY position, name")
    .all(siteId) as Category[];
  const authors = listAuthors(db, siteId);
  const entries = db
    .query<any, [string]>("SELECT * FROM entries WHERE site_id = ? AND status = 'published' AND deleted_at IS NULL ORDER BY COALESCE(published_at, created_at) DESC")
    .all(siteId)
    .map(rowToEntry);
  const byId = new Map(entries.map((e) => [e.id, e]));

  const facts = new Map(
    db
      .query<any, [string]>("SELECT key, label, value, kind, source_url, verified_at, updated_at FROM facts WHERE site_id = ? AND deleted_at IS NULL")
      .all(siteId)
      .map((r) => [r.key, { key: r.key, label: r.label, value: r.value, kind: r.kind, sourceUrl: r.source_url, verifiedAt: r.verified_at, updatedAt: r.updated_at } satisfies FactRow]),
  );
  const media = new Map(
    db
      .query<any, [string]>("SELECT id, file_key, mime, width, height, alt, caption, variants FROM media WHERE site_id = ? AND deleted_at IS NULL")
      .all(siteId)
      .map((r) => [r.id, { id: r.id, fileKey: r.file_key, mime: r.mime, width: r.width, height: r.height, alt: r.alt, caption: r.caption, variants: json(r.variants, []) } satisfies MediaRow]),
  );
  const redirects = db.query<any, [string]>("SELECT from_path, to_path, code FROM redirects WHERE site_id = ?").all(siteId).map((r) => ({ from: r.from_path, to: r.to_path, code: r.code }));
  const aiAssisted = new Set(
    db
      .query<{ entry_id: string }, [string]>("SELECT DISTINCT entry_id FROM revisions WHERE site_id = ? AND json_extract(actor, '$.kind') = 'agent'")
      .all(siteId)
      .map((r) => r.entry_id),
  );

  const { linksIn, linksOut } = linkGraph(db, siteId, entries, byId);
  const livePaths = new Set(entries.map((e) => entryPath(e)));
  const gone = db
    .query<any, [string]>("SELECT slug, type FROM entries WHERE site_id = ? AND published_at IS NOT NULL AND (status != 'published' OR deleted_at IS NOT NULL)")
    .all(siteId)
    .map((r) => entryPath(r))
    .filter((p) => p !== "/" && !livePaths.has(p));

  return {
    site,
    design,
    tokens,
    baseUrl: siteBaseUrl(site),
    categories,
    categoryById: new Map(categories.map((c) => [c.id, c])),
    authors,
    authorById: new Map(authors.map((a) => [a.id, a])),
    entries,
    byId,
    posts: entries.filter((e) => e.type === "post"),
    facts,
    media,
    redirects,
    aiAssisted,
    linksIn,
    linksOut,
    gone: [...new Set(gone)],
  };
}

function linkGraph(db: Db, siteId: string, entries: Entry[], byId: Map<string, Entry>) {
  const linksIn = new Map<string, Set<string>>();
  const linksOut = new Map<string, Set<string>>();
  const add = (from: string, to: string) => {
    if (from === to || !byId.has(from)) return;
    if (!linksOut.has(from)) linksOut.set(from, new Set());
    linksOut.get(from)!.add(to);
    if (!linksIn.has(to)) linksIn.set(to, new Set());
    linksIn.get(to)!.add(from);
  };
  for (const e of entries) for (const l of docLinks(e.body)) if (l.entryId) add(e.id, l.entryId);
  // The links module keeps the same graph in a table; include it in case it knows more.
  for (const r of db.query<{ from_entry_id: string; to_entry_id: string }, [string]>("SELECT from_entry_id, to_entry_id FROM links WHERE site_id = ? AND to_entry_id IS NOT NULL").all(siteId)) {
    add(r.from_entry_id, r.to_entry_id);
  }
  return { linksIn, linksOut };
}

export const categoryPath = (c: Pick<Category, "slug">) => `/topics/${c.slug}/`;
export const authorPath = (a: Pick<Author, "slug">) => `/authors/${a.slug}/`;
export const absoluteUrl = (m: Pick<SiteModel, "baseUrl">, path: string) => `${m.baseUrl}${path}`;

/** Authors of an entry, in byline order. */
export function entryAuthors(m: SiteModel, e: Entry): Author[] {
  return e.authorIds.map((id) => m.authorById.get(id)).filter((a): a is Author => !!a);
}

export function postsBy(m: SiteModel, authorId: string): Entry[] {
  return m.posts.filter((e) => e.authorIds.includes(authorId));
}

export function postsIn(m: SiteModel, categoryId: string): Entry[] {
  return m.posts.filter((e) => e.categoryId === categoryId);
}

/**
 * Related posts: posts this one links to or is linked from first (the link
 * graph knows best), then its neighbors by date in the same category. Picking
 * neighbors rather than the newest posts keeps a new post from changing every
 * page in its category, so publishing stays an incremental build.
 */
export function relatedPosts(m: SiteModel, e: Entry, limit = 3): Entry[] {
  const picked: Entry[] = [];
  const take = (x: Entry | undefined) => {
    if (x && x.id !== e.id && x.type === "post" && !picked.includes(x) && picked.length < limit) picked.push(x);
  };
  for (const id of m.linksOut.get(e.id) ?? []) take(m.byId.get(id));
  for (const id of m.linksIn.get(e.id) ?? []) take(m.byId.get(id));
  if (e.categoryId && picked.length < limit) {
    const siblings = categoryPosts(m, e.categoryId);
    const at = siblings.indexOf(e);
    // Older first (they're settled), then newer.
    for (let d = 1; picked.length < limit && d < siblings.length; d++) {
      take(siblings[at + d]);
      take(siblings[at - d]);
    }
  }
  return picked;
}

const byCategory = new WeakMap<SiteModel, Map<string, Entry[]>>();

function categoryPosts(m: SiteModel, categoryId: string): Entry[] {
  let index = byCategory.get(m);
  if (!index) {
    index = new Map();
    for (const p of m.posts) {
      if (!p.categoryId) continue;
      if (!index.has(p.categoryId)) index.set(p.categoryId, []);
      index.get(p.categoryId)!.push(p);
    }
    byCategory.set(m, index);
  }
  return index.get(categoryId) ?? [];
}
