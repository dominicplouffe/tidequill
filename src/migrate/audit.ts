import { XMLParser } from "fast-xml-parser";
import { parse } from "node-html-parser";
import { limitedFetch, mapLimit, publicUrl } from "../media/net.ts";

/**
 * The free audit: point it at any site and get, within minutes, page count,
 * missing titles and descriptions, duplicate titles, missing alt text, thin
 * and slow pages, a sample of broken links, and which WordPress plugins
 * Tidequill replaces. Read-only and polite: at most 200 pages, 4 at a time.
 * Everything fetched is data.
 */

export interface PluginRow {
  plugin: string;
  inTidequill: string;
  detected: string[];
}

export const PLUGIN_MAP: { plugin: string; inTidequill: string; slugs: string[] }[] = [
  { plugin: "Yoast SEO, Rank Math", inTidequill: "Built in (SEO and AEO scores, schema, sitemaps)", slugs: ["wordpress-seo", "seo-by-rank-math", "all-in-one-seo-pack", "autodescription", "wp-seopress"] },
  { plugin: "Redirection", inTidequill: "Built in redirect manager", slugs: ["redirection", "safe-redirect-manager", "simple-301-redirects"] },
  { plugin: "WP Rocket, caching plugins", inTidequill: "Not needed: pages are static", slugs: ["wp-rocket", "w3-total-cache", "wp-super-cache", "litespeed-cache", "autoptimize", "wp-fastest-cache", "wp-optimize", "sg-cachepress", "breeze", "nitropack"] },
  { plugin: "Security firewalls", inTidequill: "Not needed: no server code in themes or plugins", slugs: ["wordfence", "better-wp-security", "sucuri-scanner", "all-in-one-wp-security-and-firewall", "jetpack-protect"] },
  { plugin: "Contact Form 7, Gravity Forms", inTidequill: "Built in forms (complex multi-step forms: webhook to their existing tool)", slugs: ["contact-form-7", "gravityforms", "wpforms-lite", "wpforms", "ninja-forms", "formidable", "fluentform"] },
  { plugin: "Affiliate link plugins", inTidequill: "Built in link manager", slugs: ["thirstyaffiliates", "pretty-link", "lasso", "affiliate-links", "aawp"] },
  { plugin: "WooCommerce", inTidequill: "Not in v1: the store stays where it is (e.g. a shop subdomain) and is linked", slugs: ["woocommerce"] },
];

export interface AuditPage {
  url: string;
  status: number;
  ttfbMs: number;
  title: string;
  description: string;
  words: number;
  images: number;
  imagesMissingAlt: number;
}

export interface AuditReport {
  url: string;
  checkedAt: string;
  source: "sitemap" | "crawl";
  /** Pages the sitemap (or crawl) lists. */
  pageCount: number;
  /** Pages actually fetched (at most 200). */
  checked: number;
  isWordPress: boolean;
  missingTitles: string[];
  missingDescriptions: string[];
  duplicateTitles: { title: string; urls: string[] }[];
  missingAlt: { images: number; pages: { url: string; count: number }[] };
  thinPages: { url: string; words: number }[];
  slowPages: { url: string; ttfbMs: number }[];
  medianTtfbMs: number | null;
  brokenLinks: { url: string; status: number | null; foundOn: string }[];
  errors: { url: string; status: number | null; message: string }[];
  plugins: PluginRow[];
  pages: AuditPage[];
  summary: string[];
}

export interface AuditOptions {
  maxPages?: number;
  concurrency?: number;
  /** TTFB above this counts as slow. */
  slowMs?: number;
  brokenLinkSample?: number;
}

const PAGE_BYTES = 3 * 1024 * 1024;
const TIMEOUT = 15_000;
const SKIP_EXT = /\.(jpe?g|png|gif|webp|avif|svg|pdf|zip|mp3|mp4|mov|webm|css|js|json|xml|txt|ico|woff2?|ttf)$/i;

const sameSite = (a: URL, b: URL) => a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "");

function normalize(u: URL): string {
  const c = new URL(u.toString());
  c.hash = "";
  for (const k of [...c.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$)/.test(k)) c.searchParams.delete(k);
  return c.toString();
}

