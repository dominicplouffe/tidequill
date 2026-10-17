import { z } from "zod";
import { mapInline } from "../content/blocks.ts";
import { getEntry } from "../core/entries.ts";
import { TqError, invalid } from "../core/errors.ts";
import { id, nowIso } from "../core/ids.ts";
import { defineAction, invoke, type DiffItem } from "../core/registry.ts";
import type { Ctx } from "../core/types.ts";
import { agentCtx, pendingProposalExists } from "../links/engine.ts";
import { fetchWithTimeout, isPublicHttpUrl, readText } from "../links/http.ts";
import { applyPatch, preparePatch, undoPatch } from "../quality/patch.ts";
import {
  CHECK_EVERY_DAYS,
  backfillUsages,
  changeSummary,
  conflicts,
  detectCandidates,
  factMap,
  factPages,
  findFact,
  getFact,
  htmlToText,
  isDue,
  isLiveStatus,
  listFacts,
  sentencesUsing,
  tokenize,
  uniqueFactKey,
  verifyText,
  type Fact,
  type FactKind,
} from "./ledger.ts";

const kindSchema = z.enum(["price", "spec", "fact"]);
const sourceUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "Use a web address starting with http:// or https://");

function factPublic(ctx: Ctx, f: Fact, all?: Fact[]) {
  const pages = factPages(ctx.db, f.id);
  const clash = conflicts(all ?? listFacts(ctx.db, f.siteId)).find(([a, b]) => a.id === f.id || b.id === f.id);
  const other = clash ? (clash[0].id === f.id ? clash[1] : clash[0]) : null;
  return {
    key: f.key,
    token: `{{fact:${f.key}}}`,
    label: f.label,
    value: f.value,
    kind: f.kind,
    sourceUrl: f.sourceUrl,
    verifiedAt: f.verifiedAt,
    checkEveryDays: f.checkEveryDays,
    due: !!f.sourceUrl && isDue(f),
    unsourced: !f.sourceUrl,
    conflictsWith: other ? { key: other.key, value: other.value } : null,
    usages: pages.length,
    pages,
    updatedAt: f.updatedAt,
  };
}

defineAction({
  name: "facts.list",
  title: "List facts and prices",
  description: "Lists every tracked price, spec and fact with its value, source, when it was last checked and the pages that use it.",
  permission: "read",
  risk: "read",
  input: z.object({ kind: kindSchema.optional(), search: z.string().optional() }),
  run(ctx, input) {
    const all = listFacts(ctx.db, ctx.siteId!);
    const q = input.search?.toLowerCase();
    return all.filter((f) => (!input.kind || f.kind === input.kind) && (!q || f.label.toLowerCase().includes(q) || f.key.includes(q) || f.value.toLowerCase().includes(q))).map((f) => factPublic(ctx, f, all));
  },
});

defineAction({
  name: "facts.get",
  title: "Read a fact",
  description: "One tracked fact or price: its value, source, last check and every page that uses it.",
  permission: "read",
  risk: "read",
  input: z.object({ key: z.string() }),
  run(ctx, input) {
    return factPublic(ctx, getFact(ctx.db, ctx.siteId!, input.key));
  },
});

interface SetPayload {
  id: string;
  key: string;
  label: string;
  value: string;
  kind: FactKind;
  sourceUrl: string | null;
  checkEveryDays: number;
}

