import { mapInline, wordCount, type Doc } from "../content/blocks.ts";
import { findAuthor, saveAuthor, type Author } from "../core/authors.ts";
import { entryBySlug, entryPath, newEntry, saveEntry, uniqueSlug, type Entry, type EntryStatus } from "../core/entries.ts";
import { runEntrySaved } from "../core/hooks.ts";
import { id, nowIso, slugify } from "../core/ids.ts";
import type { Ctx } from "../core/types.ts";
import { defaultVoice } from "../core/voice.ts";
import { ingest } from "../media/ingest.ts";
import { limitedFetch, mapLimit } from "../media/net.ts";
import { SHORTCODE_ADVICE, htmlText, htmlToDoc, imageUrlsIn } from "./convert.ts";
import type { WpItem, WpSite } from "./source.ts";

/**
 * Imports a WordPress site into a Tidequill site: authors, categories, tags,
 * posts and pages (with their status, dates, slugs and SEO descriptions),
 * media, and a 301 for every address that changes. Re-running an import skips
 * what's already there, so a stopped import can simply be run again.
 */

export interface ImportOptions {
  downloadMedia: boolean;
  /** Import everything as drafts instead of keeping the published status. */
  asDrafts?: boolean;
}

export interface ImportProgress {
  phase: "reading" | "authors" | "media" | "content" | "links" | "done" | "failed";
  done: number;
  total: number;
  message: string;
}

export interface Created {
  entryIds: string[];
  categoryIds: string[];
  authorIds: string[];
  mediaIds: string[];
  redirects: string[];
}

export const emptyCreated = (): Created => ({ entryIds: [], categoryIds: [], authorIds: [], mediaIds: [], redirects: [] });

export interface ImportReport {
  source: string;
  counts: { posts: number; pages: number; categories: number; tags: number; authors: number; media: number; redirects: number; skipped: number };
  urlMap: { old: string; new: string; entryId: string; status: EntryStatus }[];
  unknownShortcodes: { name: string; count: number; entries: string[]; suggestion: string }[];
  missingAlt: { entryId: string; title: string; src: string }[];
  thinPages: { entryId: string; title: string; path: string; words: number }[];
  duplicateTitles: { title: string; paths: string[] }[];
  seo: { descriptions: number; titles: number };
  skipped: { title: string; reason: string }[];
  warnings: string[];
  created: Created;
  /** Plain sentences for the person. */
  summary: string[];
}

const CONTENT_TYPES = new Set(["post", "page"]);
const SKIP_STATUS = new Set(["trash", "auto-draft", "inherit"]);
const THIN_WORDS = 300;

function mapStatus(wp: string, date: string | null, asDrafts: boolean): { status: EntryStatus; publishAt: string | null } {
  if (asDrafts) return { status: "draft", publishAt: null };
  if (wp === "publish") return { status: "published", publishAt: null };
  if (wp === "future" && date && Date.parse(date) > Date.now()) return { status: "scheduled", publishAt: date };
  return { status: "draft", publishAt: null };
}

/** Old permalink -> path, e.g. https://old.example/2019/05/old-style/ -> /2019/05/old-style/. */
export function oldPath(link: string, siteLink: string): string | null {
  if (!link) return null;
  try {
    const u = new URL(link, siteLink || "https://example.invalid");
    if (u.searchParams.has("p") || u.searchParams.has("page_id")) return null;
    let p = decodeURIComponent(u.pathname);
    if (!p.endsWith("/") && !/\.[a-z0-9]{2,5}$/i.test(p)) p += "/";
    return p;
  } catch {
    return null;
  }
}

