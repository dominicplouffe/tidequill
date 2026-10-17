import { factKeys, plainInline, type Block, type Doc } from "../content/blocks.ts";
import type { Db } from "../core/db.ts";
import { entryPath, type Entry, type EntryStatus } from "../core/entries.ts";
import { notFound } from "../core/errors.ts";
import { slugify } from "../core/ids.ts";
import type { Ctx } from "../core/types.ts";
import { inlineRuns, splitSentences, terms } from "../quality/text.ts";

/**
 * The fact ledger: every price, spec and fact the site states, where it came
 * from, when it was last checked, and which pages use it. Pages reference facts
 * as {{fact:key}}, so changing a fact fixes every page at the next build.
 */

export type FactKind = "price" | "spec" | "fact";

export interface Fact {
  id: string;
  siteId: string;
  key: string;
  label: string;
  value: string;
  kind: FactKind;
  sourceUrl: string | null;
  verifiedAt: string | null;
  checkEveryDays: number;
  createdAt: string;
  updatedAt: string;
}

export const CHECK_EVERY_DAYS: Record<FactKind, number> = { price: 7, spec: 30, fact: 365 };

export function rowToFact(r: any): Fact {
  return {
    id: r.id,
    siteId: r.site_id,
    key: r.key,
    label: r.label,
    value: r.value,
    kind: r.kind,
    sourceUrl: r.source_url,
    verifiedAt: r.verified_at,
    checkEveryDays: r.check_every_days,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function findFact(db: Db, siteId: string, key: string): Fact | null {
  const r = db.query("SELECT * FROM facts WHERE site_id = ? AND key = ? AND deleted_at IS NULL").get(siteId, key);
  return r ? rowToFact(r) : null;
}

export function getFact(db: Db, siteId: string, key: string): Fact {
  const f = findFact(db, siteId, key) ?? findFact(db, siteId, slugify(key));
  if (!f) throw notFound(`The fact “${key}”`);
  return f;
}

export function listFacts(db: Db, siteId: string): Fact[] {
  return db.query("SELECT * FROM facts WHERE site_id = ? AND deleted_at IS NULL ORDER BY label").all(siteId).map(rowToFact);
}

/** Current values by key, for rendering and scoring. */
export function factMap(db: Db, siteId: string): Record<string, string> {
  return Object.fromEntries(listFacts(db, siteId).map((f) => [f.key, f.value]));
}

export interface FactPage {
  id: string;
  title: string;
  path: string;
  status: EntryStatus;
}

/** Pages (not deleted) that use a fact. */
export function factPages(db: Db, factId: string): FactPage[] {
  return db
    .query<{ id: string; title: string; slug: string; type: Entry["type"]; status: EntryStatus }, [string]>(
      "SELECT e.id, e.title, e.slug, e.type, e.status FROM fact_usages u JOIN entries e ON e.id = u.entry_id WHERE u.fact_id = ? AND e.deleted_at IS NULL ORDER BY e.title",
    )
    .all(factId)
    .map((r) => ({ id: r.id, title: r.title, path: entryPath(r), status: r.status }));
}

export function isLiveStatus(s: EntryStatus): boolean {
  return s === "published" || s === "scheduled";
}

/** Keeps fact_usages in step with an entry's {{fact:key}} tokens. */
export function syncFactUsages(ctx: Ctx, entry: Entry) {
  const db = ctx.db;
  db.transaction(() => {
    db.query("DELETE FROM fact_usages WHERE entry_id = ?").run(entry.id);
    if (entry.deletedAt) return;
    const keys = factKeys(entry.body);
    if (!keys.length) return;
    const ids = db
      .query<{ id: string }, [string, string]>("SELECT id FROM facts WHERE site_id = ? AND deleted_at IS NULL AND key IN (SELECT value FROM json_each(?))")
      .all(entry.siteId, JSON.stringify(keys));
    const insert = db.query("INSERT OR IGNORE INTO fact_usages (fact_id, entry_id) VALUES (?, ?)");
    for (const r of ids) insert.run(r.id, entry.id);
  })();
}

/** Records usages for entries that referenced a fact's key before the fact existed. */
export function backfillUsages(db: Db, fact: Pick<Fact, "id" | "siteId" | "key">): string[] {
  const rows = db
    .query<{ id: string; body: string }, [string, string]>("SELECT id, body FROM entries WHERE site_id = ? AND deleted_at IS NULL AND body LIKE ?")
    .all(fact.siteId, `%fact:${fact.key}%`);
  const ids: string[] = [];
  const insert = db.query("INSERT OR IGNORE INTO fact_usages (fact_id, entry_id) VALUES (?, ?)");
  for (const r of rows) {
    if (new RegExp(`\\{\\{\\s*fact:${fact.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\}\\}`).test(r.body)) {
      insert.run(fact.id, r.id);
      ids.push(r.id);
    }
  }
  return ids;
}

export function uniqueFactKey(db: Db, siteId: string, label: string): string {
  const base = slugify(label, 60) || "fact";
  let key = base;
  for (let n = 2; db.query("SELECT 1 FROM facts WHERE site_id = ? AND key = ? AND deleted_at IS NULL").get(siteId, key); n++) key = `${base}-${n}`;
  return key;
}

/** True when the fact is due for re-checking. */
export function isDue(f: Fact, now = Date.now()): boolean {
  if (!f.verifiedAt) return true;
  return now - Date.parse(f.verifiedAt) >= f.checkEveryDays * 86_400_000;
}

function normLabel(label: string): string {
  return terms(label).join(" ");
}

/** Pairs of facts with the same label but different values. */
export function conflicts(facts: Fact[]): [Fact, Fact][] {
  const out: [Fact, Fact][] = [];
  const byLabel = new Map<string, Fact[]>();
  for (const f of facts) {
    const k = normLabel(f.label);
    if (!k) continue;
    byLabel.set(k, [...(byLabel.get(k) ?? []), f]);
  }
  for (const group of byLabel.values()) {
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) if (normValue(group[i]!.value) !== normValue(group[j]!.value)) out.push([group[i]!, group[j]!]);
  }
  return out;
}

// ---------- Values ----------

export function normValue(v: string): string {
  const n = amount(v);
  return n !== null ? `${currencyOf(v)}${n}` : v.trim().toLowerCase().replace(/\s+/g, " ");
}

/** The number in a price like "$1,299.00", or null. */
export function amount(v: string): number | null {
  const m = v.replace(/\s/g, "").match(/^(?:[$€£]|USD|EUR|GBP|CAD|AUD)?(\d[\d,]*(?:\.\d+)?)(?:[$€£]|USD|EUR|GBP|CAD|AUD)?$/i);
  return m ? Number(m[1]!.replace(/,/g, "")) : null;
}

function currencyOf(v: string): string {
  return v.match(/[$€£]/)?.[0] ?? "";
}

export const PRICE_RE = /(?:[$€£]\s?\d[\d,]*(?:\.\d{2})?|\b\d[\d,]*(?:\.\d{2})?\s?(?:USD|EUR|GBP|dollars|euros)\b)/g;
export const MEASURE_RE = /\b\d+(?:\.\d+)?\s?(?:-?inch(?:es)?\b|in\.|"|”|cm\b|mm\b|ft\b|feet\b|lbs?\b|pounds\b|kg\b|watts?\b|W\b|mAh\b|GB\b|TB\b)/g;

// ---------- Subject lines ----------

/** "Oak & Co. stand price" → "The Oak & Co. stand". */
export function subjectOf(f: Pick<Fact, "label" | "kind">): string {
  let s = f.label.trim();
  if (f.kind === "price") s = s.replace(/\s+(?:price|cost|msrp)$/i, "");
  if (!/^(?:the|a|an)\s/i.test(s)) s = `The ${s}`;
  return s.replace(/^(the|a|an)\s/i, (m) => m.charAt(0).toUpperCase() + m.slice(1));
}

export function pagesPhrase(n: number, kind: FactKind, done = false): string {
  const verb = done ? "Updated" : "Update";
  if (n === 0) return "No pages mention it yet.";
  const pages = n === 1 ? "the page that mentions it" : kind === "price" ? `${n} pages that mention it` : `the ${n} pages that mention it`;
  return kind === "price" ? `${verb} the price on ${pages}.` : `${verb} ${pages}.`;
}

export function changeSummary(f: Pick<Fact, "label" | "kind">, from: string, to: string, pages: number, done = false): string {
  const head = f.kind === "price" ? `${subjectOf(f)} went from ${from} to ${to}.` : `${subjectOf(f)} changed from ${from} to ${to}.`;
  return `${head} ${pagesPhrase(pages, f.kind, done)}`;
}

// ---------- Where a fact appears ----------

/** Sentences of a doc that use a fact, rendered with the given value. */
export function sentencesUsing(d: Doc, key: string, value: string, others: Record<string, string>): string[] {
  const token = new RegExp(`\\{\\{\\s*fact:${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\}\\}`);
  const out: string[] = [];
  for (const b of d.blocks) {
    for (const t of inlineOf(b)) {
      if (!token.test(t)) continue;
      const marked = t.replace(new RegExp(token.source, "g"), "\u0001");
      for (const s of splitSentences(plainInline(marked, (k) => others[k] ?? k))) if (s.includes("\u0001")) out.push(s.replace(/\u0001/g, value));
    }
  }
  return out;
}

function inlineOf(b: Block): string[] {
  switch (b.type) {
    case "list":
      return b.items;
    case "faq":
      return b.items.flatMap((i) => [i.q, i.a]);
    case "table":
      return [...b.header, ...b.rows.flat()];
    case "image":
      return b.caption ? [b.caption] : [];
    case "divider":
    case "code":
      return [];
    default:
      return [b.text];
  }
}

// ---------- Detection ----------

export interface Candidate {
  text: string;
  blockId: string;
  kind: "price" | "measurement";
  /** The sentence it appears in. */
  context: string;
  /** An existing fact with this value, if any. */
  factKey: string | null;
  factLabel: string | null;
}

/** Literal prices and measurements in a doc that could be tracked as facts. */
export function detectCandidates(d: Doc, facts: Fact[]): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const b of d.blocks) {
    for (const t of inlineOf(b)) {
      for (const run of inlineRuns(t)) {
        if (run.protected) continue;
        const sentences = splitSentences(plainInline(t));
        for (const [re, kind] of [
          [PRICE_RE, "price"],
          [MEASURE_RE, "measurement"],
        ] as const) {
          for (const m of run.text.matchAll(re)) {
            const text = m[0].trim();
            const id = `${b.id}:${text}`;
            if (seen.has(id)) continue;
            seen.add(id);
            const match = facts.find((f) => normValue(f.value) === normValue(text));
            out.push({ text, blockId: b.id, kind, context: sentences.find((s) => s.includes(text)) ?? plainInline(t), factKey: match?.key ?? null, factLabel: match?.label ?? null });
          }
        }
      }
    }
  }
  return out;
}

