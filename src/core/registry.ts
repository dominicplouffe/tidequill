import { z } from "zod";
import { json } from "./db.ts";
import { TqError, forbidden, invalid, notFound } from "./errors.ts";
import { id, nowIso } from "./ids.ts";
import { canActAlone, recordDecision } from "./autonomy.ts";
import { confirmToken, verifyConfirmToken } from "./secret.ts";
import type { Actor, Ctx, Permission, Risk, TrustKind } from "./types.ts";
import { permissionsFor } from "./types.ts";

/**
 * The Action registry. Every feature is an action with a typed input schema;
 * the admin, Ask and the MCP server all call `invoke`. There is no other way
 * to change a site.
 */

export interface DiffItem {
  label: string;
  before?: string | null;
  after?: string | null;
  format?: "text" | "markdown" | "color" | "font" | "url" | "number";
}

export interface Prepared<P = unknown> {
  /** One plain line, e.g. "Update the Oak & Co. price on 3 pages". */
  summary: string;
  /** Optional longer reason shown on the card. */
  detail?: string;
  diff?: DiffItem[];
  /** JSON-serializable; stored on the proposal and handed to `apply`. */
  payload: P;
  entryId?: string | null;
  /** Overrides the action's default trust kind (e.g. post.update on an old post = refresh). */
  trustKind?: TrustKind;
  costUsd?: number;
  /** True when no reader can see the change (e.g. editing a draft); agents may apply these without asking. */
  invisible?: boolean;
}

export interface Applied<R = unknown, U = unknown> {
  result: R;
  /** JSON handed to `undo`. `null`/undefined = not undoable (the action must say so in its description). */
  undo?: U | null;
  summary?: string;
  costUsd?: number;
}

interface BaseDef<I> {
  name: string;
  /** Short imperative title for menus and MCP, e.g. "Draft a post". */
  title: string;
  description: string;
  input: z.ZodType<I>;
  permission: Permission;
  /** Defaults to true. Network-level actions (sites.create, sites.list) set false. */
  siteScoped?: boolean;
}

export interface ReadAction<I = any, O = any> extends BaseDef<I> {
  risk: "read";
  run(ctx: Ctx, input: I): Promise<O> | O;
}

export interface WriteAction<I = any, P = any, R = any, U = any> extends BaseDef<I> {
  risk: Exclude<Risk, "read">;
  trust: TrustKind;
  prepare(ctx: Ctx, input: I): Promise<Prepared<P>> | Prepared<P>;
  apply(ctx: Ctx & { actionId: string }, payload: P): Promise<Applied<R, U>> | Applied<R, U>;
  undo?(ctx: Ctx & { actionId: string }, undo: U): Promise<void> | void;
}

/**
 * Commands are decisions only a person makes (approve, discard, undo, restore).
 * They run directly, are never proposed, and agents can't call them.
 */
export interface CommandAction<I = any, O = any> extends BaseDef<I> {
  risk: "command";
  run(ctx: Ctx, input: I): Promise<O> | O;
}

export type ActionDef = ReadAction | WriteAction | CommandAction;

export type InvokeResult =
  | { status: "done"; result: unknown }
  | { status: "applied"; actionId: string; summary: string; result: unknown; auto: boolean; undoable: boolean }
  | { status: "proposed"; proposalId: string; summary: string; diff: DiffItem[] }
  | { status: "dry_run"; summary: string; diff: DiffItem[]; payload: unknown; confirmToken?: string }
  | { status: "needs_confirmation"; summary: string; diff: DiffItem[]; confirmToken: string };

export interface InvokeOptions {
  /** Compute the change and return it without applying or proposing. */
  dryRun?: boolean;
  /** Always create a proposal, even if the caller could apply directly. */
  propose?: boolean;
  /** Token from a dry run; required for destructive actions by people. */
  confirm?: string;
  /** Groups proposals created by one Ask plan. */
  groupId?: string;
}

/** A policy can block or annotate a change before anyone sees it (guardrails, claim rules). */
export type Policy = (ctx: Ctx, def: WriteAction, prepared: Prepared) => Promise<string | null> | string | null;

const actions = new Map<string, ActionDef>();
const policies: Policy[] = [];

export function defineAction<I, O>(def: ReadAction<I, O>): ReadAction<I, O>;
export function defineAction<I, P, R, U>(def: WriteAction<I, P, R, U>): WriteAction<I, P, R, U>;
export function defineAction<I, O>(def: CommandAction<I, O>): CommandAction<I, O>;
export function defineAction(def: ActionDef): ActionDef {
  if (actions.has(def.name)) throw new Error(`Action ${def.name} is defined twice`);
  actions.set(def.name, def);
  return def;
}

