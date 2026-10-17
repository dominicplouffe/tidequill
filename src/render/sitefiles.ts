import { docText, plainInline, type Block } from "../content/blocks.ts";
import { headingId } from "../content/html.ts";
import { entryPath, type Entry } from "../core/entries.ts";
import { ANSWER_CRAWLERS, TRAINING_CRAWLERS } from "./crawlers.ts";
import { absoluteUrl, authorPath, categoryPath, entryAuthors, type SiteModel } from "./model.ts";
import { homeEntry, type PlannedPage } from "./pages.ts";
import { factValue } from "./resolve.ts";
import { clip, entryDescription } from "./seo.ts";

/**
 * Site-wide files written on every build: sitemap, feed, robots.txt and
 * llms.txt (from one crawler policy), the static search index, redirects,
 * and the data behind the site's own MCP endpoint.
 */

export const MCP_TOOLS = ["search", "get_page", "list_facts", "ask"] as const;

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function lastmod(e: Entry): string {
  return e.updatedAt ?? e.publishedAt ?? e.modifiedAt;
}

export function sitemapXml(m: SiteModel, plan: PlannedPage[]): string {
  const entryMod = new Map(m.entries.map((e) => [`entry:${e.id}`, lastmod(e)]));
  const newest = m.entries[0] ? lastmod(m.entries[0]) : null;
  const urls = plan
    .filter((p) => p.kind !== "search" && p.kind !== "404" && !/\/page\/\d+\/$/.test(p.path))
    .map((p) => {
      const mod = entryMod.get(p.key) ?? (p.kind === "home" ? newest : null);
      return `<url><loc>${xml(absoluteUrl(m, p.path))}</loc>${mod ? `<lastmod>${mod}</lastmod>` : ""}</url>`;
    });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

export function feedXml(m: SiteModel): string {
  const fact = factValue(m);
  const items = m.posts.slice(0, 20).map((e) => {
    const url = absoluteUrl(m, entryPath(e));
    const authors = entryAuthors(m, e).map((a) => a.name);
    const cat = e.categoryId ? m.categoryById.get(e.categoryId)?.name : null;
    return [
      "<item>",
      `<title>${xml(plainInline(e.title, fact))}</title>`,
      `<link>${xml(url)}</link>`,
      `<guid isPermaLink="false">${xml(e.id)}</guid>`,
      `<pubDate>${new Date(e.publishedAt ?? e.createdAt).toUTCString()}</pubDate>`,
      authors.length ? `<dc:creator>${xml(authors.join(", "))}</dc:creator>` : "",
      cat ? `<category>${xml(cat)}</category>` : "",
      `<description>${xml(entryDescription(e, fact))}</description>`,
      "</item>",
    ]
      .filter(Boolean)
      .join("");
  });
  const updated = m.posts[0] ? new Date(lastmod(m.posts[0])).toUTCString() : new Date().toUTCString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>${xml(m.site.name)}</title>
<link>${xml(`${m.baseUrl}/`)}</link>
<description>${xml(m.site.niche || m.site.name)}</description>
<language>${xml(m.site.locale)}</language>
<lastBuildDate>${updated}</lastBuildDate>
<atom:link href="${xml(`${m.baseUrl}/feed.xml`)}" rel="self" type="application/rss+xml"/>
${items.join("\n")}
</channel>
</rss>
`;
}

/** robots.txt and llms.txt come from the same policy, so they always agree. */
export function crawlerPolicy(m: SiteModel) {
  const training = m.site.settings.allowTrainingCrawlers;
  return {
    allowed: [...ANSWER_CRAWLERS, ...(training ? TRAINING_CRAWLERS : [])],
    blocked: training ? [] : TRAINING_CRAWLERS,
    training,
  };
}

export function robotsTxt(m: SiteModel): string {
  const p = crawlerPolicy(m);
  const lines = [
    `# ${m.site.name}: AI assistants and search engines may read and cite this site.`,
    p.training ? "# AI companies may also use it to train models." : "# AI companies may not use it to train models.",
    "",
    "# Answer and search crawlers",
    ...ANSWER_CRAWLERS.map((c) => `User-agent: ${c.agent}`),
    "Allow: /",
    "",
    "# Model training crawlers",
    ...TRAINING_CRAWLERS.map((c) => `User-agent: ${c.agent}`),
    p.training ? "Allow: /" : "Disallow: /",
    "",
    "User-agent: *",
    "Allow: /",
    "Disallow: /search/",
    "",
    `Sitemap: ${m.baseUrl}/sitemap.xml`,
    "",
  ];
  return lines.join("\n");
}