defineAction({
  name: "facts.set",
  title: "Track a fact or price",
  description: "Adds a price, spec or fact to the ledger. Pages use it as {{fact:key}} and update themselves when it changes. Prices are re-checked weekly, specs monthly, other facts yearly.",
  permission: "write",
  risk: "reversible",
  trust: "prices",
  input: z.object({
    label: z.string().min(2).max(200).describe("What it is, e.g. 'Oak & Co. stand price'"),
    value: z.string().min(1).max(500).describe("e.g. '$599'"),
    kind: kindSchema.optional(),
    key: z
      .string()
      .regex(/^[\w.-]+$/, "Use letters, numbers, dots and dashes")
      .optional(),
    sourceUrl: sourceUrl.optional(),
    checkEveryDays: z.number().int().min(1).max(3650).optional(),
  }),
  prepare(ctx, input) {
    const kind: FactKind = input.kind ?? (/^\s*(?:[$€£]|\d[\d,.]*\s?(?:USD|EUR|GBP))/.test(input.value) ? "price" : "fact");
    const key = input.key ?? uniqueFactKey(ctx.db, ctx.siteId!, input.label);
    const existing = findFact(ctx.db, ctx.siteId!, key);
    if (existing) throw new TqError("conflict", `There's already a fact called “${existing.label}” (${existing.value}); change it with facts.update instead.`);
    const clash = listFacts(ctx.db, ctx.siteId!).find((f) => conflicts([f, { ...f, id: "new", label: input.label, value: input.value }]).length > 0);
    // Pages that already use {{fact:key}} change when the fact appears.
    const waiting = ctx.db
      .query<{ status: string }, [string, string]>("SELECT status FROM entries WHERE site_id = ? AND deleted_at IS NULL AND body LIKE ?")
      .all(ctx.siteId!, `%fact:${key}}%`);
    return {
      summary: `Track ${input.label}: ${input.value}`,
      detail: clash ? `This disagrees with “${clash.label}”, which says ${clash.value}; settle which is right.` : undefined,
      diff: [{ label: input.label, before: null, after: input.value }],
      invisible: !waiting.some((w) => w.status === "published" || w.status === "scheduled"),
      trustKind: kind === "price" ? "prices" : "refresh",
      payload: { id: id("fct"), key, label: input.label, value: input.value, kind, sourceUrl: input.sourceUrl ?? null, checkEveryDays: input.checkEveryDays ?? CHECK_EVERY_DAYS[kind] } satisfies SetPayload,
    };
  },
  apply(ctx, p: SetPayload) {
    const now = nowIso();
    ctx.db
      .query(
        `INSERT INTO facts (id, site_id, key, label, value, kind, source_url, verified_at, check_every_days, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(site_id, key) DO UPDATE SET label = excluded.label, value = excluded.value, kind = excluded.kind, source_url = excluded.source_url,
           verified_at = excluded.verified_at, check_every_days = excluded.check_every_days, updated_at = excluded.updated_at, deleted_at = NULL`,
      )
      .run(p.id, ctx.siteId!, p.key, p.label, p.value, p.kind, p.sourceUrl, p.sourceUrl ? now : null, p.checkEveryDays, now, now);
    const fact = findFact(ctx.db, ctx.siteId!, p.key)!;
    const used = backfillUsages(ctx.db, fact);
    ctx.services.emit({ type: "fact.changed", siteId: ctx.siteId!, factId: fact.id });
    if (used.length) ctx.services.enqueueBuild(ctx.siteId!, "fact added", used);
    return { result: { key: fact.key, token: `{{fact:${fact.key}}}`, label: fact.label, value: fact.value, kind: fact.kind, usages: used.length }, undo: { id: fact.id } };
  },
  undo(ctx, u: { id: string }) {
    ctx.db.query("UPDATE facts SET deleted_at = ? WHERE id = ? AND site_id = ?").run(nowIso(), u.id, ctx.siteId!);
    const used = ctx.db.query<{ entry_id: string }, [string]>("SELECT entry_id FROM fact_usages WHERE fact_id = ?").all(u.id).map((r) => r.entry_id);
    ctx.db.query("DELETE FROM fact_usages WHERE fact_id = ?").run(u.id);
    ctx.services.emit({ type: "fact.changed", siteId: ctx.siteId!, factId: u.id });
    if (used.length) ctx.services.enqueueBuild(ctx.siteId!, "fact removed", used);
  },
});

interface UpdatePayload {
  factId: string;
  key: string;
  value: string;
  sourceUrl: string | null;
  previous: { value: string; sourceUrl: string | null; verifiedAt: string | null };
  reason: string | null;
}

