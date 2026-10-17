import type { Db } from "../core/db.ts";
import { json } from "../core/db.ts";
import { listAuthors, type Author } from "../core/authors.ts";
import { listEntries, type Entry } from "../core/entries.ts";
import type { Site } from "../core/types.ts";
import { contentWords, overlap } from "./text.ts";

/**
 * What the agents read before doing anything: Site Brain, evidence, the fact
 * ledger and existing coverage. Plain SQL over core tables; read-only.
 */

export interface BrainEntry {
  id: string;
  kind: string;
  text: string;
  source: string | null;
  createdAt: string;
}

export interface EvidenceItem {
  id: string;
  authorId: string | null;
  kind: string;
  topic: string;
  text: string;
  mediaId: string | null;
  capturedAt: string;
}

export interface FactRow {
  id: string;
  key: string;
  label: string;
  value: string;
  kind: string;
  sourceUrl: string | null;
  verifiedAt: string | null;
  checkEveryDays: number;
}

export function brainEntries(db: Db, siteId: string, kinds?: string[], limit = 500): BrainEntry[] {
  const rows = db
    .query<any, [string, number]>("SELECT id, kind, text, source, created_at FROM brain WHERE site_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?")
    .all(siteId, limit)
    .map((r) => ({ id: r.id, kind: r.kind, text: r.text, source: r.source, createdAt: r.created_at }));
  return kinds ? rows.filter((r) => kinds.includes(r.kind)) : rows;
}

