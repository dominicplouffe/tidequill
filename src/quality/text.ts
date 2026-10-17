import { plainInline, type Block, type Doc } from "../content/blocks.ts";

/**
 * Text analysis shared by the Human, SEO, AEO and voice scorers. Everything
 * here is pure and local: no database, no network, so a 3,000-word post scores
 * in a few milliseconds.
 */

export const STOPWORDS = new Set(
  (
    "a an and are as at be been being but by can could did do does doing for from had has have having he her here hers him his how i if in into is it its " +
    "itself just me more most my no nor not of off on once only or other our ours out over own same she should so some such than that the their theirs them " +
    "then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours " +
    "about above after again against all am any because before below between both down during each few further s t don now also get got one two us use used " +
    "using may might much many make makes made like way ways thing things behind under over without between around across within it's you're we're they're i'm i've isn't don't doesn't can't won't"
  ).split(/\s+/),
);

/** Words too generic to describe what a page is about. */
export const GENERIC_TERMS = new Set(["guide", "best", "how", "tips", "tip", "review", "reviews", "complete", "ultimate", "everything", "need", "know", "new", "good", "great", "top", "pick", "choose"]);

export interface ProseBlock {
  blockId: string;
  type: Block["type"];
  /** Inline markdown as stored. */
  raw: string;
  /** Plain text with markup removed and facts resolved. */
  plain: string;
}

export interface Sentence {
  blockId: string;
  text: string;
  words: number;
}

export interface Heading {
  blockId: string;
  level: number;
  text: string;
  raw: string;
  /** Position of the heading block in the doc. */
  index: number;
}

export interface Analysis {
  title: string;
  description: string;
  slug: string;
  doc: Doc;
  prose: ProseBlock[];
  sentences: Sentence[];
  headings: Heading[];
  /** All prose, plain, joined by blank lines. */
  text: string;
  wordCount: number;
  /** Every inline link: anchor, href and block. */
  links: { blockId: string; anchor: string; href: string; raw: string }[];
  images: { blockId: string; src: string; alt: string; caption: string }[];
  evidence: number;
  tables: number;
  /** Text of table cells (counted for facts, not for rhythm). */
  tableText: string;
  faqBlocks: number;
}

const WORD_RE = /[\p{L}\p{N}$€£]+(?:['’.,:/-][\p{L}\p{N}]+)*%?/gu;

export function wordsOf(text: string): string[] {
  return text.match(WORD_RE) ?? [];
}

export function countWords(text: string): number {
  return wordsOf(text).length;
}

const ABBREVIATIONS = /\b(Mr|Mrs|Ms|Dr|St|Co|Inc|Ltd|Jr|Sr|vs|etc|approx|No|Fig|e\.g|i\.e|U\.S|a\.m|p\.m)\./g;

/** Splits prose into sentences, keeping "Oak & Co." and "1.5" intact. */
export function splitSentences(text: string): string[] {
  const guarded = text.replace(ABBREVIATIONS, (m) => m.replace(/\./g, "․")).replace(/(\d)\.(\d)/g, "$1․$2");
  return guarded
    .split(/(?<=[.!?…]["”’)\]]?)\s+(?=["“‘(\[]?[\p{Lu}\p{N}$€£])|\n+/u)
    .map((s) => s.replace(/․/g, ".").trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s));
}

/** Rough English syllable count, good enough for a readability grade. */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const trimmed = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  const groups = trimmed.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups?.length ?? 1);
}

/** Flesch-Kincaid grade level. */
export function readingGrade(sentences: Sentence[]): number {
  const words = sentences.flatMap((s) => wordsOf(s.text)).filter((w) => /\p{L}/u.test(w));
  if (!words.length || !sentences.length) return 0;
  const syl = words.reduce((n, w) => n + syllables(w), 0);
  return 0.39 * (words.length / sentences.length) + 11.8 * (syl / words.length) - 15.59;
}

/** Light stemmer: lowercases and folds plurals and possessives so "stands" matches "stand". */
export function stem(word: string): string {
  let w = word.toLowerCase().replace(/['’]s$/, "").replace(/['’]/g, "");
  if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 3 && w.endsWith("es") && /(?:ch|sh|x|ss)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) w = w.slice(0, -1);
  return w;
}

export function isStopword(word: string): boolean {
  return STOPWORDS.has(word.toLowerCase().replace(/’/g, "'"));
}

/** Content-word stems of a text, in order. */
export function terms(text: string): string[] {
  return wordsOf(text)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 1 && !isStopword(w) && !/^\d+$/.test(w))
    .map(stem);
}

