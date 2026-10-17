import { z } from "zod";
import { askMeFirst, trustSummary } from "../autonomy.ts";
import { json } from "../db.ts";
import { findEntry, entryPath, saveEntry, type Entry } from "../entries.ts";
import { TqError, invalid } from "../errors.ts";
import { health, readiness } from "../hooks.ts";
import { id, nowIso } from "../ids.ts";
import { approveProposal, defineAction, discardProposal, getProposal, proposalFromRow, undoAction, type ProposalRow } from "../registry.ts";
import { getSite } from "../sites.ts";
import type { Ctx } from "../types.ts";
import { asDoc, wordCount } from "../../content/blocks.ts";
import { verifyConfirmToken, confirmToken } from "../secret.ts";

function actorLabel(actor: any): string {
  if (!actor) return "Tidequill";
  if (actor.kind === "human") return actor.name ?? "You";
  if (actor.kind === "agent") return "Tidequill";
  return "Tidequill";
}

export function actionRow(r: any) {
  return {
    id: r.id,
    name: r.name,
    summary: r.summary,
    status: r.status,
    auto: !!r.auto,
    risk: r.risk,
    trustKind: r.trust_kind,
    by: actorLabel(json(r.actor, null)),
    actor: json(r.actor, null),
    undoable: r.status === "applied" && r.undo != null && Date.now() - Date.parse(r.created_at) < 90 * 86_400_000,
    costUsd: r.cost_usd,
    createdAt: r.created_at,
    undoneAt: r.undone_at,
    proposalId: r.proposal_id,
    runId: r.run_id,
  };
}

async function proposalCard(ctx: Ctx, p: ProposalRow) {
  let entry: any = null;
  if (p.entryId) {
    const e = findEntry(ctx.db, ctx.siteId!, p.entryId);
    if (e) {
      const ready = await readiness(ctx, e);
      const authors = ctx.db.query<{ name: string }, [string, string]>("SELECT name FROM authors WHERE site_id = ? AND id IN (SELECT value FROM json_each(?))").all(ctx.siteId!, JSON.stringify(e.authorIds));
      const first = e.body.blocks.find((b) => b.type === "paragraph");
      entry = {
        id: e.id,
        title: e.title,
        type: e.type,
        status: e.status,
        path: entryPath(e),
        publishAt: e.publishAt,
        authors: authors.map((a) => a.name),
        words: wordCount(e.body),
        sources: (JSON.stringify(e.body).match(/\]\(https?:/g) ?? []).length,
        excerpt: first && "text" in first ? first.text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").slice(0, 280) : e.description,
        ready,
      };
    }
  }
  return { ...p, payload: undefined, entry };
}

defineAction({
  name: "today.get",
  title: "What needs me today",
  description: "The Today inbox: proposals waiting for you, what the site did on its own (with undo), trust earned so far, agent spend and how the site is doing.",
  permission: "read",
  risk: "read",
  input: z.object({ days: z.number().int().min(1).max(90).optional() }),
  async run(ctx, input) {
    const siteId = ctx.siteId!;
    const site = getSite(ctx.db, siteId);
    const pending = ctx.db.query("SELECT * FROM proposals WHERE site_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 100").all(siteId).map(proposalFromRow);
    const since = new Date(Date.now() - (input.days ?? 7) * 86_400_000).toISOString();
    const done = ctx.db
      .query("SELECT * FROM actions WHERE site_id = ? AND created_at >= ? AND json_extract(actor, '$.kind') = 'agent' AND status IN ('applied', 'undone') AND (auto = 1 OR proposal_id IS NULL) AND name NOT IN ('posts.create', 'brain.add') ORDER BY created_at DESC LIMIT 50")
      .all(siteId, since)
      .map(actionRow);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const spend =
      (ctx.db.query<{ s: number }, [string, string]>("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM agent_runs WHERE site_id = ? AND created_at >= ?").get(siteId, monthStart.toISOString())?.s ?? 0) as number;
    return {
      site: { id: site.id, name: site.name, domain: site.primaryDomain },
      pending: await Promise.all(pending.map((p) => proposalCard(ctx, p))),
      doneOnItsOwn: done,
      trust: trustSummary(ctx.db, siteId),
      askMeFirst: askMeFirst(ctx.db, siteId),
      spend: { thisMonthUsd: Math.round(spend * 100) / 100, budgetUsd: site.settings.monthlyBudgetUsd },
      health: await health(ctx, siteId),
    };
  },
});

