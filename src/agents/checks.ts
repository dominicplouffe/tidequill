import type { Block, Doc } from "../content/blocks.ts";
import { fromMarkdown, toMarkdown } from "../content/markdown.ts";
import { fitAnswer, descriptionFrom } from "./writer.ts";
import { clip, sentences, wordCountOf } from "./text.ts";

/**
 * Deterministic passes over a draft, shared by the offline and model paths:
 * the Fact-checker's claim check and the SEO/AEO lead's structure pass.
 */

// ---------- Fact-check ----------

const CLAIM = /\$\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:%|percent\b|"|”|-?inch(?:es)?\b|in\b|cm\b|mm\b|ft\b|feet\b|lbs?\b|kg\b|g\b|hours?\b|minutes?\b|years?\b|days?\b|weeks?\b|months?\b|watts?\b|mph\b|km\b)|\b\d{2,}(?:[.,]\d+)?\b/gi;

const digitsOf = (s: string) => s.replace(/[^\d.]/g, "").replace(/\.$/, "");

export interface ClaimCheck {
  markdown: string;
  /** Sentences removed because their numbers have no source. */
  flagged: string[];
  /** Numeric claims that matched a source. */
  supported: number;
}

/**
 * Every claim with a number must map to Site Brain, the fact ledger or the
 * author's evidence. Unsupported sentences are removed (and listed) rather than
 * left for a reader to trust. Evidence blocks are the author's own words and
 * fact references resolve from the ledger, so both always pass.
 */
export function checkClaims(markdown: string, sources: string[], year = new Date().getUTCFullYear()): ClaimCheck {
  const known = new Set<string>();
  for (const s of sources) for (const m of s.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) known.add(digitsOf(m));
  for (const y of [year - 1, year, year + 1]) known.add(String(y));
  const flagged: string[] = [];
  let supported = 0;

  const ok = (sentence: string): boolean => {
    const text = sentence.replace(/\{\{\s*fact:[\w.-]+\s*\}\}/g, "").replace(/\]\(tq:[^)]*\)/g, "]").replace(/\]\([^)]*\)/g, "]");
    const claims = text.match(CLAIM) ?? [];
    for (const c of claims) {
      const d = digitsOf(c);
      if (!d) continue;
      // Small procedural counts ("3 options", "every 6 months") are advice, not claims.
      // Measurements, money, percentages and years always need a source.
      if (Number(d) <= 12 && !/[$%"”]|inch|\bin\b|cm|mm|ft|feet|lb|kg|\bg\b|watt|mph|km|year|percent/i.test(c)) continue;
      if (known.has(d) || known.has(d.replace(/,/g, ""))) supported++;
      else return false;
    }
    return true;
  };
  const clean = (text: string): string => {
    const kept: string[] = [];
    for (const s of sentences(text)) {
      if (ok(s)) kept.push(s);
      else flagged.push(s);
    }
    return kept.join(" ");
  };

  const doc = fromMarkdown(markdown);
  const blocks: Block[] = [];
  for (const b of doc.blocks) {
    switch (b.type) {
      case "paragraph":
      case "answer":
      case "callout": {
        const t = clean(b.text);
        if (t.trim()) blocks.push({ ...b, text: t });
        break;
      }
      case "list": {
        const items = b.items.map(clean).filter((x) => x.trim());
        if (items.length) blocks.push({ ...b, items });
        break;
      }
      case "faq":
        blocks.push({ ...b, items: b.items.map((i) => ({ q: i.q, a: clean(i.a) || i.a.replace(CLAIM, "").trim() })).filter((i) => i.a) });
        break;
      case "heading":
        if (!ok(b.text)) flagged.push(`(heading) ${b.text}`);
        blocks.push(b);
        break;
      default:
        blocks.push(b); // evidence, quotes, tables, images, code: kept as written
    }
  }
  return { markdown: toMarkdown({ v: 1, blocks }), flagged, supported };
}

