import { factKeys, type Doc } from "../content/blocks.ts";
import type { Finding, Readiness } from "../core/hooks.ts";
import type { Voice } from "../core/voice.ts";
import { scoreAeo } from "./aeo.ts";
import { FIRST_HAND_CLAIM, scoreHuman } from "./human.ts";
import { scoreSeo } from "./seo.ts";
import { analyze, type Analysis } from "./text.ts";
import { scoreVoice } from "./voice.ts";

/**
 * Pure assembly of the Ready light from everything the scorers need. The
 * quality module loads the inputs from the database; tests call this directly.
 */

export type Check = Readiness["checks"][number];

export interface LinkTarget {
  /** "missing" when the entry doesn't exist or was deleted. */
  status: "draft" | "scheduled" | "published" | "unpublished" | "missing";
  title?: string;
  redirected?: boolean;
}

export interface ScoreInput {
  entry: { id: string; type: "post" | "page"; status: string; title: string; description: string; slug: string; body: Doc; updatedAt: string | null; publishedAt: string | null };
  /** Authors in byline order; the first one's voice is matched. */
  authors: { name: string; bio: string; isPersona: boolean; voice: Voice }[];
  minimums: Readiness["minimums"];
  facts?: Record<string, string>;
  inboundLinks?: number;
  others?: { id: string; title: string }[];
  /** Status of every entry this one links to with tq: links. */
  linkTargets?: Record<string, LinkTarget>;
  /** Stored alt text of media used by image blocks. */
  mediaAlt?: Record<string, string>;
  now?: number;
}

export interface Scored extends Readiness {
  /** Plain notes on what passed, per area (for the details panel). */
  passed: { human: string[]; seo: string[]; aeo: string[] };
}

const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 } as const;

export function scoreEntry(input: ScoreInput): Scored {
  const resolveFact = (key: string) => input.facts?.[key] ?? null;
  const body = withStoredAlt(input.entry.body, input.mediaAlt);
  const a = analyze({ ...input.entry, body }, resolveFact);
  const author = input.authors[0] ?? null;
  const persona = !!author?.isPersona;

  const human = scoreHuman(a, { persona, page: input.entry.type === "page" });
  const seo = scoreSeo(a, { type: input.entry.type, status: input.entry.status, inboundLinks: input.inboundLinks ?? 0, others: input.others ?? [] });
  const aeo = scoreAeo(a, { type: input.entry.type, author, status: input.entry.status, updatedAt: input.entry.updatedAt ?? input.entry.publishedAt, resolveFact, now: input.now });
  const voice = author ? scoreVoice(a, author.voice, author.name.split(" ")[0] ?? author.name) : null;

  const findings: Finding[] = [...human.findings, ...seo.findings, ...aeo.findings, ...(voice?.findings ?? [])];
  const checks: Check[] = [];

  // Persona rule: a byline with no real person behind it can't claim first-hand experience.
  if (persona) {
    const claims = personaClaims(a);
    for (const c of claims.slice(0, 5)) {
      findings.push({
        area: "check",
        severity: "error",
        code: "check.persona_first_hand",
        blockId: c.blockId,
        quote: c.quote,
        message: `“${c.quote}” claims first-hand experience, but ${author!.name} is a persona; credit a real author or state it as a sourced fact.`,
      });
    }
    checks.push({ name: "First-hand claims", passed: claims.length === 0, blocking: true, message: claims.length ? `${author!.name} is a persona and can't claim to have tested or measured anything.` : "No first-hand claims under a persona byline." });
  }

  // Internal links must point at live pages.
  const broken = brokenInternalLinks(a, input.linkTargets ?? {});
  for (const b of broken) {
    findings.push({ area: "check", severity: "error", code: "check.internal_link_broken", blockId: b.blockId, quote: b.raw, suggestion: b.anchor, message: b.message });
  }
  if (a.links.some((l) => l.href.startsWith("tq:"))) {
    checks.push({ name: "Internal links", passed: broken.length === 0, blocking: true, message: broken.length ? broken[0]!.message : "Every internal link points to a live page." });
  }

  // Every {{fact:key}} must be in the ledger, or readers see the bare key.
  if (input.facts) {
    const unknown = factKeys(body).filter((k) => !(k in input.facts!));
    for (const key of unknown) {
      findings.push({ area: "check", severity: "error", code: "check.unknown_fact", quote: `{{fact:${key}}}`, message: `{{fact:${key}}} isn't a tracked fact; add it to the fact list or type the value instead.` });
    }
    if (factKeys(body).length) checks.push({ name: "Facts", passed: unknown.length === 0, blocking: true, message: unknown.length ? `${unknown.length} fact ${unknown.length === 1 ? "reference doesn't" : "references don't"} match a tracked fact.` : "Every fact reference has a value." });
  }

  return finalize(
    { human: human.score, seo: seo.score, aeo: aeo.score, voice: voice?.score ?? null },
    input.minimums,
    findings,
    checks,
    { human: human.passed, seo: seo.passed, aeo: aeo.passed },
  );
}