async function get(url: string) {
  try {
    const r = await limitedFetch(url, { maxBytes: PAGE_BYTES, timeoutMs: TIMEOUT, requireOk: false, headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5" } });
    return { ok: r.status < 400, status: r.status, ttfbMs: r.ttfbMs, finalUrl: r.url, text: new TextDecoder().decode(r.bytes), type: r.headers.get("content-type") ?? "" };
  } catch (err) {
    return { ok: false, status: null as number | null, ttfbMs: 0, finalUrl: url, text: "", type: "", error: (err as Error).message };
  }
}

const xml = new XMLParser({ ignoreAttributes: true, parseTagValue: false, isArray: (n) => n === "url" || n === "sitemap" });

async function sitemapUrls(base: URL, robots: string, limit: number): Promise<string[]> {
  const declared = [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]!);
  const candidates = [...declared, new URL("/sitemap.xml", base).toString(), new URL("/sitemap_index.xml", base).toString(), new URL("/wp-sitemap.xml", base).toString()];
  const seen = new Set<string>();
  const pages = new Set<string>();
  const queue = [...new Set(candidates)];
  let fetched = 0;
  while (queue.length && fetched < 25 && pages.size < limit * 5) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    fetched++;
    const r = await get(url);
    if (!r.ok || !/<(urlset|sitemapindex)\b/.test(r.text)) continue;
    let doc: any;
    try {
      doc = xml.parse(r.text);
    } catch {
      continue;
    }
    for (const s of doc?.sitemapindex?.sitemap ?? []) if (s?.loc) queue.push(String(s.loc).trim());
    for (const u of doc?.urlset?.url ?? []) {
      if (!u?.loc) continue;
      try {
        const loc = new URL(String(u.loc).trim());
        if (sameSite(loc, base)) pages.add(normalize(loc));
      } catch {
        /* not a URL */
      }
    }
    // Declared sitemaps that worked are enough; don't also probe the defaults.
    if (pages.size && declared.length === 0) break;
  }
  return [...pages];
}

