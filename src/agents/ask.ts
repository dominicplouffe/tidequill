import { z } from "zod";
import { listAuthors } from "../core/authors.ts";
import { TqError, notFound } from "../core/errors.ts";
import { id } from "../core/ids.ts";
import { describeActions, getAction, invoke, type InvokeResult } from "../core/registry.ts";
import { getSite } from "../core/sites.ts";
import type { AgentRole, Ctx } from "../core/types.ts";
import { addMessage, appliedCard, conversationOf, createConversation, listMessages, proposalCard, type AskMessage, type Card } from "./cards.ts";
import { helpAnswer } from "./help.ts";
import { contextEntry, parseIntent, slotsSentence, SUGGESTIONS, type AskContext, type PlanStep } from "./intent.ts";
import { categories as listCategories, brainSummary } from "./knowledge.ts";
import { modelFor, parseJson } from "./model.ts";
import { plannerPrompt, untrusted } from "./prompts.ts";
import { createRun, RunRecorder, setRunStatus, userIdOf } from "./runs.ts";
import { capitalize, clip } from "./text.ts";
import type { Delegated } from "./actions.ts";

/**
 * Ask: the conversation that runs the site. It knows the site and the page
 * you're on, turns what you say into a plan (a model planner when one is
 * configured, the rule-based parser otherwise), runs each step as the agent on
 * your behalf, and answers in one editorial-team voice with cards: a plan,
 * then a diff card per change. Commands (approve, undo) are never run by the
 * agent; it hands you the button instead.
 */

export const askBody = z.object({
  conversationId: z.string().optional(),
  message: z.string().min(1).max(4000),
  context: z.object({ entryId: z.string().optional(), blockId: z.string().optional(), path: z.string().optional(), screen: z.string().optional() }).optional(),
});

/** Actions the planner may use. Commands and destructive actions are left out on purpose. */
export const PLANNER_ACTIONS = [
  "posts.write",
  "posts.rewrite_block",
  "posts.refresh",
  "posts.list",
  "posts.get",
  "posts.update",
  "posts.publish",
  "posts.unpublish",
  "look.describe",
  "look.update_tokens",
  "authors.list",
  "authors.get",
  "authors.adjust_voice",
  "authors.sample",
  "authors.update",
  "authors.create",
  "categories.list",
  "categories.create",
  "brain.add",
  "brain.search",
  "settings.show",
  "settings.update",
  "autonomy.status",
  "today.get",
  "history.list",
  "proposals.list",
  "redirects.list",
  "redirects.create",
  "sites.add_domain",
  "sites.get",
  "sites.setup",
  "facts.list",
  "facts.update",
  "facts.set",
  "snapshots.create",
  "runs.list",
];

const ASK_STEPS: Record<string, string> = {
  "ask.undo": "Show the last change with its Undo button (never undo it yourself)",
  "ask.approve": "Show the proposals waiting for approval (never approve them yourself)",
  "ask.waiting": "Summarize what's waiting on Today",
  "ask.done": "Summarize what the team did recently",
  "ask.help": 'Answer a "how do I" question. input: {"question": "..."}',
  "ask.navigate": 'Open a screen. input: {"to": "/today|/settings|/capture|/authors/<slug>|/drafts/<id>|/live?path=/<slug>/", "label": "..."}',
  "ask.ask_me_first": "Turn on Ask me first",
  "ask.stop_asking": "Ask the person to turn off Ask me first themselves",
};

const COMMAND_MAP: Record<string, string> = {
  "proposals.approve": "ask.approve",
  "proposals.approve_group": "ask.approve",
  "history.undo": "ask.undo",
  "history.undo_last": "ask.undo",
  "autonomy.ask_me_first": "ask.ask_me_first",
};