function seoDescription(item: WpItem): { description: string; fromSeo: boolean } {
  const fromMeta = item.meta._yoast_wpseo_metadesc || item.meta.rank_math_description || item.meta._aioseo_description || item.meta._genesis_description || item.seoDescription || "";
  // Template variables like %%sitename%% can't be resolved outside WordPress.
  const clean = fromMeta.replace(/%%[\w_]+%%/g, "").replace(/\s+/g, " ").trim();
  if (clean) return { description: clip(htmlText(clean), 300), fromSeo: true };
  const excerpt = htmlText(item.excerpt);
  return { description: clip(excerpt, 300), fromSeo: false };
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 40)).replace(/[,;:\s]+$/, "")}…`;
}

/** Strips WordPress's size suffix: photo-300x200.jpg -> photo.jpg. */
export function fullSizeUrl(url: string): string {
  return url.replace(/-\d{2,5}x\d{2,5}(\.[a-z0-9]{3,4})(\?.*)?$/i, "$1$2").replace(/-scaled(\.[a-z0-9]{3,4})$/i, "$1");
}

export async function runImport(ctx: Ctx, wp: WpSite, opts: ImportOptions, meta: { source: string; actionId: string | null; created?: Created }, progress: (p: ImportProgress) => void): Promise<ImportReport> {
  const siteId = ctx.siteId!;
  // Filled in place as the import goes, so whoever holds it (the job) can undo a partial import.
  const created: Created = meta.created ?? emptyCreated();
  const report: ImportReport = {
    source: meta.source,
    counts: { posts: 0, pages: 0, categories: 0, tags: 0, authors: 0, media: 0, redirects: 0, skipped: 0 },
    urlMap: [],
    unknownShortcodes: [],
    missingAlt: [],
    thinPages: [],
    duplicateTitles: [],
    seo: { descriptions: 0, titles: 0 },
    skipped: [],
    warnings: [],
    created,
    summary: [],
  };
  const items = wp.items.filter((i) => CONTENT_TYPES.has(i.type) && !SKIP_STATUS.has(i.status));
  for (const t of new Set(wp.items.filter((i) => !CONTENT_TYPES.has(i.type) && !["attachment", "revision", "nav_menu_item", "customize_changeset", "wp_global_styles", "custom_css", "oembed_cache", "wp_navigation", "wp_template", "wp_template_part", "user_request"].includes(i.type)).map((i) => i.type))) {
    const n = wp.items.filter((i) => i.type === t).length;
    report.warnings.push(`${n} item${n === 1 ? "" : "s"} of the custom type “${t}” weren't imported; custom types come after v1.`);
  }

  // ---- Authors ----
  progress({ phase: "authors", done: 0, total: items.length, message: "Adding authors and categories" });
  const usedAuthors = new Set(items.map((i) => i.authorKey));
  const authorIds = new Map<string, string>();
  for (const a of wp.authors.filter((x) => usedAuthors.has(x.key) || usedAuthors.has(x.login))) {
    const existing = findAuthor(ctx.db, siteId, slugify(a.login)) ?? findAuthor(ctx.db, siteId, a.displayName);
    if (existing) {
      authorIds.set(a.key, existing.id);
      continue;
    }
    const base = slugify(a.displayName) || slugify(a.login) || "author";
    let slug = base;
    for (let n = 2; ctx.db.query("SELECT 1 FROM authors WHERE site_id = ? AND slug = ?").get(siteId, slug); n++) slug = `${base}-${n}`;
    const user = a.email ? ctx.db.query<{ id: string }, [string]>("SELECT id FROM users WHERE email = ?").get(a.email.toLowerCase()) : null;
    const author: Author = {
      id: id("aut"),
      siteId,
      slug,
      name: a.displayName,
      bio: "",
      expertise: [],
      credentials: "",
      userId: user?.id ?? null,
      isPersona: false,
      requiresApproval: true,
      voice: defaultVoice(),
      photoMediaId: null,
      createdAt: nowIso(),
    };
    saveAuthor(ctx.db, author);
    created.authorIds.push(author.id);
    authorIds.set(a.key, author.id);
    report.counts.authors++;
  }

  // ---- Categories and tags ----
  const categoryIds = new Map<string, string>();
  for (const c of wp.categories) {
    const slug = slugify(c.slug || c.name);
    if (!slug) continue;
    const existing = ctx.db.query<{ id: string }, [string, string]>("SELECT id FROM categories WHERE site_id = ? AND slug = ? AND deleted_at IS NULL").get(siteId, slug);
    if (existing) {
      categoryIds.set(c.slug, existing.id);
      continue;
    }
    // WordPress's default bucket says nothing about a post; leave those posts without a category.
    if (slug === "uncategorized") continue;
    const cid = id("cat");
    const pos = ctx.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM categories WHERE site_id = ?").get(siteId)?.n ?? 0;
    ctx.db.query("INSERT INTO categories (id, site_id, slug, name, description, position) VALUES (?, ?, ?, ?, ?, ?)").run(cid, siteId, slug, c.name || c.slug, htmlText(c.description), pos);
    created.categoryIds.push(cid);
    categoryIds.set(c.slug, cid);
    report.counts.categories++;
  }
  report.counts.tags = new Set(items.flatMap((i) => i.tags)).size;

  // ---- Media ----
  const attachments = new Map<string, WpItem>();
  const attachmentByUrl = new Map<string, WpItem>();
  for (const a of wp.items.filter((i) => i.type === "attachment" && i.attachmentUrl)) {
    attachments.set(a.wpId, a);
    attachmentByUrl.set(a.attachmentUrl!, a);
  }
  const mediaByUrl = new Map<string, { id: string; alt: string; caption: string }>();
  const lookupAttachment = (url: string) => attachmentByUrl.get(url) ?? attachmentByUrl.get(fullSizeUrl(url));
  if (opts.downloadMedia) {
    const wanted = new Set<string>();
    for (const i of items) {
      for (const u of imageUrlsIn(i.content)) wanted.add(absolute(u, wp.link));
      for (const m of i.content.matchAll(/\[gallery[^\]]*ids=["']?([\d,\s]+)/gi)) for (const gid of m[1]!.split(",")) {
        const a = attachments.get(gid.trim());
        if (a) wanted.add(a.attachmentUrl!);
      }
      if (i.thumbnailId && attachments.get(i.thumbnailId)) wanted.add(attachments.get(i.thumbnailId)!.attachmentUrl!);
    }
    // Sized copies (photo-300x200.jpg) share one download of the full-size original.
    const groups = new Map<string, string[]>();
    for (const u of [...wanted].filter((x) => /^https?:\/\//.test(x)).slice(0, 5000)) groups.set(fullSizeUrl(u), [...(groups.get(fullSizeUrl(u)) ?? []), u]);
    const total = groups.size;
    let done = 0;
    progress({ phase: "media", done, total, message: `Copying ${total} images` });
    await mapLimit([...groups.entries()], 4, async ([full, aliases]) => {
      const att = lookupAttachment(full) ?? aliases.map(lookupAttachment).find(Boolean);
      const candidates = [...new Set([full, ...aliases])];
      for (const candidate of candidates) {
        try {
          const got = await limitedFetch(candidate, { maxBytes: 50 * 1024 * 1024, timeoutMs: 60_000 });
          const filename = decodeURIComponent(new URL(candidate).pathname.split("/").pop() || "image");
          const { media, duplicate } = await ingest(ctx, { bytes: got.bytes, filename, mime: got.headers.get("content-type") ?? "", alt: att?.alt ?? "", caption: att?.caption ? htmlText(att.caption) : "", sourceUrl: candidate }, { direct: true });
          if (!duplicate) {
            created.mediaIds.push(media.id);
            report.counts.media++;
          }
          const ref = { id: media.id, alt: media.alt, caption: media.caption };
          for (const u of [full, ...aliases]) mediaByUrl.set(u, ref);
          break;
        } catch (err) {
          if (candidate === candidates[candidates.length - 1]) report.warnings.push(`Couldn't copy ${aliases[0]}: ${(err as Error).message}`);
        }
      }
      done++;
      if (done % 10 === 0) progress({ phase: "media", done, total, message: `Copied ${done} of ${total} images` });
    });
  }

  // ---- Posts and pages (first in memory, so internal links can point at new ids) ----
  progress({ phase: "content", done: 0, total: items.length, message: `Converting ${items.length} posts and pages` });
  const shortcodeUse = new Map<string, { count: number; entries: Set<string> }>();
  const planned: { entry: Entry; item: WpItem; old: string | null }[] = [];
  const byOldPath = new Map<string, string>();
  const reserved = new Set<string>();
  const sorted = [...items].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  for (const item of sorted) {
    const title = htmlText(item.title) || "Untitled";
    const baseSlug = slugify(item.slug || title) || "untitled";
    const existing = entryBySlug(ctx.db, siteId, baseSlug);
    if (existing && existing.title.toLowerCase() === title.toLowerCase()) {
      report.skipped.push({ title, reason: "Already on the site (imported before)." });
      report.counts.skipped++;
      const old = oldPath(item.link, wp.link);
      if (old) byOldPath.set(old, existing.id);
      continue;
    }
    let slug = uniqueSlug(ctx.db, siteId, baseSlug);
    for (let n = 2; reserved.has(slug); n++) slug = uniqueSlug(ctx.db, siteId, `${baseSlug}-${n}`);
    reserved.add(slug);

    const converted = htmlToDoc(item.content, {
      attachmentUrl: (wpId) => attachments.get(wpId)?.attachmentUrl ?? null,
      image: (src) => {
        const abs = absolute(src, wp.link);
        const m = mediaByUrl.get(abs) ?? mediaByUrl.get(fullSizeUrl(abs));
        const att = lookupAttachment(abs);
        if (m) return { src: `media:${m.id}`, alt: m.alt, caption: m.caption };
        return { src: abs, alt: att?.alt, caption: att?.caption ? htmlText(att.caption) : undefined };
      },
    });
    for (const name of converted.unknownShortcodes) {
      const u = shortcodeUse.get(name) ?? { count: 0, entries: new Set<string>() };
      u.count++;
      u.entries.add(title);
      shortcodeUse.set(name, u);
    }
    const { status, publishAt } = mapStatus(item.status, item.date, !!opts.asDrafts);
    const seo = seoDescription(item);
    if (seo.fromSeo) report.seo.descriptions++;
    if (item.meta._yoast_wpseo_title || item.meta.rank_math_title || item.seoTitle) report.seo.titles++;
    const authorId = authorIds.get(item.authorKey);
    const categoryId = item.categories.map((c) => categoryIds.get(c)).find(Boolean) ?? null;
    const thumb = item.thumbnailId ? attachments.get(item.thumbnailId) : undefined;
    const hero = thumb?.attachmentUrl ? mediaByUrl.get(thumb.attachmentUrl) ?? mediaByUrl.get(fullSizeUrl(thumb.attachmentUrl)) : undefined;
    const published = status === "published" ? item.date ?? nowIso() : null;
    const entry = newEntry(siteId, {
      type: item.type === "page" ? "page" : "post",
      title,
      slug,
      status,
      description: seo.description,
      body: converted.doc,
      authorIds: authorId ? [authorId] : [],
      categoryId,
      tags: item.tags,
      heroMediaId: hero?.id ?? null,
      publishAt,
      publishedAt: published,
      updatedAt: published ? (item.modified && item.modified > published ? item.modified : published) : null,
      createdAt: item.date ?? nowIso(),
    });
    for (const src of converted.missingAlt) report.missingAlt.push({ entryId: entry.id, title, src });
    const old = oldPath(item.link, wp.link);
    if (old) byOldPath.set(old, entry.id);
    planned.push({ entry, item, old });
  }

  // ---- Internal links: old addresses become tq:<entryId>, which survive any later slug change ----
  progress({ phase: "links", done: 0, total: planned.length, message: "Pointing internal links at the new pages" });
  const siteHost = hostOf(wp.link);
  const rewrite = (href: string): string => {
    if (href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("tq:") || href.startsWith("media:")) return href;
    try {
      const u = new URL(href, wp.link || "https://example.invalid");
      if (siteHost && hostOf(u.toString()) !== siteHost && !href.startsWith("/")) return href;
      const p = oldPath(u.toString(), wp.link);
      const target = p ? byOldPath.get(p) : undefined;
      return target ? `tq:${target}${u.hash}` : href;
    } catch {
      return href;
    }
  };
  for (const p of planned) p.entry.body = rewriteLinks(p.entry.body, rewrite);

  // ---- Save, redirect, report ----
  let saved = 0;
  for (const { entry, item, old } of planned) {
    saveEntry(ctx.db, entry, ctx.actor, meta.actionId);
    created.entryIds.push(entry.id);
    if (entry.type === "page") report.counts.pages++;
    else report.counts.posts++;
    try {
      await runEntrySaved(ctx, entry);
    } catch (err) {
      report.warnings.push(`“${entry.title}” was imported, but a follow-up check failed: ${(err as Error).message}`);
    }
    const now = entryPath(entry);
    if (old && old !== now && old !== "/") {
      const exists = ctx.db.query("SELECT 1 FROM redirects WHERE site_id = ? AND from_path = ?").get(siteId, old);
      if (!exists) {
        ctx.db.query("INSERT INTO redirects (site_id, from_path, to_path, code, created_at) VALUES (?, ?, ?, 301, ?)").run(siteId, old, now, nowIso());
        created.redirects.push(old);
        report.counts.redirects++;
      }
    }
    report.urlMap.push({ old: old ?? item.link, new: now, entryId: entry.id, status: entry.status });
    if (entry.status === "published") {
      const words = wordCount(entry.body);
      if (words < THIN_WORDS) report.thinPages.push({ entryId: entry.id, title: entry.title, path: now, words });
    }
    saved++;
    if (saved % 25 === 0) progress({ phase: "content", done: saved, total: planned.length, message: `Imported ${saved} of ${planned.length}` });
  }

  const titles = new Map<string, string[]>();
  for (const { entry } of planned) {
    const k = entry.title.trim().toLowerCase();
    titles.set(k, [...(titles.get(k) ?? []), entryPath(entry)]);
  }
  report.duplicateTitles = [...titles.entries()].filter(([, paths]) => paths.length > 1).map(([, paths]) => ({ title: planned.find((p) => entryPath(p.entry) === paths[0])!.entry.title, paths }));
  report.unknownShortcodes = [...shortcodeUse.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, u]) => ({ name, count: u.count, entries: [...u.entries].slice(0, 20), suggestion: SHORTCODE_ADVICE[name] ?? "The shortcode was removed and the text around it kept. Check those pages and ask me to rebuild what it did." }));

  if (planned.length) {
    ctx.services.emit({ type: "site.changed", siteId, what: "categories" });
    ctx.services.emit({ type: "site.changed", siteId, what: "authors" });
    ctx.services.enqueueBuild(siteId, "WordPress import");
  }
  report.summary = summarize(report);
  progress({ phase: "done", done: planned.length, total: planned.length, message: report.summary[0] ?? "Done" });
  return report;
}

function rewriteLinks(d: Doc, fn: (href: string) => string): Doc {
  return mapInline(d, (text) => text.replace(/(?<!!)\[([^\]]+)\]\(([^)\s]+)\)/g, (_, anchor, href) => `[${anchor}](${fn(href)})`));
}