defineAction({
  name: "proposals.list",
  title: "List proposals",
  description: "Lists proposals (pending by default) with their summaries and diffs.",
  permission: "read",
  risk: "read",
  input: z.object({ status: z.enum(["pending", "approved", "discarded", "superseded"]).optional(), groupId: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }),
  async run(ctx, input) {
    const rows = input.groupId
      ? ctx.db.query("SELECT * FROM proposals WHERE site_id = ? AND group_id = ? ORDER BY created_at").all(ctx.siteId!, input.groupId)
      : ctx.db.query("SELECT * FROM proposals WHERE site_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?").all(ctx.siteId!, input.status ?? "pending", input.limit ?? 50);
    return Promise.all(rows.map(proposalFromRow).map((p) => proposalCard(ctx, p)));
  },
});

defineAction({
  name: "proposals.get",
  title: "Read a proposal",
  description: "One proposal with its full diff and, for drafts, the Ready light.",
  permission: "read",
  risk: "read",
  input: z.object({ id: z.string() }),
  async run(ctx, input) {
    const p = getProposal(ctx, input.id);
    return { ...(await proposalCard(ctx, p)), payload: p.payload };
  },
});

defineAction({
  name: "proposals.approve",
  title: "Approve",
  description: "Approves a proposal and applies it. Approvals without edits build trust for that kind of work. Only people can approve.",
  permission: "review",
  risk: "command",
  input: z.object({ id: z.string(), edits: z.record(z.string(), z.any()).optional() }),
  run(ctx, input) {
    return approveProposal(ctx, input.id, input.edits);
  },
});

defineAction({
  name: "proposals.approve_group",
  title: "Approve all",
  description: "Approves every pending proposal from one Ask plan, in order. Stops at the first one that can't be applied.",
  permission: "review",
  risk: "command",
  input: z.object({ groupId: z.string() }),
  async run(ctx, input) {
    const rows = ctx.db.query("SELECT id FROM proposals WHERE site_id = ? AND group_id = ? AND status = 'pending' ORDER BY created_at").all(ctx.siteId!, input.groupId) as { id: string }[];
    const results: unknown[] = [];
    for (const r of rows) {
      try {
        results.push(await approveProposal(ctx, r.id));
      } catch (err) {
        results.push({ status: "failed", proposalId: r.id, error: (err as Error).message });
        break;
      }
    }
    return { approved: results.filter((r: any) => r.status === "applied").length, results };
  },
});

defineAction({
  name: "proposals.discard",
  title: "Discard",
  description: "Discards a proposal. The reason (optional) is remembered so the team doesn't propose the same thing again.",
  permission: "review",
  risk: "command",
  input: z.object({ id: z.string(), reason: z.string().max(500).optional() }),
  run(ctx, input) {
    return discardProposal(ctx, input.id, input.reason);
  },
});

defineAction({
  name: "history.list",
  title: "What changed",
  description: "Recent changes on this site, who or what made them, and whether they can be undone.",
  permission: "read",
  risk: "read",
  input: z.object({ limit: z.number().int().min(1).max(500).optional(), auto: z.boolean().optional(), entryId: z.string().optional() }),
  run(ctx, input) {
    let rows = ctx.db.query("SELECT * FROM actions WHERE site_id = ? ORDER BY created_at DESC LIMIT ?").all(ctx.siteId!, input.limit ?? 100) as any[];
    if (input.auto !== undefined) rows = rows.filter((r) => !!r.auto === input.auto);
    if (input.entryId) rows = rows.filter((r) => r.input.includes(input.entryId!) || (r.result ?? "").includes(input.entryId!));
    return rows.map(actionRow);
  },
});