function roleFor(action: string): AgentRole {
  if (action.startsWith("look.")) return "designer";
  if (action.startsWith("posts.write") || action.startsWith("posts.rewrite")) return "writer";
  if (action.startsWith("redirects.") || action.startsWith("posts.refresh") || action.startsWith("facts.")) return "steward";
  if (action.startsWith("brain.search")) return "researcher";
  return "editor";
}

interface Plan {
  steps: PlanStep[];
  reply?: string;
  unknown: string[];
  costUsd: number;
  planner: "model" | "rules";
}

// ---------- Understanding ----------

async function modelPlan(ctx: Ctx, message: string, context: AskContext, history: AskMessage[]): Promise<Plan | null> {
  const client = modelFor(ctx);
  if (client.offline) return null;
  const site = getSite(ctx.db, ctx.siteId!);
  const catalog = describeActions()
    .filter((a) => PLANNER_ACTIONS.includes(a.name))
    .map((a) => `- ${a.name}: ${a.title}. ${a.description}\n  input: ${JSON.stringify(a.input)}`)
    .concat(Object.entries(ASK_STEPS).map(([n, d]) => `- ${n}: ${d}`))
    .join("\n");
  const entry = contextEntry(ctx, context);
  const block = entry && context.blockId ? entry.body.blocks.find((b) => b.id === context.blockId) : null;
  const page = entry
    ? `On “${entry.title}” (entryId ${entry.id}, ${entry.status}${block ? `, section blockId ${block.id}` : ""}). ${untrusted("page", (block ? JSON.stringify(block) : entry.description).slice(0, 1200))}`
    : context.screen
      ? `On the ${context.screen} screen.`
      : "In the admin.";
  try {
    const r = await client.complete({
      tier: "frontier",
      cachePrefix: brainSummary(ctx.db, site),
      json: true,
      maxTokens: 3000,
      messages: [
        {
          role: "user",
          content: `${plannerPrompt({
            catalog,
            site: `${site.name} (${site.primaryDomain ?? "no domain"}): ${site.niche}`,
            page,
            authors: listAuthors(ctx.db, site.id)
              .map((a) => `${a.name} (id ${a.id}${a.isPersona ? ", persona" : ""})`)
              .join("; "),
            categories: listCategories(ctx.db, site.id).map((c) => c.name).join(", "),
            today: new Date().toISOString().slice(0, 10),
            history: history
              .slice(-6)
              .map((m) => `${m.role}: ${clip(m.text, 300)}`)
              .join("\n"),
          })}\n\nThe owner says:\n${untrusted("owner message", message)}`,
        },
      ],
    });
    const j = parseJson<{ reply?: string; steps?: { action: string; input?: Record<string, unknown>; why?: string }[] }>(r.text);
    if (!j) return null;
    const steps: PlanStep[] = [];
    const dropped: string[] = [];
    for (const s of j.steps ?? []) {
      const action = COMMAND_MAP[s.action] ?? s.action;
      if (action in ASK_STEPS) {
        steps.push({ action, input: s.input ?? {}, text: s.why ?? ASK_STEPS[action]! });
        continue;
      }
      if (!PLANNER_ACTIONS.includes(action)) {
        dropped.push(s.action);
        continue;
      }
      let def;
      try {
        def = getAction(action);
      } catch {
        dropped.push(s.action);
        continue;
      }
      if (!def.input.safeParse(s.input ?? {}).success) {
        dropped.push(s.action);
        continue;
      }
      steps.push({ action, input: s.input ?? {}, text: s.why ? capitalize(s.why) : def.title, why: s.why });
    }
    return { steps, reply: j.reply, unknown: dropped.length && !steps.length ? [message] : [], costUsd: r.costUsd, planner: "model" };
  } catch {
    return null;
  }
}

async function understand(ctx: Ctx, message: string, context: AskContext, history: AskMessage[]): Promise<Plan> {
  const fromModel = await modelPlan(ctx, message, context, history);
  // The rules still run when the model plan is empty, so common requests never dead-end.
  if (fromModel && (fromModel.steps.length || fromModel.reply)) return fromModel;
  const parsed = parseIntent(ctx, message, context);
  return { steps: parsed.steps, unknown: parsed.unknown, costUsd: fromModel ? 0 : 0, planner: "rules" };
}

