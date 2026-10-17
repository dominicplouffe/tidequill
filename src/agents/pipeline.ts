import { findAuthor, listAuthors } from "../core/authors.ts";
import type { Db } from "../core/db.ts";
import { json } from "../core/db.ts";
import { TqError } from "../core/errors.ts";
import { enqueue } from "../core/jobs.ts";
import { slugify } from "../core/ids.ts";
import { getEntry } from "../core/entries.ts";
import { readiness } from "../core/hooks.ts";
import { invoke, type InvokeResult } from "../core/registry.ts";
import { getSite } from "../core/sites.ts";
import type { Ctx, Site } from "../core/types.ts";
import { addMessage, proposalCard, type Card } from "./cards.ts";
import { checkClaims, seoPass, structureStats } from "./checks.ts";
import {
  bestCategory,
  brainFor,
  coverage,
  evidenceFor,
  factsFor,
  forbiddenTopics,
  lessons,
  markIdeaUsed,
  brainSummary,
  type BrainEntry,
  type EvidenceItem,
  type FactRow,
} from "./knowledge.ts";
import { modelFor, ModelUnavailableError, parseJson, type ModelClient } from "./model.ts";
import { hasAction, invokeOptional } from "./optional.ts";
import { draftPrompt, editorPrompt, outlinePrompt, revisePrompt, TEAM_VOICE, voiceBrief } from "./prompts.ts";
import { agentCtx, getRun, RunPaused, RunRecorder, setRunStatus, SITE_CONCURRENCY, activeRuns, updatePlan } from "./runs.ts";
import { humanize, overlap, tellsIn, wordCountOf } from "./text.ts";
import { writeOffline, removeSentencesWith, type Draft } from "./writer.ts";

/**
 * The editorial pipeline: Brief → Research → Outline → Draft (in voice) →
 * Fact-check → SEO/AEO → Human pass → Editor review → Proposal. Every step
 * is recorded on the run. With a model, writing steps prompt it; offline (or
 * when a model reply can't be used) the built-in writer does the work.
 */

export const PIPELINE_STEPS = ["Brief", "Research", "Outline", "Draft in voice", "Fact-check", "SEO and answer pass", "Human pass", "Editor review", "Proposal"];

export interface WriteInput {
  topic: string;
  title?: string;
  authorId: string | null;
  categoryId: string | null;
  notes?: string;
  /** "next_slot", an ISO time, or "none". */
  schedule: string;
  groupId?: string;
  ideaId?: string;
}

export interface WrittenPost {
  /** The saved draft. */
  entryId: string;
  title: string;
  description: string;
  markdown: string;
  authorId: string | null;
  categoryId: string | null;
  flagged: string[];
}

interface Research {
  brain: BrainEntry[];
  facts: FactRow[];
  evidence: EvidenceItem[];
  related: { id: string; title: string; status: string }[];
  lessons: BrainEntry[];
  rules: BrainEntry[];
  forbidden: string[];
  audience?: string;
}

function realAuthorNames(db: Db, siteId: string): Map<string, string> {
  return new Map(listAuthors(db, siteId).filter((a) => !a.isPersona).map((a) => [a.id, a.name]));
}