/** Combines scores, findings and checks into the light and headline. */
export function finalize(scores: Readiness["scores"], minimums: Readiness["minimums"], findings: Finding[], checks: Check[], passed: Scored["passed"] = { human: [], seo: [], aeo: [] }): Scored {
  const sorted = [...findings].sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity]);
  const below = (["human", "seo", "aeo"] as const).filter((k) => scores[k] < minimums[k]);
  const errors = sorted.filter((f) => f.severity === "error").length;
  const failedBlocking = checks.filter((c) => !c.passed && c.blocking);
  // Errors already explain blocking checks from this module; count each problem once.
  const blockingOnly = failedBlocking.filter((c) => !sorted.some((f) => f.severity === "error" && f.area === "check" && checkFor(f.code) === c.name)).length;
  const ready = below.length === 0 && errors === 0 && failedBlocking.length === 0;

  let fixes = errors + blockingOnly;
  for (const area of below) fixes += Math.max(1, sorted.filter((f) => f.area === area && f.severity === "warn").length);
  const far = below.some((k) => scores[k] < minimums[k] - 15);
  const light: Readiness["light"] = ready ? "green" : errors || failedBlocking.length || far ? "red" : "amber";
  const headline = ready ? "Ready" : `${fixes} ${fixes === 1 ? "fix" : "fixes"} before it's ready`;
  return { ready, light, scores, minimums, headline, findings: sorted, checks, passed };
}

function checkFor(code: string): string | null {
  if (code === "check.persona_first_hand") return "First-hand claims";
  if (code === "check.internal_link_broken") return "Internal links";
  if (code === "check.unknown_fact") return "Facts";
  return null;
}

export function personaClaims(a: Analysis): { blockId: string; quote: string }[] {
  const out: { blockId: string; quote: string }[] = [];
  for (const p of a.prose) for (const m of p.plain.matchAll(FIRST_HAND_CLAIM)) out.push({ blockId: p.blockId, quote: m[0] });
  return out;
}

export function brokenInternalLinks(a: Analysis, targets: Record<string, LinkTarget>) {
  const out: { blockId: string; anchor: string; raw: string; message: string }[] = [];
  for (const l of a.links) {
    if (!l.href.startsWith("tq:")) continue;
    const t = targets[l.href.slice(3)] ?? { status: "missing" as const };
    let message: string | null = null;
    if (t.status === "missing") message = `The link “${l.anchor}” points to a page that no longer exists; remove it or link somewhere else.`;
    else if (t.status === "unpublished") message = `The link “${l.anchor}” points to “${t.title}”, which is off the site; remove it or link somewhere else.`;
    else if (t.status === "draft") message = `The link “${l.anchor}” points to the draft “${t.title}”; publish that first or remove the link.`;
    else if (t.redirected) message = `The link “${l.anchor}” points to “${t.title}”, which now redirects; link to where it goes instead.`;
    if (message) out.push({ blockId: l.blockId, anchor: l.anchor, raw: l.raw, message });
  }
  return out;
}

/** Image blocks with an empty alt use the media library's alt text, as the renderer does. */
function withStoredAlt(body: Doc, mediaAlt?: Record<string, string>): Doc {
  if (!mediaAlt) return body;
  return {
    v: 1,
    blocks: body.blocks.map((b) => (b.type === "image" && !b.alt && b.src.startsWith("media:") && mediaAlt[b.src.slice(6)] ? { ...b, alt: mediaAlt[b.src.slice(6)]! } : b)),
  };
}