export function llmsTxt(m: SiteModel): string {
  const fact = factValue(m);
  const p = crawlerPolicy(m);
  const home = homeEntry(m);
  const line = (e: Entry) => {
    const d = entryDescription(e, fact);
    return `- [${plainInline(e.title, fact)}](${absoluteUrl(m, `${entryPath(e)}index.md`)})${d ? `: ${d}` : ""}`;
  };
  const sections: string[] = [`# ${m.site.name}`, ""];
  if (m.site.niche) sections.push(`> ${m.site.niche}`, "");
  sections.push(
    "Every page has a clean markdown version at its address plus `index.md` (linked below).",
    "",
    `You can also ask this site directly over MCP (Streamable HTTP, JSON-RPC): ${m.baseUrl}/mcp. Tools: ${MCP_TOOLS.join(", ")}. Description: ${m.baseUrl}/.well-known/mcp.json`,
    "",
    "## Use by AI",
    "",
    "- Answering questions and citing pages with a link: allowed.",
    `- Training AI models: ${p.training ? "allowed." : "not allowed (see robots.txt)."}`,
    "",
  );
  if (home) sections.push("## Start here", "", line(home), "");
  for (const c of m.categories) {
    const posts = m.posts.filter((e) => e.categoryId === c.id);
    if (!posts.length) continue;
    sections.push(`## ${c.name}`, "", ...posts.slice(0, 200).map(line), "");
  }
  const loose = m.posts.filter((e) => !e.categoryId || !m.categoryById.has(e.categoryId));
  if (loose.length) sections.push("## More posts", "", ...loose.slice(0, 200).map(line), "");
  const pages = m.entries.filter((e) => e.type === "page" && e !== home);
  if (pages.length) sections.push("## About this site", "", ...pages.map(line), "");
  sections.push("## Optional", "", `- [Sitemap](${m.baseUrl}/sitemap.xml)`, `- [RSS feed](${m.baseUrl}/feed.xml)`, `- [Facts and prices](${m.baseUrl}/agent/facts.json)`, "");
  return sections.join("\n");
}

// ---------- search index and agent data ----------

export interface SearchDoc {
  title: string;
  path: string;
  description: string;
  headings: string[];
  text: string;
}

export function searchIndex(m: SiteModel): SearchDoc[] {
  const fact = factValue(m);
  return m.entries.map((e) => ({
    title: plainInline(e.title, fact),
    path: entryPath(e),
    description: entryDescription(e, fact),
    headings: e.body.blocks.flatMap((b) => (b.type === "heading" ? [plainInline(b.text, fact)] : [])),
    text: clip(docText(e.body, fact), 300),
  }));
}

export interface Passage {
  title: string;
  url: string;
  heading: string | null;
  text: string;
}

function blockPlain(b: Block, fact: (k: string) => string | null): string {
  switch (b.type) {
    case "list":
      return b.items.map((i) => `- ${plainInline(i, fact)}`).join("\n");
    case "faq":
      return b.items.map((i) => `${plainInline(i.q, fact)} ${plainInline(i.a, fact)}`).join("\n");
    case "table":
      return [b.header, ...b.rows].map((r) => r.map((c) => plainInline(c, fact)).join(" | ")).join("\n");
    case "image":
      return b.caption ? plainInline(b.caption, fact) : "";
    case "code":
    case "divider":
      return "";
    default:
      return "text" in b ? plainInline(b.text, fact) : "";
  }
}