export function addPolicy(policy: Policy) {
  policies.push(policy);
}

export function getAction(name: string): ActionDef {
  const def = actions.get(name);
  if (!def) throw notFound(`The action "${name}"`);
  return def;
}

export function listActions(): ActionDef[] {
  return [...actions.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** JSON schema of an action's input, for MCP tools, the REST API and the planner. */
export function inputJsonSchema(def: ActionDef): Record<string, unknown> {
  const schema = z.toJSONSchema(def.input, { unrepresentable: "any", io: "input" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export function describeActions() {
  return listActions().map((d) => ({
    name: d.name,
    title: d.title,
    description: d.description,
    risk: d.risk,
    permission: d.permission,
    trust: d.risk === "read" || d.risk === "command" ? null : (d as WriteAction).trust,
    siteScoped: d.siteScoped !== false,
    input: inputJsonSchema(d),
  }));
}

function checkPermission(ctx: Ctx, def: ActionDef, alt?: Permission) {
  if (ctx.actor.kind === "system") return;
  if (def.siteScoped !== false && !ctx.siteId) throw invalid("Pick a site first.");
  // Network-level actions: any signed-in person (or their agent); the action checks the rest.
  if (def.siteScoped === false) return;
  const perms = ctx.role ? permissionsFor(ctx.role) : [];
  if (perms.includes(def.permission)) return;
  if (alt && perms.includes(alt)) return;
  throw forbidden();
}

function parseInput<I>(def: ActionDef, raw: unknown): I {
  const parsed = def.input.safeParse(raw ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path?.length ? ` (${first.path.join(".")})` : "";
    throw invalid(`That request for "${def.title}" isn't quite right${where}: ${first?.message ?? "invalid input"}.`, parsed.error.issues);
  }
  return parsed.data as I;
}

export async function invoke(ctx: Ctx, name: string, rawInput: unknown, opts: InvokeOptions = {}): Promise<InvokeResult> {
  const def = getAction(name);
  checkPermission(ctx, def);
  const input = parseInput(def, rawInput);

  if (def.risk === "read") {
    return { status: "done", result: await def.run(ctx, input) };
  }
  if (def.risk === "command") {
    if (ctx.actor.kind === "agent") throw forbidden("Only a person can do that. I can ask you instead.");
    return { status: "done", result: await def.run(ctx, input) };
  }

  const prepared = await def.prepare(ctx, input);
  for (const policy of policies) {
    const problem = await policy(ctx, def, prepared);
    if (problem) throw new TqError("invalid", problem);
  }
  const diff = prepared.diff ?? [];
  const trustKind = prepared.trustKind ?? def.trust;

  if (opts.dryRun) {
    const token = def.risk === "destructive" ? confirmToken(ctx.db, ctx.siteId, name, input) : undefined;
    return { status: "dry_run", summary: prepared.summary, diff, payload: prepared.payload, confirmToken: token };
  }

  const isPerson = ctx.actor.kind === "human";
  const isSystem = ctx.actor.kind === "system";

  if (isPerson && !opts.propose) {
    if (def.risk === "destructive" && !verifyConfirmToken(ctx.db, ctx.siteId, name, input, opts.confirm)) {
      return { status: "needs_confirmation", summary: prepared.summary, diff, confirmToken: confirmToken(ctx.db, ctx.siteId, name, input) };
    }
    return applyPrepared(ctx, def, input, prepared, { auto: false });
  }

  if (isSystem && !opts.propose && def.risk !== "destructive") {
    return applyPrepared(ctx, def, input, prepared, { auto: false });
  }

  // Changes no reader can see (drafts) don't need permission.
  if (!opts.propose && prepared.invisible && def.risk !== "destructive") {
    return applyPrepared(ctx, def, input, prepared, { auto: false });
  }

  // Agents: act alone only when trust is earned and nothing says ask.
  if (!opts.propose && def.risk !== "destructive" && ctx.siteId && canActAlone(ctx.db, ctx.siteId, trustKind)) {
    return applyPrepared(ctx, def, input, prepared, { auto: true });
  }

  const proposalId = createProposal(ctx, def, input, prepared, trustKind, opts.groupId);
  return { status: "proposed", proposalId, summary: prepared.summary, diff };
}

function createProposal(ctx: Ctx, def: WriteAction, input: unknown, prepared: Prepared, trustKind: TrustKind, groupId?: string): string {
  if (!ctx.siteId) throw invalid("Proposals belong to a site.");
  const pid = id("prp");
  ctx.db
    .query(
      `INSERT INTO proposals (id, site_id, action_name, input, payload, summary, detail, diff, trust_kind, risk, actor, status, group_id, entry_id, run_id, created_at, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    )
    .run(
      pid,
      ctx.siteId,
      def.name,
      JSON.stringify(input),
      JSON.stringify(prepared.payload),
      prepared.summary,
      prepared.detail ?? "",
      JSON.stringify(prepared.diff ?? []),
      trustKind,
      def.risk,
      JSON.stringify(ctx.actor),
      groupId ?? null,
      prepared.entryId ?? null,
      ctx.runId ?? null,
      nowIso(),
      prepared.costUsd ?? 0,
    );
  ctx.services.emit({ type: "proposal.created", siteId: ctx.siteId, proposalId: pid });
  return pid;
}

async function applyPrepared(
  ctx: Ctx,
  def: WriteAction,
  input: unknown,
  prepared: Prepared,
  meta: { auto: boolean; proposalId?: string; actor?: Actor },
): Promise<InvokeResult & { status: "applied" }> {
  const actionId = id("act");
  const actx = { ...ctx, actionId };
  let applied: Applied;
  try {
    applied = await def.apply(actx, prepared.payload);
  } catch (err) {
    ctx.db
      .query(
        `INSERT INTO actions (id, site_id, name, input, actor, status, risk, trust_kind, summary, result, proposal_id, run_id, auto, created_at)
         VALUES (?, ?, ?, ?, ?, 'failed', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(actionId, ctx.siteId, def.name, JSON.stringify(input), JSON.stringify(meta.actor ?? ctx.actor), def.risk, prepared.trustKind ?? def.trust, prepared.summary, JSON.stringify({ error: String((err as Error).message ?? err) }), meta.proposalId ?? null, ctx.runId ?? null, meta.auto ? 1 : 0, nowIso());
    throw err;
  }
  const summary = applied.summary ?? prepared.summary;
  const undoable = applied.undo != null && typeof def.undo === "function";
  ctx.db
    .query(
      `INSERT INTO actions (id, site_id, name, input, actor, status, risk, trust_kind, summary, undo, result, proposal_id, run_id, auto, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, 'applied', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      actionId,
      ctx.siteId,
      def.name,
      JSON.stringify(input),
      JSON.stringify(meta.actor ?? ctx.actor),
      def.risk,
      prepared.trustKind ?? def.trust,
      summary,
      undoable ? JSON.stringify(applied.undo) : null,
      JSON.stringify(applied.result ?? null),
      meta.proposalId ?? null,
      ctx.runId ?? null,
      meta.auto ? 1 : 0,
      (prepared.costUsd ?? 0) + (applied.costUsd ?? 0),
      nowIso(),
    );
  ctx.services.emit({ type: "action.applied", siteId: ctx.siteId, actionId, auto: meta.auto });
  return { status: "applied", actionId, summary, result: applied.result, auto: meta.auto, undoable };
}

export interface ProposalRow {
  id: string;
  siteId: string;
  actionName: string;
  input: unknown;
  payload: unknown;
  summary: string;
  detail: string;
  diff: DiffItem[];
  trustKind: TrustKind;
  risk: Risk;
  actor: Actor;
  status: "pending" | "approved" | "discarded" | "superseded";
  groupId: string | null;
  entryId: string | null;
  runId: string | null;
  createdAt: string;
  decidedAt: string | null;
  edited: boolean;
  reason: string | null;
  costUsd: number;
  actionId: string | null;
}

export function proposalFromRow(r: any): ProposalRow {
  return {
    id: r.id,
    siteId: r.site_id,
    actionName: r.action_name,
    input: json(r.input, {}),
    payload: json(r.payload, {}),
    summary: r.summary,
    detail: r.detail,
    diff: json(r.diff, []),
    trustKind: r.trust_kind,
    risk: r.risk,
    actor: json(r.actor, { kind: "system" }),
    status: r.status,
    groupId: r.group_id,
    entryId: r.entry_id,
    runId: r.run_id,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    edited: !!r.edited,
    reason: r.reason,
    costUsd: r.cost_usd,
    actionId: r.action_id,
  };
}

export function getProposal(ctx: Ctx, proposalId: string): ProposalRow {
  const row = ctx.db.query("SELECT * FROM proposals WHERE id = ? AND site_id = ?").get(proposalId, ctx.siteId);
  if (!row) throw notFound("That proposal");
  return proposalFromRow(row);
}

/**
 * Approves a pending proposal. `edits` are merged into the payload; an edited
 * approval still applies but does not count toward earned trust.
 */
export async function approveProposal(ctx: Ctx, proposalId: string, edits?: Record<string, unknown>) {
  const p = getProposal(ctx, proposalId);
  if (p.status !== "pending") throw new TqError("conflict", `That proposal was already ${p.status}.`);
  const def = getAction(p.actionName);
  if (def.risk === "read" || def.risk === "command") throw invalid("Only changes can be proposed.");
  if (ctx.actor.kind === "agent") throw forbidden("Only a person can approve.");
  checkPermission(ctx, def, "review");
  // A person editing the draft before approving counts as an edited approval.
  const touchedByPerson =
    !!p.entryId &&
    !!ctx.db
      .query("SELECT 1 FROM revisions WHERE entry_id = ? AND created_at > ? AND json_extract(actor, '$.kind') = 'human' LIMIT 1")
      .get(p.entryId, p.createdAt);
  const edited = (!!edits && Object.keys(edits).length > 0) || touchedByPerson;
  const payload = edits && Object.keys(edits).length && typeof p.payload === "object" && p.payload ? { ...(p.payload as object), ...edits } : p.payload;
  const res = await applyPrepared(
    { ...ctx, runId: p.runId ?? undefined },
    def,
    p.input,
    { summary: p.summary, payload, trustKind: p.trustKind, entryId: p.entryId, costUsd: p.costUsd },
    { auto: false, proposalId: p.id, actor: p.actor },
  );
  ctx.db
    .query("UPDATE proposals SET status = 'approved', decided_at = ?, decided_by = ?, edited = ?, payload = ?, action_id = ? WHERE id = ?")
    .run(nowIso(), ctx.actor.kind === "human" ? ctx.actor.userId : null, edited ? 1 : 0, JSON.stringify(payload), res.actionId, p.id);
  const trust = recordDecision(ctx.db, p.siteId, p.trustKind, edited ? "edited" : "clean");
  ctx.services.emit({ type: "proposal.decided", siteId: p.siteId, proposalId: p.id, status: "approved" });
  return { ...res, trust };
}

export function discardProposal(ctx: Ctx, proposalId: string, reason?: string) {
  const p = getProposal(ctx, proposalId);
  if (p.status !== "pending") throw new TqError("conflict", `That proposal was already ${p.status}.`);
  const def = getAction(p.actionName);
  if (ctx.actor.kind === "agent") throw forbidden("Only a person can discard a proposal.");
  checkPermission(ctx, def, "review");
  ctx.db
    .query("UPDATE proposals SET status = 'discarded', decided_at = ?, decided_by = ?, reason = ? WHERE id = ?")
    .run(nowIso(), ctx.actor.kind === "human" ? ctx.actor.userId : null, reason ?? null, p.id);
  const trust = recordDecision(ctx.db, p.siteId, p.trustKind, "discarded");
  // Rejections are the most valuable signal: keep them as lessons in Site Brain.
  ctx.db
    .query("INSERT INTO brain (id, site_id, kind, text, source, created_at) VALUES (?, ?, 'lesson', ?, ?, ?)")
    .run(id("brn"), p.siteId, `Discarded: ${p.summary}${reason ? `. Reason: ${reason}` : ""}`, `proposal:${p.id}`, nowIso());
  ctx.services.emit({ type: "proposal.decided", siteId: p.siteId, proposalId: p.id, status: "discarded" });
  return { status: "discarded" as const, trust };
}

/** Undo one applied action. Undo is one click for 90 days. */
export async function undoAction(ctx: Ctx, actionId: string) {
  const row = ctx.db.query<any, [string]>("SELECT * FROM actions WHERE id = ?").get(actionId);
  if (!row || (ctx.siteId && row.site_id && row.site_id !== ctx.siteId)) throw notFound("That change");
  if (row.status === "undone") throw new TqError("conflict", "That change was already undone.");
  if (row.status !== "applied") throw new TqError("conflict", "Only applied changes can be undone.");
  const ageDays = (Date.now() - Date.parse(row.created_at)) / 86_400_000;
  if (ageDays > 90) throw new TqError("conflict", "Changes older than 90 days can't be undone one by one; restore a snapshot instead.");
  const def = getAction(row.name);
  if (def.risk === "read" || def.risk === "command" || !def.undo || row.undo == null) throw new TqError("conflict", "This change can't be undone.");
  checkPermission(ctx, def, "review");
  await def.undo({ ...ctx, siteId: row.site_id ?? ctx.siteId, actionId }, json(row.undo, null));
  ctx.db.query("UPDATE actions SET status = 'undone', undone_at = ? WHERE id = ?").run(nowIso(), actionId);
  // An undo of something the site did on its own is a rejection: it costs trust.
  if (row.auto && row.site_id && row.trust_kind) recordDecision(ctx.db, row.site_id, row.trust_kind, "discarded");
  return { status: "undone" as const, actionId, summary: row.summary as string };
}

/** Test helper: forget all registered actions. */
export function _resetRegistryForTests() {
  actions.clear();
  policies.length = 0;
}