// ---------- SEO / AEO ----------

export interface SeoResult {
  title: string;
  description: string;
  markdown: string;
  fixes: string[];
}

const isQuestion = (b: Block | undefined): b is Block & { type: "heading" } => !!b && b.type === "heading" && b.level === 2 && b.text.trim().endsWith("?");

/** Title ≤ 60, description ≤ 155, and every question H2 followed by a 40–60 word answer block. */
export function seoPass(title: string, description: string, markdown: string): SeoResult {
  const fixes: string[] = [];
  let t = title.replace(/\s+/g, " ").trim();
  if (t.length > 60) {
    const before = t;
    t = t.includes(":") && t.split(":")[0]!.length >= 20 ? t.split(":")[0]!.trim() : clip(t, 60);
    fixes.push(`Shortened the title to ${t.length} characters (was ${before.length}).`);
  }
  const doc: Doc = fromMarkdown(markdown);
  const blocks = [...doc.blocks];
  for (let i = 0; i < blocks.length; i++) {
    const h = blocks[i];
    if (!isQuestion(h)) continue;
    const next = blocks[i + 1];
    // Sentences from the section's paragraphs, to build or extend the answer.
    const sectionText: string[] = [];
    for (let j = i + 1; j < blocks.length && !(blocks[j]!.type === "heading" && (blocks[j] as any).level === 2); j++) {
      const b = blocks[j]!;
      if (b.type === "paragraph") sectionText.push(...sentences(b.text));
    }
    if (next?.type === "answer") {
      const n = wordCountOf(next.text);
      if (n > 60) {
        const ss = sentences(next.text);
        while (ss.length > 1 && wordCountOf(ss.join(" ")) > 60) ss.pop();
        const fixed = wordCountOf(ss.join(" ")) >= 40 ? ss.join(" ") : fitAnswer(ss, sectionText);
        blocks[i + 1] = { ...next, text: fixed };
        fixes.push(`Tightened the answer under “${h.text}” to ${wordCountOf(fixed)} words.`);
      } else if (n < 40) {
        const fixed = fitAnswer(sentences(next.text), sectionText.filter((s) => !next.text.includes(s)));
        blocks[i + 1] = { ...next, text: fixed };
        fixes.push(`Filled out the answer under “${h.text}” to ${wordCountOf(fixed)} words.`);
      }
    } else {
      const text = fitAnswer(sectionText.slice(0, 4), sectionText.slice(4));
      blocks.splice(i + 1, 0, { id: `${h.id}a`, type: "answer", text });
      fixes.push(`Added a short answer under “${h.text}”.`);
    }
  }
  const md = toMarkdown({ v: 1, blocks });
  let d = description.replace(/\s+/g, " ").trim();
  if (!d) {
    d = descriptionFrom(md.match(/:::answer\n([\s\S]*?)\n:::/)?.[1] ?? md);
    fixes.push("Wrote a meta description from the first answer.");
  } else if (d.length > 155) {
    d = descriptionFrom(d);
    fixes.push(`Shortened the meta description to ${d.length} characters.`);
  }
  if (!/:::faq/.test(md)) fixes.push("No FAQ block yet.");
  return { title: t, description: d, markdown: md, fixes };
}

/** Counts that the Ready light cares about, for run history and tests. */
export function structureStats(markdown: string) {
  const doc = fromMarkdown(markdown);
  const questions = doc.blocks.filter((b) => isQuestion(b)).length;
  const answers = doc.blocks.filter((b, i) => b.type === "answer" && isQuestion(doc.blocks[i - 1])).map((b) => wordCountOf((b as any).text));
  return {
    words: wordCountOf(markdown.replace(/:::\w*(\{[^}]*\})?|[#>|*-]/g, " ")),
    questions,
    answers,
    answersInRange: answers.filter((n) => n >= 40 && n <= 60).length,
    faq: doc.blocks.some((b) => b.type === "faq"),
  };
}
