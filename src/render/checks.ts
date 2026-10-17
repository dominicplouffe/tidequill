import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse, type HTMLElement } from "node-html-parser";
import { docLinks } from "../content/blocks.ts";
import { entryPath, getEntry } from "../core/entries.ts";
import type { Ctx } from "../core/types.ts";
import { loadSiteModel, type SiteModel } from "./model.ts";
import { homeEntry, planPages, renderCtx, renderEntry, renderHome, type PageKind } from "./pages.ts";
import { withEntry } from "./preview.ts";
import { firstText } from "./seo.ts";
import { contrastProblems } from "./tokens.ts";

/**
 * Publish checks on the rendered HTML. Each check answers in one sentence:
 * what passed, or what's wrong and how to fix it.
 */

export interface PublishCheck {
  name: string;
  passed: boolean;
  message: string;
  blocking: boolean;
}

export const BUDGET = { htmlGzipBytes: 30 * 1024, inlineCssBytes: 14 * 1024 } as const;

const kb = (n: number) => `${Math.round((n / 1024) * 10) / 10} KB`;

/**
 * The performance budget, checked on every page the build writes: under 30 KB
 * of compressed HTML, under 14 KB of inline CSS, and no JavaScript except the
 * search island.
 */
export function budgetProblems(html: string, path: string, kind: PageKind): string[] {
  const out: string[] = [];
  const gz = Bun.gzipSync(Buffer.from(html)).length;
  if (gz > BUDGET.htmlGzipBytes) out.push(`The page at ${path} is ${kb(gz)} compressed, over the 30 KB budget; split it into shorter pages or move long tables onto their own page.`);
  let css = 0;
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) css += Buffer.byteLength(m[1]!);
  if (css > BUDGET.inlineCssBytes) out.push(`The page at ${path} inlines ${kb(css)} of CSS, over the 14 KB budget; trim the design's styles.`);
  for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
    const attrs = m[1]!;
    if (/type\s*=\s*"application\/ld\+json"/i.test(attrs)) continue;
    if (kind === "search" && /src\s*=\s*"[^"]*\/_tq\/search\.js"/i.test(attrs)) continue;
    out.push(`The page at ${path} loads JavaScript; public pages ship none, so remove the script (only the search page may have one).`);
    break;
  }
  return out;
}

export function performanceCheck(html: string, path: string, kind: PageKind): PublishCheck {
  const problems = budgetProblems(html, path, kind);
  const gz = Bun.gzipSync(Buffer.from(html)).length;
  return problems.length
    ? { name: "Performance budget", passed: false, blocking: true, message: problems[0]! }
    : { name: "Performance budget", passed: true, blocking: true, message: `Fast: ${kb(gz)} compressed, no JavaScript.` };
}

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function first<T>(items: T[]): T | undefined {
  return items[0];
}

export function crawlerCheck(root: HTMLElement, bodyText: string): PublishCheck {
  const name = "Readable by search and AI crawlers";
  const main = root.querySelector("main");
  const problems: string[] = [];
  if (!main) problems.push("The page has no <main> region, so crawlers can't tell the article from the menus; use a design that marks it up.");
  const h1 = root.querySelector("h1");
  if (!h1 || !h1.text.trim()) problems.push("The page has no headline in its HTML; give the post a title.");
  const sample = norm(bodyText.split("\n")[0] ?? "").slice(0, 80);
  if (main && sample && !norm(main.text).includes(sample)) problems.push("The opening text isn't in the page's HTML, so crawlers without JavaScript miss it; move it out of any script or embed.");
  if (!root.querySelector('script[type="application/ld+json"]')) problems.push("The page has no structured data; republish it so the article details are included.");
  const noAlt = root.querySelectorAll("main img").filter((i) => i.getAttribute("alt") === undefined);
  if (noAlt.length) problems.push(`${noAlt.length} image${noAlt.length > 1 ? "s have" : " has"} no alt text in the HTML; describe what each shows.`);
  return problems.length ? { name, passed: false, blocking: true, message: problems[0]! } : { name, passed: true, blocking: true, message: "Headline, text, links, images and structured data are all in the HTML." };
}

const VAGUE_LINKS = new Set(["click here", "here", "read more", "more", "this", "link", "this link", "learn more"]);

export function accessibilityCheck(root: HTMLElement, m: SiteModel): PublishCheck {
  const name = "Accessibility";
  const problems: string[] = [];
  if (!root.querySelector("html")?.getAttribute("lang")) problems.push("The page doesn't say which language it's in; set the site's language.");
  const h1s = root.querySelectorAll("h1");
  if (h1s.length !== 1) problems.push(h1s.length ? `The page has ${h1s.length} top-level headings; keep the title as the only one and make the others section headings.` : "The page has no title heading; give it a title.");
  let prev = 1;
  for (const h of root.querySelectorAll("main h1, main h2, main h3, main h4, main h5, main h6")) {
    const level = Number(h.tagName.slice(1));
    if (level > prev + 1) {
      problems.push(`The heading “${h.text.trim().slice(0, 60)}” skips a level; make it a level-${prev + 1} heading or add one above it.`);
      break;
    }
    prev = level;
  }
  const missing = root.querySelectorAll(".prose img").filter((i) => !(i.getAttribute("alt") ?? "").trim());
  if (missing.length) problems.push(`${missing.length} image${missing.length > 1 ? "s are" : " is"} missing alt text; describe what ${missing.length > 1 ? "each shows" : "it shows"} in a short sentence.`);
  const vague = first(root.querySelectorAll("main a").filter((a) => VAGUE_LINKS.has(norm(a.text))));
  if (vague) problems.push(`A link just says “${vague.text.trim()}”; name where it goes, like “our walnut stand review”.`);
  const contrast = first(contrastProblems(m.tokens));
  if (contrast) problems.push(contrast.message);
  return problems.length ? { name, passed: false, blocking: true, message: problems[0]! } : { name, passed: true, blocking: true, message: "Headings in order, images described, links named and colors readable." };
}