/** Section-sized passages (a heading and what follows) for the MCP `ask` tool. */
export function passages(m: SiteModel): Passage[] {
  const fact = factValue(m);
  const out: Passage[] = [];
  for (const e of m.entries) {
    const title = plainInline(e.title, fact);
    const base = absoluteUrl(m, entryPath(e));
    let heading: string | null = null;
    let anchor = "";
    let buf: string[] = [];
    const flush = () => {
      const text = buf.join("\n").trim();
      if (text) out.push({ title, url: `${base}${anchor}`, heading, text: clip(text, 1200) });
      buf = [];
    };
    if (e.description) buf.push(plainInline(e.description, fact));
    for (const b of e.body.blocks) {
      if (b.type === "heading" && b.level === 2) {
        flush();
        heading = plainInline(b.text, fact);
        anchor = `#${headingId(b.text)}`;
        continue;
      }
      const t = blockPlain(b, fact);
      if (t) buf.push(b.type === "heading" ? `${t}:` : t);
    }
    flush();
  }
  return out;
}

export function agentFiles(m: SiteModel): Record<string, unknown> {
  const fact = factValue(m);
  const usage = new Map<string, string[]>();
  for (const e of m.entries) {
    const used = JSON.stringify(e.body).match(/\{\{\s*fact:([\w.-]+)\s*\}\}/g) ?? [];
    for (const u of new Set(used)) {
      const key = u.replace(/^\{\{\s*fact:|\s*\}\}$/g, "");
      if (!usage.has(key)) usage.set(key, []);
      usage.get(key)!.push(absoluteUrl(m, entryPath(e)));
    }
  }
  const facts = [...m.facts.values()].map((f) => ({ key: f.key, label: f.label, value: f.value, kind: f.kind, source: f.sourceUrl, verifiedAt: f.verifiedAt, usedOn: usage.get(f.key) ?? [] }));
  return {
    "agent/site.json": {
      name: m.site.name,
      about: m.site.niche,
      url: `${m.baseUrl}/`,
      language: m.site.locale,
      mcp: `${m.baseUrl}/mcp`,
      llms: `${m.baseUrl}/llms.txt`,
      topics: m.categories.map((c) => ({ name: c.name, url: absoluteUrl(m, categoryPath(c)) })),
      authors: m.authors.map((a) => ({ name: a.name, url: absoluteUrl(m, authorPath(a)), credentials: a.credentials || null })),
      training: m.site.settings.allowTrainingCrawlers,
    },
    "agent/pages.json": m.entries.map((e) => ({
      title: plainInline(e.title, fact),
      path: entryPath(e),
      url: absoluteUrl(m, entryPath(e)),
      markdown: `${entryPath(e)}index.md`,
      description: entryDescription(e, fact),
      type: e.type,
      category: e.categoryId ? m.categoryById.get(e.categoryId)?.name ?? null : null,
      authors: entryAuthors(m, e).map((a) => a.name),
      updated: lastmod(e),
    })),
    "agent/facts.json": facts,
    "agent/products.json": facts.filter((f) => f.kind === "price").map((f) => ({ name: f.label, price: f.value, key: f.key, source: f.source, verifiedAt: f.verifiedAt, mentionedOn: f.usedOn })),
    "agent/passages.json": passages(m),
  };
}

export function mcpManifest(m: SiteModel) {
  return {
    name: `${m.site.name}`,
    description: `Ask ${m.site.name} directly: search its pages, read any page as markdown, list its facts and prices, or ask a question and get passages with links.`,
    endpoint: `${m.baseUrl}/mcp`,
    transport: "streamable-http",
    protocolVersion: "2025-06-18",
    readOnly: true,
    tools: [...MCP_TOOLS],
    llms: `${m.baseUrl}/llms.txt`,
  };
}

/**
 * Redirects the edge applies: the redirects table, plus 410 Gone for pages
 * that were live once and were taken down (unless something lives there now).
 */
export function redirectsJson(m: SiteModel, livePaths: Set<string>): Record<string, { to?: string; code: number }> {
  const out: Record<string, { to?: string; code: number }> = {};
  for (const p of m.gone) if (!livePaths.has(p)) out[p] = { code: 410 };
  for (const r of m.redirects) {
    if (livePaths.has(r.from)) continue;
    out[r.from] = r.code === 410 ? { code: 410 } : { to: r.to, code: r.code === 302 ? 302 : 301 };
  }
  return out;
}
