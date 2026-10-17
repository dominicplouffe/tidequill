import { XMLParser } from "fast-xml-parser";
import { TqError } from "../core/errors.ts";
import { limitedFetch, publicUrl } from "../media/net.ts";
import { htmlText } from "./convert.ts";

/**
 * One shape for a WordPress site, whether it came from a WXR export file or
 * the live REST API. Everything in it is data from the old site.
 */

export interface WpAuthor {
  key: string;
  login: string;
  email: string;
  displayName: string;
}

export interface WpTerm {
  key: string;
  slug: string;
  name: string;
  description: string;
}

export interface WpItem {
  wpId: string;
  type: string;
  title: string;
  slug: string;
  status: string;
  /** ISO dates, or null when the old site had none. */
  date: string | null;
  modified: string | null;
  link: string;
  content: string;
  excerpt: string;
  authorKey: string;
  categories: string[];
  tags: string[];
  meta: Record<string, string>;
  attachmentUrl: string | null;
  thumbnailId: string | null;
  /** From the REST API's SEO plugin fields, when present. */
  seoDescription?: string;
  seoTitle?: string;
  alt?: string;
  caption?: string;
}

export interface WpSite {
  title: string;
  link: string;
  authors: WpAuthor[];
  categories: WpTerm[];
  tags: WpTerm[];
  items: WpItem[];
}

const asArray = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const str = (v: unknown): string => (v == null ? "" : typeof v === "object" ? String((v as any)["#text"] ?? "") : String(v));

/** "2019-05-14 10:00:00" (GMT) -> ISO; "0000-00-00 00:00:00" -> null. */
export function wpDate(v: string | undefined | null, assumeUtc = true): string | null {
  const s = (v ?? "").trim();
  if (!s || s.startsWith("0000")) return null;
  const isoish = s.includes("T") ? s : s.replace(" ", "T");
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(isoish) || !assumeUtc ? isoish : `${isoish}Z`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// ---------- WXR ----------

export function looksLikeWxr(text: string): boolean {
  const head = text.slice(0, 4000);
  return head.includes("<rss") && (head.includes("wordpress.org/export") || head.includes("xmlns:wp="));
}

export function parseWxr(xml: string): WpSite {
  if (!looksLikeWxr(xml)) throw new TqError("invalid", "That file isn't a WordPress export. In WordPress, go to Tools → Export → All content, and upload the .xml file it gives you.");
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: false,
    trimValues: true,
    processEntities: true,
    htmlEntities: true,
    isArray: (name) => ["item", "wp:postmeta", "category", "wp:author", "wp:category", "wp:tag", "wp:term"].includes(name),
  });
  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    throw new TqError("invalid", `The export file is damaged and can't be read (${(err as Error).message}). Export it again from WordPress.`);
  }
  const ch = doc?.rss?.channel;
  if (!ch) throw new TqError("invalid", "That WordPress export has no content in it.");
  const authors: WpAuthor[] = asArray(ch["wp:author"]).map((a: any) => ({
    key: str(a["wp:author_login"]),
    login: str(a["wp:author_login"]),
    email: str(a["wp:author_email"]),
    displayName: str(a["wp:author_display_name"]) || [str(a["wp:author_first_name"]), str(a["wp:author_last_name"])].filter(Boolean).join(" ") || str(a["wp:author_login"]),
  }));
  const categories: WpTerm[] = asArray(ch["wp:category"]).map((c: any) => ({
    key: str(c["wp:category_nicename"]),
    slug: str(c["wp:category_nicename"]),
    name: str(c["wp:cat_name"]),
    description: str(c["wp:category_description"]),
  }));
  const tags: WpTerm[] = asArray(ch["wp:tag"]).map((t: any) => ({ key: str(t["wp:tag_slug"]), slug: str(t["wp:tag_slug"]), name: str(t["wp:tag_name"]), description: str(t["wp:tag_description"]) }));
  const items: WpItem[] = asArray(ch.item).map((it: any) => {
    const meta: Record<string, string> = {};
    for (const m of asArray(it["wp:postmeta"])) meta[str((m as any)["wp:meta_key"])] = str((m as any)["wp:meta_value"]);
    const cats = asArray(it.category) as any[];
    return {
      wpId: str(it["wp:post_id"]),
      type: str(it["wp:post_type"]) || "post",
      title: str(it.title),
      slug: decodeURIComponent(str(it["wp:post_name"])),
      status: str(it["wp:status"]) || "publish",
      date: wpDate(str(it["wp:post_date_gmt"])) ?? wpDate(str(it["wp:post_date"])),
      modified: wpDate(str(it["wp:post_modified_gmt"])) ?? wpDate(str(it["wp:post_modified"])),
      link: str(it.link),
      content: str(it["content:encoded"]),
      excerpt: str(it["excerpt:encoded"]),
      authorKey: str(it["dc:creator"]),
      categories: cats.filter((c) => c["@_domain"] === "category").map((c) => str(c["@_nicename"]) || str(c)),
      tags: cats.filter((c) => c["@_domain"] === "post_tag").map((c) => str(c)),
      meta,
      attachmentUrl: str(it["wp:attachment_url"]) || null,
      thumbnailId: meta._thumbnail_id || null,
      alt: meta._wp_attachment_image_alt,
      caption: str(it["excerpt:encoded"]),
    };
  });
  return { title: str(ch.title), link: str(ch.link) || str(ch["wp:base_site_url"]), authors, categories, tags, items };
}

// ---------- REST API ----------

export interface RestCredentials {
  username?: string;
  appPassword?: string;
}