// ---------- Executing ----------

interface StepOutcome {
  status: "pending" | "running" | "done" | "failed";
  cards: Card[];
  text?: string;
  proposed?: boolean;
  applied?: boolean;
  background?: boolean;
  costUsd?: number;
  minutes?: number;
  slot?: string;
}

function withExtras(action: string, input: Record<string, unknown>, extras: Record<string, unknown>): Record<string, unknown> {
  try {
    const def = getAction(action);
    const next = { ...input, ...Object.fromEntries(Object.entries(extras).filter(([k]) => !(k in input))) };
    return def.input.safeParse(next).success ? next : input;
  } catch {
    return input;
  }
}

async function cardsFor(ctx: Ctx, r: InvokeResult | null | undefined): Promise<{ cards: Card[]; proposed: boolean; applied: boolean }> {
  if (!r) return { cards: [], proposed: false, applied: false };
  if (r.status === "proposed") {
    const card = await proposalCard(ctx, r.proposalId);
    return { cards: card ? [card] : [], proposed: true, applied: false };
  }
  if (r.status === "applied") {
    const card = appliedCard(ctx.db, r.actionId);
    return { cards: card ? [card] : [], proposed: false, applied: true };
  }
  return { cards: [], proposed: false, applied: false };
}

const SHORT_DATE = (iso: string | null) => (iso ? new Date(iso).toUTCString().slice(0, 11) : "");

function entryHref(e: { id: string; status: string; path?: string; slug?: string }) {
  return e.status === "published" ? `/live?path=${e.path ?? `/${e.slug}/`}` : `/drafts/${e.id}`;
}