defineAction({
  name: "facts.update",
  title: "Change a fact or price everywhere",
  description: "Changes a tracked fact or price and fixes every page that mentions it at once. The proposal lists each page and the sentence that changes; undo puts the old value back everywhere.",
  permission: "write",
  risk: "reversible",
  trust: "prices",
  input: z.object({
    key: z.string(),
    value: z.string().min(1).max(500),
    source: sourceUrl.optional().describe("Where the new value was confirmed"),
    reason: z.string().max(300).optional(),
  }),
  prepare(ctx, input) {
    const f = getFact(ctx.db, ctx.siteId!, input.key);
    if (input.value === f.value && (!input.source || input.source === f.sourceUrl)) throw invalid(`${f.label} is already ${f.value}.`);
    const pages = factPages(ctx.db, f.id);
    const live = pages.filter((p) => isLiveStatus(p.status));
    const values = factMap(ctx.db, ctx.siteId!);
    const diff: DiffItem[] = [{ label: f.label, before: f.value, after: input.value }];
    if (input.source && input.source !== f.sourceUrl) diff.push({ label: "Source", before: f.sourceUrl, after: input.source, format: "url" });
    for (const page of pages.slice(0, 8)) {
      const e = getEntry(ctx.db, ctx.siteId!, page.id);
      const before = sentencesUsing(e.body, f.key, f.value, values)[0];
      const after = sentencesUsing(e.body, f.key, input.value, values)[0];
      diff.push({ label: `On “${page.title}”`, before: before ?? f.value, after: after ?? input.value });
    }
    return {
      summary: input.value === f.value ? `Confirm ${f.label} at ${f.value} from a new source` : changeSummary(f, f.value, input.value, pages.length),
      detail: input.reason ?? (pages.length ? pages.map((p) => p.title).join(" · ") : undefined),
      diff,
      entryId: pages.length === 1 ? pages[0]!.id : null,
      trustKind: f.kind === "price" ? "prices" : "refresh",
      invisible: live.length === 0,
      payload: {
        factId: f.id,
        key: f.key,
        value: input.value,
        sourceUrl: input.source ?? f.sourceUrl,
        previous: { value: f.value, sourceUrl: f.sourceUrl, verifiedAt: f.verifiedAt },
        reason: input.reason ?? null,
      } satisfies UpdatePayload,
    };
  },
  apply(ctx, p: UpdatePayload) {
    const f = getFact(ctx.db, ctx.siteId!, p.key);
    if (f.value !== p.previous.value) throw new TqError("conflict", `${f.label} changed to ${f.value} after this was suggested; check it again before changing it.`);
    const now = nowIso();
    ctx.db.query("UPDATE facts SET value = ?, source_url = ?, verified_at = ?, updated_at = ? WHERE id = ?").run(p.value, p.sourceUrl, now, now, f.id);
    const pages = factPages(ctx.db, f.id);
    ctx.services.emit({ type: "fact.changed", siteId: ctx.siteId!, factId: f.id });
    const live = pages.filter((x) => isLiveStatus(x.status)).map((x) => x.id);
    if (live.length) ctx.services.enqueueBuild(ctx.siteId!, `fact changed: ${f.label}`, live);
    return {
      result: { key: f.key, value: p.value, previous: p.previous.value, pages },
      summary: changeSummary(f, p.previous.value, p.value, pages.length, true),
      undo: { factId: f.id, key: f.key, value: p.value, restore: p.previous },
    };
  },
  undo(ctx, u: { factId: string; key: string; value: string; restore: UpdatePayload["previous"] }) {
    ctx.db.query("UPDATE facts SET value = ?, source_url = ?, verified_at = ?, updated_at = ? WHERE id = ? AND site_id = ?").run(u.restore.value, u.restore.sourceUrl, u.restore.verifiedAt, nowIso(), u.factId, ctx.siteId!);
    ctx.services.emit({ type: "fact.changed", siteId: ctx.siteId!, factId: u.factId });
    const live = factPages(ctx.db, u.factId).filter((x) => isLiveStatus(x.status)).map((x) => x.id);
    if (live.length) ctx.services.enqueueBuild(ctx.siteId!, "fact undo", live);
  },
});

defineAction({
  name: "facts.link",
  title: "Track a price in a post",
  description: "Replaces a literal mention (like “$599”) in a post with the tracked fact, so the post updates itself when the fact changes.",
  permission: "write",
  risk: "reversible",
  trust: "prices",
  input: z.object({ id: z.string().describe("The post"), factKey: z.string(), text: z.string().min(1).max(200).describe("The literal text to replace, e.g. '$599'") }),
  prepare(ctx, input) {
    const entry = getEntry(ctx.db, ctx.siteId!, input.id);
    const f = getFact(ctx.db, ctx.siteId!, input.factKey);
    const { doc, count } = tokenize(entry.body, input.text, f.key, mapInline);
    if (!count) throw invalid(`I couldn't find “${input.text}” in “${entry.title}” outside links; check the exact text.`);
    return preparePatch(entry, doc, {
      summary: `Track “${input.text}” in “${entry.title}” as ${f.label}, so it updates on its own`,
      detail: input.text === f.value ? undefined : `Readers will see ${f.value}, the current value, instead of ${input.text}.`,
      liveTrust: f.kind === "price" ? "prices" : "refresh",
    });
  },
  apply: applyPatch,
  undo: undoPatch,
});

defineAction({
  name: "facts.detect",
  title: "Find prices to track",
  description: "Finds literal prices and measurements in a post, and which ones match a fact already tracked, so they can be linked and kept current.",
  permission: "read",
  risk: "read",
  input: z.object({ id: z.string() }),
  run(ctx, input) {
    const entry = getEntry(ctx.db, ctx.siteId!, input.id);
    const facts = listFacts(ctx.db, ctx.siteId!);
    return detectCandidates(entry.body, facts).map((c) => ({
      ...c,
      advice: c.factKey ? `Link “${c.text}” to “${c.factLabel}” so it updates on its own.` : c.kind === "price" ? `Track “${c.text}” as a price so it's re-checked every week.` : `Track “${c.text}” as a spec if it may change.`,
    }));
  },
});