defineAction({
  name: "history.undo",
  title: "Undo",
  description: "Undoes one change, by its action id. Works for 90 days.",
  permission: "write",
  risk: "command",
  input: z.object({ actionId: z.string() }),
  run(ctx, input) {
    return undoAction(ctx, input.actionId);
  },
});

defineAction({
  name: "history.undo_last",
  title: "Undo the last change",
  description: "Undoes the most recent change on this site that can be undone.",
  permission: "write",
  risk: "command",
  input: z.object({}),
  async run(ctx) {
    const r = ctx.db.query<{ id: string }, [string]>("SELECT id FROM actions WHERE site_id = ? AND status = 'applied' AND undo IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(ctx.siteId!);
    if (!r) throw invalid("There's nothing to undo.");
    return undoAction(ctx, r.id);
  },
});

// ---------- Snapshots ----------

interface SnapshotData {
  site: { name: string; niche: string; design: string; tokens: unknown; settings: unknown };
  entries: Record<string, string | null>;
}

defineAction({
  name: "snapshots.create",
  title: "Save a snapshot",
  description: "Saves the whole site as it is right now, so it can be rolled back to this moment.",
  permission: "write",
  risk: "reversible",
  trust: "other",
  input: z.object({ label: z.string().max(120).optional() }),
  prepare(ctx, input) {
    return { summary: `Save a snapshot${input.label ? `: ${input.label}` : ""}`, invisible: true, payload: { id: id("snp"), label: input.label ?? new Date().toUTCString().slice(0, 22) } };
  },
  apply(ctx, p: { id: string; label: string }) {
    const s = ctx.db.query<any, [string]>("SELECT name, niche, design, tokens, settings FROM sites WHERE id = ?").get(ctx.siteId!);
    const entries = Object.fromEntries(
      (ctx.db.query("SELECT id, current_revision_id FROM entries WHERE site_id = ? AND deleted_at IS NULL").all(ctx.siteId!) as any[]).map((r) => [r.id, r.current_revision_id]),
    );
    const data: SnapshotData = { site: { name: s.name, niche: s.niche, design: s.design, tokens: json(s.tokens, {}), settings: json(s.settings, {}) }, entries };
    ctx.db.query("INSERT INTO snapshots (id, site_id, label, data, created_at) VALUES (?, ?, ?, ?, ?)").run(p.id, ctx.siteId!, p.label, JSON.stringify(data), nowIso());
    return { result: { id: p.id, label: p.label, entries: Object.keys(entries).length }, undo: { id: p.id } };
  },
  undo(ctx, u: { id: string }) {
    ctx.db.query("DELETE FROM snapshots WHERE id = ?").run(u.id);
  },
});

defineAction({
  name: "snapshots.list",
  title: "List snapshots",
  description: "Lists saved snapshots of the whole site.",
  permission: "read",
  risk: "read",
  input: z.object({}),
  run(ctx) {
    return (ctx.db.query("SELECT id, label, created_at, data FROM snapshots WHERE site_id = ? ORDER BY created_at DESC").all(ctx.siteId!) as any[]).map((r) => ({
      id: r.id,
      label: r.label,
      createdAt: r.created_at,
      entries: Object.keys(json<SnapshotData>(r.data, { site: {} as any, entries: {} }).entries).length,
    }));
  },
});

defineAction({
  name: "snapshots.restore",
  title: "Roll the site back",
  description: "Restores every post, page, the look and the settings to a snapshot. Posts created after it are taken off the site. A snapshot of the current state is saved first, so this can be reversed. Needs a confirmation token from a dry run (call once without `confirm`).",
  permission: "admin",
  risk: "command",
  input: z.object({ id: z.string(), confirm: z.string().optional() }),
  run(ctx, input) {
    const snap = ctx.db.query<any, [string, string]>("SELECT * FROM snapshots WHERE id = ? AND site_id = ?").get(input.id, ctx.siteId!);
    if (!snap) throw invalid("That snapshot doesn't exist.");
    const data = json<SnapshotData>(snap.data, { site: {} as any, entries: {} });
    if (!verifyConfirmToken(ctx.db, ctx.siteId, "snapshots.restore", { id: input.id }, input.confirm)) {
      return { status: "needs_confirmation", summary: `Roll the whole site back to “${snap.label}”`, confirmToken: confirmToken(ctx.db, ctx.siteId, "snapshots.restore", { id: input.id }) };
    }
    const actor = ctx.actor;
    // Safety net: snapshot the present first.
    const currentEntries = Object.fromEntries((ctx.db.query("SELECT id, current_revision_id FROM entries WHERE site_id = ? AND deleted_at IS NULL").all(ctx.siteId!) as any[]).map((r) => [r.id, r.current_revision_id]));
    const s = ctx.db.query<any, [string]>("SELECT name, niche, design, tokens, settings FROM sites WHERE id = ?").get(ctx.siteId!);
    const backupId = id("snp");
    ctx.db.query("INSERT INTO snapshots (id, site_id, label, data, created_at) VALUES (?, ?, ?, ?, ?)").run(backupId, ctx.siteId!, `Before rolling back to ${snap.label}`, JSON.stringify({ site: { name: s.name, niche: s.niche, design: s.design, tokens: json(s.tokens, {}), settings: json(s.settings, {}) }, entries: currentEntries }), nowIso());

    const actionId = id("act");
    let restored = 0;
    let removed = 0;
    for (const [entryId, revId] of Object.entries(data.entries)) {
      const current = findEntry(ctx.db, ctx.siteId!, entryId, true);
      if (!current || current.currentRevisionId === revId || !revId) continue;
      const rev = ctx.db.query<{ snapshot: string }, [string]>("SELECT snapshot FROM revisions WHERE id = ?").get(revId);
      if (!rev) continue;
      const snapEntry = json<Entry>(rev.snapshot, current);
      saveEntry(ctx.db, { ...current, ...snapEntry, body: asDoc(snapEntry.body), deletedAt: null }, actor, actionId);
      restored++;
    }
    for (const entryId of Object.keys(currentEntries)) {
      if (entryId in data.entries) continue;
      const e = findEntry(ctx.db, ctx.siteId!, entryId);
      if (e && e.status === "published") {
        saveEntry(ctx.db, { ...e, status: "unpublished" }, actor, actionId);
        removed++;
      }
    }
    ctx.db.query("UPDATE sites SET name = ?, niche = ?, design = ?, tokens = ?, settings = ? WHERE id = ?").run(data.site.name, data.site.niche, data.site.design, JSON.stringify(data.site.tokens), JSON.stringify(data.site.settings), ctx.siteId!);
    ctx.db
      .query("INSERT INTO actions (id, site_id, name, input, actor, status, risk, trust_kind, summary, created_at) VALUES (?, ?, 'snapshots.restore', ?, ?, 'applied', 'command', 'other', ?, ?)")
      .run(actionId, ctx.siteId!, JSON.stringify({ id: input.id }), JSON.stringify(actor), `Rolled the site back to “${snap.label}”`, nowIso());
    ctx.services.emit({ type: "site.changed", siteId: ctx.siteId!, what: "look" });
    ctx.services.enqueueBuild(ctx.siteId!, "snapshot restored");
    return { status: "restored", restored, removed, backupSnapshotId: backupId };
  },
});

export { TqError };
