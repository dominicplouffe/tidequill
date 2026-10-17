import type { Finding } from "../core/hooks.ts";
import { capitalize, findUnprotected, mean, specifics, stdev, type Analysis, type ProseBlock } from "./text.ts";

/**
 * Human score: does this read as written by a person who knows the subject?
 * Based on Wikipedia's "Signs of AI writing". No single sign proves anything,
 * so surface patterns cost a little each and missing substance costs the most.
 * Fixes push toward substance (a measurement, an observation, a source), never
 * toward synonym swaps.
 */

export interface HumanOptions {
  /** The byline is a persona: first-hand detail can't count, sources must. */
  persona?: boolean;
  /** Pages (About, Contact) aren't held to first-hand detail or sources. */
  page?: boolean;
}

export interface ScoreResult {
  score: number;
  findings: Finding[];
  /** Plain notes on what passed, for the details panel. */
  passed: string[];
}

interface PhraseRule {
  code: string;
  re: RegExp;
  message: (quote: string) => string;
  /** Mechanical rewrite of the sentence that contains the match, if one is safe. */
  cut?: (sentence: string) => string;
  penalty: number;
  severity?: Finding["severity"];
}

const say = "say what you saw instead, like a measurement or what happened when you used it";

const PUFFERY: PhraseRule[] = [
  {
    code: "human.puffery",
    re: /\b(?:stands?|serves?|stood) as an? (?:enduring |lasting )?(?:testament|reminder|symbol|beacon)(?: to| of)?(?: (?:the |a |an |its |their |his |her |our |your |my )?[\w-]+)?/gi,
    message: (q) => `“${q}” is puffery, a common sign of AI writing; ${say}.`,
    penalty: 6,
  },
  { code: "human.puffery", re: /\ba testament to(?: (?:the |a |an |its |their |his |her |our |your |my )?[\w-]+)?/gi, message: (q) => `“${q}” is puffery, a common sign of AI writing; ${say}.`, penalty: 6 },
  { code: "human.puffery", re: /\bpivotal(?: [\w-]+)?/gi, message: (q) => `“${q}” claims importance without showing it; ${say}.`, penalty: 5 },
  { code: "human.puffery", re: /\bplays? an? (?:vital|crucial|key|pivotal|significant|important|essential) role\b/gi, message: (q) => `“${q}” is a stock phrase; show the effect with a number or an example instead.`, penalty: 5 },
  { code: "human.puffery", re: /\b(?:rich|storied) (?:heritage|history|tapestry|legacy|tradition)\b|\btapestry of\b|\benduring legacy\b|\bindelible mark\b/gi, message: (q) => `“${q}” is puffery; name the year, the person or the detail that makes it true.`, penalty: 5 },
  {
    code: "human.promotional",
    re: /\b(?:breathtaking|awe-inspiring|nestled|vibrant|bustling|must-see|must-visit|world-class|state-of-the-art|cutting-edge|unparalleled|unrivaled|second to none|game[- ]changer|groundbreaking|revolutionary|transformative|timeless elegance|meticulously crafted|commitment to (?:excellence|quality)|unwavering|elevate[sd]?|delve[sd]?|delving|ever-evolving|in the realm of|navigat(?:e|ing) the complexities)\b/gi,
    message: (q) => `“${q}” sounds like an ad; replace it with a detail you can back up, like a measurement or a price.`,
    penalty: 4,
  },
  {
    code: "human.promotional",
    re: /\b(?:seamless|seamlessly|effortless|effortlessly)\b/gi,
    message: (q) => `“${q}” is an empty promise; say how long it actually took or what went wrong.`,
    // Only the adverb can be cut safely; "a seamless experience" needs a person.
    cut: (s) => (/\b(?:seamlessly|effortlessly)\b/i.test(s) ? s.replace(/\s*\b(?:seamlessly|effortlessly)\b/i, "") : s),
    penalty: 4,
  },
  {
    code: "human.filler",
    re: /^(?:it(?:'|’)s|it is) (?:important|worth|crucial|essential) (?:to note|noting|mentioning|to remember|to mention|to understand) that\s+|^(?:in today(?:'|’)s (?:fast-paced|digital|modern) (?:world|age|landscape)|needless to say|it goes without saying that),?\s+/gim,
    message: (q) => `“${q.trim()}” adds nothing; start with the point itself.`,
    cut: (s) => capitalize(s.replace(/^(?:it(?:'|’)s|it is) (?:important|worth|crucial|essential) (?:to note|noting|mentioning|to remember|to mention|to understand) that\s+|^(?:in today(?:'|’)s (?:fast-paced|digital|modern) (?:world|age|landscape)|needless to say|it goes without saying that),?\s+/i, "")),
    penalty: 4,
  },
  {
    code: "human.trailing_clause",
    re: /,\s+(?:highlighting|underscoring|emphasizing|emphasising|showcasing|reflecting|symbolizing|signaling|signalling|demonstrating|illustrating|cementing|solidifying|ensuring|fostering|contributing to|paving the way)\b[^.!?]*/gi,
    message: (q) => `The trailing clause “${q.replace(/^,\s*/, "")}” is a common AI sign; cut it, or replace it with the evidence it hints at.`,
    cut: (s) => s.replace(/,\s+(?:highlighting|underscoring|emphasizing|emphasising|showcasing|reflecting|symbolizing|signaling|signalling|demonstrating|illustrating|cementing|solidifying|ensuring|fostering|contributing to|paving the way)\b[^.!?]*/i, ""),
    penalty: 5,
  },
  {
    code: "human.summary",
    re: /^(?:in conclusion|in summary|to sum up|to summarize|overall|ultimately|all in all|in the end),\s*/gim,
    message: (q) => `Opening with “${q.replace(/,\s*$/, "").trim()}” signals a recap; end with your recommendation or a last useful detail instead.`,
    cut: (s) => capitalize(s.replace(/^(?:in conclusion|in summary|to sum up|to summarize|overall|ultimately|all in all|in the end),\s*/i, "")),
    penalty: 6,
  },
  {
    code: "human.negative_parallelism",
    re: /\b(?:it(?:'|’)s|it is|this is|that(?:'|’)s|they(?:'|’)re|they are|is|are)\s+not\s+(?:just|only|merely|simply)\b[^.!?]{1,80}?[,;—–]\s*(?:it(?:'|’)s|it is|but|they(?:'|’)re|this is)\b|\bnot only\b[^.!?]{1,80}?\bbut also\b|\bnot about\b[^.!?]{1,60}?[.;,—]\s*it(?:'|’)s about\b/gi,
    message: () => `“It's not just X, it's Y” is a common AI pattern; say the one thing you mean, plainly.`,
    penalty: 5,
  },
  {
    code: "human.chatbot",
    re: /\b(?:as an ai(?: language model)?|as a large language model|i hope this helps|i hope you found this|let me know if you (?:have any|need)|feel free to (?:ask|reach out)|knowledge cutoff|as of my last (?:update|training)|i cannot browse|great question|certainly!)/gi,
    message: (q) => `“${q}” is left over from a chatbot; delete the sentence.`,
    cut: () => "",
    penalty: 15,
    severity: "error",
  },
];

const ADJECTIVES = new Set(
  "sleek sturdy stylish modern elegant durable versatile functional timeless innovative intuitive robust reliable affordable practical beautiful stunning unique powerful efficient comprehensive engaging dynamic vibrant rich diverse seamless simple clean bold warm inviting cozy spacious bright fresh crisp smooth solid compact lightweight minimalist sophisticated luxurious premium thoughtful accessible flexible scalable secure fast easy effective".split(
    " ",
  ),
);

function looksAdjective(w: string): boolean {
  const x = w.toLowerCase();
  return ADJECTIVES.has(x) || (x.length >= 5 && /(?:ful|ous|ive|able|ible|ical|less|ant|ent|ish)$/.test(x));
}

/** The sentence of a prose block that contains `index` of its plain text. */
function sentenceAt(text: string, index: number): string {
  const before = text.slice(0, index);
  const start = Math.max(before.lastIndexOf(". "), before.lastIndexOf("! "), before.lastIndexOf("? "));
  const from = start < 0 ? 0 : start + 2;
  const rest = text.slice(index);
  const endMatch = rest.match(/[.!?](?=\s|$)/);
  const to = endMatch ? index + endMatch.index! + 1 : text.length;
  return text.slice(from, to).trim();
}

function finding(f: Omit<Finding, "area" | "severity"> & { severity?: Finding["severity"] }): Finding {
  return { ...f, area: "human", severity: f.severity ?? "warn" };
}

/** Builds a mechanical fix when the sentence appears verbatim in the stored text. */
function withCut(p: ProseBlock, sentence: string, cut: ((s: string) => string) | undefined): { quote?: string; suggestion?: string } {
  if (!cut) return {};
  const rewritten = cut(sentence).replace(/\s{2,}/g, " ").replace(/\s+([,.;!?])/g, "$1").trim();
  if (rewritten === sentence || findUnprotected(p.raw, sentence) < 0) return {};
  return { quote: sentence, suggestion: rewritten };
}

const FIRST_HAND =
  /\b(?:I|we)(?:(?:'|’)ve| have)?\s+(?:measured|tested|bought|tried|built|assembled|weighed|timed|counted|returned|ordered|installed|noticed|spent|paid|ran|checked|compared|owned|own|used|took|drilled|mounted|unboxed|cooked|visited)\b|\b(?:in my|in our) (?:testing|tests|experience|house|apartment|living room|kitchen|garage)\b|\bmy (?:old|first|own|last) \w+|\bwhen I\b/i;

/** First-hand claims a persona may never make. */
export const FIRST_HAND_CLAIM = /\b(?:I|we)(?:(?:'|’)ve| have)?\s+(?:measured|tested|bought|paid|tried|built|assembled|weighed|timed|returned|ordered|installed|owned|used|drilled|mounted|unboxed)\b|\bin (?:my|our) testing\b/gi;

export function scoreHuman(a: Analysis, opts: HumanOptions = {}): ScoreResult {
  const findings: Finding[] = [];
  const passed: string[] = [];
  let penalty = 0;
  const caps: Record<string, number> = {};
  const charge = (code: string, amount: number, cap: number) => {
    const used = caps[code] ?? 0;
    const add = Math.max(0, Math.min(amount, cap - used));
    caps[code] = used + add;
    penalty += add;
  };
  const CAPS: Record<string, number> = {
    "human.puffery": 30,
    "human.promotional": 16,
    "human.filler": 12,
    "human.trailing_clause": 15,
    "human.summary": 12,
    "human.negative_parallelism": 15,
    "human.chatbot": 30,
  };

  // Surface patterns, per prose block.
  for (const p of a.prose) {
    // Character ranges already flagged, so overlapping rules don't double count.
    const covered: [number, number][] = [];
    for (const rule of PUFFERY) {
      for (const sentence of rule.re.flags.includes("m") ? splitLines(p.plain) : [p.plain]) {
        for (const m of sentence.matchAll(rule.re)) {
          const quote = m[0].trim().replace(/[,;:]$/, "");
          const at = Math.max(0, p.plain.indexOf(m[0]));
          if (!quote || covered.some(([s, e]) => at < e && at + m[0].length > s)) continue;
          covered.push([at, at + m[0].length]);
          const full = sentenceAt(p.plain, at);
          const fix = withCut(p, full, rule.cut);
          findings.push(finding({ code: rule.code, blockId: p.blockId, message: rule.message(quote), severity: rule.severity, quote: fix.quote ?? quote, suggestion: fix.suggestion }));
          charge(rule.code, rule.penalty, CAPS[rule.code] ?? 15);
        }
      }
    }
  }

  // Section-ending summary headings.
  for (const h of a.headings) {
    if (/^(?:conclusion|in conclusion|final thoughts|wrapping up|summary|the bottom line|key takeaways)\s*[:.]?$/i.test(h.text)) {
      findings.push(finding({ code: "human.summary", blockId: h.blockId, quote: h.text, message: `A “${h.text}” section that repeats the post is a common AI sign; end with your recommendation or a final detail instead.` }));
      charge("human.summary", 6, CAPS["human.summary"]!);
    }
  }

  // Rule of three: "sleek, sturdy, and stylish" again and again.
  const triplets: string[] = [];
  for (const m of a.text.matchAll(/\b([a-z][\w-]+), ([a-z][\w-]+),? and ([a-z][\w-]+)\b/gi)) {
    if ([m[1]!, m[2]!, m[3]!].every(looksAdjective)) triplets.push(m[0]);
  }
  if (triplets.length >= 2) {
    findings.push(finding({ code: "human.rule_of_three", quote: triplets[0], message: `You list three adjectives ${triplets.length} times, like “${triplets[0]}”; keep the one you can back up and add the detail that proves it.` }));
    charge("human.rule_of_three", 4 * triplets.length, 12);
  }

  // Formatting tells.
  const raw = a.prose.map((p) => p.raw).join("\n");
  const bold = raw.match(/\*\*[^*]+\*\*/g)?.length ?? 0;
  if (bold > 3 && bold / Math.max(1, a.wordCount / 100) > 1.5) {
    findings.push(finding({ code: "human.bold", message: `${bold} bold phrases make everything look equally urgent; keep bold for the one thing readers must not miss.` }));
    charge("human.bold", 5, 5);
  }
  const emoji = (raw + a.headings.map((h) => h.raw).join(" ")).match(/\p{Extended_Pictographic}/gu)?.length ?? 0;
  if (emoji > 0) {
    findings.push(finding({ code: "human.emoji", message: `Remove the ${emoji === 1 ? "emoji" : `${emoji} emoji`}; they read as generated in an article like this.` }));
    charge("human.emoji", 3 * emoji, 9);
  }
  const titleCased = a.headings.filter((h) => isTitleCase(h.text));
  if (a.headings.length >= 3 && titleCased.length / a.headings.length >= 0.75) {
    findings.push(finding({ code: "human.title_case", severity: "info", message: "Every heading is in Title Case; use sentence case so they read like a person wrote them.", suggestion: "Sentence case for all headings" }));
    charge("human.title_case", 4, 4);
  } else if (a.headings.length >= 3) passed.push("Headings in sentence case");

  // Uniform rhythm.
  const lengths = a.sentences.map((s) => s.words).filter((n) => n > 0);
  if (lengths.length >= 8) {
    const cv = stdev(lengths) / Math.max(1, mean(lengths));
    if (cv < 0.3) {
      findings.push(finding({ code: "human.rhythm", message: `Most sentences are about ${Math.round(mean(lengths))} words long; mix in a short one and a longer, detailed one.` }));
      charge("human.rhythm", 8, 8);
    } else passed.push("Sentence length varies naturally");
  }

  // Substance: the part that matters most.
  const words = Math.max(1, a.wordCount);
  const specificCount = specifics(a.text).length + specifics(a.tableText).length;
  const perHundred = (specificCount / words) * 100;
  const names = properNames(a);
  const firstHand = FIRST_HAND.test(a.text) || a.evidence > 0;
  const sources = a.links.filter((l) => /^https?:\/\//i.test(l.href)).length;
  const scale = Math.min(1, words / 150);

  let substance = 16 * (1 - Math.min(1, perHundred / 1.2));
  if (perHundred < 0.5) {
    findings.push(finding({ code: "human.no_specifics", message: "There are almost no numbers here; add one thing you measured, counted or paid, like a width, a weight or a price." }));
  } else passed.push(`${specificCount} specific numbers`);
  if (opts.page) {
    // About and contact pages: specifics still help, sources and first-hand detail don't apply.
  } else if (opts.persona) {
    if (sources === 0) {
      substance += 10;
      findings.push(finding({ code: "human.no_sources", message: "This byline can't claim first-hand experience, so link the key claims to where they come from." }));
    }
  } else if (!firstHand) {
    substance += 10;
    findings.push(finding({ code: "human.no_first_hand", message: "Nothing here shows you used it; add one thing you saw or did, or attach a photo or note from your phone." }));
  } else passed.push("First-hand detail");
  if (names < 2) substance += 4;
  if (opts.page) {
    // Nothing to cite on an About page.
  } else if (sources + a.evidence === 0) {
    substance += 6;
    if (!opts.persona) findings.push(finding({ code: "human.no_sources", severity: "info", message: "No claim links to a source; link the most important one to where you checked it." }));
  } else passed.push(`${sources} sources linked`);
  penalty += substance * scale;

  return { score: clamp(100 - penalty), findings, passed };
}

function splitLines(text: string): string[] {
  // Rules anchored at a sentence start run per sentence.
  return text.split(/(?<=[.!?])\s+/);
}

export function isTitleCase(text: string): boolean {
  const words = text.replace(/[?!.:]/g, "").split(/\s+/).slice(1).filter((w) => w.length >= 4 && /^\p{L}/u.test(w));
  return words.length >= 2 && words.every((w) => /^\p{Lu}/u.test(w));
}

/** Converts a Title Case heading to sentence case, keeping names and acronyms seen elsewhere. */
export function sentenceCase(text: string, keep: Set<string>): string {
  return text
    .split(/(\s+)/)
    .map((w, i) => {
      if (i === 0 || /^\s+$/.test(w)) return w;
      const bare = w.replace(/[^\p{L}\p{N}&.'’-]/gu, "");
      if (/^\p{Lu}{2,}/u.test(bare) || /\d/.test(bare) || keep.has(bare)) return w;
      return w.replace(/^(\W*)(\p{Lu})/u, (_, pre, c) => pre + c.toLowerCase());
    })
    .join("");
}

/** Capitalized words used mid-sentence: names, brands, places. */
export function namesInBody(a: Analysis): Set<string> {
  const out = new Set<string>();
  for (const s of a.sentences) {
    const words = s.text.split(/\s+/).slice(1);
    for (const w of words) {
      const bare = w.replace(/[^\p{L}\p{N}&.'’-]/gu, "").replace(/[.'’]+$/, "");
      if (bare.length > 1 && /^\p{Lu}/u.test(bare) && bare !== "I") out.add(bare);
    }
  }
  return out;
}

function properNames(a: Analysis): number {
  return namesInBody(a).size;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}
