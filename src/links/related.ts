import { GENERIC_TERMS, inlineRuns, isStopword, stem, terms } from "../quality/text.ts";

/**
 * Pure relatedness and anchor finding for the internal linking engine.
 * Relatedness is TF-IDF over titles, headings, category and tags; anchors are
 * phrases that already appear in the linking page and name the target's topic.
 */

export interface DocInfo {
  id: string;
  title: string;
  headings: string[];
  categoryId: string | null;
  tags: string[];
}

export type Vector = Map<string, number>;

function featureCounts(d: DocInfo): Vector {
  const v: Vector = new Map();
  const add = (t: string, w: number) => v.set(t, (v.get(t) ?? 0) + w);
  for (const t of terms(d.title)) if (!GENERIC_TERMS.has(t)) add(t, 3);
  for (const h of d.headings) for (const t of terms(h)) if (!GENERIC_TERMS.has(t)) add(t, 1);
  if (d.categoryId) add(`cat:${d.categoryId}`, 2);
  for (const tag of d.tags) add(`tag:${tag.toLowerCase()}`, 1.5);
  return v;
}

/** TF-IDF vectors for a set of documents. */
export function vectorize(docs: DocInfo[]): Map<string, Vector> {
  const counts = docs.map((d) => [d.id, featureCounts(d)] as const);
  const df = new Map<string, number>();
  for (const [, v] of counts) for (const t of v.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  const out = new Map<string, Vector>();
  for (const [id, v] of counts) {
    const w: Vector = new Map();
    for (const [t, tf] of v) w.set(t, tf * (Math.log((n + 1) / ((df.get(t) ?? 0) + 1)) + 1));
    out.set(id, w);
  }
  return out;
}

export function cosine(a: Vector, b: Vector): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [t, x] of a) {
    na += x * x;
    const y = b.get(t);
    if (y) dot += x * y;
  }
  for (const y of b.values()) nb += y * y;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Documents most related to `id`, best first, above `min` similarity. */
export function related(docs: DocInfo[], id: string, opts: { min?: number; limit?: number } = {}): { id: string; score: number }[] {
  const vectors = vectorize(docs);
  const self = vectors.get(id);
  if (!self) return [];
  return docs
    .filter((d) => d.id !== id)
    .map((d) => ({ id: d.id, score: cosine(self, vectors.get(d.id)!) }))
    .filter((x) => x.score >= (opts.min ?? 0.08))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 10);
}

/** Term weights that describe a target page, for anchor matching. */
export function targetTerms(d: Pick<DocInfo, "title" | "headings">): Map<string, number> {
  const w = new Map<string, number>();
  for (const t of terms(d.title)) if (!GENERIC_TERMS.has(t)) w.set(t, Math.max(w.get(t) ?? 0, 3));
  for (const h of d.headings) for (const t of terms(h)) if (!GENERIC_TERMS.has(t)) w.set(t, Math.max(w.get(t) ?? 0, 1));
  return w;
}

export interface AnchorCandidate {
  blockId: string;
  anchor: string;
  score: number;
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
/** Words an anchor shouldn't start or end on. */
const EDGE = new Set(["a", "an", "the", "of", "for", "to", "in", "on", "and", "or", "with", "at", "by", "from", "your", "our", "my"]);

/**
 * The best descriptive anchor for a link to `target`: 2-6 consecutive words of
 * existing text that name the target's topic, outside existing links, never
 * across punctuation or formatting. Phrases from the target's title score
 * highest; words the linking page's own title shares ("TV stand" on a TV stand
 * site) count little, and an anchor made only of them is rejected.
 */
export function findAnchor(
  blocks: { blockId: string; raw: string }[],
  target: Pick<DocInfo, "title" | "headings">,
  opts: { sourceTitle?: string; skipBlocks?: Set<string> } = {},
): AnchorCandidate | null {
  const weights = targetTerms(target);
  const titleSeq = [...target.title.matchAll(WORD)].map((m) => stem(m[0]));
  const shared = new Set(opts.sourceTitle ? terms(opts.sourceTitle) : []);
  const isTitleRun = (stems: string[]) => {
    outer: for (let i = 0; i + stems.length <= titleSeq.length; i++) {
      for (let j = 0; j < stems.length; j++) if (titleSeq[i + j] !== stems[j]) continue outer;
      return true;
    }
    return false;
  };
  let best: AnchorCandidate | null = null;
  for (const b of blocks) {
    if (opts.skipBlocks?.has(b.blockId)) continue;
    for (const run of inlineRuns(b.raw)) {
      if (run.protected) continue;
      const words = [...run.text.matchAll(WORD)].map((m) => ({ text: m[0], start: m.index!, end: m.index! + m[0].length, stem: stem(m[0]) }));
      for (let i = 0; i < words.length; i++) {
        if (EDGE.has(words[i]!.text.toLowerCase())) continue;
        for (let len = 2; len <= 6 && i + len <= words.length; len++) {
          const win = words.slice(i, i + len);
          const last = win[win.length - 1]!;
          const anchor = run.text.slice(win[0]!.start, last.end);
          if (/[.!?;:,()"“”*_`[\]{}<>]/.test(anchor)) break;
          if (EDGE.has(last.text.toLowerCase()) || isStopword(last.text)) continue;
          const titleRun = isTitleRun(win.map((w) => w.stem));
          const content = win.filter((w) => terms(w.text).length > 0);
          const matched = new Set(content.filter((w) => weights.has(w.stem)).map((w) => w.stem));
          const distinctive = [...matched].filter((t) => !shared.has(t));
          if (titleRun) {
            if (len < 3 && !distinctive.length) continue;
          } else {
            if (!weights.has(win[0]!.stem) || !weights.has(last.stem)) continue;
            if (matched.size < 2 || matched.size / Math.max(1, content.length) < 0.6 || !distinctive.length) continue;
          }
          let score = 0;
          for (const t of matched) score += weights.get(t)! * (shared.has(t) ? 0.3 : 1);
          if (titleRun) score += 0.8 * len;
          score -= len * 0.05;
          if (!best || score > best.score) best = { blockId: b.blockId, anchor, score };
        }
      }
    }
  }
  return best;
}
