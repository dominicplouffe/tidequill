import type { Db } from "../core/db.ts";
import { json } from "../core/db.ts";
import { TqError, notFound } from "../core/errors.ts";
import { id, nowIso } from "../core/ids.ts";
import { getSite } from "../core/sites.ts";
import type { Actor, AgentRole, Ctx, Role } from "../core/types.ts";
import { ModelUnavailableError, type ModelClient, type ModelRequest, type ModelResponse } from "./model.ts";

/**
 * Run history. Every agent job is an AgentRun: who asked, the plan, each step
 * (role, model, tokens, cost, duration, a one-line output), the status and the
 * resulting proposals. To the person it reads as one editorial team; roles
 * only show up here.
 */

export type RunStatus = "queued" | "running" | "done" | "failed" | "paused";
export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface RunStep {
  role: AgentRole;
  label: string;
  status: StepStatus;
  model?: string;
  provider?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  ms?: number;
  /** One readable line: "Read 6 Site Brain entries and 2 notes from Fred". */
  output?: string;
}

export type RunKind = "write" | "ask" | "voice" | "refresh" | "rewrite" | "setup" | "autopilot";

/** Stored in `agent_runs.plan`. */
export interface RunPlan {
  label: string;
  kind: RunKind;
  /** The planned step labels, in order. */
  outline: string[];
  input?: unknown;
  /** Role of the person behind the run; agent steps act with it (earned autonomy applies). */
  role: Role | null;
  userId: string | null;
  groupId?: string;
  conversationId?: string;
  ceilingUsd: number;
  error?: string;
  result?: unknown;
  /** Where the run came from: "ask", "autopilot", "setup", "api". */
  source?: string;
}

export interface AgentRun {
  id: string;
  siteId: string | null;
  requester: Actor;
  request: string;
  plan: RunPlan;
  steps: RunStep[];
  status: RunStatus;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  createdAt: string;
  finishedAt: string | null;
}

/** Default per-job cost ceiling. */
export const JOB_CEILING_USD = 2;
/** Jobs that may run at once per site. */
export const SITE_CONCURRENCY = 3;