export function isQuestion(heading: string): boolean {
  return /\?\s*$/.test(heading) || /^(how|what|why|when|which|who|where|can|could|does|do|is|are|should|will|would|did)\b/i.test(heading.trim());
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/** First `max` words of text cut at a sentence end when possible. */
export function trimToWords(text: string, min: number, max: number): string {
  const out: string[] = [];
  let n = 0;
  for (const s of splitSentences(text)) {
    const w = countWords(s);
    if (n >= min || (n > 0 && n + w > max)) break;
    out.push(s);
    n += w;
  }
  let joined = out.join(" ");
  if (countWords(joined) > max) {
    const words = joined.split(/\s+/).slice(0, max);
    joined = `${words.join(" ").replace(/[,;:]$/, "")}.`;
  }
  return joined.trim();
}

/** Trims text to `max` characters on a sentence or word boundary. */
export function trimToChars(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  let out = "";
  for (const s of splitSentences(clean)) {
    if ((out ? `${out} ${s}` : s).length > max) break;
    out = out ? `${out} ${s}` : s;
  }
  if (out.length >= max * 0.5) return out;
  const cut = clean.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:.]$/, "")}…`;
}

export function capitalize(s: string): string {
  return s.replace(/^(\s*["“‘(]?)(\p{Ll})/u, (_, pre, c) => pre + c.toUpperCase());
}

/** Text inside a link, fact token or code span; protected from rewrites. */
export const PROTECTED_INLINE = /(?<!!)\[[^\]]+\]\([^)\s]+(?:\s+"[^"]*")?\)|\{\{\s*fact:[\w.-]+\s*\}\}|`[^`]+`/g;

/** Splits raw inline markdown into editable plain runs and protected spans. */
export function inlineRuns(raw: string): { text: string; start: number; protected: boolean }[] {
  const runs: { text: string; start: number; protected: boolean }[] = [];
  let last = 0;
  for (const m of raw.matchAll(PROTECTED_INLINE)) {
    if (m.index! > last) runs.push({ text: raw.slice(last, m.index), start: last, protected: false });
    runs.push({ text: m[0], start: m.index!, protected: true });
    last = m.index! + m[0].length;
  }
  if (last < raw.length) runs.push({ text: raw.slice(last), start: last, protected: false });
  return runs;
}

/** Index of `needle` in `raw` outside links, facts and code, or -1. */
export function findUnprotected(raw: string, needle: string, caseInsensitive = false): number {
  if (!needle) return -1;
  for (const run of inlineRuns(raw)) {
    if (run.protected) continue;
    const hay = caseInsensitive ? run.text.toLowerCase() : run.text;
    const at = hay.indexOf(caseInsensitive ? needle.toLowerCase() : needle);
    if (at >= 0) return run.start + at;
  }
  return -1;
}

function proseOf(b: Block): string[] {
  switch (b.type) {
    case "paragraph":
    case "answer":
    case "evidence":
      return [b.text];
    case "quote":
      return [b.text];
    case "callout":
      return b.tone === "disclosure" ? [] : [b.text];
    case "list":
      return b.items;
    case "faq":
      return b.items.map((i) => i.a);
    default:
      return [];
  }
}

const LINK_RE = /(?<!!)\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

export function analyze(entry: { title: string; description: string; slug: string; body: Doc }, resolveFact?: (key: string) => string | null): Analysis {
  const doc = entry.body;
  const prose: ProseBlock[] = [];
  const headings: Heading[] = [];
  const links: Analysis["links"] = [];
  const images: Analysis["images"] = [];
  let evidence = 0;
  let tables = 0;
  let faqBlocks = 0;
  const tableCells: string[] = [];

  doc.blocks.forEach((b, index) => {
    if (b.type === "heading") headings.push({ blockId: b.id, level: b.level, text: plainInline(b.text, resolveFact).trim(), raw: b.text, index });
    if (b.type === "image") images.push({ blockId: b.id, src: b.src, alt: b.alt ?? "", caption: b.caption ?? "" });
    if (b.type === "evidence") evidence++;
    if (b.type === "faq") faqBlocks++;
    if (b.type === "table") {
      tables++;
      tableCells.push(...b.header, ...b.rows.flat());
    }
    const inline: string[] = b.type === "heading" ? [b.text] : b.type === "table" ? [...b.header, ...b.rows.flat()] : b.type === "faq" ? b.items.flatMap((i) => [i.q, i.a]) : proseOf(b);
    for (const t of inline) for (const m of t.matchAll(LINK_RE)) links.push({ blockId: b.id, anchor: m[1]!, href: m[2]!, raw: m[0] });
    for (const raw of proseOf(b)) prose.push({ blockId: b.id, type: b.type, raw, plain: plainInline(raw, resolveFact).replace(/\s+/g, " ").trim() });
  });

  const sentences: Sentence[] = [];
  for (const p of prose) {
    if (p.type === "code") continue;
    for (const s of splitSentences(p.plain)) sentences.push({ blockId: p.blockId, text: s, words: countWords(s) });
  }
  const text = prose.map((p) => p.plain).join("\n\n");
  return {
    title: entry.title,
    description: entry.description,
    slug: entry.slug,
    doc,
    prose,
    sentences,
    headings,
    text,
    wordCount: countWords(text) + countWords(headings.map((h) => h.text).join(" ")),
    links,
    images,
    evidence,
    tables,
    tableText: tableCells.map((c) => plainInline(c, resolveFact)).join(" "),
    faqBlocks,
  };
}

/** Numbers, prices, measurements and years: the specifics readers and assistants can quote. */
export function specifics(text: string): string[] {
  return text.match(/[$€£]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?(?:\s?(?:%|"|”|-?inch(?:es)?|in\b|cm|mm|ft|feet|lbs?|pounds?|kg|g\b|oz|hours?|minutes?|days?|weeks?|months?|years?|watts?|mph|km))?/gi) ?? [];
}

/** True for internal links (tq: entries and same-site paths). */
export function isInternalHref(href: string): boolean {
  return href.startsWith("tq:") || (href.startsWith("/") && !href.startsWith("//"));
}

export function isExternalHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}