/** Titles quoted in rejection lessons ("Discarded: Schedule “Title” on …"). */
function rejectedTitles(ls: BrainEntry[]): string[] {
  return ls.flatMap((l) => [...l.text.matchAll(/[“"]([^”"]{8,120})[”"]/g)].map((m) => m[1]!));
}

/** Phrases a reviewer asked us not to use, from lesson reasons ("Reason: don't say 'best ever'"). */
function rejectedPhrases(ls: BrainEntry[]): string[] {
  return ls.flatMap((l) => {
    const reason = l.text.split(/Reason:\s*/i)[1] ?? "";
    // A quote opens after a space or the start ("don't say 'best ever'"), so apostrophes in words don't count.
    return [...reason.matchAll(/(?:^|[\s(:])[‘'“"]([^’'”"]{3,60})[’'”"]/g)].map((m) => m[1]!.toLowerCase().trim());
  });
}

function sourcesText(r: Research, topic: string, notes?: string): string[] {
  return [topic, notes ?? "", ...r.brain.map((b) => b.text), ...r.facts.map((f) => `${f.label} ${f.value}`), ...r.evidence.map((e) => e.text)];
}

/** Writes one post through the pipeline and saves it as a draft (invisible to readers); the caller proposes publishing it. */
export async function writePost(ctx: Ctx, rec: RunRecorder, input: WriteInput): Promise<WrittenPost> {
  const db = ctx.db;
  const siteId = ctx.siteId!;
  const site = getSite(db, siteId);
  const client = rec.client(modelFor(ctx));
  const author = input.authorId ? findAuthor(db, siteId, input.authorId) : null;

  // 1. Brief
  const brief = await rec.step(
    "Brief",
    () => {
      const category = input.categoryId ? { id: input.categoryId } : bestCategory(db, siteId, input.topic);
      return { categoryId: category?.id ?? null };
    },
    () => `“${input.title ?? input.topic}”${author ? ` as ${author.name}` : ""}${input.schedule === "none" ? "" : input.schedule === "next_slot" ? ", for the next free slot" : `, for ${new Date(input.schedule).toUTCString().slice(0, 16)}`}.`,
  );

  // 2. Research: Site Brain, facts, evidence and what the site already covers.
  const research = await rec.step(
    "Research",
    (): Research => {
      const topic = `${input.title ?? ""} ${input.topic} ${input.notes ?? ""}`;
      const brain = brainFor(db, siteId, topic);
      const rules = brain.filter((b) => b.kind === "claim_rule");
      const ls = lessons(db, siteId, 50);
      const audience = brain.find((b) => b.kind === "identity" && /^(audience|readers)\s*:/i.test(b.text))?.text.replace(/^(audience|readers)\s*:\s*/i, "");
      return {
        brain,
        facts: factsFor(db, siteId, topic),
        evidence: evidenceFor(db, siteId, topic, author?.id),
        related: coverage(db, siteId, topic).map((c) => ({ id: c.entry.id, title: c.entry.title, status: c.entry.status })),
        lessons: ls,
        rules,
        forbidden: forbiddenTopics(rules),
        audience,
      };
    },
    (r) => `Read ${r.brain.length} Site Brain ${r.brain.length === 1 ? "entry" : "entries"}, ${r.facts.length} fact${r.facts.length === 1 ? "" : "s"}, ${r.evidence.length} piece${r.evidence.length === 1 ? "" : "s"} of evidence and ${r.related.length} related post${r.related.length === 1 ? "" : "s"}.`,
  );

  const avoidTitles = [...research.related.map((r) => r.title), ...rejectedTitles(research.lessons)];
  const offlineInput = {
    topic: input.topic,
    title: input.title,
    niche: site.niche,
    siteName: site.name,
    author: author ? { id: author.id, name: author.name, isPersona: author.isPersona, voice: author.voice } : null,
    brain: research.brain,
    facts: research.facts,
    evidence: research.evidence,
    realAuthors: realAuthorNames(db, siteId),
    related: research.related.filter((r) => r.status === "published"),
    forbidden: research.forbidden,
    avoidTitles,
    notes: input.notes,
    audience: research.audience,
    siteLinks: siteLinks(db, siteId, brief.categoryId),
  };
  let offlineDraft: Draft | null = null;
  const offline = () => (offlineDraft ??= writeOffline(offlineInput));
  const prefix = `${TEAM_VOICE}\n\n${brainSummary(db, site)}${author ? `\n\n${voiceBrief(author)}` : ""}`;

  // 3. Outline
  const outline = await rec.step(
    "Outline",
    async () => {
      if (client.offline) return { title: offline().title, description: offline().description, sections: offline().outline, model: false };
      const res = await tryModel(rec, client, {
        tier: "frontier",
        cachePrefix: prefix,
        json: true,
        maxTokens: 3000,
        messages: [
          {
            role: "user",
            content: outlinePrompt({
              topic: input.title ?? input.topic,
              notes: input.notes,
              research: researchText(research),
              coverage: research.related.map((r) => `- ${r.title} (tq:${r.id})`).join("\n"),
              lessons: research.lessons.slice(0, 20).map((l) => `- ${l.text}`).join("\n"),
            }),
          },
        ],
      });
      const j = res ? parseJson<{ title?: string; description?: string; angle?: string; sections?: { question: string; points?: string[] }[]; faq?: string[] }>(res) : null;
      if (!j?.sections?.length || !j.title) {
        rec.note("The outline reply wasn't usable, so I planned it with the built-in writer.");
        return { title: offline().title, description: offline().description, sections: offline().outline, model: false };
      }
      return { title: input.title ?? j.title, description: j.description ?? "", sections: j.sections.map((s) => s.question), faq: j.faq ?? [], points: j.sections, model: true };
    },
    (o) => `${o.sections.length} sections: ${o.sections.slice(0, 3).join(" · ")}${o.sections.length > 3 ? " …" : ""}`,
  );

  // 4. Draft in the author's voice
  let draft = await rec.step(
    "Draft in voice",
    async () => {
      if (client.offline || !outline.model) return { title: offline().title, description: offline().description, markdown: offline().markdown };
      const outlineText = [`Title: ${outline.title}`, ...((outline as any).points ?? []).map((s: any) => `## ${s.question}\n${(s.points ?? []).map((p: string) => `- ${p}`).join("\n")}`), (outline as any).faq?.length ? `FAQ: ${(outline as any).faq.join(" | ")}` : ""].join("\n");
      const res = await tryModel(rec, client, {
        tier: "frontier",
        cachePrefix: prefix,
        maxTokens: 6000,
        messages: [
          {
            role: "user",
            content: draftPrompt({
              outline: outlineText,
              voice: author ? voiceBrief(author) : "Voice: the site's editorial team. Plain, specific, warm. Writes as “we”; never claims first-hand testing.",
              evidence: research.evidence.map((e) => `- [${e.id}, ${e.kind}${e.authorId ? `, by ${offlineInput.realAuthors.get(e.authorId) ?? "a persona"}` : ""}] ${e.text}`).join("\n"),
              facts: research.facts.map((f) => `- ${f.key}: ${f.label} = ${f.value}`).join("\n"),
              links: research.related.filter((r) => r.status === "published").map((r) => `- [${r.title}](tq:${r.id})`).join("\n"),
              wordsMin: 700,
              wordsMax: 1100,
            }),
          },
        ],
      });
      const parsed = res ? parseDraft(res) : null;
      if (!parsed || wordCountOf(parsed.markdown) < 250) {
        rec.note("The draft reply wasn't usable, so the built-in writer drafted it.");
        return { title: offline().title, description: offline().description, markdown: offline().markdown };
      }
      return { title: input.title ?? parsed.title ?? outline.title, description: parsed.description || outline.description, markdown: parsed.markdown };
    },
    (d) => `${wordCountOf(d.markdown)} words as ${author?.name ?? "the editorial team"}.`,
  );

  // 5. Fact-check: numbers must trace to a source; register ledger facts where the facts module exists.
  const facts = await rec.step(
    "Fact-check",
    async () => {
      let markdown = draft.markdown;
      // Personas never claim first-hand experience.
      if (!author || author.isPersona) for (const p of ["i tested", "i bought", "i measured", "in my experience", "i've owned", "i have owned", "we tested", "in our tests"]) markdown = removeSentencesWith(markdown, p);
      const check = checkClaims(markdown, sourcesText(research, `${input.title ?? ""} ${input.topic}`, input.notes));
      const registered = await registerFacts(ctx, research, check.markdown);
      return { ...check, markdown: registered.markdown, registered: registered.keys };
    },
    (f) =>
      `${f.supported} numeric claim${f.supported === 1 ? "" : "s"} checked against sources${f.flagged.length ? `; removed ${f.flagged.length} with no source` : ""}${f.registered.length ? `; tracked ${f.registered.length} in the fact ledger` : ""}.`,
  );
  draft = { ...draft, markdown: facts.markdown };

  // 6. SEO / AEO
  const seo = await rec.step(
    "SEO and answer pass",
    () => seoPass(draft.title, draft.description, draft.markdown),
    (s) => {
      const st = structureStats(s.markdown);
      return `${st.questions} question headings, ${st.answersInRange}/${st.answers.length} answers at 40–60 words${st.faq ? ", FAQ" : ""}. ${s.fixes.slice(0, 2).join(" ")}`.trim();
    },
  );
  draft = { title: seo.title, description: seo.description, markdown: seo.markdown };

  // From here on the draft is saved (drafts are invisible to readers), so the Ready light scores the real entry.
  let entryId: string | null = null;
  const save = async (d: { title: string; description: string; markdown: string }) => {
    if (!entryId) {
      const created = await invoke(ctx, "posts.create", { type: "post", title: d.title, description: d.description, markdown: d.markdown, authors: author ? [author.id] : undefined, category: brief.categoryId ?? undefined });
      if (created.status !== "applied") throw new TqError("failed", "I couldn't save the draft.");
      entryId = (created.result as { id: string }).id;
    } else {
      await invoke(ctx, "posts.update", { id: entryId, title: d.title, description: d.description, markdown: d.markdown, reason: "Editorial pass" });
    }
  };
  await save(draft);

  // 7. Human pass: the Ready light's findings (if the quality module is installed) plus our own AI-tell list, at most 2 rounds.
  const human = await rec.step(
    "Human pass",
    async () => {
      let markdown = draft.markdown;
      const banned = author?.voice.banned ?? [];
      let rounds = 0;
      let fixed = 0;
      for (; rounds < 2; rounds++) {
        const score = await qualityFindings(ctx, entryId!);
        const local = tellsIn(markdown, banned);
        if (!score.findings.length && !local.length) break;
        let next = humanize(markdown, banned);
        for (const f of score.findings) {
          if (f.quote && f.suggestion !== undefined && next.includes(f.quote)) {
            next = next.replace(f.quote, f.suggestion);
            fixed++;
          }
        }
        const open = score.findings.filter((f) => !(f.quote && f.suggestion !== undefined)).map((f) => f.message);
        if (open.length && !client.offline) {
          const res = await tryModel(rec, client, { tier: "frontier", cachePrefix: prefix, maxTokens: 6000, messages: [{ role: "user", content: revisePrompt({ markdown: next, findings: open, voice: author ? voiceBrief(author) : "" }) }] });
          if (res && wordCountOf(res) > wordCountOf(next) * 0.6) next = humanize(res.trim() + "\n", banned);
        }
        fixed += local.length;
        if (next === markdown) break;
        markdown = next;
        await save({ ...draft, markdown });
      }
      return { markdown, rounds, fixed };
    },
    (h) => (h.fixed ? `Revised ${h.fixed} phrase${h.fixed === 1 ? "" : "s"} in ${Math.max(1, h.rounds)} round${h.rounds === 1 ? "" : "s"}.` : "Reads human; nothing to revise."),
  );
  draft = { ...draft, markdown: human.markdown };

  // 8. Editor review: claim rules and the last 50 rejections.
  const review = await rec.step(
    "Editor review",
    async () => {
      let markdown = draft.markdown;
      let title = draft.title;
      const notes: string[] = [];
      for (const phrase of [...research.forbidden, ...rejectedPhrases(research.lessons)]) {
        if (markdown.toLowerCase().includes(phrase)) {
          markdown = removeSentencesWith(markdown, phrase);
          notes.push(`Took out “${phrase}”.`);
        }
      }
      const repeat = rejectedTitles(research.lessons).find((t) => overlap(title, t) >= 0.85);
      if (repeat && !input.title) {
        const alt = writeOffline({ ...offlineInput, avoidTitles: [...avoidTitles, title] }).title;
        notes.push(`Changed the title: “${repeat}” was turned down before.`);
        title = alt;
      }
      if (!client.offline) {
        const res = await tryModel(rec, client, {
          tier: "fast",
          cachePrefix: prefix,
          json: true,
          maxTokens: 1500,
          messages: [{ role: "user", content: editorPrompt({ title, markdown, lessons: research.lessons.slice(0, 50).map((l) => `- ${l.text}`).join("\n"), rules: research.rules.map((r) => `- ${r.text}`).join("\n") }) }],
        });
        const j = res ? parseJson<{ ok?: boolean; notes?: string[]; fixes?: { find: string; replace: string }[] }>(res) : null;
        for (const f of j?.fixes ?? []) {
          if (f?.find && typeof f.replace === "string" && markdown.includes(f.find)) {
            markdown = markdown.replace(f.find, f.replace);
            notes.push(`Fixed: “${f.find.slice(0, 40)}”.`);
          }
        }
        for (const n of (j?.notes ?? []).slice(0, 3)) notes.push(n);
      }
      return { markdown, title, notes, checked: research.lessons.length };
    },
    (r) => `Checked ${r.checked} past rejection${r.checked === 1 ? "" : "s"} and ${research.rules.length} claim rule${research.rules.length === 1 ? "" : "s"}. ${r.notes.length ? r.notes.slice(0, 2).join(" ") : "Nothing repeats."}`,
  );

  if (review.markdown !== draft.markdown || review.title !== draft.title) await save({ title: review.title, description: draft.description, markdown: review.markdown });
  return { entryId: entryId!, title: review.title, description: draft.description, markdown: review.markdown, authorId: author?.id ?? null, categoryId: brief.categoryId, flagged: facts.flagged };
}

/** Internal pages a new post can link to: its category page and How we test, when they exist. */
function siteLinks(db: Db, siteId: string, categoryId: string | null): { anchor: string; href: string }[] {
  const out: { anchor: string; href: string }[] = [];
  const cat = categoryId ? db.query<{ name: string; slug: string }, [string]>("SELECT name, slug FROM categories WHERE id = ?").get(categoryId) : null;
  if (cat) out.push({ anchor: `More ${cat.name.toLowerCase()}`, href: `/topics/${cat.slug}/` });
  const how = db.query<{ title: string; slug: string }, [string]>("SELECT title, slug FROM entries WHERE site_id = ? AND type = 'page' AND slug = 'how-we-test' AND status = 'published' AND deleted_at IS NULL").get(siteId);
  if (how) out.push({ anchor: "How we test", href: `/${how.slug}/` });
  return out;
}

function researchText(r: Research): string {
  return [
    ...r.brain.map((b) => `- [${b.kind}] ${b.text}`),
    ...r.facts.map((f) => `- [fact ${f.key}] ${f.label}: ${f.value}`),
    ...r.evidence.map((e) => `- [evidence ${e.id}, ${e.kind}] ${e.text}`),
  ].join("\n");
}

/** Calls the model; a provider outage propagates (the job retries), anything else returns null so the step falls back. */
async function tryModel(rec: RunRecorder, client: ModelClient, req: Parameters<ModelClient["complete"]>[0]): Promise<string | null> {
  try {
    return (await client.complete(req)).text;
  } catch (err) {
    if (err instanceof RunPaused || err instanceof ModelUnavailableError) throw err;
    rec.note(`Model call failed (${String((err as Error)?.message ?? err).slice(0, 80)}).`);
    return null;
  }
}

/** Parses the TITLE / DESCRIPTION / --- / body format. */
export function parseDraft(text: string): { title?: string; description?: string; markdown: string } | null {
  const t = text.replace(/^```(?:markdown|md)?\s*/i, "").replace(/```\s*$/, "").trim();
  const title = t.match(/^TITLE:\s*(.+)$/m)?.[1]?.trim();
  const description = t.match(/^DESCRIPTION:\s*(.+)$/m)?.[1]?.trim();
  const sep = t.indexOf("\n---\n");
  const body = sep >= 0 ? t.slice(sep + 5) : t.replace(/^(TITLE|DESCRIPTION):.*$/gm, "");
  const markdown = body.replace(/^#\s+.*\n/, "").trim();
  return markdown ? { title, description, markdown: markdown + "\n" } : null;
}

interface QFinding {
  message: string;
  quote?: string;
  suggestion?: string;
}

/** Findings from the Ready light (the quality module's readiness hook, or quality.score) for a saved draft. */
async function qualityFindings(ctx: Ctx, entryId: string): Promise<{ findings: QFinding[]; ready: boolean | null }> {
  const keep = (findings: any[]) => findings.filter((f) => f && typeof f.message === "string" && f.severity !== "info" && f.area !== "check").map((f) => ({ message: f.message, quote: f.quote, suggestion: f.suggestion }));
  try {
    const r = await readiness(ctx, getEntry(ctx.db, ctx.siteId!, entryId));
    if (r) return { findings: keep(r.findings), ready: r.ready };
    const res = await invokeOptional(ctx, "quality.score", [{ id: entryId }, { entryId }]);
    const out: any = res && res.status === "done" ? res.result : null;
    return { findings: keep(out?.findings ?? out?.ready?.findings ?? []), ready: out?.ready ?? null };
  } catch {
    return { findings: [], ready: null };
  }
}

/**
 * Brain facts shaped "<label> is <value>" that the draft uses become ledger
 * facts (when the facts module provides facts.set and it applies), and the
 * draft references them as {{fact:key}} so a later change heals every page.
 */
async function registerFacts(ctx: Ctx, r: Research, markdown: string): Promise<{ markdown: string; keys: string[] }> {
  if (!hasAction("facts.set")) return { markdown, keys: [] };
  const keys: string[] = [];
  let md = markdown;
  for (const b of r.brain.filter((x) => x.kind === "fact")) {
    const m = b.text.trim().match(/^(.{3,80}?)\s+(?:is|are|costs?|weighs?|measures?|=|:)\s+(?:about |around |roughly )?(\$?\d[\d,.]*\s?(?:%|[a-z]+|"|”)?)\.?$/i);
    if (!m) continue;
    const [, label, value] = m as unknown as [string, string, string];
    if (!md.includes(value) || r.facts.some((f) => f.value === value)) continue;
    const key = slugify(label, 60);
    try {
      const res = await invokeOptional(ctx, "facts.set", [
        { key, label, value, source: `brain:${b.id}` },
        { key, label, value },
        { key, value },
      ]);
      if (res?.status === "applied") {
        md = md.replace(value, `{{fact:${key}}}`);
        keys.push(key);
      }
    } catch {
      /* the ledger is optional; the number stays as plain text */
    }
  }
  return { markdown: md, keys };
}

// ---------- Slots ----------

/** Free publishing slots after `after`, skipping scheduled posts and pending publish proposals. */
export function freeSlots(db: Db, site: Site, n: number, after = new Date()): string[] {
  const { days, time } = site.settings.cadence;
  const [hh, mm] = time.split(":").map(Number);
  const taken = new Set<string>(
    db
      .query<{ publish_at: string }, [string]>("SELECT publish_at FROM entries WHERE site_id = ? AND status = 'scheduled' AND deleted_at IS NULL AND publish_at IS NOT NULL")
      .all(site.id)
      .map((r) => r.publish_at.slice(0, 13)),
  );
  for (const p of db.query<{ payload: string }, [string]>("SELECT payload FROM proposals WHERE site_id = ? AND status = 'pending' AND action_name = 'posts.publish'").all(site.id)) {
    const at = json<{ at?: string | null }>(p.payload, {}).at;
    if (at) taken.add(at.slice(0, 13));
  }
  const useDays = days.length ? days : [0, 1, 2, 3, 4, 5, 6];
  const out: string[] = [];
  for (let i = 0; i < 400 && out.length < n; i++) {
    const d = new Date(after.getTime() + i * 86_400_000);
    d.setUTCHours(hh ?? 9, mm ?? 0, 0, 0);
    if (d.getTime() <= Math.max(after.getTime(), Date.now() + 5 * 60_000)) continue;
    if (!useDays.includes(d.getUTCDay())) continue;
    const key = d.toISOString().slice(0, 13);
    if (taken.has(key)) continue;
    taken.add(key);
    out.push(d.toISOString());
  }
  return out;
}

/** Monday 00:00 UTC of next week. */
export function nextWeekStart(now = new Date()): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + ((8 - dow) % 7 || 7));
  return d;
}

// ---------- The background job ----------

export const WRITE_JOB = "agents.write";

/** Job handler for "agents.write": runs the pipeline, creates the draft and proposes publishing it. */
export async function runWriteJob(base: Ctx, payload: { runId: string }, job: { attempts: number }) {
  const db = base.db;
  const run = getRun(db, payload.runId);
  if (run.status !== "queued" && run.status !== "running") return;
  if (run.siteId && run.status === "queued" && activeRuns(db, run.siteId) >= SITE_CONCURRENCY) {
    // Three jobs already running on this site: try again shortly.
    enqueue(db, WRITE_JOB, run.siteId, payload, new Date(Date.now() + 30_000));
    return;
  }
  setRunStatus(db, run.id, "running");
  const ctx = agentCtx(base, run, "writer");
  const rec = new RunRecorder(db, run.id);
  const input = run.plan.input as WriteInput;
  try {
    const post = await writePost(ctx, rec, input);
    const outcome = await rec.step("Proposal", () => proposeDraft(ctx, input, post), (o) => o.summary);
    if (input.ideaId) markIdeaUsed(db, input.ideaId, run.id);
    updatePlan(db, run.id, { result: outcome });
    setRunStatus(db, run.id, "done");
  } catch (err) {
    if (err instanceof RunPaused) {
      setRunStatus(db, run.id, "paused", err.message);
    } else if (err instanceof ModelUnavailableError && job.attempts < 3) {
      setRunStatus(db, run.id, "queued", err.message);
      throw err; // the job queue retries with backoff
    } else {
      setRunStatus(db, run.id, "failed", err instanceof TqError ? err.message : "Something went wrong while writing. Nothing was published; you can ask me to try again.");
      if (!(err instanceof TqError)) console.error("[tidequill] write job failed:", err);
    }
  }
  await notifyConversation(base, run.id);
}

async function proposeDraft(ctx: Ctx, input: WriteInput, post: WrittenPost) {
  const entryId = post.entryId;
  if (input.schedule === "none") return { entryId, proposalId: null, title: post.title, summary: `Saved the draft “${post.title}”.` };
  const site = getSite(ctx.db, ctx.siteId!);
  const at = input.schedule === "next_slot" ? freeSlots(ctx.db, site, 1)[0] : input.schedule;
  let res: InvokeResult;
  try {
    res = await invoke(ctx, "posts.publish", { id: entryId, at }, { groupId: input.groupId });
  } catch (err) {
    // Trust was earned but the draft isn't Ready: ask a person instead of failing.
    res = await invoke(ctx, "posts.publish", { id: entryId, at }, { groupId: input.groupId, propose: true }).catch(() => ({ status: "done", result: { error: (err as Error).message } }) as InvokeResult);
  }
  if (res.status === "proposed") return { entryId, proposalId: res.proposalId, title: post.title, summary: `Draft “${post.title}” is waiting for your approval.` };
  if (res.status === "applied") return { entryId, proposalId: null, actionId: res.actionId, title: post.title, summary: `Scheduled “${post.title}” on its own (trust earned).` };
  return { entryId, proposalId: null, title: post.title, summary: `Saved the draft “${post.title}”; it needs a fix before it can be scheduled.` };
}

/**
 * When the last background run of an Ask plan finishes, the conversation gets
 * a follow-up: "Done. 3 posts are waiting for you." with the proposal cards.
 */
async function notifyConversation(base: Ctx, runId: string) {
  const db = base.db;
  const run = getRun(db, runId);
  const conv = run.plan.conversationId;
  if (!conv) return;
  const siblings = db
    .query<any, [string, string]>("SELECT id, status, plan FROM agent_runs WHERE json_extract(plan, '$.conversationId') = ? AND COALESCE(json_extract(plan, '$.groupId'), '') = ?")
    .all(conv, run.plan.groupId ?? "")
    .filter((r) => json<any>(r.plan, {}).kind !== "ask");
  if (siblings.some((r) => r.status === "queued" || r.status === "running")) return;
  const already = db.query("SELECT 1 FROM messages WHERE conversation_id = ? AND content LIKE ?").get(conv, `%"notifiedRuns":"${run.plan.groupId ?? run.id}"%`);
  if (already) return;
  const cards: Card[] = [];
  const ctx = { ...base, siteId: run.siteId };
  let waiting = 0;
  const paused: string[] = [];
  const failed: string[] = [];
  for (const s of siblings) {
    const plan = json<any>(s.plan, {});
    if (s.status === "paused") paused.push(plan.error ?? "A job paused.");
    if (s.status === "failed") failed.push(plan.error ?? "A job failed.");
    for (const p of db.query<{ id: string }, [string]>("SELECT id FROM proposals WHERE run_id = ? ORDER BY created_at").all(s.id)) {
      const card = await proposalCard(ctx, p.id);
      if (card) {
        cards.push(card);
        waiting++;
      }
    }
  }
  const n = siblings.length;
  let text = waiting
    ? `Done. ${waiting === 1 ? "1 post is" : `${waiting} posts are`} waiting for you.`
    : paused.length
      ? paused[0]!
      : failed.length
        ? failed[0]!
        : `Done. ${n === 1 ? "The draft is" : `${n} drafts are`} ready.`;
  if (waiting && paused.length) text += ` ${paused[0]}`;
  const msg = addMessage(db, conv, "assistant", text, cards);
  // Marker so the same group isn't announced twice.
  db.query("UPDATE messages SET content = json_set(content, '$.notifiedRuns', ?) WHERE id = ?").run(run.plan.groupId ?? run.id, msg.id);
}

