import { z } from "zod";
import type { Block } from "../content/blocks.ts";
import { blockToMarkdown, toMarkdown } from "../content/markdown.ts";
import { findAuthor, getAuthor, listAuthors, type Author } from "../core/authors.ts";
import { getEntry } from "../core/entries.ts";
import { TqError, invalid } from "../core/errors.ts";
import { id, slugify } from "../core/ids.ts";
import { enqueue } from "../core/jobs.ts";
import { defineAction, invoke, type DiffItem, type InvokeResult } from "../core/registry.ts";
import { getSite } from "../core/sites.ts";
import type { Ctx } from "../core/types.ts";
import { defaultVoice, type Voice } from "../core/voice.ts";
import { seoPass } from "./checks.ts";
import { allFacts, brainFor, evidenceFor, isStale } from "./knowledge.ts";
import { describeLook, effectiveTokens } from "./look.ts";
import { estimateCall, modelFor, parseJson } from "./model.ts";
import { invokeOptional } from "./optional.ts";
import { PIPELINE_STEPS, WRITE_JOB, type WriteInput } from "./pipeline.ts";
import { refreshPrompt, rewriteBlockPrompt, samplePrompt, TEAM_VOICE, voiceBrief, voicePrompt } from "./prompts.ts";
import { agentCtx, assertBudget, createRun, getRun, RunRecorder, setRunStatus, updatePlan, userIdOf } from "./runs.ts";
import { capitalize, clip, humanize, sentences, tellsIn, wordCountOf } from "./text.ts";
import { adjustVoice, defaultParagraph, learnVoice, voiceMatch, voiceParagraph } from "./voiceprint.ts";
import { fitAnswer, shapeSentences } from "./writer.ts";
import { brainSummary } from "./knowledge.ts";

/**
 * Agent actions. Each one does its thinking in `apply` (which may spend model
 * budget, hence risk "costly") and then acts on the site through `invoke` as an
 * agent on behalf of the person who asked, so drafts apply quietly and anything
 * a reader would see becomes a proposal until trust is earned.
 */

const money = (n: number) => `$${n.toFixed(2)}`;

/** Rough model cost of one post through the pipeline (0 offline). */
export function estimateWrite(ctx: Ctx): number {
  return Math.round((estimateCall(ctx, "frontier", 4000, 1500) + estimateCall(ctx, "frontier", 7000, 4500) + estimateCall(ctx, "fast", 6000, 600) + 0.5 * estimateCall(ctx, "frontier", 6000, 4000)) * 100) / 100;
}

function resolveAuthor(ctx: Ctx, key: string | undefined): Author | null {
  if (key) {
    const a = findAuthor(ctx.db, ctx.siteId!, key);
    if (!a) throw invalid(`There's no author called “${key}” on this site. Add them first, or write as one of: ${listAuthors(ctx.db, ctx.siteId!).map((x) => x.name).join(", ") || "nobody yet"}.`);
    return a;
  }
  // Default byline: the person asking, if they are an author; else the first author.
  const userId = userIdOf(ctx.actor);
  const authors = listAuthors(ctx.db, ctx.siteId!);
  return authors.find((a) => a.userId && a.userId === userId) ?? authors[0] ?? null;
}

function resolveCategoryId(ctx: Ctx, key: string | undefined): string | null {
  if (!key) return null;
  const r = ctx.db.query<{ id: string }, [string, string, string, string]>("SELECT id FROM categories WHERE site_id = ? AND deleted_at IS NULL AND (id = ? OR slug = ? OR lower(name) = lower(?))").get(ctx.siteId!, key, slugify(key), key);
  if (!r) throw invalid(`There's no category called “${key}”. Ask me to add it first.`);
  return r.id;
}

/** Agent actions return what they did on the site so Ask can show the right card. */
export interface Delegated {
  runId?: string;
  delegated?: InvokeResult | null;
  message?: string;
  navigate?: { to: string; label: string };
  [k: string]: unknown;
}

// ---------- posts.write ----------

const scheduleSchema = z
  .string()
  .refine((s) => s === "next_slot" || s === "none" || !Number.isNaN(Date.parse(s)), "Use “next_slot”, “none” or a date and time")
  .optional()
  .describe('"next_slot" (default): the next free publishing slot; an ISO date-time; or "none" to leave it as a draft');

