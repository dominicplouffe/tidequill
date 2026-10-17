import type { Block, Doc } from "../content/blocks.ts";
import { blockId } from "../content/blocks.ts";
import { fromMarkdown } from "../content/markdown.ts";
import type { Entry } from "../core/entries.ts";
import { uniqueSlug } from "../core/entries.ts";
import { invalid } from "../core/errors.ts";
import type { Finding } from "../core/hooks.ts";
import type { Ctx, TrustKind } from "../core/types.ts";
import { suggestOutgoing } from "../links/engine.ts";
import { namesInBody, sentenceCase } from "./human.ts";
import { isLive, replaceInBlock } from "./patch.ts";
import { analyze, findUnprotected } from "./text.ts";

/**
 * Mechanical fixes for Ready-light findings. Each returns the new body (and
 * fields) for a patch; anything that needs judgment says so instead.
 */

export interface FixPlan {
  body: Doc;
  fields?: { description?: string; slug?: string };
  summary: string;
  liveTrust: TrustKind;
}

function dropEmpty(d: Doc): Doc {
  const blocks: Block[] = [];
  for (const b of d.blocks) {
    if (b.type === "paragraph" && !b.text.trim()) continue;
    if (b.type === "list") {
      const items = b.items.filter((i) => i.trim());
      if (!items.length) continue;
      blocks.push(items.length === b.items.length ? b : { ...b, items });
      continue;
    }
    blocks.push(b);
  }
  return { v: 1, blocks };
}

/** Collapses the double spaces a cut leaves behind in one block. */
function tidy(d: Doc, id: string): Doc {
  const clean = (t: string) => t.replace(/[ \t]{2,}/g, " ").replace(/ +([,.;!?])/g, "$1").trim();
  return {
    v: 1,
    blocks: d.blocks.map((b) => {
      if (b.id !== id) return b;
      if (b.type === "list") return { ...b, items: b.items.map(clean) };
      if (b.type === "paragraph" || b.type === "answer" || b.type === "callout" || b.type === "quote") return { ...b, text: clean(b.text) };
      return b;
    }),
  };
}

/** Inserts blocks before a trailing disclosure, else at the end. */
function appendBlocks(d: Doc, add: Block[]): Doc {
  const last = d.blocks[d.blocks.length - 1];
  if (last?.type === "callout" && last.tone === "disclosure") return { v: 1, blocks: [...d.blocks.slice(0, -1), ...add, last] };
  return { v: 1, blocks: [...d.blocks, ...add] };
}

export function buildFix(ctx: Ctx, entry: Entry, f: Finding): FixPlan {
  const title = `“${entry.title}”`;
  switch (f.code) {
    case "seo.meta_missing":
    case "seo.meta_long": {
      if (!f.suggestion) throw invalid("Write one or two sentences saying who this is for and what they'll learn; there's no opening paragraph to draft it from yet.");
      return { body: entry.body, fields: { description: f.suggestion }, summary: `Add a meta description to ${title}`, liveTrust: "refresh" };
    }
    case "aeo.direct_answer": {
      if (!f.suggestion || !f.blockId) throw invalid(`Write two or three sentences answering “${f.quote}” right under the heading.`);
      const i = entry.body.blocks.findIndex((b) => b.id === f.blockId);
      if (i < 0) throw invalid("That heading isn't in the post any more; reload and try again.");
      const blocks = [...entry.body.blocks];
      blocks.splice(i + 1, 0, { id: blockId(), type: "answer", text: f.suggestion });
      return { body: { v: 1, blocks }, summary: `Add a direct answer under “${f.quote}” in ${title}`, liveTrust: "refresh" };
    }
    case "aeo.faq": {
      if (!f.suggestion) throw invalid("Add a short answer under each question heading first, then the FAQ can be built from them.");
      const faq = fromMarkdown(f.suggestion).blocks.filter((b) => b.type === "faq");
      return { body: appendBlocks(entry.body, faq), summary: `Add an FAQ to ${title} from the questions it answers`, liveTrust: "refresh" };
    }
    case "human.title_case": {
      const keep = namesInBody(analyze(entry));
      const body: Doc = { v: 1, blocks: entry.body.blocks.map((b) => (b.type === "heading" ? { ...b, text: sentenceCase(b.text, keep) } : b)) };
      return { body, summary: `Put the headings of ${title} in sentence case`, liveTrust: "refresh" };
    }
    case "seo.heading_order": {
      let previous = 1;
      const body: Doc = {
        v: 1,
        blocks: entry.body.blocks.map((b) => {
          if (b.type !== "heading") return b;
          const level = Math.min(b.level, previous + 1) as 2 | 3 | 4;
          previous = level;
          return level === b.level ? b : { ...b, level };
        }),
      };
      return { body, summary: `Fix the heading levels in ${title}`, liveTrust: "refresh" };
    }
    case "seo.alt_missing": {
      const block = entry.body.blocks.find((b) => b.id === f.blockId);
      if (!block || block.type !== "image") throw invalid("That image isn't in the post any more; reload and try again.");
      const alt = block.caption?.replace(/\*+|`/g, "").trim();
      if (!alt) throw invalid("Describe what the photo shows in a few words; I can't see it well enough to write the alt text myself.");
      const body: Doc = { v: 1, blocks: entry.body.blocks.map((b) => (b.id === block.id ? { ...block, alt } : b)) };
      return { body, summary: `Add alt text to an image in ${title}`, liveTrust: "alt_text" };
    }
    case "seo.slug": {
      if (isLive(entry)) throw invalid("This page is live, so changing its address needs a redirect; ask me to change the address instead.");
      if (!f.suggestion) throw invalid("Pick a short address of three to six words.");
      return { body: entry.body, fields: { slug: uniqueSlug(ctx.db, entry.siteId, f.suggestion, entry.id) }, summary: `Shorten the address of ${title} to /${f.suggestion}/`, liveTrust: "refresh" };
    }
    case "seo.no_internal_links": {
      const picks = suggestOutgoing(ctx, entry, 3);
      if (!picks.length) throw invalid("No related live posts mention the same topic yet; link one by hand, or publish a related post first.");
      let body = entry.body;
      for (const s of picks) body = replaceInBlock(body, s.blockId, s.anchor, `[${s.anchor}](tq:${s.targetId})`, (t, n) => findUnprotected(t, n)) ?? body;
      return { body, summary: `Link ${title} to ${picks.length} related ${picks.length === 1 ? "post" : "posts"}`, liveTrust: "links" };
    }
  }
  // Text the finding quotes, with a mechanical replacement.
  if (f.blockId && f.quote && f.suggestion !== undefined) {
    // Broken links are quoted as markup; everything else is plain text outside links.
    const locate = f.code === "check.internal_link_broken" ? (t: string, n: string) => t.indexOf(n) : (t: string, n: string) => findUnprotected(t, n);
    const next = replaceInBlock(entry.body, f.blockId, f.quote, f.suggestion, locate);
    if (!next) throw invalid("That text has changed since; reload and try again.");
    const what = f.code === "check.internal_link_broken" ? "Remove a broken link" : f.suggestion ? "Tighten a sentence" : "Remove a sentence";
    return { body: dropEmpty(tidy(next, f.blockId)), summary: `${what} in ${title}`, liveTrust: f.code === "check.internal_link_broken" ? "links" : "refresh" };
  }
  throw invalid(`This one needs you: ${f.message.charAt(0).toLowerCase()}${f.message.slice(1)}`);
}