function hostOf(u: string): string | null {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function absolute(src: string, base: string): string {
  try {
    return new URL(src, base || undefined).toString();
  } catch {
    return src;
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function summarize(r: ImportReport): string[] {
  const out = [
    `Imported ${plural(r.counts.posts, "post")} and ${plural(r.counts.pages, "page")}, with ${plural(r.counts.categories, "new category", "new categories")}, ${plural(r.counts.authors, "new author")} and ${plural(r.counts.media, "image")}.`,
  ];
  if (r.counts.redirects) out.push(`${plural(r.counts.redirects, "old address", "old addresses")} now redirect${r.counts.redirects === 1 ? "s" : ""} to ${r.counts.redirects === 1 ? "its" : "their"} new place, so no link breaks.`);
  else out.push("Every address stayed the same, so no redirects were needed.");
  if (r.seo.descriptions) out.push(`Kept ${plural(r.seo.descriptions, "search description")} from your SEO plugin.`);
  if (r.unknownShortcodes.length) out.push(`${plural(r.unknownShortcodes.length, "shortcode")} couldn't be converted: ${r.unknownShortcodes.map((s) => `[${s.name}]`).join(", ")}.`);
  if (r.missingAlt.length) out.push(`${plural(r.missingAlt.length, "image")} had no alt text; I'll propose some.`);
  if (r.thinPages.length) out.push(`${plural(r.thinPages.length, "live page")} ${r.thinPages.length === 1 ? "is" : "are"} thin (under ${THIN_WORDS} words).`);
  if (r.duplicateTitles.length) out.push(`${plural(r.duplicateTitles.length, "title")} ${r.duplicateTitles.length === 1 ? "is" : "are"} used by more than one page.`);
  if (r.counts.skipped) out.push(`Skipped ${plural(r.counts.skipped, "item")} that ${r.counts.skipped === 1 ? "was" : "were"} already here.`);
  return out;
}

/** Undo an import: remove what it created. */
export function undoImport(ctx: Ctx, created: Created) {
  const siteId = ctx.siteId!;
  const now = nowIso();
  ctx.db.transaction(() => {
    for (const e of created.entryIds) ctx.db.query("UPDATE entries SET deleted_at = ?, status = CASE WHEN status = 'published' THEN 'unpublished' ELSE status END WHERE id = ? AND site_id = ?").run(now, e, siteId);
    for (const c of created.categoryIds) ctx.db.query("UPDATE categories SET deleted_at = ? WHERE id = ? AND site_id = ?").run(now, c, siteId);
    for (const a of created.authorIds) ctx.db.query("UPDATE authors SET deleted_at = ? WHERE id = ? AND site_id = ?").run(now, a, siteId);
    for (const m of created.mediaIds) ctx.db.query("UPDATE media SET deleted_at = ? WHERE id = ? AND site_id = ?").run(now, m, siteId);
    for (const r of created.redirects) ctx.db.query("DELETE FROM redirects WHERE site_id = ? AND from_path = ?").run(siteId, r);
  })();
  for (const e of created.entryIds) ctx.services.emit({ type: "entry.unpublished", siteId, entryId: e });
  ctx.services.enqueueBuild(siteId, "import undone");
}