defineAction({
  name: "posts.write",
  title: "Write a post",
  description:
    "Has the editorial team research and write a post in an author's voice (Site Brain, facts and the author's evidence), then save it as a draft and propose scheduling it. Runs in the background and returns a runId. Undo cancels the job if it hasn't started; a finished draft is discarded from Today instead.",
  permission: "write",
  risk: "costly",
  trust: "new_post",
  input: z.object({
    topic: z.string().min(2).max(300).describe("What the post is about, or its working title"),
    title: z.string().max(120).optional().describe("Use exactly this title"),
    author: z.string().optional().describe("Author id, slug or name; defaults to you or the first author"),
    category: z.string().optional(),
    notes: z.string().max(2000).optional().describe("Anything the writer should know"),
    schedule: scheduleSchema,
    idea: z.string().optional().describe("The Site Brain idea id this post comes from"),
    groupId: z.string().optional().describe("Groups the resulting proposals with an Ask plan"),
    conversationId: z.string().optional(),
    source: z.enum(["ask", "autopilot", "setup", "api"]).optional(),
  }),
  prepare(ctx, input) {
    const author = resolveAuthor(ctx, input.author);
    const categoryId = resolveCategoryId(ctx, input.category);
    const estimate = estimateWrite(ctx);
    assertBudget(ctx.db, ctx.siteId!, estimate);
    const label = `${input.title ?? capitalize(input.topic)}${author ? `, as ${author.name}` : ""}`;
    const write: WriteInput = { topic: input.topic, title: input.title, authorId: author?.id ?? null, categoryId, notes: input.notes, schedule: input.schedule ?? "next_slot", groupId: input.groupId, ideaId: input.idea };
    return {
      summary: `Write “${input.title ?? capitalize(input.topic)}”${author ? ` as ${author.name}` : ""}${estimate ? ` (about ${money(estimate)})` : ""}`,
      detail: "The draft waits for you on Today. Nothing goes live until you approve it.",
      invisible: true,
      payload: { runId: id("run"), label, write, conversationId: input.conversationId, source: input.source ?? (input.conversationId ? "ask" : "api"), estimate },
    };
  },
  apply(ctx, p: { runId: string; label: string; write: WriteInput; conversationId?: string; source: string; estimate: number }) {
    createRun(ctx, { runId: p.runId, request: `Write a post: ${p.write.title ?? p.write.topic}`, label: p.label, kind: "write", outline: PIPELINE_STEPS, input: p.write, groupId: p.write.groupId, conversationId: p.conversationId, source: p.source });
    enqueue(ctx.db, WRITE_JOB, ctx.siteId!, { runId: p.runId });
    return { result: { runId: p.runId, label: p.label, estimateUsd: p.estimate }, undo: { runId: p.runId } };
  },
  undo(ctx, u: { runId: string }) {
    const run = getRun(ctx.db, u.runId);
    if (run.status === "queued") setRunStatus(ctx.db, u.runId, "failed", "Cancelled before it started.");
  },
});

// ---------- posts.rewrite_block ----------