export interface VerifyResult {
  key: string;
  status: "verified" | "changed" | "unreachable" | "unclear";
  found: string | null;
  checkedUrl: string;
  message: string;
}

/** Re-reads a fact's source page and compares it with the stored value. The page is data only. */
export async function verifyFact(ctx: Ctx, f: Fact): Promise<VerifyResult> {
  const url = f.sourceUrl;
  if (!url) throw invalid(`Add a source link to “${f.label}” first, so I know where to check it.`);
  const base = { key: f.key, checkedUrl: url };
  if (!isPublicHttpUrl(url)) return { ...base, status: "unreachable", found: null, message: "That source isn't a public web address, so it can't be checked." };
  let text: string;
  try {
    const res = await fetchWithTimeout(url, { method: "GET", headers: { accept: "text/html,text/plain;q=0.9,*/*;q=0.5" } }, 10_000);
    if (!res.ok) return { ...base, status: "unreachable", found: null, message: `The source answered with an error (${res.status}); check the link or add a new source.` };
    const body = await readText(res);
    text = /html/i.test(res.headers.get("content-type") ?? "html") ? htmlToText(body) : body;
  } catch {
    return { ...base, status: "unreachable", found: null, message: "The source couldn't be reached; I'll try again later." };
  }
  const r = verifyText(text, f);
  if (r.status === "verified") {
    ctx.db.query("UPDATE facts SET verified_at = ? WHERE id = ?").run(nowIso(), f.id);
    return { ...base, status: "verified", found: r.found, message: `${f.label} is still ${f.value} at the source.` };
  }
  if (r.status === "changed") return { ...base, status: "changed", found: r.found, message: `The source now says ${r.found} for ${f.label}, not ${f.value}.` };
  return { ...base, status: "unclear", found: null, message: `I couldn't find ${f.label} on the source page; check that the link still points to it.` };
}

defineAction({
  name: "facts.verify",
  title: "Check a fact against its source",
  description: "Re-reads the fact's source page and says whether the value still matches (verified), changed, or the page couldn't be reached. Records the check time when it matches.",
  permission: "read",
  risk: "read",
  input: z.object({ key: z.string() }),
  run(ctx, input) {
    return verifyFact(ctx, getFact(ctx.db, ctx.siteId!, input.key));
  },
});

defineAction({
  name: "facts.stale",
  title: "Facts that need attention",
  description: "Facts with no source, facts overdue for a check, and facts that disagree with each other.",
  permission: "read",
  risk: "read",
  input: z.object({}),
  run(ctx) {
    const all = listFacts(ctx.db, ctx.siteId!);
    const brief = (f: Fact) => ({ key: f.key, label: f.label, value: f.value, kind: f.kind, verifiedAt: f.verifiedAt, usages: factPages(ctx.db, f.id).length });
    return {
      unsourced: all.filter((f) => !f.sourceUrl).map((f) => ({ ...brief(f), advice: `Add a source link for “${f.label}” so it can be checked.` })),
      overdue: all.filter((f) => f.sourceUrl && isDue(f)).map((f) => ({ ...brief(f), advice: `Re-check “${f.label}” against its source.` })),
      conflicts: conflicts(all).map(([a, b]) => ({ facts: [brief(a), brief(b)], advice: `“${a.label}” is ${a.value} in one place and ${b.value} in another; keep the right one and update the other.` })),
    };
  },
});

/** Every 6 hours: re-check due facts with a source; propose (or, once trusted, apply) price changes. */
export async function reverifyJob(ctx: Ctx) {
  if (!ctx.siteId) return;
  const due = listFacts(ctx.db, ctx.siteId)
    .filter((f) => f.sourceUrl && isDue(f))
    .sort((a, b) => (a.verifiedAt ?? "").localeCompare(b.verifiedAt ?? ""))
    .slice(0, 25);
  const checker = agentCtx(ctx, "fact_checker");
  for (const f of due) {
    const r = await verifyFact(ctx, f);
    if (r.status !== "changed" || f.kind !== "price" || !r.found) continue;
    if (pendingProposalExists(ctx, "facts.update", { key: f.key, value: r.found })) continue;
    try {
      await invoke(checker, "facts.update", { key: f.key, value: r.found, source: f.sourceUrl!, reason: `The source now lists ${r.found}.` });
    } catch (err) {
      if (!(err instanceof TqError)) throw err;
    }
  }
}