/** Plain-words summary of a read action's result. */
async function summarizeRead(ctx: Ctx, action: string, result: any): Promise<{ text: string; cards: Card[] }> {
  switch (action) {
    case "settings.show":
      return { text: "Here are your settings. Say any of them differently to change it.", cards: [{ type: "settings", sentences: result.sentences }] };
    case "autonomy.status": {
      const trust = result.trust as { label: string; clean: number; threshold: number; earned: boolean }[];
      const earned = trust.filter((t) => t.earned).map((t) => t.label.toLowerCase());
      const next = trust.filter((t) => !t.earned).sort((a, b) => b.clean / b.threshold - a.clean / a.threshold)[0];
      const text = `${result.askMeFirst ? "Ask me first is on, so I ask before every change. " : ""}${earned.length ? `I handle ${earned.join(", ")} on my own.` : "I haven't earned any work on my own yet."}${next ? ` Next up: ${next.label.toLowerCase()} (${next.clean} of ${next.threshold} clean approvals).` : ""}`;
      return { text, cards: [{ type: "results", title: "Trust earned so far", items: trust.map((t) => ({ title: t.label, subtitle: t.earned ? "Handled on its own" : `${t.clean} of ${t.threshold} clean approvals`, kind: "trust" })) }] };
    }
    case "posts.list": {
      const items = (result as any[]).slice(0, 12);
      if (!items.length) return { text: "Nothing matches that yet.", cards: [] };
      const count = (result as any[]).length;
      return {
        text: `${count === 1 ? "1 match" : `${count} matches`}.`,
        cards: [{ type: "results", title: capitalize(`${count} ${items[0].type === "page" ? "pages" : "posts"}`), items: items.map((e) => ({ title: e.title, subtitle: `${capitalize(e.status)}${e.publishAt ? `, ${SHORT_DATE(e.publishAt)}` : e.publishedAt ? `, ${SHORT_DATE(e.publishedAt)}` : ""}`, href: entryHref(e), kind: e.type })) }],
      };
    }
    case "today.get":
      return summarizeToday(ctx, result, "waiting");
    case "look.describe":
      return { text: "Here are three directions. Pick one to preview it; nothing changes on the live site until you approve.", cards: [{ type: "looks", options: result.options }] };
    case "authors.sample":
      return { text: `Default: ${result.default}\n\n${result.authorName} (voice match ${result.voiceMatch}): ${result.author}`, cards: [] };
    case "authors.list":
      return { text: `${result.length} author${result.length === 1 ? "" : "s"}.`, cards: [{ type: "results", title: "Authors", items: result.map((a: any) => ({ title: a.name, subtitle: a.isPersona ? "Persona" : a.expertise?.join(", ") || "Author", href: `/authors/${a.slug}`, kind: "author" })) }] };
    case "brain.search":
      return { text: result.length ? `Site Brain has ${result.length} matching ${result.length === 1 ? "entry" : "entries"}.` : "Site Brain has nothing on that yet.", cards: result.length ? [{ type: "results", title: "Site Brain", items: result.slice(0, 10).map((b: any) => ({ title: b.text, subtitle: b.kind.replace("_", " "), kind: "brain" })) }] : [] };
    case "history.list":
      return { text: "Here's what changed recently.", cards: [{ type: "results", title: "Recent changes", items: result.slice(0, 10).map((a: any) => ({ title: a.summary, subtitle: `${a.by}${a.auto ? ", on its own" : ""}, ${SHORT_DATE(a.createdAt)}${a.status === "undone" ? " (undone)" : ""}`, kind: "change" })) }] };
    case "runs.list":
      return { text: result.length ? "Here's what the team is working on." : "No jobs yet.", cards: result.length ? [{ type: "results", title: "Jobs", items: result.map((r: any) => ({ title: r.label, subtitle: r.status, kind: "run" })) }] : [] };
    case "proposals.list": {
      const cards = (await Promise.all((result as any[]).slice(0, 6).map((p) => proposalCard(ctx, p.id)))).filter(Boolean) as Card[];
      return { text: cards.length ? `${cards.length} waiting for you.` : "Nothing is waiting for you.", cards };
    }
    default: {
      const arr = Array.isArray(result) ? result : null;
      if (arr) return { text: `Found ${arr.length}.`, cards: [{ type: "results", title: "Results", items: arr.slice(0, 10).map((x: any) => ({ title: String(x.title ?? x.name ?? x.label ?? x.id ?? ""), subtitle: x.status ?? x.kind, kind: "item" })) }] };
      return { text: "Here it is.", cards: [] };
    }
  }
}

async function summarizeToday(ctx: Ctx, t: any, mode: "waiting" | "done"): Promise<{ text: string; cards: Card[] }> {
  if (mode === "done") {
    const done = (t.doneOnItsOwn as any[]) ?? [];
    const runs = ctx.db.query<{ id: string; plan: string; status: string; created_at: string }, [string, string]>("SELECT id, plan, status, created_at FROM agent_runs WHERE site_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 10").all(ctx.siteId!, new Date(Date.now() - 7 * 86_400_000).toISOString());
    const items = [
      ...done.slice(0, 8).map((a) => ({ title: a.summary, subtitle: `${a.auto ? "On its own" : "Done"}, ${SHORT_DATE(a.createdAt)}${a.status === "undone" ? " (undone)" : ""}`, kind: "change" })),
      ...runs.filter((r) => JSON.parse(r.plan).kind !== "ask").map((r) => ({ title: JSON.parse(r.plan).label as string, subtitle: `${capitalize(r.status)}, ${SHORT_DATE(r.created_at)}`, kind: "run" })),
    ];
    const text = items.length ? `This week I ${done.length ? `made ${done.length} change${done.length === 1 ? "" : "s"} on my own` : "made no changes on my own"}${runs.length ? ` and worked on ${runs.length} job${runs.length === 1 ? "" : "s"}` : ""}. Spent $${t.spend.thisMonthUsd.toFixed(2)} of $${t.spend.budgetUsd} this month.` : "Quiet week: nothing done on my own yet.";
    return { text, cards: items.length ? [{ type: "results", title: "What the team did", items }] : [] };
  }
  const pending = (t.pending as any[]) ?? [];
  if (!pending.length) return { text: `Nothing is waiting for you. Spent $${t.spend.thisMonthUsd.toFixed(2)} of $${t.spend.budgetUsd} this month.`, cards: [] };
  const cards = (await Promise.all(pending.slice(0, 5).map((p) => proposalCard(ctx, p.id)))).filter(Boolean) as Card[];
  const text = `${pending.length === 1 ? "1 thing is" : `${pending.length} things are`} waiting for you${pending.length > 5 ? "; here are the first 5" : ""}.`;
  return { text, cards: pending.length > 5 ? [...cards, { type: "navigate", to: "/today", label: "See all on Today" }] : cards };
}

