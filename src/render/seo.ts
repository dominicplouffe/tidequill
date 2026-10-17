import { plainInline, type Doc } from "../content/blocks.ts";
import type { Author } from "../core/authors.ts";
import type { Entry } from "../core/entries.ts";
import { absoluteUrl, authorPath, type SiteModel } from "./model.ts";

/** Title tag: "Post title | Site" when that fits in 60 characters, otherwise the post title alone. */
export function titleTag(title: string, siteName: string): string {
  const full = `${title} | ${siteName}`;
  return full.length <= 60 || !title ? full : title;
}

/** Cuts text at a word boundary, for meta descriptions (155) and excerpts. */
export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:.\s]+$/, "")}…`;
}

/** The entry's own description, or its first answer/paragraph. */
export function entryDescription(e: Entry, fact: (k: string) => string | null): string {
  if (e.description.trim()) return clip(plainInline(e.description, fact), 155);
  return clip(firstText(e.body, fact), 155);
}

export function firstText(d: Doc, fact: (k: string) => string | null): string {
  const b = d.blocks.find((x) => x.type === "answer") ?? d.blocks.find((x) => x.type === "paragraph");
  return b && "text" in b ? plainInline(b.text, fact) : "";
}

/** JSON for a <script type="application/ld+json">: no "</script>" can break out of it. */
export function ldJson(graph: object[]): string {
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
}

export function organization(m: SiteModel) {
  return { "@type": "Organization", "@id": `${m.baseUrl}/#org`, name: m.site.name, url: `${m.baseUrl}/`, description: m.site.niche || undefined };
}

export function person(m: SiteModel, a: Author) {
  return {
    "@type": "Person",
    "@id": `${absoluteUrl(m, authorPath(a))}#person`,
    name: a.name,
    url: absoluteUrl(m, authorPath(a)),
    description: a.bio || undefined,
    jobTitle: a.credentials || undefined,
    knowsAbout: a.expertise.length ? a.expertise : undefined,
  };
}

export function breadcrumbList(m: SiteModel, items: { label: string; href: string }[]) {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.label, item: absoluteUrl(m, c.href) })),
  };
}

export function website(m: SiteModel) {
  return {
    "@type": "WebSite",
    "@id": `${m.baseUrl}/#website`,
    name: m.site.name,
    url: `${m.baseUrl}/`,
    description: m.site.niche || undefined,
    inLanguage: m.site.locale,
    publisher: { "@id": `${m.baseUrl}/#org` },
    potentialAction: { "@type": "SearchAction", target: `${m.baseUrl}/search/?q={search_term_string}`, "query-input": "required name=search_term_string" },
  };
}

export function articleLd(
  m: SiteModel,
  e: Entry,
  v: { url: string; title: string; description: string; authors: Author[]; image: string | null; section: string | null; published: string; modified: string },
) {
  return {
    "@type": e.type === "post" ? "BlogPosting" : "Article",
    "@id": `${v.url}#article`,
    headline: v.title.slice(0, 110),
    description: v.description,
    url: v.url,
    mainEntityOfPage: v.url,
    datePublished: v.published,
    dateModified: v.modified,
    inLanguage: m.site.locale,
    author: v.authors.length ? v.authors.map((a) => person(m, a)) : [{ "@id": `${m.baseUrl}/#org` }],
    publisher: { "@id": `${m.baseUrl}/#org` },
    image: v.image ? [v.image] : undefined,
    articleSection: v.section ?? undefined,
    keywords: e.tags.length ? e.tags.join(", ") : undefined,
  };
}

export function faqLd(d: Doc, fact: (k: string) => string | null) {
  const items = d.blocks.flatMap((b) => (b.type === "faq" ? b.items : []));
  if (!items.length) return null;
  return {
    "@type": "FAQPage",
    mainEntity: items.map((i) => ({ "@type": "Question", name: plainInline(i.q, fact), acceptedAnswer: { "@type": "Answer", text: plainInline(i.a, fact) } })),
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** "Oct 20, 2026" in the site's language and time zone. */
export function dateLabel(iso: string, locale: string, timeZone: string): string {
  const key = `${locale}|${timeZone}`;
  let f = formatters.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric", timeZone });
    } catch {
      f = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    }
    formatters.set(key, f);
  }
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : f.format(d);
}