/** Brain entries relevant to a topic, best first. Identity, claim rules and style always apply. */
export function brainFor(db: Db, siteId: string, topic: string, limit = 12): BrainEntry[] {
  const all = brainEntries(db, siteId).filter((b) => b.kind !== "idea" && b.kind !== "lesson");
  const always = all.filter((b) => b.kind === "identity" || b.kind === "claim_rule" || b.kind === "style");
  const scored = all
    .filter((b) => !always.includes(b))
    .map((b) => ({ b, s: overlap(topic, b.text) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.b);
  return [...always, ...scored].slice(0, limit);
}

/** The last rejection lessons (the Editor reads these before proposing anything). */
export function lessons(db: Db, siteId: string, limit = 50): BrainEntry[] {
  return brainEntries(db, siteId, ["lesson"], limit * 4).slice(0, limit);
}

export function evidenceFor(db: Db, siteId: string, topic: string, authorId?: string | null, limit = 6): EvidenceItem[] {
  const rows = db
    .query<any, [string]>("SELECT * FROM evidence WHERE site_id = ? AND deleted_at IS NULL ORDER BY captured_at DESC LIMIT 300")
    .all(siteId)
    .map((r) => ({ id: r.id, authorId: r.author_id, kind: r.kind, topic: r.topic, text: r.text || json<{ transcript?: string; summary?: string }>(r.extracted, {}).transcript || json<{ summary?: string }>(r.extracted, {}).summary || "", mediaId: r.media_id, capturedAt: r.captured_at }));
  return rows
    .map((e) => ({ e, s: overlap(topic, `${e.topic} ${e.text}`) + (authorId && e.authorId === authorId ? 0.25 : 0) }))
    .filter((x) => x.s >= 0.25 && (x.e.text.trim() || x.e.mediaId))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.e);
}

export function allFacts(db: Db, siteId: string): FactRow[] {
  return db
    .query<any, [string]>("SELECT * FROM facts WHERE site_id = ? AND deleted_at IS NULL ORDER BY key")
    .all(siteId)
    .map((r) => ({ id: r.id, key: r.key, label: r.label, value: r.value, kind: r.kind, sourceUrl: r.source_url, verifiedAt: r.verified_at, checkEveryDays: r.check_every_days }));
}

export function factsFor(db: Db, siteId: string, topic: string, limit = 8): FactRow[] {
  return allFacts(db, siteId)
    .map((f) => ({ f, s: overlap(topic, `${f.label} ${f.key.replace(/[.-]/g, " ")}`) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.f);
}

/** A fact is stale when it hasn't been verified within its check interval. */
export function isStale(f: FactRow, now = Date.now()): boolean {
  if (!f.verifiedAt) return true;
  return now - Date.parse(f.verifiedAt) > f.checkEveryDays * 86_400_000;
}

/** Existing posts on (or near) a topic, for internal links and to avoid repeats. */
export function coverage(db: Db, siteId: string, topic: string, limit = 6): { entry: Entry; score: number }[] {
  return listEntries(db, siteId, { type: "post", status: ["published", "scheduled", "draft"], limit: 500 })
    .map((entry) => ({ entry, score: overlap(topic, `${entry.title} ${entry.description}`) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export interface Idea {
  id: string;
  title: string;
  reason: string;
  used: boolean;
  createdAt: string;
}

export const IDEA_SEPARATOR = " — ";

export function ideas(db: Db, siteId: string): Idea[] {
  return brainEntries(db, siteId, ["idea"])
    .map((b) => {
      const [title, ...rest] = b.text.split(IDEA_SEPARATOR);
      return { id: b.id, title: title!.trim(), reason: rest.join(IDEA_SEPARATOR).trim(), used: (b.source ?? "").startsWith("used:"), createdAt: b.createdAt };
    })
    .reverse(); // oldest first: the setup order is the planned order
}

export function markIdeaUsed(db: Db, ideaId: string, runId: string) {
  db.query("UPDATE brain SET source = ? WHERE id = ? AND kind = 'idea'").run(`used:${runId}`, ideaId);
}

export interface CategoryRow {
  id: string;
  slug: string;
  name: string;
  description: string;
}

export function categories(db: Db, siteId: string): CategoryRow[] {
  return db.query<CategoryRow, [string]>("SELECT id, slug, name, description FROM categories WHERE site_id = ? AND deleted_at IS NULL ORDER BY position, name").all(siteId);
}

/** The category that best fits a topic (by word overlap), or null. */
export function bestCategory(db: Db, siteId: string, topic: string): CategoryRow | null {
  const scored = categories(db, siteId)
    .map((c) => ({ c, s: overlap(`${c.name} ${c.description}`, topic) + overlap(topic, c.name) }))
    .sort((a, b) => b.s - a.s);
  return scored[0] && scored[0].s > 0 ? scored[0].c : null;
}

/** Phrases the claim rules forbid ("never recommend glass stands" -> "glass stands"). */
export function forbiddenTopics(rules: BrainEntry[]): string[] {
  const out: string[] = [];
  for (const r of rules) {
    const m = r.text.match(/\b(?:never|don'?t|do not|avoid)\s+(?:recommend(?:ing)?|say(?:ing)?|use|using|mention(?:ing)?|call(?:ing)?|claim(?:ing)?|suggest(?:ing)?|promote)\s+(?:that\s+)?["“']?([^"”'.;,]+)["”']?/i);
    if (m) out.push(m[1]!.trim().toLowerCase());
  }
  return out;
}

/** The Site Brain summary every prompt starts with (stable per site, so it caches). */
export function brainSummary(db: Db, site: Site, extraAuthors?: Author[]): string {
  const b = brainEntries(db, site.id).filter((x) => x.kind !== "lesson" && x.kind !== "idea");
  const by = (k: string) => b.filter((x) => x.kind === k).map((x) => `- ${x.text}`);
  const authors = extraAuthors ?? listAuthors(db, site.id);
  const sections = [
    `Site: ${site.name}${site.primaryDomain ? ` (${site.primaryDomain})` : ""}`,
    `What it is about: ${site.niche || "(not set yet)"}`,
    by("identity").length ? `Identity:\n${by("identity").join("\n")}` : "",
    by("position").length ? `Positions the site holds:\n${by("position").join("\n")}` : "",
    by("claim_rule").length ? `Claim rules (never break these):\n${by("claim_rule").join("\n")}` : "",
    by("style").length ? `Style notes:\n${by("style").join("\n")}` : "",
    by("fact").length ? `Known facts:\n${by("fact").slice(0, 40).join("\n")}` : "",
    by("competitor").length ? `Competitors:\n${by("competitor").join("\n")}` : "",
    categories(db, site.id).length ? `Categories: ${categories(db, site.id).map((c) => c.name).join(", ")}` : "",
    authors.length ? `Authors: ${authors.map((a) => `${a.name}${a.isPersona ? " (persona, no first-hand experience)" : ""}${a.expertise.length ? ` covers ${a.expertise.join(", ")}` : ""}`).join("; ")}` : "",
  ];
  return sections.filter(Boolean).join("\n\n");
}

export function topicWords(topic: string): string[] {
  return contentWords(topic);
}
