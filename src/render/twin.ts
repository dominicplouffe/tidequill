import { plainInline, type Block, type Doc } from "../content/blocks.ts";
import { blockToMarkdown } from "../content/markdown.ts";
import type { Entry } from "../core/entries.ts";
import { absoluteUrl, entryAuthors, type SiteModel } from "./model.ts";
import { mediaRef } from "./resolve.ts";

/**
 * The markdown twin of a page (/<slug>/index.md): plain CommonMark that an AI
 * can quote without our directives, with facts filled in and internal links
 * pointing at real URLs.
 */

function resolveInline(m: SiteModel, text: string, resolveEntry: (id: string) => string | null): string {
  return text
    .replace(/\{\{\s*fact:([\w.-]+)\s*\}\}/g, (_, k) => m.facts.get(k)?.value ?? k)
    .replace(/(?<!!)\[([^\]]+)\]\(tq:([\w-]+)\)/g, (_, anchor, id) => {
      const path = resolveEntry(id);
      return path ? `[${anchor}](${absoluteUrl(m, path)})` : anchor;
    })
    .replace(/(?<!!)\[([^\]]+)\]\((\/[^)\s]*)\)/g, (_, anchor, path) => `[${anchor}](${absoluteUrl(m, path)})`);
}

function plainBlock(m: SiteModel, b: Block, inline: (t: string) => string): string {
  switch (b.type) {
    case "answer":
      return `**Short answer:** ${inline(b.text)}`;
    case "callout": {
      const label = { note: "Note", tip: "Tip", disclosure: "Disclosure", warning: "Warning" }[b.tone];
      return inline(b.text)
        .split("\n")
        .map((l, i) => `> ${i === 0 ? `**${label}:** ` : ""}${l}`)
        .join("\n");
    }
    case "faq":
      return ["## Frequently asked questions", ...b.items.map((i) => `### ${inline(i.q)}\n\n${inline(i.a)}`)].join("\n\n");
    case "evidence": {
      const ref = b.media ? mediaRef(m.media.get(b.media)) : null;
      const img = ref ? `![${plainInline(b.text).slice(0, 120)}](${absoluteUrl(m, ref.src)})\n\n` : "";
      return `${img}*First-hand note:* ${inline(b.text)}`;
    }
    case "image": {
      const ref = b.src.startsWith("media:") ? mediaRef(m.media.get(b.src.slice(6))) : { src: b.src };
      if (!ref) return "";
      const src = ref.src.startsWith("/") ? absoluteUrl(m, ref.src) : ref.src;
      return `![${b.alt || ref.alt || ""}](${src})${b.caption ? `\n\n*${inline(b.caption)}*` : ""}`;
    }
    case "code":
      return blockToMarkdown(b);
    default:
      return blockToMarkdown(mapBlockText(b, inline));
  }
}

function mapBlockText(b: Block, fn: (t: string) => string): Block {
  switch (b.type) {
    case "paragraph":
    case "heading":
      return { ...b, text: fn(b.text) };
    case "quote":
      return { ...b, text: fn(b.text), cite: b.cite ? fn(b.cite) : b.cite };
    case "list":
      return { ...b, items: b.items.map(fn) };
    case "table":
      return { ...b, header: b.header.map(fn), rows: b.rows.map((r) => r.map(fn)) };
    default:
      return b;
  }
}

export function docMarkdown(m: SiteModel, d: Doc, resolveEntry: (id: string) => string | null): string {
  const inline = (t: string) => resolveInline(m, t, resolveEntry);
  return d.blocks
    .map((b) => plainBlock(m, b, inline))
    .filter(Boolean)
    .join("\n\n");
}

function yamlString(s: string): string {
  return JSON.stringify(s);
}

export function entryMarkdown(m: SiteModel, e: Entry, opts: { path: string; title: string; description: string; resolveEntry: (id: string) => string | null }): string {
  const authors = entryAuthors(m, e).map((a) => a.name);
  const category = e.categoryId ? m.categoryById.get(e.categoryId)?.name : null;
  const front = [
    "---",
    `title: ${yamlString(opts.title)}`,
    opts.description ? `description: ${yamlString(opts.description)}` : null,
    authors.length ? `author: ${yamlString(authors.join(", "))}` : null,
    category ? `category: ${yamlString(category)}` : null,
    e.publishedAt ? `published: ${e.publishedAt}` : null,
    `updated: ${e.updatedAt ?? e.publishedAt ?? e.modifiedAt}`,
    `url: ${absoluteUrl(m, opts.path)}`,
    "---",
  ].filter((l): l is string => l !== null);
  return `${front.join("\n")}\n\n# ${opts.title}\n\n${docMarkdown(m, e.body, opts.resolveEntry)}\n`;
}
