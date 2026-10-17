import type { Finding } from "../core/hooks.ts";
import { slugify } from "../core/ids.ts";
import type { ScoreResult } from "./human.ts";
import { GENERIC_TERMS, isExternalHref, isInternalHref, readingGrade, stem, terms, trimToChars, wordsOf, type Analysis } from "./text.ts";

/**
 * SEO score: the local checks a search engine cares about. Everything that
 * needs the database (inbound links, other titles) is passed in, so this stays
 * a pure function.
 */

export interface SeoContext {
  type: "post" | "page";
  status: string;
  /** Published pages on this site that link here. */
  inboundLinks: number;
  /** Other entries on the site, for keyword cannibalization. */
  others: { id: string; title: string }[];
}

export const TITLE_MAX = 60;
export const META_MAX = 155;

function finding(f: Omit<Finding, "area" | "severity"> & { severity?: Finding["severity"] }): Finding {
  return { ...f, area: "seo", severity: f.severity ?? "warn" };
}

/** Units and size words: frequent in good posts, never the topic. */
const MEASURE_WORDS = new Set(
  "inch pound feet foot cm mm lb kg ounce oz gram meter metre mile hour minute second day week month year percent dollar wide tall long high deep least most".split(" "),
);

/**
 * What the post is mostly about: the most repeated content word (headings count
 * double), shown with its most common neighbour when they usually go together
 * ("tv stand" rather than "stand").
 */
export function primaryTerm(a: Analysis): { term: string; stem: string } | null {
  const words = new Map<string, { n: number; surface: Map<string, number> }>();
  const pairs = new Map<string, { n: number; surface: Map<string, number> }>();
  const bump = (m: typeof words, key: string, surface: string, by = 1) => {
    const c = m.get(key) ?? { n: 0, surface: new Map() };
    c.n += by;
    c.surface.set(surface, (c.surface.get(surface) ?? 0) + by);
    m.set(key, c);
  };
  const usable = (w: string) => !/^\d/.test(w) && terms(w).length > 0 && !GENERIC_TERMS.has(stem(w)) && !MEASURE_WORDS.has(stem(w));
  const sources: [string, number][] = [...a.headings.map((h): [string, number] => [h.text, 2]), ...a.sentences.map((x): [string, number] => [x.text, 1])];
  for (const [text, weight] of sources) {
    for (const part of text.split(/[,;:()]+/)) {
      const ws = wordsOf(part);
      for (let i = 0; i < ws.length; i++) {
        if (!usable(ws[i]!)) continue;
        bump(words, stem(ws[i]!), ws[i]!.toLowerCase(), weight);
        const next = ws[i + 1];
        if (next && usable(next)) bump(pairs, `${stem(ws[i]!)} ${stem(next)}`, `${ws[i]} ${next}`.toLowerCase(), weight);
      }
    }
  }
  const top = [...words.entries()].filter(([, c]) => c.n >= 3).sort((x, y) => y[1].n - x[1].n || x[0].localeCompare(y[0]))[0];
  if (!top) return null;
  const [topStem, topCount] = top;
  const surface = (c: { surface: Map<string, number> }) => [...c.surface.entries()].sort((x, y) => y[1] - x[1])[0]![0];
  const pair = [...pairs.entries()]
    .filter(([k, c]) => k.split(" ").includes(topStem) && c.n >= Math.max(2, topCount.n * 0.4))
    .sort((x, y) => y[1].n - x[1].n)[0];
  return { term: pair ? surface(pair[1]) : surface(topCount), stem: topStem };
}