const PLAIN: [RegExp, string][] = [
  [/\butili[sz]e\b/gi, "use"],
  [/\bapproximately\b/gi, "about"],
  [/\bpurchase\b/gi, "buy"],
  [/\badditional\b/gi, "extra"],
  [/\bnumerous\b/gi, "many"],
  [/\bindividuals\b/gi, "people"],
  [/\bdemonstrate\b/gi, "show"],
  [/\bsufficient\b/gi, "enough"],
  [/\bprior to\b/gi, "before"],
  [/\bin order to\b/gi, "to"],
  [/\bcommence\b/gi, "start"],
  [/\bensure\b/gi, "make sure"],
];
const CONTRACT: [RegExp, string][] = [
  [/\bdo not\b/g, "don't"],
  [/\bit is\b/g, "it's"],
  [/\byou are\b/g, "you're"],
  [/\bcannot\b/g, "can't"],
  [/\bthat is\b/g, "that's"],
  [/\bwe are\b/g, "we're"],
];
const EXPAND: [RegExp, string][] = [
  [/\bdon't\b/g, "do not"],
  [/\bit's\b/g, "it is"],
  [/\byou're\b/g, "you are"],
  [/\bcan't\b/g, "cannot"],
  [/\bthat's\b/g, "that is"],
  [/\bwe're\b/g, "we are"],
];

/** Offline rewrite of one text field by instruction. */
export function rewriteText(text: string, instruction: string, voice: Voice, opts: { isAnswer?: boolean; extra?: string[]; firstPerson?: boolean } = {}): string {
  const ins = instruction.toLowerCase();
  let out = text;
  if (/\b(short|shorter|tighten|tighter|trim|concise|cut|briefer)\b/.test(ins)) {
    const ss = sentences(out);
    const keep = Math.max(1, Math.ceil(ss.length / 2));
    out = ss.slice(0, keep).join(" ");
    if (opts.isAnswer && wordCountOf(out) < 40) out = fitAnswer(ss.slice(0, keep), ss.slice(keep));
  }
  if (/\b(longer|expand|more detail|elaborate|flesh)\b/.test(ins) && opts.extra?.length) out = `${out} ${opts.extra.slice(0, 2).join(" ")}`;
  if (/\b(simpler|plainer|easier|plain english|less jargon)\b/.test(ins)) {
    for (const [re, rep] of PLAIN) out = out.replace(re, rep);
    out = shapeSentences(out, 11);
  }
  if (/\b(more formal|professional)\b/.test(ins)) for (const [re, rep] of EXPAND) out = out.replace(re, rep);
  if (/\b(casual|friendlier|relaxed|less formal|conversational)\b/.test(ins)) for (const [re, rep] of CONTRACT) out = out.replace(re, rep);
  if (/\b(funn(y|ier)|humou?r|joke|lighter)\b/.test(ins) && !/\bless\b/.test(ins)) out = `${out} ${opts.firstPerson ? "(Ask me how I know.)" : "(Future you will be grateful.)"}`;
  if (/\bless (jok|funny|humou?r)/.test(ins)) out = out.replace(/\s*\([^)]{3,80}\)/g, "");
  if (opts.firstPerson && /\b(as|in) \w+'?s? voice|\brewrite as\b/.test(ins)) out = out.replace(/\bWe\b/g, "I").replace(/\bwe\b/g, "I").replace(/\bOur\b/g, "My").replace(/\bour\b/g, "my").replace(/\bus\b/g, "me");
  out = shapeSentences(out, voice.sentenceLength.avgWords ?? 15);
  return humanize(out, voice.banned).trim();
}

function rewriteBlockOffline(b: Block, instruction: string, voice: Voice, extra: string[], firstPerson: boolean): Block {
  const f = (t: string, isAnswer = false) => rewriteText(t, instruction, voice, { extra, firstPerson, isAnswer });
  switch (b.type) {
    case "paragraph":
    case "callout":
      return { ...b, text: f(b.text) };
    case "answer":
      return { ...b, text: f(b.text, true) };
    case "heading":
      return /\bshort/.test(instruction.toLowerCase()) ? { ...b, text: clip(b.text, 50) } : b;
    case "list":
      return { ...b, items: /\bshort/.test(instruction.toLowerCase()) ? b.items.slice(0, Math.max(2, Math.ceil(b.items.length * 0.6))).map((i) => f(i)) : b.items.map((i) => f(i)) };
    case "faq":
      return { ...b, items: b.items.map((i) => ({ q: i.q, a: f(i.a) })) };
    case "quote":
      return b; // quotes keep the speaker's words
    default:
      return b;
  }
}

defineAction({
  name: "posts.rewrite_block",
  title: "Rewrite one section",
  description:
    'Rewrites one section of a post by instruction ("Shorter", "Rewrite as Fred", "Simpler", "Add a photo" to place the author\'s evidence), then saves it through posts.update_block: applied on drafts, a proposal with a diff on live posts. Not undoable itself; undo or discard the edit it makes.',
  permission: "write",
  risk: "costly",
  trust: "refresh",
  input: z.object({ id: z.string(), blockId: z.string(), instruction: z.string().min(2).max(500), groupId: z.string().optional() }),
  prepare(ctx, input) {
    const e = getEntry(ctx.db, ctx.siteId!, input.id);
    if (!e.body.blocks.some((b) => b.id === input.blockId)) throw invalid("That section isn't in this post any more. Reload the page and try again.");
    assertBudget(ctx.db, ctx.siteId!, estimateCall(ctx, "frontier", 3000, 800));
    return { summary: `Rewrite a section of “${e.title}”: ${input.instruction}`, entryId: e.id, invisible: true, payload: input };
  },
  async apply(ctx, p: { id: string; blockId: string; instruction: string; groupId?: string }): Promise<{ result: Delegated; undo: null }> {
    const e = getEntry(ctx.db, ctx.siteId!, p.id);
    const block = e.body.blocks.find((b) => b.id === p.blockId)!;
    const runId = createRun(ctx, { request: `${p.instruction} (section of “${e.title}”)`, label: `Rewrite a section of “${e.title}”`, kind: "rewrite", outline: ["Rewrite", "Proposal"], status: "running", groupId: p.groupId });
    const run = getRun(ctx.db, runId);
    const rec = new RunRecorder(ctx.db, runId);
    const actx = agentCtx(ctx, run, "writer");
    const named = p.instruction.match(/\b(?:as|in)\s+([A-Z][\w'-]+)(?:'s)?(?:\s+voice)?\b/i)?.[1];
    const author = (named && findAuthor(ctx.db, ctx.siteId!, named.replace(/'s$/i, ""))) || (e.authorIds[0] ? findAuthor(ctx.db, ctx.siteId!, e.authorIds[0]) : null);
    const voice = author?.voice ?? defaultVoice();
    const firstPerson = !!author && !author.isPersona && voice.person === "I";
    try {
      // "Add a photo": suggest the author's own evidence for this post.
      if (/\b(photo|picture|image|evidence)\b/i.test(p.instruction)) {
        const ev = evidenceFor(ctx.db, ctx.siteId!, `${e.title} ${blockToMarkdown(block)}`, author?.id, 10).find((x) => x.mediaId && !JSON.stringify(e.body).includes(x.id));
        if (!ev) {
          setRunStatus(ctx.db, runId, "done");
          return { result: { runId, delegated: null, message: "There's no photo for this post yet. Snap one from Capture on your phone and I'll place it here.", navigate: { to: "/capture", label: "Open Capture" } }, undo: null };
        }
        const md = `${blockToMarkdown(block)}\n\n:::evidence{id=${ev.id} kind=${ev.kind} media=${ev.mediaId}}\n${ev.text.trim() || (author ? `Photo by ${author.name}.` : "Photo from the site's tests.")}\n:::`;
        const delegated = await rec.step("Proposal", () => invoke(actx, "posts.update_block", { id: e.id, blockId: block.id, markdown: md, reason: "Adds the author's photo to this section", substantive: true }, { groupId: p.groupId }), (r) => r.status);
        setRunStatus(ctx.db, runId, "done");
        return { result: { runId, delegated }, undo: null };
      }
      const client = rec.client(modelFor(ctx));
      const newMd = await rec.step(
        "Rewrite",
        async () => {
          const extra = brainFor(ctx.db, ctx.siteId!, e.title, 6)
            .filter((b) => b.kind === "fact" || b.kind === "position")
            .map((b) => b.text.replace(/[.]?$/, "."));
          if (client.offline) return blockToMarkdown(rewriteBlockOffline(block, p.instruction, voice, extra, firstPerson));
          const ctxText = toMarkdown({ v: 1, blocks: e.body.blocks.filter((b) => b.id !== block.id).slice(0, 12) });
          const site = getSite(ctx.db, ctx.siteId!);
          const r = await client.complete({
            tier: "frontier",
            cachePrefix: `${TEAM_VOICE}\n\n${brainSummary(ctx.db, site)}`,
            maxTokens: 2000,
            messages: [{ role: "user", content: rewriteBlockPrompt({ block: blockToMarkdown(block), instruction: p.instruction, voice: author ? voiceBrief(author) : "", context: ctxText }) }],
          });
          const text = r.text.replace(/^```(?:markdown|md)?\s*/i, "").replace(/```\s*$/, "").trim();
          return text || blockToMarkdown(rewriteBlockOffline(block, p.instruction, voice, extra, firstPerson));
        },
        (md) => `${wordCountOf(blockToMarkdown(block))} → ${wordCountOf(md)} words.`,
      );
      const delegated = await rec.step("Proposal", () => invoke(actx, "posts.update_block", { id: e.id, blockId: block.id, markdown: newMd, reason: `${capitalize(p.instruction)} (one section)` }, { groupId: p.groupId }), (r) => (r.status === "proposed" ? "Waiting for your approval." : "Saved to the draft."));
      setRunStatus(ctx.db, runId, "done");
      return { result: { runId, delegated, markdown: newMd }, undo: null };
    } catch (err) {
      setRunStatus(ctx.db, runId, "failed", (err as Error).message);
      throw err;
    }
  },
});

// ---------- posts.refresh ----------

const YEAR_CONTEXT = /\b((?:in|for|of|best|top|updated|as of)\s+)(20\d\d)\b|\b(20\d\d)(\s+(?:guide|update|edition|picks|review|buyer'?s guide))\b|\((20\d\d)\)/gi;

/** Offline refresh: current years, tightened answers, AI tells. Returns the new markdown, title and reasons. */
export function refreshOffline(title: string, markdown: string, banned: string[], year = new Date().getUTCFullYear()): { title: string; markdown: string; reasons: string[] } {
  let years = 0;
  const bump = (s: string) =>
    s.replace(YEAR_CONTEXT, (m, pre, y1, y2, post, y3) => {
      const y = Number(y1 ?? y2 ?? y3);
      if (!y || y >= year) return m;
      years++;
      if (y1) return `${pre}${year}`;
      if (y2) return `${year}${post}`;
      return `(${year})`;
    });
  const newTitle = bump(title);
  let md = bump(markdown);
  const reasons: string[] = [];
  if (years) reasons.push(`updated ${years} year reference${years === 1 ? "" : "s"} to ${year}`);
  const seo = seoPass(newTitle, "x", md);
  const answerFixes = seo.fixes.filter((f) => /answer/i.test(f));
  if (answerFixes.length) {
    md = seo.markdown;
    reasons.push(`${answerFixes.length === 1 ? "tightened 1 answer" : `tightened ${answerFixes.length} answers`} for search and AI answers`);
  }
  const tells = tellsIn(md, banned);
  if (tells.length) {
    md = humanize(md, banned);
    reasons.push(`rewrote ${tells.length} stock phrase${tells.length === 1 ? "" : "s"}`);
  }
  return { title: seo.title, markdown: md, reasons };
}

defineAction({
  name: "posts.refresh",
  title: "Refresh an old post",
  description: "Runs a refresh pass on a post (dated years, stale facts, answer blocks, stock phrases, your notes) and proposes only the changed sections with a one-line reason. Says so when nothing needs changing. Not undoable itself; discard or undo the edit it proposes.",
  permission: "write",
  risk: "costly",
  trust: "refresh",
  input: z.object({ id: z.string(), notes: z.string().max(2000).optional(), groupId: z.string().optional() }),
  prepare(ctx, input) {
    const e = getEntry(ctx.db, ctx.siteId!, input.id);
    assertBudget(ctx.db, ctx.siteId!, estimateCall(ctx, "frontier", 8000, 4000));
    return { summary: `Refresh “${e.title}”`, entryId: e.id, invisible: true, payload: input };
  },
  async apply(ctx, p: { id: string; notes?: string; groupId?: string }): Promise<{ result: Delegated; undo: null }> {
    const e = getEntry(ctx.db, ctx.siteId!, p.id);
    const runId = createRun(ctx, { request: `Refresh “${e.title}”${p.notes ? `: ${p.notes}` : ""}`, label: `Refresh “${e.title}”`, kind: "refresh", outline: ["Research", "Refresh", "Proposal"], input: { id: e.id, notes: p.notes }, status: "running", groupId: p.groupId, source: ctx.actor.kind === "agent" ? "autopilot" : "api" });
    const run = getRun(ctx.db, runId);
    const rec = new RunRecorder(ctx.db, runId);
    const actx = agentCtx(ctx, run, "steward");
    const author = e.authorIds[0] ? findAuthor(ctx.db, ctx.siteId!, e.authorIds[0]) : null;
    const banned = author?.voice.banned ?? defaultVoice().banned;
    try {
      const md = toMarkdown(e.body);
      const stale = await rec.step(
        "Research",
        () => {
          const used = new Set([...md.matchAll(/\{\{\s*fact:([\w.-]+)\s*\}\}/g)].map((m) => m[1]!));
          return allFacts(ctx.db, ctx.siteId!).filter((f) => used.has(f.key) && isStale(f));
        },
        (s) => (s.length ? `${s.length} fact${s.length === 1 ? "" : "s"} due for re-checking.` : "Facts on this page are current."),
      );
      // Ask the fact ledger to re-verify stale facts (self-healing then fixes every page that uses them).
      for (const f of stale) await invokeOptional(actx, "facts.verify", [{ key: f.key }, { id: f.id }, { factId: f.id }]).catch(() => null);
      const client = rec.client(modelFor(ctx));
      const refreshed = await rec.step(
        "Refresh",
        async () => {
          const off = refreshOffline(e.title, md, banned);
          if (client.offline) return { ...off, reason: off.reasons.length ? capitalize(off.reasons.join("; ")) + "." : "" };
          const r = await client.complete({
            tier: "frontier",
            cachePrefix: `${TEAM_VOICE}\n\n${brainSummary(ctx.db, getSite(ctx.db, ctx.siteId!))}`,
            maxTokens: 8000,
            messages: [{ role: "user", content: refreshPrompt({ title: e.title, markdown: off.markdown, reasons: [...off.reasons, ...stale.map((f) => `“${f.label}” may have changed`)], notes: p.notes, voice: author ? voiceBrief(author) : "" }) }],
          });
          const reason = r.text.match(/^REASON:\s*(.+)$/m)?.[1]?.trim();
          const sep = r.text.indexOf("\n---\n");
          const body = sep >= 0 ? r.text.slice(sep + 5).trim() + "\n" : "";
          if (!body || wordCountOf(body) < wordCountOf(md) * 0.6) return { ...off, reason: off.reasons.length ? capitalize(off.reasons.join("; ")) + "." : "" };
          return { title: off.title, markdown: humanize(body, banned), reasons: off.reasons, reason: reason ?? capitalize(off.reasons.join("; ")) };
        },
        (r) => r.reason || "Nothing needed changing.",
      );
      if (refreshed.markdown === md && refreshed.title === e.title) {
        setRunStatus(ctx.db, runId, "done");
        const message = stale.length ? `“${e.title}” reads current. I asked the fact ledger to re-check ${stale.length} fact${stale.length === 1 ? "" : "s"} it uses.` : `“${e.title}” is already current. Nothing to refresh.`;
        return { result: { runId, delegated: null, message, changed: false }, undo: null };
      }
      const said = refreshed.reason.replace(/^Refresh:\s*/i, "") || "small updates";
      const reason = `Refresh: ${said[0]!.toLowerCase()}${said.slice(1)}`;
      const delegated = await rec.step(
        "Proposal",
        () => invoke(actx, "posts.update", { id: e.id, markdown: refreshed.markdown, ...(refreshed.title !== e.title ? { title: refreshed.title } : {}), reason, substantive: true }, { groupId: p.groupId }),
        (r) => (r.status === "proposed" ? "Waiting for your approval." : "Applied."),
      );
      setRunStatus(ctx.db, runId, "done");
      return { result: { runId, delegated, changed: true, reason }, undo: null };
    } catch (err) {
      setRunStatus(ctx.db, runId, "failed", (err as Error).message);
      throw err;
    }
  },
});

// ---------- look.describe ----------

defineAction({
  name: "look.describe",
  title: "Describe the look",
  description: 'Turns a few words ("warmer", "more premium", "calm Scandinavian", "dark") into three design directions with full design tokens, all meeting WCAG AA contrast. Nothing changes until one is picked (look.update_tokens).',
  permission: "read",
  risk: "read",
  input: z.object({ description: z.string().min(2).max(500) }),
  run(ctx, input) {
    const site = getSite(ctx.db, ctx.siteId!);
    return { options: describeLook(input.description), current: effectiveTokens(ctx, site) };
  },
});

// ---------- Voices ----------

function sampleTopic(author: Author, topic?: string): string {
  return topic?.trim() || author.expertise[0] || "getting the basics right";
}

function hearIt(author: Author, voice: Voice, topic: string) {
  return voiceParagraph(voice, { topic, name: author.name, isPersona: author.isPersona });
}

/** Writes before/after into a proposal created for a voice change ("Hear it"). */
function annotateVoiceProposal(ctx: Ctx, proposalId: string, before: string, after: string, extra: DiffItem[] = []) {
  const row = ctx.db.query<{ diff: string; detail: string }, [string]>("SELECT diff, detail FROM proposals WHERE id = ?").get(proposalId);
  if (!row) return;
  const diff = [...(JSON.parse(row.diff) as DiffItem[]), ...extra, { label: "Hear it", before, after, format: "text" as const }];
  ctx.db.query("UPDATE proposals SET diff = ?, detail = ? WHERE id = ?").run(JSON.stringify(diff), `Before: ${before}\n\nAfter: ${after}`, proposalId);
}

defineAction({
  name: "authors.learn_voice",
  title: "Learn a voice from samples",
  description: "Reads 1–10 writing samples by an author and extracts their voice fingerprint (sentence length, person, humor, habits, favourite phrases), then proposes it as an update to the author. Not undoable itself; discard the proposal instead.",
  permission: "write",
  risk: "costly",
  trust: "settings",
  input: z.object({ author: z.string(), samples: z.array(z.string().min(20)).min(1).max(10), groupId: z.string().optional() }),
  prepare(ctx, input) {
    const a = getAuthor(ctx.db, ctx.siteId!, input.author);
    assertBudget(ctx.db, ctx.siteId!, estimateCall(ctx, "fast", 6000, 400));
    return { summary: `Learn ${a.name}’s voice from ${input.samples.length} sample${input.samples.length === 1 ? "" : "s"}`, invisible: true, payload: { authorId: a.id, samples: input.samples, groupId: input.groupId } };
  },
  async apply(ctx, p: { authorId: string; samples: string[]; groupId?: string }): Promise<{ result: Delegated; undo: null }> {
    const a = getAuthor(ctx.db, ctx.siteId!, p.authorId);
    const runId = createRun(ctx, { request: `Learn ${a.name}'s voice`, label: `Learn ${a.name}’s voice`, kind: "voice", outline: ["Voice analysis", "Proposal"], status: "running", groupId: p.groupId });
    const rec = new RunRecorder(ctx.db, runId);
    const actx = agentCtx(ctx, getRun(ctx.db, runId), "editor");
    const learned = await rec.step(
      "Voice analysis",
      async () => {
        const l = learnVoice(p.samples, a.voice);
        const client = rec.client(modelFor(ctx));
        if (!client.offline) {
          const r = await client.complete({ tier: "fast", json: true, maxTokens: 800, messages: [{ role: "user", content: voicePrompt(p.samples) }] }).catch(() => null);
          const j = r ? parseJson<{ vocabulary?: string; structure?: string; habits?: string[] }>(r.text) : null;
          if (j?.vocabulary) l.voice.vocabulary = clip(j.vocabulary, 160);
          if (j?.structure) l.voice.structure = clip(j.structure, 120);
          if (Array.isArray(j?.habits) && j!.habits.length) l.voice.habits = [...new Set([...l.voice.habits.filter((h) => /measurements|first person|exclamation/i.test(h)), ...j!.habits.map((h) => clip(String(h), 60))])].slice(0, 6);
        }
        return l;
      },
      (l) => l.findings.slice(0, 3).join(" · "),
    );
    const topic = sampleTopic(a);
    const before = voiceParagraph(a.voice, { topic, isPersona: a.isPersona });
    const after = voiceParagraph(learned.voice, { topic, isPersona: a.isPersona });
    const delegated = await rec.step("Proposal", () => invoke(actx, "authors.update", { author: a.id, voice: learned.voice }, { groupId: p.groupId, propose: true }), (r) => r.status);
    if (delegated.status === "proposed") annotateVoiceProposal(ctx, delegated.proposalId, before, after);
    setRunStatus(ctx.db, runId, "done");
    return { result: { runId, delegated, voice: learned.voice, findings: learned.findings, sample: { before, after, voiceMatch: voiceMatch(after, learned.voice) } }, undo: null };
  },
});

defineAction({
  name: "authors.adjust_voice",
  title: "Adjust a voice",
  description: 'Changes an author\'s voice from a plain instruction ("a bit less jokey", "funnier", "shorter sentences", "never say game-changer") and proposes it with a before-and-after paragraph. Not undoable itself; discard the proposal instead.',
  permission: "write",
  risk: "costly",
  trust: "settings",
  input: z.object({ author: z.string(), instruction: z.string().min(2).max(500), groupId: z.string().optional() }),
  prepare(ctx, input) {
    const a = getAuthor(ctx.db, ctx.siteId!, input.author);
    const adj = adjustVoice(a.voice, input.instruction);
    if (!adj.understood && modelFor(ctx).offline) {
      throw invalid(`I'm not sure how to change ${a.name}'s voice from “${input.instruction}”. Try “funnier”, “a bit less jokey”, “shorter sentences”, “more formal” or “never say …”.`);
    }
    return { summary: `Adjust ${a.name}’s voice: ${input.instruction}`, invisible: true, payload: { authorId: a.id, instruction: input.instruction, groupId: input.groupId } };
  },
  async apply(ctx, p: { authorId: string; instruction: string; groupId?: string }): Promise<{ result: Delegated; undo: null }> {
    const a = getAuthor(ctx.db, ctx.siteId!, p.authorId);
    const runId = createRun(ctx, { request: `${p.instruction} (${a.name}'s voice)`, label: `Adjust ${a.name}’s voice`, kind: "voice", outline: ["Voice change", "Proposal"], status: "running", groupId: p.groupId });
    const rec = new RunRecorder(ctx.db, runId);
    const actx = agentCtx(ctx, getRun(ctx.db, runId), "editor");
    const adj = await rec.step("Voice change", () => adjustVoice(a.voice, p.instruction), (x) => x.changes.join(" · ") || "No change.");
    const topic = sampleTopic(a);
    const before = voiceParagraph(a.voice, { topic, isPersona: a.isPersona });
    const after = voiceParagraph(adj.voice, { topic, isPersona: a.isPersona });
    const delegated = await rec.step("Proposal", () => invoke(actx, "authors.update", { author: a.id, voice: adj.voice }, { groupId: p.groupId, propose: true }), (r) => r.status);
    if (delegated.status === "proposed") annotateVoiceProposal(ctx, delegated.proposalId, before, after);
    setRunStatus(ctx.db, runId, "done");
    updatePlan(ctx.db, runId, { result: { changes: adj.changes } });
    return { result: { runId, delegated, changes: adj.changes, sample: { before, after } }, undo: null };
  },
});

defineAction({
  name: "authors.sample",
  title: "Hear a voice",
  description: "The same short paragraph in the site's default voice and in an author's voice, with the voice match score.",
  permission: "read",
  risk: "read",
  input: z.object({ author: z.string(), topic: z.string().max(200).optional() }),
  async run(ctx, input) {
    const a = getAuthor(ctx.db, ctx.siteId!, input.author);
    const topic = sampleTopic(a, input.topic);
    let voiced = hearIt(a, a.voice, topic);
    const client = modelFor(ctx);
    if (!client.offline) {
      const r = await client.complete({ tier: "fast", maxTokens: 300, messages: [{ role: "user", content: samplePrompt({ topic, voice: voiceBrief(a) }) }] }).catch(() => null);
      if (r?.text && wordCountOf(r.text) >= 20) voiced = humanize(r.text.trim(), a.voice.banned);
    }
    return { topic, default: defaultParagraph(topic), author: voiced, authorName: a.name, voiceMatch: voiceMatch(voiced, a.voice) };
  },
});

// ---------- Runs ----------

defineAction({
  name: "runs.list",
  title: "What the team is working on",
  description: "Recent agent jobs on this site with their status, steps and cost.",
  permission: "read",
  risk: "read",
  input: z.object({ limit: z.number().int().min(1).max(100).optional(), status: z.enum(["queued", "running", "done", "failed", "paused"]).optional() }),
  run(ctx, input) {
    const rows = ctx.db.query<{ id: string }, [string, number]>("SELECT id FROM agent_runs WHERE site_id = ? ORDER BY created_at DESC LIMIT ?").all(ctx.siteId!, input.limit ?? 20);
    return rows
      .map((r) => getRun(ctx.db, r.id))
      .filter((r) => !input.status || r.status === input.status)
      .map((r) => ({ id: r.id, label: r.plan.label, status: r.status, kind: r.plan.kind, costUsd: r.costUsd, createdAt: r.createdAt, error: r.plan.error }));
  },
});

defineAction({
  name: "runs.resume",
  title: "Resume a paused job",
  description: "Lets a job that paused at its cost ceiling or the monthly budget carry on, with its ceiling raised by another $2.",
  permission: "admin",
  risk: "command",
  input: z.object({ runId: z.string() }),
  run(ctx, input) {
    const run = getRun(ctx.db, input.runId);
    if (run.siteId !== ctx.siteId) throw new TqError("not_found", "That job was not found.");
    if (run.status !== "paused") throw new TqError("conflict", `That job is ${run.status}, not paused.`);
    if (run.plan.kind !== "write") throw new TqError("conflict", "Only writing jobs can be resumed. Ask me to try again instead.");
    assertBudget(ctx.db, ctx.siteId!, 0.01);
    updatePlan(ctx.db, run.id, { ceilingUsd: run.costUsd + 2, error: undefined });
    // The pipeline runs again from the brief; the money already spent stays on the run.
    ctx.db.query("UPDATE agent_runs SET status = 'queued', steps = ? WHERE id = ?").run(JSON.stringify(run.steps.map((s) => ({ role: s.role, label: s.label, status: "pending" }))), run.id);
    enqueue(ctx.db, WRITE_JOB, ctx.siteId!, { runId: run.id });
    return { runId: run.id, status: "queued" };
  },
});