function analyse(url: string, html: string) {
  const root = parse(html, { comment: true, blockTextElements: { script: true, style: true, noscript: true } });
  const title = (root.querySelector("title")?.text ?? "").replace(/\s+/g, " ").trim();
  const description = (root.querySelector('meta[name="description"]')?.getAttribute("content") ?? "").trim();
  const imgs = root.querySelectorAll("img");
  // Missing or empty alt counts, unless the image is marked as decoration.
  const missingAlt = imgs.filter((i) => !(i.getAttribute("alt") ?? "").trim() && i.getAttribute("role") !== "presentation" && i.getAttribute("aria-hidden") !== "true").length;
  const links = root
    .querySelectorAll("a[href]")
    .map((a) => a.getAttribute("href")!)
    .filter((h) => h && !/^(#|mailto:|tel:|javascript:)/i.test(h));
  for (const sel of ["script", "style", "noscript", "nav", "header", "footer", "aside", "form", "svg"]) for (const el of root.querySelectorAll(sel)) el.remove();
  const main = root.querySelector("main") ?? root.querySelector("article") ?? root.querySelector("body") ?? root;
  const text = main.text.replace(/\s+/g, " ").trim();
  const words = text ? text.split(" ").filter((w) => /\w/.test(w)).length : 0;
  const plugins = new Set<string>();
  for (const m of html.matchAll(/\/wp-content\/plugins\/([a-z0-9_-]+)\//gi)) plugins.add(m[1]!.toLowerCase());
  if (/This site is optimized with the Yoast SEO/i.test(html) || /yoast-schema-graph/.test(html)) plugins.add("wordpress-seo");
  if (/rank-math|Rank Math/i.test(html)) plugins.add("seo-by-rank-math");
  if (/WP Rocket/i.test(html)) plugins.add("wp-rocket");
  if (/woocommerce/i.test(html)) plugins.add("woocommerce");
  const isWordPress = /\/wp-content\/|\/wp-includes\/|<meta name="generator" content="WordPress/i.test(html);
  return { title, description, images: imgs.length, missingAlt, links, words, plugins, isWordPress, url };
}

export async function runAudit(raw: string, opts: AuditOptions = {}): Promise<AuditReport> {
  const maxPages = Math.min(200, Math.max(1, opts.maxPages ?? 200));
  const concurrency = Math.min(4, Math.max(1, opts.concurrency ?? 4));
  const slowMs = opts.slowMs ?? 800;
  const base = publicUrl(raw);
  if (!base.pathname || base.pathname === "") base.pathname = "/";

  const robots = await get(new URL("/robots.txt", base).toString());
  let listed = await sitemapUrls(base, robots.ok ? robots.text : "", maxPages);
  const source: AuditReport["source"] = listed.length ? "sitemap" : "crawl";
  const pageCount = listed.length;

  const results = new Map<string, ReturnType<typeof analyse> & { status: number | null; ttfbMs: number }>();
  const errors: AuditReport["errors"] = [];
  const allLinks: { href: string; foundOn: string }[] = [];
  const plugins = new Set<string>();
  let isWordPress = false;

  const visit = async (url: string) => {
    const r = await get(url);
    if (!r.ok || !/html/i.test(r.type || "text/html")) {
      errors.push({ url, status: r.status, message: (r as any).error ?? (r.ok ? "Not an HTML page" : `Answered ${r.status}`) });
      return [] as string[];
    }
    const a = analyse(url, r.text);
    a.plugins.forEach((p) => plugins.add(p));
    if (a.isWordPress) isWordPress = true;
    results.set(url, { ...a, status: r.status, ttfbMs: r.ttfbMs });
    const internal: string[] = [];
    for (const h of a.links) {
      try {
        const u = new URL(h, r.finalUrl || url);
        if (!/^https?:$/.test(u.protocol)) continue;
        allLinks.push({ href: normalize(u), foundOn: url });
        if (sameSite(u, base) && !SKIP_EXT.test(u.pathname)) internal.push(normalize(u));
      } catch {
        /* skip */
      }
    }
    return internal;
  };

  if (source === "sitemap") {
    await mapLimit(listed.slice(0, maxPages), concurrency, (u) => visit(u));
  } else {
    // No sitemap: crawl from the home page, breadth first.
    const seen = new Set<string>([normalize(base)]);
    let frontier = [normalize(base)];
    while (frontier.length && results.size + errors.length < maxPages) {
      const room = maxPages - results.size - errors.length;
      const batch = frontier.slice(0, room);
      const found = await mapLimit(batch, concurrency, (u) => visit(u));
      frontier = [];
      for (const u of found.flat()) {
        if (seen.has(u)) continue;
        seen.add(u);
        frontier.push(u);
      }
    }
    listed = [...results.keys()];
  }

  const pages: AuditPage[] = [...results.values()].map((r) => ({ url: r.url, status: r.status ?? 0, ttfbMs: r.ttfbMs, title: r.title, description: r.description, words: r.words, images: r.images, imagesMissingAlt: r.missingAlt }));

  // Broken links: a sample of distinct targets we haven't already fetched; internal ones first.
  const checkedUrls = new Set([...results.keys(), ...errors.map((e) => e.url)]);
  const targets = new Map<string, string>();
  for (const l of allLinks) if (!checkedUrls.has(l.href) && !targets.has(l.href)) targets.set(l.href, l.foundOn);
  const sample = [...targets.entries()].sort((a, b) => Number(sameSite(new URL(b[0]), base)) - Number(sameSite(new URL(a[0]), base))).slice(0, opts.brokenLinkSample ?? 40);
  const brokenLinks: AuditReport["brokenLinks"] = [];
  await mapLimit(sample, concurrency, async ([href, foundOn]) => {
    let r = await limitedFetch(href, { maxBytes: 64 * 1024, timeoutMs: TIMEOUT, method: "HEAD", requireOk: false }).catch(() => null);
    if (r && (r.status === 405 || r.status === 403 || r.status === 501)) r = await limitedFetch(href, { maxBytes: PAGE_BYTES, timeoutMs: TIMEOUT, requireOk: false }).catch(() => null);
    if (!r || r.status >= 400) brokenLinks.push({ url: href, status: r?.status ?? null, foundOn });
  });
  for (const e of errors) {
    const foundOn = allLinks.find((l) => l.href === e.url)?.foundOn;
    if (foundOn && e.status && e.status >= 400) brokenLinks.push({ url: e.url, status: e.status, foundOn });
  }

  const byTitle = new Map<string, string[]>();
  for (const p of pages) if (p.title) byTitle.set(p.title.toLowerCase(), [...(byTitle.get(p.title.toLowerCase()) ?? []), p.url]);
  const ttfbs = pages.map((p) => p.ttfbMs).sort((a, b) => a - b);
  const report: AuditReport = {
    url: base.toString(),
    checkedAt: new Date().toISOString(),
    source,
    pageCount: source === "sitemap" ? pageCount : pages.length,
    checked: pages.length,
    isWordPress,
    missingTitles: pages.filter((p) => !p.title).map((p) => p.url),
    missingDescriptions: pages.filter((p) => !p.description).map((p) => p.url),
    duplicateTitles: [...byTitle.entries()].filter(([, urls]) => urls.length > 1).map(([, urls]) => ({ title: pages.find((p) => p.url === urls[0])!.title, urls })),
    missingAlt: { images: pages.reduce((s, p) => s + p.imagesMissingAlt, 0), pages: pages.filter((p) => p.imagesMissingAlt).map((p) => ({ url: p.url, count: p.imagesMissingAlt })) },
    thinPages: pages.filter((p) => p.words < 300).map((p) => ({ url: p.url, words: p.words })),
    slowPages: pages.filter((p) => p.ttfbMs > slowMs).map((p) => ({ url: p.url, ttfbMs: p.ttfbMs })).sort((a, b) => b.ttfbMs - a.ttfbMs),
    medianTtfbMs: ttfbs.length ? ttfbs[Math.floor(ttfbs.length / 2)]! : null,
    brokenLinks,
    errors,
    plugins: PLUGIN_MAP.map((row) => ({ plugin: row.plugin, inTidequill: row.inTidequill, detected: row.slugs.filter((s) => plugins.has(s)) })),
    pages,
    summary: [],
  };
  report.summary = auditSummary(report);
  return report;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function auditSummary(r: AuditReport): string[] {
  const out: string[] = [];
  out.push(
    r.source === "sitemap"
      ? `The sitemap lists ${plural(r.pageCount, "page")}; I checked ${r.checked === r.pageCount ? "all of them" : r.checked}.`
      : `There's no sitemap, so I followed links from the home page and found ${plural(r.checked, "page")}.`,
  );
  if (r.missingTitles.length) out.push(`${plural(r.missingTitles.length, "page")} ${r.missingTitles.length === 1 ? "has" : "have"} no title.`);
  if (r.missingDescriptions.length) out.push(`${plural(r.missingDescriptions.length, "page")} ${r.missingDescriptions.length === 1 ? "has" : "have"} no search description.`);
  if (r.duplicateTitles.length) out.push(`${plural(r.duplicateTitles.length, "title")} ${r.duplicateTitles.length === 1 ? "is" : "are"} shared by more than one page.`);
  if (r.missingAlt.images) out.push(`${plural(r.missingAlt.images, "image")} on ${plural(r.missingAlt.pages.length, "page")} ${r.missingAlt.images === 1 ? "has" : "have"} no alt text.`);
  if (r.thinPages.length) out.push(`${plural(r.thinPages.length, "page")} ${r.thinPages.length === 1 ? "is" : "are"} thin (under 300 words).`);
  if (r.medianTtfbMs != null) out.push(`Pages start arriving in ${r.medianTtfbMs} ms on average${r.slowPages.length ? `; ${plural(r.slowPages.length, "page")} took longer than 0.8 seconds` : ""}. Tidequill pages start in under 50 ms.`);
  if (r.brokenLinks.length) out.push(`${plural(r.brokenLinks.length, "broken link")} in the sample I checked.`);
  const replaced = r.plugins.filter((p) => p.detected.length);
  if (replaced.length) out.push(`You won't need ${replaced.map((p) => p.detected.join(", ")).join("; ")} on Tidequill.`);
  if (out.length === 1) out.push("No problems found. Nice work.");
  return out;
}
