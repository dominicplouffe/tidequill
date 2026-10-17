import { headingId, docHtml, escapeHtml, type MediaRef, type Resolver } from "../content/html.ts";
import { plainInline } from "../content/blocks.ts";
import { initials, type Author } from "../core/authors.ts";
import { entryPath, type Entry } from "../core/entries.ts";
import { pageCss, renderTemplate, type TemplateName } from "./engine.ts";
import {
  absoluteUrl,
  authorPath,
  categoryPath,
  entryAuthors,
  postsBy,
  postsIn,
  relatedPosts,
  type Category,
  type SiteModel,
} from "./model.ts";
import { factValue, mediaRef, siteResolver } from "./resolve.ts";
import { articleLd, breadcrumbList, clip, dateLabel, entryDescription, faqLd, ldJson, organization, person, titleTag, website } from "./seo.ts";
import { entryMarkdown } from "./twin.ts";

/**
 * View models for every kind of public page, and the plan of which pages a
 * site has. Each view is fully resolved before it reaches a template.
 */

export const PAGE_SIZE = 24;
export const HOME_LATEST = 12;

export type PageKind = "home" | "entry" | "list" | "author" | "search" | "404";

export interface RenderedPage {
  path: string;
  kind: PageKind;
  html: string;
  /** Markdown twin, for entries (served at <path>index.md). */
  markdown?: string;
  entryId?: string;
}

export interface RenderOptions {
  /** Live editing: data-tq-block attributes and the title field marker. */
  annotate?: boolean;
  /** Resolve internal links to drafts too (live editing and previews). */
  includeDrafts?: (entryId: string) => string | null;
}

export interface RenderCtx {
  m: SiteModel;
  resolver: Resolver;
  fact: (key: string) => string | null;
  css: { inline: string; preload: string | null };
  nav: { label: string; href: string }[];
  footer: { label: string; href: string }[];
  topics: { name: string; href: string; count: number }[];
  opts: RenderOptions;
}

