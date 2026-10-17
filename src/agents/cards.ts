import type { Db } from "../core/db.ts";
import { json } from "../core/db.ts";
import { findEntry } from "../core/entries.ts";
import { id, nowIso } from "../core/ids.ts";
import { readiness, type Readiness } from "../core/hooks.ts";
import type { DiffItem } from "../core/registry.ts";
import type { Ctx } from "../core/types.ts";
import type { DesignTokens } from "./look.ts";
import { findRun } from "./runs.ts";

/** The Ask HTTP contract (docs/ARCHITECTURE.md). */
export type Card =
  | { type: "plan"; title: string; steps: { text: string; status: "pending" | "running" | "done" | "failed" }[]; costUsd: number; minutes: number; runId?: string; groupId?: string }
  | { type: "proposal"; proposalId: string; summary: string; diff: DiffItem[]; trustKind: string; status: string; entry?: { id: string; title: string; ready?: Readiness | null } }
  | { type: "applied"; actionId: string; summary: string; undoable: boolean; auto: boolean }
  | { type: "settings"; sentences: { key: string; sentence: string; say: string }[] }
  | { type: "results"; title: string; items: { title: string; subtitle?: string; href?: string; kind: string }[] }
  | { type: "progress"; runId: string; label: string; status: string }
  | { type: "looks"; options: { name: string; description: string; tokens: DesignTokens }[] }
  | { type: "navigate"; to: string; label: string }
  | { type: "error"; message: string };

export interface AskMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  cards: Card[];
  createdAt: string;
}

export async function proposalCard(ctx: Ctx, proposalId: string): Promise<Card | null> {
  const r = ctx.db.query<any, [string]>("SELECT * FROM proposals WHERE id = ?").get(proposalId);
  if (!r) return null;
  const card: Card & { type: "proposal" } = { type: "proposal", proposalId: r.id, summary: r.summary, diff: json<DiffItem[]>(r.diff, []), trustKind: r.trust_kind ?? "other", status: r.status };
  if (r.entry_id) {
    const e = findEntry(ctx.db, r.site_id, r.entry_id);
    if (e) card.entry = { id: e.id, title: e.title, ready: await readiness({ ...ctx, siteId: r.site_id }, e) };
  }
  return card;
}

export function appliedCard(db: Db, actionId: string): Card | null {
  const r = db.query<any, [string]>("SELECT * FROM actions WHERE id = ?").get(actionId);
  if (!r) return null;
  return { type: "applied", actionId: r.id, summary: r.summary, undoable: r.status === "applied" && r.undo != null, auto: !!r.auto };
}

// ---------- Conversations ----------

export function createConversation(db: Db, siteId: string | null, userId: string): string {
  const cid = id("cnv");
  db.query("INSERT INTO conversations (id, site_id, user_id, created_at) VALUES (?, ?, ?, ?)").run(cid, siteId, userId, nowIso());
  return cid;
}

export function conversationOf(db: Db, conversationId: string): { id: string; siteId: string | null; userId: string } | null {
  const r = db.query<any, [string]>("SELECT id, site_id, user_id FROM conversations WHERE id = ?").get(conversationId);
  return r ? { id: r.id, siteId: r.site_id, userId: r.user_id } : null;
}

export function addMessage(db: Db, conversationId: string, role: "user" | "assistant", text: string, cards: Card[] = []): AskMessage {
  const msg: AskMessage = { id: id("msg"), role, text, cards, createdAt: nowIso() };
  db.query("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)").run(msg.id, conversationId, role, JSON.stringify({ text, cards }), msg.createdAt);
  return msg;
}

/** Messages in order, with proposal, applied and progress cards refreshed to their current status. */
export async function listMessages(ctx: Ctx, conversationId: string): Promise<AskMessage[]> {
  const rows = ctx.db.query<any, [string]>("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid").all(conversationId);
  const out: AskMessage[] = [];
  for (const r of rows) {
    const c = json<{ text: string; cards: Card[] }>(r.content, { text: "", cards: [] });
    out.push({ id: r.id, role: r.role, text: c.text, cards: await Promise.all((c.cards ?? []).map((card) => refreshCard(ctx, card))), createdAt: r.created_at });
  }
  return out;
}

async function refreshCard(ctx: Ctx, card: Card): Promise<Card> {
  if (card.type === "proposal") {
    const row = ctx.db.query<{ status: string }, [string]>("SELECT status FROM proposals WHERE id = ?").get(card.proposalId);
    return row ? { ...card, status: row.status } : card;
  }
  if (card.type === "applied") {
    const row = ctx.db.query<{ status: string; undo: string | null }, [string]>("SELECT status, undo FROM actions WHERE id = ?").get(card.actionId);
    return row ? { ...card, undoable: row.status === "applied" && row.undo != null } : card;
  }
  if (card.type === "progress") {
    const run = findRun(ctx.db, card.runId);
    return run ? { ...card, status: run.status } : card;
  }
  return card;
}