/** Similarity of two titles (Jaccard over content-word stems, ignoring words like "guide"). */
export function titleSimilarity(a: string, b: string): number {
  const x = new Set(terms(a).filter((t) => !GENERIC_TERMS.has(t)));
  const y = new Set(terms(b).filter((t) => !GENERIC_TERMS.has(t)));
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

/** A meta description drafted from the opening paragraph. */
export function suggestMeta(a: Analysis): string | null {
  const first = a.prose.find((p) => (p.type === "paragraph" || p.type === "answer") && p.plain.length > 40);
  return first ? trimToChars(first.plain, META_MAX) : null;
}

export function scoreSeo(a: Analysis, ctx: SeoContext): ScoreResult {
  const findings: Finding[] = [];
  const passed: string[] = [];
  let penalty = 0;

  // Title
  const titleLen = a.title.trim().length;
  if (titleLen > TITLE_MAX) {
    findings.push(finding({ code: "seo.title_length", message: `Shorten the title to ${TITLE_MAX} characters or fewer; it's ${titleLen} now and search results will cut it off.` }));
    penalty += 10;
  } else if (titleLen < 15) {
    findings.push(finding({ code: "seo.title_length", severity: "info", message: "The title is very short; say what the reader gets, in up to 60 characters." }));
    penalty += 4;
  } else passed.push(`Title ${titleLen} characters`);

  const primary = primaryTerm(a);
  if (primary) {
    const titleStems = wordsOf(a.title).map(stem);
    const at = titleStems.indexOf(primary.stem);
    if (at < 0) {
      findings.push(finding({ code: "seo.title_term", message: `Put “${primary.term}” in the title; it's what this post is mostly about.` }));
      penalty += 8;
    } else if (at > Math.max(3, titleStems.length * 0.5)) {
      findings.push(finding({ code: "seo.title_term", severity: "info", message: `Move “${primary.term}” closer to the start of the title.` }));
      penalty += 3;
    } else passed.push(`“${primary.term}” near the start of the title`);
  }

  // Meta description
  const desc = a.description.trim();
  if (!desc) {
    const suggestion = suggestMeta(a);
    findings.push(finding({ code: "seo.meta_missing", message: "Add a meta description, the one or two sentences search results show under the title.", suggestion: suggestion ?? undefined }));
    penalty += 12;
  } else if (desc.length > META_MAX) {
    findings.push(finding({ code: "seo.meta_long", message: `Shorten the meta description to ${META_MAX} characters; it's ${desc.length} now.`, quote: desc, suggestion: trimToChars(desc, META_MAX) }));
    penalty += 6;
  } else if (desc.length < 50) {
    findings.push(finding({ code: "seo.meta_short", severity: "info", message: "The meta description is short; say who it's for and what they'll learn, in up to 155 characters." }));
    penalty += 3;
  } else passed.push(`Meta description ${desc.length} characters`);

  // One H1 (the title) and a logical outline.
  let previous = 1;
  let skipped = false;
  for (const h of a.headings) {
    if (h.level > previous + 1) {
      skipped = true;
      findings.push(finding({ code: "seo.heading_order", blockId: h.blockId, quote: h.text, message: `“${h.text}” skips a heading level; make it an H${previous + 1}.`, suggestion: `H${previous + 1}` }));
      penalty += 4;
      break;
    }
    previous = h.level;
  }
  if (!skipped) passed.push("One H1 and a logical outline");

  // Length
  const minWords = ctx.type === "page" ? 120 : 500;
  if (a.wordCount < minWords / 2) {
    findings.push(finding({ code: "seo.thin", message: `At ${a.wordCount} words this is thin; answer the follow-up questions a reader would ask next.` }));
    penalty += 15;
  } else if (a.wordCount < minWords) {
    findings.push(finding({ code: "seo.thin", severity: "info", message: `At ${a.wordCount} words this may be too short to rank; add the detail a reader would ask for next.` }));
    penalty += 5;
  } else passed.push(`${a.wordCount} words`);

  // Links
  const internal = a.links.filter((l) => isInternalHref(l.href));
  const external = a.links.filter((l) => isExternalHref(l.href));
  if (internal.length === 0 && ctx.type === "post") {
    findings.push(finding({ code: "seo.no_internal_links", message: "Link to at least two related posts on this site so readers and search engines find them." }));
    penalty += 10;
  } else if (internal.length === 1 && ctx.type === "post") {
    findings.push(finding({ code: "seo.no_internal_links", severity: "info", message: "Add one more link to a related post on this site." }));
    penalty += 3;
  } else if (internal.length) passed.push(`${internal.length} internal links`);
  if (ctx.status === "published" && ctx.type === "post") {
    if (ctx.inboundLinks === 0) {
      findings.push(finding({ code: "seo.orphan", severity: "info", message: "No other page links here yet; link to it from one or two related posts." }));
      penalty += 5;
    } else passed.push(`${ctx.inboundLinks} pages link here`);
  }
  const anchors = internal.map((l) => l.anchor.toLowerCase().trim());
  if (anchors.some((x) => /^(?:here|click here|this|this post|read more|link|this article)$/.test(x))) {
    findings.push(finding({ code: "seo.anchor_text", severity: "info", message: "Replace “click here” style link text with words that say where the link goes." }));
    penalty += 3;
  }
  if (external.length === 0 && ctx.type === "post") {
    findings.push(finding({ code: "seo.no_external_links", severity: "info", message: "Link to one authoritative source, like a maker's spec sheet or a standards body." }));
    penalty += 6;
  } else if (external.length) passed.push(`${external.length} external links`);

  // Images
  const noAlt = a.images.filter((i) => !i.alt.trim());
  for (const img of noAlt.slice(0, 5)) {
    findings.push(finding({ code: "seo.alt_missing", blockId: img.blockId, message: "Add alt text to this image saying what it shows, for screen readers and image search.", suggestion: img.caption || undefined }));
  }
  penalty += Math.min(18, noAlt.length * 6);
  if (a.images.length && !noAlt.length) passed.push("Alt text on all images");

  // Slug
  const ideal = cleanSlug(a.title);
  if (a.slug.length > 60 || /-[2-9]$/.test(a.slug) || /^untitled/.test(a.slug) || a.slug.split("-").length > 8) {
    findings.push(finding({ code: "seo.slug", severity: "info", message: `Use a shorter address like /${ideal}/ while this is still a draft.`, suggestion: ideal }));
    penalty += 4;
  } else passed.push("Clean address");

  // Keyword cannibalization
  const twin = ctx.others.map((o) => ({ ...o, sim: titleSimilarity(a.title, o.title) })).sort((x, y) => y.sim - x.sim)[0];
  if (twin && twin.sim >= 0.6) {
    findings.push(finding({ code: "seo.cannibalization", quote: twin.title, message: `“${twin.title}” covers almost the same topic; give this post a different question to answer, or link the two.` }));
    penalty += 12;
  }

  // Readability
  const grade = readingGrade(a.sentences);
  if (a.sentences.length >= 5) {
    if (grade > 12) {
      findings.push(finding({ code: "seo.readability", message: `This reads at grade ${Math.round(grade)}; split the longest sentences and use shorter words.` }));
      penalty += 8;
    } else if (grade > 9.5) {
      findings.push(finding({ code: "seo.readability", severity: "info", message: `This reads at grade ${Math.round(grade)}; a few shorter sentences would make it easier to skim.` }));
      penalty += 3;
    } else passed.push(`Reading grade ${Math.max(1, Math.round(grade))}`);
  }

  return { score: Math.max(0, Math.min(100, Math.round(100 - penalty))), findings, passed };
}

/** A short address from a title: no stop words, at most six words. */
export function cleanSlug(title: string): string {
  const words = slugify(title).split("-").filter(Boolean);
  const kept = words.filter((w) => !["a", "an", "the", "for", "to", "of", "and", "in", "on", "your", "you", "with", "how", "what", "why"].includes(w));
  return (kept.length >= 2 ? kept : words).slice(0, 6).join("-") || "post";
}
