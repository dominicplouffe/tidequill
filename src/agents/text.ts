/** Small, deterministic text helpers shared by the offline writer, voice learning and the intent parser. */

/** FNV-1a hash of a string, for seeding. */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A seeded PRNG (mulberry32) with helpers. Same seed, same choices. */
export function rng(seed: string | number) {
  let a = typeof seed === "number" ? seed >>> 0 : hash(seed);
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick<T>(arr: readonly T[]): T {
      return arr[Math.floor(next() * arr.length)]!;
    },
    shuffle<T>(arr: readonly T[]): T[] {
      const out = [...arr];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
    chance: (p: number) => next() < p,
  };
}
export type Rng = ReturnType<typeof rng>;

export const STOPWORDS = new Set(
  "a am an and are as at be been but by can do does for from get got had has have how i if in into is it its just me more most my no not of on or our out so than that the their them then there these they this to too up us was we what when where which who why will with you your about after all also any because before being best both each few here his her how into like make many much must new now off only other over same she should some such tell than those through under until very want way well were what while would he oh ok yes".split(
    " ",
  ),
);

export function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9][a-z0-9'’-]*/g) ?? [];
}

export function contentWords(text: string): string[] {
  return words(text).filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

export function wordCountOf(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Splits prose into sentences (keeps the punctuation). */
export function sentences(text: string): string[] {
  return (
    text
      .replace(/\s+/g, " ")
      .trim()
      .match(/[^.!?]+(?:[.!?]+["”’)]*|$)/g)
      ?.map((s) => s.trim())
      .filter(Boolean) ?? []
  );
}

/** Share of `a`'s content words that also appear in `b` (0–1). */
export function overlap(a: string, b: string): number {
  const aw = new Set(contentWords(a).map(stem));
  if (!aw.size) return 0;
  const bw = new Set(contentWords(b).map(stem));
  let n = 0;
  for (const w of aw) if (bw.has(w)) n++;
  return n / aw.size;
}

/** Very small stemmer: enough to match "stands" with "stand" and "cables" with "cable". */
export function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export function titleCase(s: string): string {
  const small = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or", "the", "to", "vs", "with"]);
  return s
    .split(/\s+/)
    .map((w, i) => (i > 0 && small.has(w.toLowerCase()) ? w.toLowerCase() : /^[a-z]/.test(w) ? capitalize(w) : w))
    .join(" ");
}

/** "TV stands" -> "TV stand", "boxes" -> "box", "stories" -> "story". Only touches the last word. */
export function singular(phrase: string): string {
  const parts = phrase.trim().split(/\s+/);
  const last = parts.pop() ?? "";
  let s = last;
  if (/[^aeiou]ies$/i.test(last)) s = last.slice(0, -3) + "y";
  else if (/(ches|shes|sses|xes|zes)$/i.test(last)) s = last.slice(0, -2);
  else if (/[^su]s$/i.test(last) && last.length > 3) s = last.slice(0, -1);
  return [...parts, s].join(" ");
}

export function isPlural(phrase: string): boolean {
  return singular(phrase) !== phrase.trim();
}

/** "a" or "an" for a noun phrase. */
export function article(phrase: string): string {
  const w = phrase.trim().toLowerCase();
  if (/^(hour|honest|heir)/.test(w)) return "an";
  if (/^(uni|use|eu|one|ur)/.test(w)) return "a";
  if (/^[A-Z]{2,}/.test(phrase.trim())) return /^[AEFHILMNORSX]/.test(phrase.trim()) ? "an" : "a"; // "an HDMI", "a TV"
  return /^[aeiou]/.test(w) ? "an" : "a";
}

/** Joins with commas and a final "and". */
export function listJoin(items: string[], conj = "and"): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} ${conj} ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} ${conj} ${items[items.length - 1]}`;
}

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
export function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

export function parseCount(word: string | undefined): number | null {
  if (!word) return null;
  const w = word.toLowerCase();
  if (/^\d+$/.test(w)) return Number(w);
  if (w === "a" || w === "an" || w === "one") return 1;
  if (w === "a couple of" || w === "couple") return 2;
  if (w === "a few" || w === "few" || w === "some" || w === "several") return 3;
  const i = NUMBER_WORDS.indexOf(w);
  return i >= 0 ? i : null;
}

/** Trims to at most `max` characters on a word boundary, without a dangling comma. */
export function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : t.slice(0, max)).replace(/[\s,;:–—-]+$/, "");
}

/** Phrases that make text read as machine-written. The human pass rewrites or drops them. */
export const AI_TELLS: [RegExp, string][] = [
  [/\bin today'?s (fast-paced|modern|digital) world,?\s*/gi, ""],
  [/\bit'?s (important|worth) (to note|noting) that\s*/gi, ""],
  [/\bwhen it comes to\b/gi, "with"],
  [/\bdelve(s|d)? into\b/gi, "look$1 at"],
  [/\bdelve\b/gi, "look"],
  [/\bnavigat(e|ing) the (world|landscape) of\b/gi, "choosing"],
  [/\bunlock(s|ing)? the (power|potential) of\b/gi, "get more from"],
  [/\bgame[- ]changer\b/gi, "big improvement"],
  [/\belevate(s|d)? your\b/gi, "improve$1 your"],
  [/\ba testament to\b/gi, "proof of"],
  [/\bseamless(ly)?\b/gi, "smooth$1"],
  [/\bin conclusion,?\s*/gi, ""],
  [/\bwhether you'?re a (seasoned|beginner)[^,]*,\s*/gi, ""],
  [/\bembark on\b/gi, "start"],
  [/\bplethora of\b/gi, "lot of"],
  [/\bmyriad (of )?/gi, "many "],
  [/\bat the end of the day,?\s*/gi, ""],
  [/\bleverage\b/gi, "use"],
  [/\brobust\b/gi, "sturdy"],
];

/** Removes AI-tell phrases and any author-banned phrases; tidies capitalisation afterwards. */
export function humanize(text: string, banned: string[] = []): string {
  let out = text;
  for (const [re, rep] of AI_TELLS) out = out.replace(re, rep);
  for (const phrase of banned) {
    if (!phrase.trim()) continue;
    const re = new RegExp(`\\b${phrase.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b,?\\s*`, "gi");
    out = out.replace(re, "");
  }
  // Fix sentences that now start lowercase, and doubled spaces.
  return out
    .replace(/(^|[.!?]\s+|\n)([a-z])/g, (_, p, c) => p + c.toUpperCase())
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ([,.])/g, "$1");
}

/** Finds banned or AI-tell phrases present in text (for findings and tests). */
export function tellsIn(text: string, banned: string[] = []): string[] {
  const found: string[] = [];
  for (const [re] of AI_TELLS) {
    const m = text.match(new RegExp(re.source, "i"));
    if (m) found.push(m[0].trim());
  }
  for (const b of banned) if (b.trim() && text.toLowerCase().includes(b.trim().toLowerCase())) found.push(b);
  return found;
}

/** Fuzzy match score of a query against a label: 0 (none) to 1 (exact). Prefix and word-start matches rank highest. */
export function fuzzyScore(query: string, label: string): number {
  const q = query.toLowerCase().trim();
  const l = label.toLowerCase();
  if (!q) return 0;
  if (l === q) return 1;
  if (l.startsWith(q)) return 0.9;
  const lw = l.split(/[^a-z0-9]+/).filter(Boolean);
  const qw = q.split(/[^a-z0-9]+/).filter(Boolean);
  if (qw.length && qw.every((w) => lw.some((x) => x.startsWith(w)))) return 0.8 - Math.min(0.2, (lw.length - qw.length) * 0.02);
  if (l.includes(q)) return 0.6;
  // In-order subsequence ("frd" -> "fred").
  let i = 0;
  for (const ch of l) if (ch === q[i]) i++;
  if (i === q.length && q.length >= 3) return 0.35;
  const hits = qw.filter((w) => w.length > 2 && lw.some((x) => x.startsWith(w))).length;
  return qw.length ? (hits / qw.length) * 0.5 : 0;
}