/** Reads a live WordPress site through /wp-json/wp/v2, page by page. */
export async function fetchWpRest(siteUrl: string, creds: RestCredentials, onProgress?: (what: string, count: number) => void): Promise<WpSite> {
  const base = publicUrl(siteUrl);
  const root = base.toString().replace(/\/+$/, "");
  const authed = !!(creds.username && creds.appPassword);
  const headers: Record<string, string> = { accept: "application/json" };
  if (authed) headers.authorization = `Basic ${btoa(`${creds.username}:${creds.appPassword!.replace(/\s+/g, "")}`)}`;
  let usePrettyRoutes = true;

  const endpoint = (path: string, query: Record<string, string | number>) => {
    const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
    return usePrettyRoutes ? `${root}/wp-json/wp/v2/${path}?${qs}` : `${root}/?rest_route=/wp/v2/${path}&${qs}`;
  };

  const getAll = async (path: string, extra: Record<string, string | number> = {}): Promise<any[]> => {
    const out: any[] = [];
    for (let page = 1; page <= 200; page++) {
      let res = await limitedFetch(endpoint(path, { per_page: 100, page, ...extra }), { maxBytes: 50 * 1024 * 1024, timeoutMs: 60_000, headers, requireOk: false });
      if (res.status === 404 && page === 1 && usePrettyRoutes) {
        usePrettyRoutes = false;
        res = await limitedFetch(endpoint(path, { per_page: 100, page, ...extra }), { maxBytes: 50 * 1024 * 1024, timeoutMs: 60_000, headers, requireOk: false });
      }
      if (res.status === 400 && page > 1) break; // past the last page
      if (res.status === 401 || res.status === 403) {
        throw new TqError("unauthorized", `${base.hostname} refused the username or application password. In WordPress, go to Users → Profile → Application Passwords and create a new one.`);
      }
      if (res.status >= 400) throw new TqError("failed", `${base.hostname} answered ${res.status} when asked for its ${path}. Is the WordPress REST API turned on?`);
      let rows: unknown;
      try {
        rows = JSON.parse(new TextDecoder().decode(res.bytes));
      } catch {
        throw new TqError("failed", `${base.hostname} didn't answer like a WordPress site. Check the address, or upload an export file instead.`);
      }
      if (!Array.isArray(rows)) break;
      out.push(...rows);
      onProgress?.(path, out.length);
      const total = Number(res.headers.get("x-wp-totalpages") ?? 0);
      if (rows.length < 100 || (total && page >= total)) break;
    }
    return out;
  };

  const editCtx: Record<string, string> = authed ? { context: "edit" } : {};
  const statuses: Record<string, string> = authed ? { status: "publish,future,draft,pending,private" } : {};
  const [users, cats, tags, media, posts, pages] = [
    await getAll("users", editCtx).catch(() => [] as any[]),
    await getAll("categories"),
    await getAll("tags"),
    await getAll("media", editCtx).catch(() => [] as any[]),
    await getAll("posts", { ...editCtx, ...statuses }),
    await getAll("pages", { ...editCtx, ...statuses }),
  ];

  const rendered = (v: any) => (v && typeof v === "object" ? (v.raw ?? v.rendered ?? "") : String(v ?? ""));
  const catById = new Map(cats.map((c: any) => [String(c.id), c]));
  const tagById = new Map(tags.map((t: any) => [String(t.id), t]));

  const toItem = (p: any, type: string): WpItem => ({
    wpId: String(p.id),
    type,
    title: htmlText(rendered(p.title)),
    slug: decodeURIComponent(String(p.slug ?? "")),
    status: String(p.status ?? "publish"),
    date: wpDate(p.date_gmt) ?? wpDate(p.date, false),
    modified: wpDate(p.modified_gmt) ?? wpDate(p.modified, false),
    link: String(p.link ?? ""),
    content: rendered(p.content),
    excerpt: rendered(p.excerpt),
    authorKey: String(p.author ?? ""),
    categories: asArray(p.categories).map((id: any) => catById.get(String(id))?.slug).filter(Boolean) as string[],
    tags: asArray(p.tags).map((id: any) => tagById.get(String(id))?.name).filter(Boolean) as string[],
    meta: Object.fromEntries(Object.entries(p.meta && typeof p.meta === "object" && !Array.isArray(p.meta) ? p.meta : {}).map(([k, v]) => [k, Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "")])),
    attachmentUrl: null,
    thumbnailId: p.featured_media ? String(p.featured_media) : null,
    seoDescription: p.yoast_head_json?.description ?? p.yoast_head_json?.og_description ?? undefined,
    seoTitle: p.yoast_head_json?.title ?? undefined,
  });

  return {
    title: base.hostname,
    link: root,
    authors: users.map((u: any) => ({ key: String(u.id), login: String(u.slug ?? u.username ?? u.id), email: String(u.email ?? ""), displayName: String(u.name ?? u.slug ?? "Author") })),
    categories: cats.map((c: any) => ({ key: String(c.slug), slug: String(c.slug), name: htmlText(String(c.name ?? c.slug)), description: String(c.description ?? "") })),
    tags: tags.map((t: any) => ({ key: String(t.slug), slug: String(t.slug), name: htmlText(String(t.name ?? t.slug)), description: "" })),
    items: [
      ...posts.map((p: any) => toItem(p, "post")),
      ...pages.map((p: any) => toItem(p, "page")),
      ...media.map(
        (m: any): WpItem => ({
          ...toItem(m, "attachment"),
          attachmentUrl: String(m.source_url ?? ""),
          alt: String(m.alt_text ?? ""),
          caption: htmlText(rendered(m.caption)),
        }),
      ),
    ],
  };
}