function rowToRun(r: any): AgentRun {
  return {
    id: r.id,
    siteId: r.site_id,
    requester: json<Actor>(r.requester, { kind: "system" }),
    request: r.request,
    plan: json<RunPlan>(r.plan, { label: r.request, kind: "ask", outline: [], role: null, userId: null, ceilingUsd: JOB_CEILING_USD }),
    steps: json<RunStep[]>(r.steps, []),
    status: r.status,
    costUsd: r.cost_usd,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

export function findRun(db: Db, runId: string): AgentRun | null {
  const r = db.query("SELECT * FROM agent_runs WHERE id = ?").get(runId);
  return r ? rowToRun(r) : null;
}

export function getRun(db: Db, runId: string): AgentRun {
  const r = findRun(db, runId);
  if (!r) throw notFound("That job");
  return r;
}

export function userIdOf(actor: Actor): string | null {
  return actor.kind === "human" ? actor.userId : actor.kind === "agent" ? actor.onBehalfOf : null;
}

export function createRun(
  ctx: Ctx,
  opts: { runId?: string; request: string; label: string; kind: RunKind; outline?: string[]; input?: unknown; groupId?: string; conversationId?: string; source?: string; status?: RunStatus },
): string {
  const runId = opts.runId ?? id("run");
  const plan: RunPlan = {
    label: opts.label,
    kind: opts.kind,
    outline: opts.outline ?? [],
    input: opts.input,
    role: ctx.role,
    userId: userIdOf(ctx.actor),
    groupId: opts.groupId,
    conversationId: opts.conversationId,
    ceilingUsd: JOB_CEILING_USD,
    source: opts.source,
  };
  const steps: RunStep[] = (opts.outline ?? []).map((label) => ({ role: roleForStep(label), label, status: "pending" }));
  ctx.db
    .query("INSERT INTO agent_runs (id, site_id, requester, request, plan, steps, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(runId, ctx.siteId, JSON.stringify(ctx.actor), opts.request.slice(0, 2000), JSON.stringify(plan), JSON.stringify(steps), opts.status ?? "queued", nowIso());
  return runId;
}

/** Pipeline step labels map to the role that does them (shown only in run history). */
export function roleForStep(label: string): AgentRole {
  const l = label.toLowerCase();
  if (l.startsWith("research")) return "researcher";
  if (l.startsWith("draft") || l.startsWith("human") || l.startsWith("rewrite") || l.startsWith("voice")) return "writer";
  if (l.startsWith("fact")) return "fact_checker";
  if (l.startsWith("seo")) return "seo";
  if (l.startsWith("look") || l.startsWith("design")) return "designer";
  if (l.startsWith("refresh") || l.startsWith("budget")) return "steward";
  return "editor";
}

export function updatePlan(db: Db, runId: string, patch: Partial<RunPlan>) {
  const run = getRun(db, runId);
  db.query("UPDATE agent_runs SET plan = ? WHERE id = ?").run(JSON.stringify({ ...run.plan, ...patch }), runId);
}

export function setRunStatus(db: Db, runId: string, status: RunStatus, error?: string) {
  const finished = status === "done" || status === "failed" ? nowIso() : null;
  db.query("UPDATE agent_runs SET status = ?, finished_at = COALESCE(?, finished_at) WHERE id = ?").run(status, finished, runId);
  if (error !== undefined) updatePlan(db, runId, { error });
}

/** Proposals created inside a run (linked by `proposals.run_id`). */
export function runProposalIds(db: Db, runId: string): string[] {
  return db.query<{ id: string }, [string]>("SELECT id FROM proposals WHERE run_id = ? ORDER BY created_at").all(runId).map((r) => r.id);
}

/** The public shape for `GET /api/runs/:runId`. */
export function runView(db: Db, run: AgentRun) {
  return {
    id: run.id,
    status: run.status,
    label: run.plan.label,
    kind: run.plan.kind,
    steps: run.steps.map((s) => ({ role: s.role, label: s.label, status: s.status, model: s.model, costUsd: s.costUsd, ms: s.ms, output: s.output })),
    costUsd: Math.round(run.costUsd * 10000) / 10000,
    proposalIds: runProposalIds(db, run.id),
    error: run.plan.error,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
  };
}

// ---------- Budget ----------

function monthStartIso(now = new Date()): string {
  const d = new Date(now);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/** What agents spent on this site this calendar month (UTC), across all runs. */
export function monthSpend(db: Db, siteId: string): number {
  return db.query<{ s: number }, [string, string]>("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM agent_runs WHERE site_id = ? AND created_at >= ?").get(siteId, monthStartIso())?.s ?? 0;
}

export function budgetLeft(db: Db, siteId: string): number {
  const site = getSite(db, siteId);
  return Math.max(0, site.settings.monthlyBudgetUsd - monthSpend(db, siteId));
}

const money = (n: number) => `$${n < 10 ? n.toFixed(2).replace(/\.00$/, "") : Math.round(n)}`;

/** Refuses a new job that would push this month's spend past the budget. */
export function assertBudget(db: Db, siteId: string, estimateUsd: number) {
  const site = getSite(db, siteId);
  const spent = monthSpend(db, siteId);
  const budget = site.settings.monthlyBudgetUsd;
  // Offline work costs nothing and is never refused; paid work stops once the budget is spent.
  const over = spent + estimateUsd > budget + 1e-9 || (estimateUsd > 0 && spent >= budget);
  if (over) {
    throw new TqError(
      "budget",
      budget <= 0
        ? `The agent budget for this site is ${money(0)}, so I can't start new work. Say “Set the budget to $40” to turn it back on.`
        : `That would go past this month's agent budget (${money(spent)} of ${money(budget)} spent). Say “Set the budget to ${money(Math.ceil((budget + Math.max(estimateUsd, 10)) / 10) * 10)}” to raise it.`,
      { spentUsd: spent, budgetUsd: budget, estimateUsd },
    );
  }
}

export function activeRuns(db: Db, siteId: string): number {
  return db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM agent_runs WHERE site_id = ? AND status = 'running'").get(siteId)?.n ?? 0;
}

/** Thrown inside a run when a ceiling is hit; the job stops and the run is marked paused. */
export class RunPaused extends Error {}

// ---------- Recording steps ----------

/**
 * Records a run step by step. `client()` wraps a model client so every call's
 * tokens and cost land on the current step and the run, failovers are noted,
 * and the per-job ceiling and monthly budget are checked after each call.
 */
export class RunRecorder {
  private current: number | null = null;
  readonly notes: string[] = [];

  constructor(
    readonly db: Db,
    readonly runId: string,
  ) {}

  get run(): AgentRun {
    return getRun(this.db, this.runId);
  }

  private save(steps: RunStep[]) {
    this.db.query("UPDATE agent_runs SET steps = ? WHERE id = ?").run(JSON.stringify(steps), this.runId);
  }

  private index(label: string): number {
    const steps = this.run.steps;
    let i = steps.findIndex((s) => s.label === label && (s.status === "pending" || s.status === "running"));
    if (i < 0) {
      steps.push({ role: roleForStep(label), label, status: "pending" });
      this.save(steps);
      i = steps.length - 1;
    }
    return i;
  }

  patchStep(i: number, patch: Partial<RunStep>) {
    const steps = this.run.steps;
    steps[i] = { ...steps[i]!, ...patch };
    this.save(steps);
  }

  /** Runs `fn` as one visible step. Its return value's `output` (if any) becomes the step's one-liner. */
  async step<T>(label: string, fn: () => Promise<T> | T, describe?: (r: T) => string): Promise<T> {
    const i = this.index(label);
    const started = Date.now();
    this.current = i;
    this.patchStep(i, { status: "running" });
    try {
      const r = await fn();
      this.patchStep(i, { status: "done", ms: Date.now() - started, ...(describe ? { output: describe(r).slice(0, 300) } : {}) });
      return r;
    } catch (err) {
      this.patchStep(i, { status: "failed", ms: Date.now() - started, output: String((err as Error)?.message ?? err).slice(0, 300) });
      throw err;
    } finally {
      this.current = null;
    }
  }

  skip(label: string, why: string) {
    this.patchStep(this.index(label), { status: "skipped", output: why });
  }

  note(text: string) {
    this.notes.push(text);
    if (this.current != null) {
      const s = this.run.steps[this.current]!;
      this.patchStep(this.current, { output: [s.output, text].filter(Boolean).join(" ").slice(0, 300) });
    }
  }

  record(r: ModelResponse) {
    this.db.query("UPDATE agent_runs SET cost_usd = cost_usd + ?, tokens_in = tokens_in + ?, tokens_out = tokens_out + ? WHERE id = ?").run(r.costUsd, r.tokensIn, r.tokensOut, this.runId);
    if (this.current != null) {
      const s = this.run.steps[this.current]!;
      this.patchStep(this.current, {
        model: r.model,
        provider: r.provider,
        tokensIn: (s.tokensIn ?? 0) + r.tokensIn,
        tokensOut: (s.tokensOut ?? 0) + r.tokensOut,
        costUsd: Math.round(((s.costUsd ?? 0) + r.costUsd) * 1e6) / 1e6,
      });
    }
    if (r.failover?.length) this.note(`Switched to ${r.provider} after ${r.failover.join(", ")}.`);
  }

  /** Throws RunPaused when the job's ceiling or the site's monthly budget is spent. */
  checkLimits() {
    const run = this.run;
    if (run.costUsd > run.plan.ceilingUsd + 1e-9) {
      throw new RunPaused(`I paused this job: it reached its ${money(run.plan.ceilingUsd)} limit. Say “resume it” to let it finish, or discard it.`);
    }
    if (run.siteId) {
      const site = getSite(this.db, run.siteId);
      if (monthSpend(this.db, run.siteId) > site.settings.monthlyBudgetUsd + 1e-9) {
        throw new RunPaused(`I paused this job: this month's agent budget (${money(site.settings.monthlyBudgetUsd)}) is spent. Raise it to let it finish.`);
      }
    }
  }

  client(base: ModelClient): ModelClient {
    return {
      offline: base.offline,
      complete: async (req: ModelRequest) => {
        this.checkLimits();
        const r = await base.complete(req);
        this.record(r);
        this.checkLimits();
        return r;
      },
    };
  }
}

export { ModelUnavailableError };

/**
 * The context agent steps act with: an agent actor on behalf of the person who
 * asked, with that person's role, so permissions and earned autonomy apply.
 */
export function agentCtx(base: Ctx, run: Pick<AgentRun, "id" | "siteId" | "plan">, role: AgentRole): Ctx {
  return { ...base, siteId: run.siteId ?? base.siteId, actor: { kind: "agent", role, onBehalfOf: run.plan.userId, runId: run.id }, role: run.plan.role, runId: run.id };
}