/** Replaces every unprotected, whole occurrence of `literal` with the fact token. */
export function tokenize(d: Doc, literal: string, key: string, map: (d: Doc, fn: (t: string) => string) => Doc): { doc: Doc; count: number } {
  const esc = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{N}]|[.,]\\p{N})`, "gu");
  let count = 0;
  const doc = map(d, (t) =>
    inlineRuns(t)
      .map((run) =>
        run.protected
          ? run.text
          : run.text.replace(re, () => {
              count++;
              return `{{fact:${key}}}`;
            }),
      )
      .join(""),
  );
  return { doc, count };
}

// ---------- Verification (pure) ----------

/** Visible text of an HTML page. Scripts, styles and markup are dropped; the result is data only. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#36;|&dollar;/g, "$")
    .replace(/&pound;/g, "£")
    .replace(/&euro;/g, "€")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export interface VerifyFinding {
  status: "verified" | "changed" | "unclear";
  found: string | null;
}

/**
 * Looks for the fact's value on a source page. For prices it finds the place
 * where the label's words cluster and reads the nearest price there.
 */
export function verifyText(text: string, f: Pick<Fact, "label" | "value" | "kind">): VerifyFinding {
  const lower = text.toLowerCase();
  const want = amount(f.value);
  if (f.kind !== "price" || want === null) {
    const v = f.value.trim().toLowerCase().replace(/\s+/g, " ");
    return lower.includes(v) ? { status: "verified", found: f.value } : { status: "unclear", found: null };
  }
  const words = [...new Set(terms(f.label).filter((t) => !["price", "cost", "msrp", "co"].includes(t)))];
  const prices = [...text.matchAll(PRICE_RE)].map((m) => ({ text: m[0].replace(/\s/g, ""), at: m.index!, n: amount(m[0].replace(/\s?(?:USD|EUR|GBP|dollars|euros)$/i, "")) }));
  if (!prices.length) return { status: "unclear", found: null };

  // Where on the page the label's words cluster.
  let best: { at: number; hits: number } | null = null;
  if (words.length) {
    for (const w of words) {
      for (let at = lower.indexOf(w); at >= 0; at = lower.indexOf(w, at + 1)) {
        const window = lower.slice(Math.max(0, at - 250), at + 250);
        const hits = words.filter((x) => window.includes(x)).length;
        if (!best || hits > best.hits) best = { at, hits };
      }
    }
  }
  const strong = best && best.hits >= Math.max(1, Math.ceil(words.length * 0.6));
  if (strong) {
    // The span the label's words cover around the best spot; product pages put the price after the name.
    let start = best!.at;
    let end = best!.at;
    for (const w of words) {
      const from = Math.max(0, best!.at - 250);
      for (let at = lower.indexOf(w, from); at >= 0 && at <= best!.at + 250; at = lower.indexOf(w, at + 1)) {
        start = Math.min(start, at);
        end = Math.max(end, at + w.length);
      }
    }
    const after = prices.filter((p) => p.at >= end && p.at - end <= 300).sort((x, y) => x.at - y.at);
    const before = prices.filter((p) => p.at < start && start - p.at <= 120).sort((x, y) => y.at - x.at);
    const near = [...after, ...before];
    if (near.some((p) => p.n === want)) return { status: "verified", found: f.value };
    if (near.length) return { status: "changed", found: near[0]!.text };
  }
  if (prices.some((p) => p.n === want)) return { status: "verified", found: f.value };
  return { status: "unclear", found: null };
}