export function renderCtx(m: SiteModel, opts: RenderOptions = {}): RenderCtx {
  const topics = m.categories.map((c) => ({ name: c.name, href: categoryPath(c), count: postsIn(m, c.id).length })).filter((t) => t.count > 0);
  const pages = m.entries.filter((e) => e.type === "page" && e.slug !== "home");
  const about = pages.find((p) => p.slug === "about");
  const nav = [...topics.slice(0, 6).map((t) => ({ label: t.name, href: t.href })), ...(about ? [{ label: plainInline(about.title), href: entryPath(about) }] : [])];
  const footer = pages
    .map((p) => ({ label: plainInline(p.title), href: entryPath(p) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return {
    m,
    resolver: siteResolver(m, { extraPath: opts.includeDrafts }),
    fact: factValue(m),
    css: pageCss(m.design, m.tokens),
    nav,
    footer,
    topics,
    opts,
  };
}

// ---------- shared pieces ----------

interface Seo {
  title: string;
  ogTitle: string;
  description: string;
  canonical: string;
  ogType: "website" | "article" | "profile";
  image?: string | null;
  imageAlt?: string;
  published?: string | null;
  modified?: string | null;
  markdown?: string | null;
  noindex?: boolean;
  jsonLd?: string | null;
}

/** Collapses the blank lines template tags leave behind, without touching <pre> blocks. */
export function tidyHtml(html: string): string {
  return html
    .split(/(<pre\b[\s\S]*?<\/pre>)/)
    .map((part, i) => (i % 2 ? part : part.replace(/\n[ \t]*(?:\n[ \t]*)+/g, "\n")))
    .join("");
}

function siteData(rc: RenderCtx, current: string | null, path: string) {
  const { m } = rc;
  return {
    name: m.site.name,
    lang: m.site.locale || "en",
    ogLocale: (m.site.locale || "en_US").replace("-", "_"),
    tagline: clip(m.site.niche, 140),
    year: new Date().getUTCFullYear(),
    // "page" when the link is this very page, "true" when it's the section the page is in.
    nav: rc.nav.map((n) => ({ ...n, current: n.href === path ? "page" : current === n.href ? "true" : null })),
    footer: rc.footer,
  };
}

function page(rc: RenderCtx, template: TemplateName, path: string, kind: PageKind, current: string | null, seo: Seo, view: Record<string, unknown>, tail = ""): string {
  const html = renderTemplate(rc.m.design, template, {
    site: siteData(rc, current, path),
    seo: { twitterCard: seo.image ? "summary_large_image" : "summary", ...seo },
    css: rc.css,
    page: { kind, path, tail },
    ...view,
  });
  return tidyHtml(html);
}

function dateView(rc: RenderCtx, iso: string | null | undefined) {
  if (!iso) return null;
  return { iso, label: dateLabel(iso, rc.m.site.locale, rc.m.site.settings.timezone) };
}

function imgHtml(ref: MediaRef, alt: string, opts: { eager?: boolean; sizes?: string }): string {
  const dims = ref.width && ref.height ? ` width="${ref.width}" height="${ref.height}"` : "";
  const srcset = ref.srcset ? ` srcset="${escapeHtml(ref.srcset)}" sizes="${escapeHtml(opts.sizes ?? "(max-width: 760px) 100vw, 760px")}"` : "";
  const loading = opts.eager ? ' fetchpriority="high"' : ' loading="lazy"';
  return `<img src="${escapeHtml(ref.src)}" alt="${escapeHtml(alt)}"${dims}${srcset}${loading} decoding="async">`;
}

function heroOf(rc: RenderCtx, e: Entry): { ref: MediaRef; alt: string } | null {
  if (!e.heroMediaId) return null;
  const ref = mediaRef(rc.m.media.get(e.heroMediaId));
  return ref ? { ref, alt: ref.alt ?? "" } : null;
}

function card(rc: RenderCtx, e: Entry) {
  const hero = heroOf(rc, e);
  const cat = e.categoryId ? rc.m.categoryById.get(e.categoryId) : null;
  return {
    title: plainInline(e.title, rc.fact),
    href: entryPath(e),
    description: clip(entryDescription(e, rc.fact), 140),
    date: e.type === "post" ? dateView(rc, e.updatedAt ?? e.publishedAt) : null,
    category: cat?.name ?? null,
    // The title next to it says what the picture is about, so the image is decorative here.
    image: hero ? imgHtml(hero.ref, "", { sizes: "(max-width: 600px) 100vw, 360px" }) : null,
  };
}

function authorView(rc: RenderCtx, a: Author) {
  const photo = a.photoMediaId ? mediaRef(rc.m.media.get(a.photoMediaId)) : null;
  return {
    name: a.name,
    href: authorPath(a),
    bio: a.bio,
    credentials: a.credentials,
    initials: initials(a.name),
    photo: photo ? imgHtml({ ...photo, srcset: undefined }, `Photo of ${a.name}`, {}) : null,
    expertise: a.expertise,
  };
}

function pager(base: string, pageNo: number, pages: number) {
  if (pages <= 1) return null;
  const at = (n: number) => (n === 1 ? base : `${base}page/${n}/`);
  return { prev: pageNo > 1 ? at(pageNo - 1) : null, next: pageNo < pages ? at(pageNo + 1) : null, label: `Page ${pageNo} of ${pages}` };
}

export function pagedPath(base: string, pageNo: number): string {
  return pageNo === 1 ? base : `${base}page/${pageNo}/`;
}

function pageCount(n: number, size = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(n / size));
}

function titleAttrs(rc: RenderCtx): string {
  return rc.opts.annotate ? ' data-tq-field="title"' : "";
}

// ---------- entries ----------

/** Byline: "By Fred Laurent, updated Oct 20, 2026" (pages show only the date). */
function byline(rc: RenderCtx, e: Entry, authors: Author[], updated: string): string {
  const d = dateView(rc, updated);
  const time = d ? `<time datetime="${escapeHtml(d.iso)}">${escapeHtml(d.label)}</time>` : "";
  if (e.type === "page" || !authors.length) return time ? `Updated ${time}` : "";
  const names = authors.map((a) => `<a href="${authorPath(a)}" rel="author">${escapeHtml(a.name)}</a>`);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0]!;
  return `By ${list}${time ? `, updated ${time}` : ""}`;
}

function disclosure(rc: RenderCtx, e: Entry, authors: Author[]): string | null {
  if (!rc.m.site.settings.aiDisclosure || !rc.m.aiAssisted.has(e.id)) return null;
  const people = authors.filter((a) => !a.isPersona).map((a) => a.name);
  if (!people.length) return "Written with AI assistance.";
  return `Written with AI assistance, reviewed by ${people.length > 1 ? `${people.slice(0, -1).join(", ")} and ${people[people.length - 1]}` : people[0]}.`;
}

export function renderEntry(rc: RenderCtx, e: Entry): RenderedPage {
  const { m } = rc;
  const path = entryPath(e);
  const url = absoluteUrl(m, path);
  const title = plainInline(e.title, rc.fact);
  const description = entryDescription(e, rc.fact);
  const authors = entryAuthors(m, e);
  const cat = e.categoryId ? m.categoryById.get(e.categoryId) ?? null : null;
  const updated = e.updatedAt ?? e.publishedAt ?? e.modifiedAt;
  const published = e.publishedAt ?? e.createdAt;
  const hero = heroOf(rc, e);
  const crumbs = [{ label: "Home", href: "/" }, ...(cat ? [{ label: cat.name, href: categoryPath(cat) }] : []), { label: title, href: path }];
  const image = hero ? absoluteUrl(m, hero.ref.src) : null;

  const graph: object[] = [
    articleLd(m, e, { url, title, description, authors, image, section: cat?.name ?? null, published, modified: updated }),
    breadcrumbList(m, crumbs),
    organization(m),
  ];
  const faq = faqLd(e.body, rc.fact);
  if (faq) graph.push(faq);

  const view = {
    entry: {
      title,
      titleAttrs: titleAttrs(rc),
      isPost: e.type === "post",
      category: cat ? { name: cat.name, href: categoryPath(cat) } : null,
      byline: byline(rc, e, authors, updated),
      disclosure: disclosure(rc, e, authors),
      hero: hero ? imgHtml(hero.ref, hero.alt, { eager: true }) : null,
      bodyHtml: docHtml(e.body, { resolver: rc.resolver, annotate: rc.opts.annotate, lazyFrom: hero ? 0 : 1 }),
      toc: e.body.blocks.flatMap((b) => (b.type === "heading" && b.level === 2 ? [{ id: headingId(b.text), text: plainInline(b.text, rc.fact) }] : [])),
      authors: e.type === "post" ? authors.map((a) => authorView(rc, a)) : [],
      related: e.type === "post" ? relatedPosts(m, e).map((r) => card(rc, r)) : [],
      breadcrumbs: crumbs,
    },
  };
  const seo: Seo = {
    title: titleTag(title, m.site.name),
    ogTitle: title,
    description,
    canonical: url,
    ogType: "article",
    image,
    imageAlt: hero?.alt ?? "",
    published,
    modified: updated,
    markdown: `${path}index.md`,
    jsonLd: ldJson(graph),
  };
  const html = page(rc, "entry", path, "entry", cat ? categoryPath(cat) : path, seo, view);
  const markdown = entryMarkdown(m, e, { path, title, description, resolveEntry: (id) => rc.resolver.entry?.(id) ?? null });
  return { path, kind: "entry", html, markdown, entryId: e.id };
}

// ---------- home ----------

export function homeEntry(m: SiteModel): Entry | null {
  return m.entries.find((e) => e.type === "page" && e.slug === "home") ?? null;
}

export function renderHome(rc: RenderCtx, pageNo = 1, homePage: Entry | null = homeEntry(rc.m)): RenderedPage {
  const { m } = rc;
  const path = pagedPath("/", pageNo);
  const pages = homePage ? 1 : pageCount(m.posts.length);
  const latest = homePage ? m.posts.slice(0, HOME_LATEST) : m.posts.slice((pageNo - 1) * PAGE_SIZE, pageNo * PAGE_SIZE);
  const first = pageNo === 1;
  const hero = homePage ? heroOf(rc, homePage) : (m.posts.map((p) => heroOf(rc, p)).find(Boolean) ?? null);
  const title = homePage ? plainInline(homePage.title, rc.fact) : first ? m.site.name : `Latest posts, page ${pageNo}`;
  const lede = homePage ? plainInline(homePage.description, rc.fact) : first ? m.site.niche : "";
  const description = clip(homePage ? entryDescription(homePage, rc.fact) || m.site.niche : m.site.niche || `Latest posts from ${m.site.name}.`, 155);
  const firstTopic = rc.topics[0];

  const view = {
    home: {
      kicker: null,
      title,
      titleAttrs: homePage ? titleAttrs(rc) : "",
      lede,
      bodyHtml: homePage ? docHtml(homePage.body, { resolver: rc.resolver, annotate: rc.opts.annotate, lazyFrom: 1 }) : null,
      heroImage: hero && first ? imgHtml(hero.ref, hero.alt, { eager: true, sizes: "(max-width: 700px) 100vw, 560px" }) : null,
      cta: first && firstTopic ? { label: `Browse ${firstTopic.name}`, href: firstTopic.href } : null,
      latestTitle: homePage ? "Latest posts" : first ? "Latest" : "Older posts",
      latest: latest.map((e) => card(rc, e)),
      pager: homePage ? null : pager("/", pageNo, pages),
      topics: rc.topics,
    },
  };
  const seo: Seo = {
    title: first && (!homePage || title === m.site.name) ? m.site.name : titleTag(title, m.site.name),
    ogTitle: first ? m.site.name : title,
    description,
    canonical: absoluteUrl(m, path),
    ogType: "website",
    image: hero ? absoluteUrl(m, hero.ref.src) : null,
    imageAlt: hero?.alt ?? "",
    markdown: homePage && first ? "/index.md" : null,
    jsonLd: ldJson(first ? [website(m), organization(m)] : [breadcrumbList(m, [{ label: "Home", href: "/" }, { label: title, href: path }]), organization(m)]),
  };
  const html = page(rc, "home", path, "home", "/", seo, view);
  const markdown =
    homePage && first ? entryMarkdown(m, homePage, { path: "/", title, description, resolveEntry: (id) => rc.resolver.entry?.(id) ?? null }) : undefined;
  return { path, kind: "home", html, markdown, entryId: homePage?.id };
}

// ---------- categories and authors ----------

export function renderCategory(rc: RenderCtx, c: Category, pageNo = 1): RenderedPage {
  const { m } = rc;
  const base = categoryPath(c);
  const path = pagedPath(base, pageNo);
  const posts = postsIn(m, c.id);
  const pages = pageCount(posts.length);
  const crumbs = [
    { label: "Home", href: "/" },
    { label: c.name, href: base },
  ];
  const title = pageNo === 1 ? c.name : `${c.name}, page ${pageNo}`;
  const description = clip(c.description || `Every ${m.site.name} post about ${c.name.toLowerCase()}, newest first.`, 155);
  const view = {
    list: {
      title,
      description: pageNo === 1 ? c.description : "",
      postsTitle: pageNo === 1 ? `Latest in ${c.name}` : `More in ${c.name}`,
      items: posts.slice((pageNo - 1) * PAGE_SIZE, pageNo * PAGE_SIZE).map((e) => card(rc, e)),
      pager: pager(base, pageNo, pages),
      breadcrumbs: crumbs,
    },
  };
  const seo: Seo = {
    title: titleTag(title, m.site.name),
    ogTitle: title,
    description,
    canonical: absoluteUrl(m, path),
    ogType: "website",
    jsonLd: ldJson([
      { "@type": "CollectionPage", "@id": `${absoluteUrl(m, path)}#page`, name: title, description, url: absoluteUrl(m, path), isPartOf: { "@id": `${m.baseUrl}/#website` } },
      breadcrumbList(m, crumbs),
      organization(m),
    ]),
  };
  return { path, kind: "list", html: page(rc, "list", path, "list", base, seo, view) };
}

export function renderAuthor(rc: RenderCtx, a: Author, pageNo = 1): RenderedPage {
  const { m } = rc;
  const base = authorPath(a);
  const path = pagedPath(base, pageNo);
  const posts = postsBy(m, a.id);
  const pages = pageCount(posts.length);
  const crumbs = [
    { label: "Home", href: "/" },
    { label: a.name, href: base },
  ];
  const description = clip(a.bio || `Posts by ${a.name} on ${m.site.name}.`, 155);
  const view = {
    author: {
      ...authorView(rc, a),
      postsTitle: pageNo === 1 ? `Posts by ${a.name}` : `More posts by ${a.name}, page ${pageNo}`,
      items: posts.slice((pageNo - 1) * PAGE_SIZE, pageNo * PAGE_SIZE).map((e) => card(rc, e)),
      pager: pager(base, pageNo, pages),
      breadcrumbs: crumbs,
    },
  };
  const seo: Seo = {
    title: titleTag(pageNo === 1 ? a.name : `${a.name}, page ${pageNo}`, m.site.name),
    ogTitle: a.name,
    description,
    canonical: absoluteUrl(m, path),
    ogType: "profile",
    jsonLd: ldJson([{ "@type": "ProfilePage", url: absoluteUrl(m, path), mainEntity: person(m, a) }, breadcrumbList(m, crumbs), organization(m)]),
  };
  return { path, kind: "author", html: page(rc, "author", path, "author", null, seo, view) };
}

// ---------- search and 404 ----------

/** The one script a public page may load: the search island. */
export const SEARCH_ISLAND = '<script type="module" src="/_tq/search.js"></script>';

export function renderSearch(rc: RenderCtx): RenderedPage {
  const { m } = rc;
  const path = "/search/";
  const seo: Seo = {
    title: titleTag("Search", m.site.name),
    ogTitle: `Search ${m.site.name}`,
    description: clip(`Search every post on ${m.site.name}.`, 155),
    canonical: absoluteUrl(m, path),
    ogType: "website",
    noindex: true,
  };
  return { path, kind: "search", html: page(rc, "search", path, "search", path, seo, { search: { topics: rc.topics } }, SEARCH_ISLAND) };
}

export function render404(rc: RenderCtx): RenderedPage {
  const { m } = rc;
  const seo: Seo = {
    title: titleTag("Page not found", m.site.name),
    ogTitle: "Page not found",
    description: "This page doesn't exist.",
    canonical: `${m.baseUrl}/`,
    ogType: "website",
    noindex: true,
  };
  return { path: "/404.html", kind: "404", html: page(rc, "404", "/404.html", "404", null, seo, { notFound: { topics: rc.topics } }) };
}

// ---------- the plan ----------

export interface PlannedPage {
  path: string;
  kind: PageKind;
  /** What the page shows: "entry:<id>", "category:<id>", "author:<id>", "home", "search", "404". */
  key: string;
  render(rc: RenderCtx): RenderedPage;
}

/** Every page the site has right now. Rendering is lazy, so planning 1,000 pages is cheap. */
export function planPages(m: SiteModel): PlannedPage[] {
  const out: PlannedPage[] = [];
  const homePage = homeEntry(m);
  const homePages = homePage ? 1 : pageCount(m.posts.length);
  for (let n = 1; n <= homePages; n++) out.push({ path: pagedPath("/", n), kind: "home", key: "home", render: (rc) => renderHome(rc, n, homePage) });
  for (const e of m.entries) {
    if (e === homePage) continue;
    out.push({ path: entryPath(e), kind: "entry", key: `entry:${e.id}`, render: (rc) => renderEntry(rc, e) });
  }
  for (const c of m.categories) {
    const n = postsIn(m, c.id).length;
    if (!n) continue;
    for (let p = 1; p <= pageCount(n); p++) out.push({ path: pagedPath(categoryPath(c), p), kind: "list", key: `category:${c.id}`, render: (rc) => renderCategory(rc, c, p) });
  }
  for (const a of m.authors) {
    const n = postsBy(m, a.id).length;
    if (!n) continue;
    for (let p = 1; p <= pageCount(n); p++) out.push({ path: pagedPath(authorPath(a), p), kind: "author", key: `author:${a.id}`, render: (rc) => renderAuthor(rc, a, p) });
  }
  out.push({ path: "/search/", kind: "search", key: "search", render: renderSearch });
  out.push({ path: "/404.html", kind: "404", key: "404", render: render404 });
  return out;
}