function graphItems(json: unknown): Record<string, unknown>[] {
  if (!json || typeof json !== "object") return [];
  const g = (json as { "@graph"?: unknown })["@graph"];
  return Array.isArray(g) ? (g as Record<string, unknown>[]) : [json as Record<string, unknown>];
}

export function structuredDataCheck(root: HTMLElement): PublishCheck {
  const name = "Structured data";
  const problems: string[] = [];
  const scripts = root.querySelectorAll('script[type="application/ld+json"]');
  if (!scripts.length) problems.push("The page has no structured data; republish it so search engines get the article details.");
  for (const s of scripts) {
    let data: unknown;
    try {
      data = JSON.parse(s.textContent);
    } catch {
      problems.push("The structured data isn't valid JSON; republish the page to regenerate it.");
      continue;
    }
    if ((data as { "@context"?: string })["@context"] !== "https://schema.org") problems.push("The structured data doesn't say it uses schema.org; republish the page to regenerate it.");
    for (const item of graphItems(data)) {
      const type = item["@type"];
      if (!type) problems.push("Part of the structured data has no type; republish the page to regenerate it.");
      if (type === "BlogPosting" || type === "Article") {
        if (!item.headline) problems.push("The article data has no headline; give the post a title.");
        if (!item.datePublished) problems.push("The article data has no publish date; publish the post to set one.");
        if (!item.author) problems.push("The article data has no author; add an author to the post.");
      }
      if (type === "FAQPage") {
        const qs = (item.mainEntity as { name?: string; acceptedAnswer?: { text?: string } }[]) ?? [];
        if (qs.some((q) => !q.name || !q.acceptedAnswer?.text)) problems.push("A question in the FAQ has no answer; answer it or remove it.");
      }
    }
  }
  return problems.length ? { name, passed: false, blocking: true, message: problems[0]! } : { name, passed: true, blocking: true, message: "Structured data is valid schema.org JSON-LD." };
}

const SITE_FILES = new Set(["/feed.xml", "/sitemap.xml", "/robots.txt", "/llms.txt", "/search.json", "/search/"]);

export function internalLinksCheck(root: HTMLElement, m: SiteModel, opts: { dataDir: string; unpublishedTargets: number }): PublishCheck {
  const name = "Internal links";
  const known = new Set(planPages(m).map((p) => p.path));
  const redirects = new Map(m.redirects.map((r) => [r.from, r.to]));
  const broken: string[] = [];
  for (const a of root.querySelectorAll("main a[href]")) {
    let href = a.getAttribute("href") ?? "";
    if (href.startsWith(m.baseUrl)) href = href.slice(m.baseUrl.length) || "/";
    if (!href.startsWith("/") || href.startsWith("//")) continue;
    const path = href.split(/[?#]/)[0]!;
    if (path.startsWith("/media/")) {
      if (!existsSync(join(opts.dataDir, "media", m.site.id, decodeURIComponent(path.slice(7))))) broken.push(path);
      continue;
    }
    if (known.has(path) || SITE_FILES.has(path) || path.endsWith("/index.md") || redirects.has(path) || known.has(`${path}/`)) continue;
    broken.push(path);
  }
  if (broken.length) {
    return { name, passed: false, blocking: true, message: `The link to ${broken[0]} goes nowhere${broken.length > 1 ? ` (and ${broken.length - 1} more)` : ""}; point it at a live page or remove it.` };
  }
  if (opts.unpublishedTargets) {
    const n = opts.unpublishedTargets;
    return { name, passed: false, blocking: false, message: `${n} link${n > 1 ? "s point" : " points"} to a post that isn't live yet, so ${n > 1 ? "they show" : "it shows"} as plain text until it's published.` };
  }
  return { name, passed: true, blocking: true, message: "Every internal link goes to a live page." };
}

/** Runs every rendered-HTML check on an entry as it would look published. */
export async function checkRenderedEntry(ctx: Ctx, entryId: string): Promise<PublishCheck[]> {
  const siteId = ctx.siteId ?? (ctx.db.query<{ site_id: string }, [string]>("SELECT site_id FROM entries WHERE id = ?").get(entryId)?.site_id as string);
  const e = getEntry(ctx.db, siteId, entryId);
  const m = withEntry(loadSiteModel(ctx.db, siteId), e);
  const rc = renderCtx(m);
  const isHome = e.type === "page" && e.slug === "home";
  const rendered = isHome ? renderHome(rc, 1, homeEntry(m)) : renderEntry(rc, m.byId.get(e.id)!);
  const root = parse(rendered.html, { comment: false, blockTextElements: { script: true, style: true, pre: true } });
  const unpublishedTargets = docLinks(e.body).filter((l) => l.entryId && !m.byId.has(l.entryId)).length;
  return [
    crawlerCheck(root, firstText(e.body, (k) => m.facts.get(k)?.value ?? null)),
    accessibilityCheck(root, m),
    structuredDataCheck(root),
    internalLinksCheck(root, m, { dataDir: ctx.dataDir, unpublishedTargets }),
    performanceCheck(rendered.html, entryPath(e), rendered.kind),
  ];
}