async function runStep(ctx: Ctx, agent: Ctx, step: PlanStep, extras: { groupId: string; conversationId: string }): Promise<StepOutcome> {
  try {
    switch (step.action) {
      case "ask.reply":
        return { status: "done", cards: [], text: String(step.input.text ?? "") };
      case "ask.help": {
        const h = helpAnswer(String(step.input.question ?? ""));
        if (!h) return { status: "done", cards: [], text: "I don't have a help page for that yet. Tell me what you're trying to do and I'll do it, or show you where it lives." };
        return { status: "done", cards: h.navigate ? [{ type: "navigate", ...h.navigate }] : [], text: [h.answer, h.offer].filter(Boolean).join(" ") };
      }
      case "ask.navigate":
        return { status: "done", cards: [{ type: "navigate", to: String(step.input.to ?? "/today"), label: String(step.input.label ?? "Open") }], text: "" };
      case "ask.undo": {
        const r = ctx.db.query<{ id: string }, [string]>("SELECT id FROM actions WHERE site_id = ? AND status = 'applied' AND undo IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(ctx.siteId!);
        const card = r ? appliedCard(ctx.db, r.id) : null;
        if (!card) return { status: "done", cards: [], text: "There's nothing to undo right now." };
        return { status: "done", cards: [card], text: "Here's the last change. Tap Undo to reverse it." };
      }
      case "ask.approve": {
        const rows = ctx.db.query<{ id: string }, [string]>("SELECT id FROM proposals WHERE site_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 6").all(ctx.siteId!);
        const cards = (await Promise.all(rows.map((r) => proposalCard(ctx, r.id)))).filter(Boolean) as Card[];
        return { status: "done", cards, text: cards.length ? "Here's what's waiting. Tap Approve on each one you're happy with." : "Nothing is waiting for approval." };
      }
      case "ask.waiting":
      case "ask.done": {
        const r = await invoke(agent, "today.get", {});
        const s = await summarizeToday(ctx, (r as any).result, step.action === "ask.done" ? "done" : "waiting");
        return { status: "done", ...s };
      }
      case "ask.ask_me_first": {
        // Turning it on only makes the site more careful, so a person saying it is enough.
        await invoke(ctx, "autonomy.ask_me_first", { on: true });
        return { status: "done", cards: [], text: "Done. I'll ask before every change, even work I've earned. Say “stop asking me first” when you want me back on my own." };
      }
      case "ask.stop_asking":
        return {
          status: "done",
          cards: [{ type: "navigate", to: "/settings", label: "Open Settings" }],
          text: "That one's yours to flip: turn off Ask me first in Settings, and the work I've earned will happen on its own again.",
        };
    }

    const input = withExtras(step.action, step.input, extras);
    const r = await invoke(agent, step.action, input, { groupId: extras.groupId });
    if (r.status === "done") {
      const s = await summarizeRead(ctx, step.action, r.result);
      return { status: "done", ...s };
    }
    if (r.status === "applied") {
      const res = r.result as Delegated & { runId?: string; label?: string; estimateUsd?: number };
      if (step.action === "posts.write" && res?.runId) {
        const at = typeof input.schedule === "string" && !["next_slot", "none"].includes(input.schedule) ? input.schedule : undefined;
        return { status: "running", background: true, cards: [{ type: "progress", runId: res.runId, label: `Drafting “${res.label?.split(", as ")[0] ?? input.topic}”`, status: "queued" }], costUsd: res.estimateUsd ?? 0, minutes: modelFor(ctx).offline ? 1 : 2, slot: at };
      }
      if (res && ("delegated" in res || "message" in res)) {
        const nested = await cardsFor(ctx, res.delegated ?? null);
        const cards = [...nested.cards, ...(res.navigate ? [{ type: "navigate" as const, ...res.navigate }] : [])];
        return { status: nested.proposed ? "pending" : "done", cards, text: res.message, proposed: nested.proposed, applied: nested.applied };
      }
      const c = await cardsFor(ctx, r);
      return { status: "done", ...c };
    }
    if (r.status === "proposed") {
      const c = await cardsFor(ctx, r);
      return { status: "pending", ...c };
    }
    return { status: "done", cards: [] };
  } catch (err) {
    const message = err instanceof TqError ? err.message : "That step didn't work. Nothing was changed.";
    if (!(err instanceof TqError)) console.error("[tidequill] ask step failed:", err);
    return { status: "failed", cards: [{ type: "error", message }], text: undefined };
  }
}

export interface AskResult {
  conversationId: string;
  messages: AskMessage[];
}

export async function ask(ctx: Ctx, body: z.infer<typeof askBody>): Promise<AskResult> {
  const userId = userIdOf(ctx.actor);
  if (!userId) throw new TqError("unauthorized", "Sign in first.");
  let conversationId = body.conversationId;
  if (conversationId) {
    const conv = conversationOf(ctx.db, conversationId);
    if (!conv || conv.userId !== userId) throw notFound("That conversation");
    if (conv.siteId && ctx.siteId && conv.siteId !== ctx.siteId) throw new TqError("conflict", "That conversation belongs to another site. Start a new one here.");
  } else conversationId = createConversation(ctx.db, ctx.siteId, userId);

  const history = await listMessages(ctx, conversationId);
  const userMsg = addMessage(ctx.db, conversationId, "user", body.message);
  if (!ctx.siteId) {
    const m = addMessage(ctx.db, conversationId, "assistant", "Pick a site first, then ask me anything about it.");
    return { conversationId, messages: [userMsg, m] };
  }
  const context: AskContext = body.context ?? {};
  const plan = await understand(ctx, body.message, context, history);
  const reply = await execute(ctx, plan, body.message, conversationId);
  const assistant = addMessage(ctx.db, conversationId, "assistant", reply.text, reply.cards);
  return { conversationId, messages: [userMsg, assistant] };
}

async function execute(ctx: Ctx, plan: Plan, message: string, conversationId: string): Promise<{ text: string; cards: Card[] }> {
  if (!plan.steps.length) {
    if (plan.reply) return { text: plan.reply, cards: [] };
    return {
      text: `I'm not sure how to do that yet. You could try: ${SUGGESTIONS.slice(0, 3).map((s) => `“${s}”`).join(", ")}. Or ask “how do I…” and I'll explain.`,
      cards: [],
    };
  }
  const groupId = id("grp");
  const writes = plan.steps.filter((s) => !s.action.startsWith("ask.") && isWrite(s.action));
  const costly = plan.steps.filter((s) => isCostly(s.action));
  // A run records the plan itself (its steps link to proposals and drafting jobs).
  const runId = writes.length || plan.costUsd ? createRun(ctx, { request: message, label: clip(message, 80), kind: "ask", outline: plan.steps.map((s) => s.text), groupId, conversationId, status: "running", source: "ask" }) : undefined;
  const rec = runId ? new RunRecorder(ctx.db, runId) : null;
  if (rec && plan.costUsd) ctx.db.query("UPDATE agent_runs SET cost_usd = cost_usd + ? WHERE id = ?").run(plan.costUsd, runId!);

  const outcomes: StepOutcome[] = [];
  for (const step of plan.steps) {
    const agent: Ctx = { ...ctx, actor: { kind: "agent", role: roleFor(step.action), onBehalfOf: userIdOf(ctx.actor), runId }, runId };
    const run = () => runStep(ctx, agent, step, { groupId, conversationId });
    const o = rec ? await rec.step(step.text, run, (x) => x.text ?? x.status).catch(() => ({ status: "failed" as const, cards: [] })) : await run();
    outcomes.push(o);
  }
  if (runId) setRunStatus(ctx.db, runId, outcomes.some((o) => o.status === "failed") && outcomes.every((o) => o.status === "failed") ? "failed" : "done");

  const cards: Card[] = [];
  const texts: string[] = [];
  const showPlan = plan.steps.length > 1 || costly.length > 0;
  if (showPlan) {
    const planSteps = plan.steps.map((s, i) => ({ text: s.text, status: outcomes[i]!.status }));
    const slots = outcomes.map((o) => o.slot).filter(Boolean) as string[];
    if (slots.length > 1) planSteps.push({ text: `Schedule them ${slotsSentence(slots)}, after you approve each draft.`, status: "pending" });
    const cost = outcomes.reduce((a, o) => a + (o.costUsd ?? 0), plan.costUsd);
    const minutes = Math.max(1, Math.ceil(outcomes.reduce((a, o) => a + (o.minutes ?? 0), 0)));
    cards.push({ type: "plan", title: `Plan, ${planSteps.length} step${planSteps.length === 1 ? "" : "s"}`, steps: planSteps, costUsd: Math.round(cost * 1000) / 1000, minutes, runId, groupId });
  }
  for (const o of outcomes) cards.push(...o.cards);

  const proposed = outcomes.filter((o) => o.proposed || (o.status === "pending" && o.cards.some((c) => c.type === "proposal"))).length;
  const background = outcomes.filter((o) => o.background).length;
  const failed = outcomes.filter((o) => o.status === "failed");
  const changed = outcomes.filter((o) => o.applied).length;
  if (plan.reply && plan.planner === "model") texts.push(plan.reply);
  else if (proposed || background) {
    texts.push("Here's the plan. Nothing changes on the live site until you approve.");
    if (background) texts.push(background === 1 ? "I'll tell you here when the draft is ready." : `I'll tell you here when the ${background} drafts are ready.`);
  } else if (changed && !failed.length && outcomes.every((o) => !o.text)) {
    texts.push(plan.steps.some((s) => s.action === "brain.add") ? "Done. I'll remember that." : "Done.");
  }
  for (const o of outcomes) if (o.text) texts.push(o.text);
  if (failed.length && !texts.length) texts.push(failed.length === outcomes.length ? "I couldn't do that. Here's why:" : "Most of that is done; one step didn't work:");
  if (plan.unknown.length) texts.push(`I didn't catch “${clip(plan.unknown[0]!, 80)}”. Say it another way and I'll add it.`);
  return { text: texts.join(" ").trim() || "Done.", cards };
}

function isCostly(action: string): boolean {
  try {
    return getAction(action).risk === "costly";
  } catch {
    return false;
  }
}

function isWrite(action: string): boolean {
  try {
    const def = getAction(action);
    return def.risk !== "read" && def.risk !== "command";
  } catch {
    return false;
  }
}

export async function conversation(ctx: Ctx, conversationId: string): Promise<AskResult> {
  const userId = userIdOf(ctx.actor);
  const conv = conversationOf(ctx.db, conversationId);
  if (!conv || conv.userId !== userId) throw notFound("That conversation");
  return { conversationId, messages: await listMessages(ctx, conversationId) };
}
