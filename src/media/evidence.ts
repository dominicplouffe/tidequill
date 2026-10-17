import type { Hono } from "hono";
import { z } from "zod";
import { block, type Block } from "../content/blocks.ts";
import { findAuthor, listAuthors, type Author } from "../core/authors.ts";
import { json } from "../core/db.ts";
import { getEntry, listEntries } from "../core/entries.ts";
import { TqError, invalid } from "../core/errors.ts";
import { id, nowIso } from "../core/ids.ts";
import { defineAction, getAction, invoke, type WriteAction } from "../core/registry.ts";
import type { Runtime } from "../core/runtime.ts";
import type { Ctx } from "../core/types.ts";
import { requestCtx, type Env } from "../server/app.ts";
import { extractFacts, type Extracted } from "./facts.ts";
import { actorUserId, ingest } from "./ingest.ts";
import { currentFetch, formatBytes } from "./net.ts";
import { MAX_UPLOAD_BYTES, findMedia, type Media } from "./store.ts";

/**
 * Experience capture: photos, voice notes, test logs, receipts and quick notes
 * from the phone. Each becomes an Evidence row tied to an author, a topic and a
 * date, its facts go to Site Brain, and drafts can quote it word for word.
 */

export const EVIDENCE_KINDS = ["photo", "voice", "note", "test", "receipt", "video"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

const KIND_LABEL: Record<EvidenceKind, string> = { photo: "photo", voice: "voice note", note: "note", test: "test log", receipt: "receipt", video: "video" };

export interface Evidence {
  id: string;
  siteId: string;
  kind: EvidenceKind;
  topic: string;
  text: string;
  authorId: string | null;
  authorName: string | null;
  media: Media | null;
  extracted: Extracted;
  capturedAt: string;
  createdAt: string;
}

function rowToEvidence(ctx: Ctx, r: any): Evidence {
  const author = r.author_id ? findAuthor(ctx.db, r.site_id, r.author_id) : null;
  return {
    id: r.id,
    siteId: r.site_id,
    kind: r.kind,
    topic: r.topic,
    text: r.text,
    authorId: r.author_id,
    authorName: author?.name ?? null,
    media: r.media_id ? findMedia(ctx.db, r.site_id, r.media_id) : null,
    extracted: json<Extracted>(r.extracted, { facts: [], summary: "" }),
    capturedAt: r.captured_at,
    createdAt: r.created_at,
  };
}

export function getEvidence(ctx: Ctx, evidenceId: string): Evidence {
  const r = ctx.db.query("SELECT * FROM evidence WHERE id = ? AND site_id = ? AND deleted_at IS NULL").get(evidenceId, ctx.siteId!);
  if (!r) throw new TqError("not_found", "That piece of evidence was not found.");
  return rowToEvidence(ctx, r);
}

/** The author byline belonging to whoever is capturing (a person, or the person an agent works for). */
function authorForActor(ctx: Ctx): Author | null {
  const userId = actorUserId(ctx);
  if (!userId) return null;
  const r = ctx.db.query<{ id: string }, [string, string]>("SELECT id FROM authors WHERE site_id = ? AND user_id = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 1").get(ctx.siteId!, userId);
  return r ? findAuthor(ctx.db, ctx.siteId!, r.id) : null;
}

function resolveAuthor(ctx: Ctx, key: string | undefined): Author | null {
  if (!key) return authorForActor(ctx);
  const a = findAuthor(ctx.db, ctx.siteId!, key);
  if (!a) throw invalid(`There's no author called “${key}” on this site.`);
  if (a.isPersona) throw invalid(`${a.name} is a persona, and personas can't capture first-hand experience. Pick a real author.`);
  return a;
}

// ---------- Actions ----------

interface AddPayload {
  id: string;
  kind: EvidenceKind;
  text: string;
  topic: string;
  authorId: string | null;
  authorName: string | null;
  mediaId: string | null;
  capturedAt: string;
  extracted: Extracted;
  brainId: string | null;
}

defineAction({
  name: "evidence.add",
  title: "Save a piece of evidence",
  description:
    "Saves something an author actually saw or did (photo, voice note, test log, receipt, video or quick note) with its topic and date. Facts in it, like prices, measurements and test results, go to Site Brain. Invisible to readers until a post uses it.",
  permission: "write",
  risk: "reversible",
  trust: "other",
  input: z.object({
    kind: z.enum(EVIDENCE_KINDS),
    text: z.string().max(20_000).optional().describe("What was said or noted, in the author's own words (for voice notes, the transcript)"),
    author: z.string().optional().describe("Author id, slug or name; defaults to your own byline"),
    topic: z.string().max(200).optional().describe("Product or topic, e.g. “oak stand”"),
    mediaId: z.string().optional(),
    capturedAt: z.string().optional().describe("When it was captured (ISO date); defaults to now"),
  }),
  prepare(ctx, input) {
    const text = (input.text ?? "").trim();
    if (!text && !input.mediaId) throw invalid("Add a photo, a recording or a few words.");
    const media = input.mediaId ? findMedia(ctx.db, ctx.siteId!, input.mediaId.replace(/^media:/, "")) : null;
    if (input.mediaId && !media) throw invalid("That file isn't in the media library.");
    const author = resolveAuthor(ctx, input.author);
    const captured = input.capturedAt ? Date.parse(input.capturedAt) : NaN;
    const extracted = extractFacts(text);
    const label = KIND_LABEL[input.kind];
    return {
      summary: `Save ${author ? `${author.name}’s` : "a"} ${label}${input.topic ? ` about ${input.topic}` : ""}`,
      invisible: true,
      payload: {
        id: id("evd"),
        kind: input.kind,
        text,
        topic: (input.topic ?? "").trim(),
        authorId: author?.id ?? null,
        authorName: author?.name ?? null,
        mediaId: media?.id ?? null,
        capturedAt: Number.isNaN(captured) ? nowIso() : new Date(captured).toISOString(),
        extracted,
        brainId: text ? id("brn") : null,
      } satisfies AddPayload,
    };
  },
  apply(ctx, p: AddPayload) {
    const siteId = ctx.siteId!;
    const now = nowIso();
    ctx.db.transaction(() => {
      ctx.db
        .query("INSERT INTO evidence (id, site_id, author_id, kind, topic, text, media_id, extracted, captured_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(p.id, siteId, p.authorId, p.kind, p.topic, p.text, p.mediaId, JSON.stringify(p.extracted), p.capturedAt, now);
      if (p.brainId) {
        const who = p.authorName ?? "An author";
        const about = p.topic ? ` on ${p.topic}` : "";
        const body = p.extracted.facts.length ? p.extracted.summary : p.text.length > 280 ? `${p.text.slice(0, 277)}…` : p.text;
        ctx.db
          .query("INSERT INTO brain (id, site_id, kind, text, source, verified_at, created_at) VALUES (?, ?, 'fact', ?, ?, ?, ?)")
          .run(p.brainId, siteId, `${who}'s ${KIND_LABEL[p.kind]}${about} (${p.capturedAt.slice(0, 10)}): ${body}`, `evidence:${p.id}`, now, now);
      }
    })();
    return { result: getEvidence(ctx, p.id), undo: { id: p.id, brainId: p.brainId } };
  },
  undo(ctx, u: { id: string; brainId: string | null }) {
    const now = nowIso();
    ctx.db.query("UPDATE evidence SET deleted_at = ? WHERE id = ? AND site_id = ?").run(now, u.id, ctx.siteId!);
    if (u.brainId) ctx.db.query("UPDATE brain SET deleted_at = ? WHERE id = ? AND site_id = ?").run(now, u.brainId, ctx.siteId!);
  },
});

defineAction({
  name: "evidence.list",
  title: "List captured evidence",
  description: "Lists photos, voice notes, test logs, receipts and notes authors captured, newest first. Filter by author, topic or kind.",
  permission: "read",
  risk: "read",
  input: z.object({
    author: z.string().optional(),
    topic: z.string().optional().describe("Words from the topic or text, e.g. “oak stand”"),
    kind: z.enum(EVIDENCE_KINDS).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  run(ctx, input) {
    const where = ["site_id = ?", "deleted_at IS NULL"];
    const args: (string | number)[] = [ctx.siteId!];
    if (input.author) {
      const a = findAuthor(ctx.db, ctx.siteId!, input.author);
      if (!a) return [];
      where.push("author_id = ?");
      args.push(a.id);
    }
    if (input.kind) {
      where.push("kind = ?");
      args.push(input.kind);
    }
    for (const w of (input.topic ?? "").toLowerCase().split(/\s+/).filter((x) => x.length > 1)) {
      where.push("(lower(topic) LIKE ? OR lower(text) LIKE ?)");
      args.push(`%${w}%`, `%${w}%`);
    }
    args.push(input.limit ?? 50);
    return ctx.db
      .query(`SELECT * FROM evidence WHERE ${where.join(" AND ")} ORDER BY captured_at DESC LIMIT ?`)
      .all(...args)
      .map((r) => rowToEvidence(ctx, r));
  },
});

function evidenceBlock(ev: Evidence): Block {
  const text = ev.text || ev.media?.caption || ev.media?.alt || ev.topic || KIND_LABEL[ev.kind];
  return block({ type: "evidence", evidenceId: ev.id, kind: ev.kind, text, ...(ev.media ? { media: ev.media.id } : {}) });
}

defineAction({
  name: "evidence.attach",
  title: "Add evidence to a post",
  description:
    "Puts a piece of evidence (the author's photo, test result or own words) into a post, after a given section or at the end. On a draft this happens right away; on a live post it is an edit with a diff, proposed like any other refresh.",
  permission: "write",
  risk: "reversible",
  trust: "refresh",
  input: z.object({ entryId: z.string(), evidenceId: z.string(), afterBlockId: z.string().optional() }),
  async prepare(ctx, input) {
    const entry = getEntry(ctx.db, ctx.siteId!, input.entryId);
    const ev = getEvidence(ctx, input.evidenceId);
    if (entry.body.blocks.some((b) => b.type === "evidence" && b.evidenceId === ev.id)) throw new TqError("conflict", `“${entry.title}” already shows that evidence.`);
    const blocks = [...entry.body.blocks];
    let at = blocks.length;
    if (input.afterBlockId) {
      const i = blocks.findIndex((b) => b.id === input.afterBlockId);
      if (i < 0) throw invalid("That section isn't in this post any more. Reload and try again.");
      at = i + 1;
    }
    blocks.splice(at, 0, evidenceBlock(ev));
    const update = getAction("posts.update") as WriteAction;
    const summary = `Add ${ev.authorName ? `${ev.authorName}’s` : "the"} ${KIND_LABEL[ev.kind]} to “${entry.title}”`;
    const prepared = await update.prepare(ctx, { id: entry.id, body: { v: 1, blocks }, substantive: false, reason: summary });
    return { ...prepared, summary };
  },
  apply(ctx, payload) {
    return (getAction("posts.update") as WriteAction).apply(ctx, payload);
  },
  undo(ctx, u) {
    return (getAction("posts.update") as WriteAction).undo!(ctx, u);
  },
});

// ---------- The weekly nudge ----------

const LEADING = /^(?:how to (?:pick|choose|buy|build|assemble|fix|clean|set up|install|use|measure|mount)|how to|why (?:i|we)|why|what|when|which|where|the best|best|my|our|a review of|review of|is|are|can|should|do|does|i tested|we tested|testing)\s+/i;

/** "How to pick a TV stand for a small room" -> "the TV stand". */
export function subjectOf(title: string): string {
  let t = title.split(/[:—–|?(]/)[0]!.trim();
  for (let i = 0; i < 3; i++) t = t.replace(LEADING, "");
  t = t
    .replace(/\s+(?:review|guide|tips|ideas|explained|compared|test|tested)\b.*$/i, "")
    .replace(/\s+(?:vs\.?|versus|for|in|under|with|that|after|on)\s.*$/i, "")
    .replace(/^(?:a|an|the|your|my|our)\s+/i, "")
    .trim();
  const words = t.split(/\s+/).slice(0, 5).join(" ");
  if (!words) return "it";
  const plural = /s$/i.test(words) && !/ss$/i.test(words);
  return plural ? words : `the ${words}`;
}

function nudgeFor(title: string, topic: string): { kind: EvidenceKind; ask: string } {
  const subject = topic ? (/^(the|a|an)\s/i.test(topic) ? topic : `the ${topic}`) : subjectOf(title);
  const t = title.toLowerCase();
  if (/\b(review|tested|test|vs|versus|durab|how strong|held|load|weight)\b/.test(t)) {
    return { kind: "test", ask: `How did ${subject} hold up? A quick test note (what it held, where it gave) is enough.` };
  }
  if (/\b(price|cost|deal|cheap|budget|worth|spend|afford)\b/.test(t)) return { kind: "receipt", ask: `Got the receipt for ${subject}? A photo of it proves what you paid.` };
  if (/\b(mistake|lesson|regret|why|opinion|wish)\b/.test(t)) return { kind: "voice", ask: `Got 30 seconds on what surprised you about ${subject}? A voice note is plenty.` };
  const state = /\b(assembl|build|install|set ?up|stand|shelf|shelves|desk|cabinet|table|rack|mount|kit)/.test(t) ? "assembled" : "in use";
  return { kind: "photo", ask: `Got a photo of ${subject} ${state}?` };
}

defineAction({
  name: "evidence.nudge",
  title: "What should authors capture this week?",
  description:
    "Suggests one thing per author to capture this week (a photo, a test note, a receipt or a voice note), based on their drafts that don't have any first-hand evidence yet.",
  permission: "read",
  risk: "read",
  input: z.object({ author: z.string().optional() }),
  run(ctx, input) {
    const authors = (input.author ? [resolveAuthor(ctx, input.author)!] : listAuthors(ctx.db, ctx.siteId!)).filter((a) => a && !a.isPersona);
    const out: { authorId: string; authorName: string; entryId: string | null; title: string | null; kind: EvidenceKind; ask: string }[] = [];
    for (const a of authors) {
      const drafts = listEntries(ctx.db, ctx.siteId!, { authorId: a.id, status: ["draft", "scheduled"], limit: 50 }).sort((x, y) => y.modifiedAt.localeCompare(x.modifiedAt));
      const lacking = drafts.find((e) => !e.body.blocks.some((b) => b.type === "evidence" || (b.type === "image" && b.src.startsWith("media:"))));
      if (lacking) {
        const n = nudgeFor(lacking.title, "");
        out.push({ authorId: a.id, authorName: a.name, entryId: lacking.id, title: lacking.title, ...n });
        continue;
      }
      if (!drafts.length) {
        const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
        const recent = ctx.db.query<{ n: number }, [string, string, string]>("SELECT COUNT(*) AS n FROM evidence WHERE site_id = ? AND author_id = ? AND captured_at >= ? AND deleted_at IS NULL").get(ctx.siteId!, a.id, since);
        if (!recent?.n) {
          const first = a.name.split(/\s+/)[0];
          out.push({ authorId: a.id, authorName: a.name, entryId: null, title: null, kind: "photo", ask: `${first}, got a photo of something you used or fixed this week? It could be the start of the next post.` });
        }
      }
    }
    return out;
  },
});

// ---------- Upload route and transcription ----------

/** Transcribes a voice note with a Whisper-compatible endpoint, when an OpenAI-compatible key is configured. */
export async function transcribe(rt: Runtime, audio: Blob, filename: string): Promise<string | null> {
  const key = rt.config.models.openaiKey;
  if (!key) return null;
  const base = (rt.config.models.openaiBaseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const form = new FormData();
  form.append("file", audio, filename || "voice-note.webm");
  form.append("model", process.env.TQ_TRANSCRIBE_MODEL ?? "whisper-1");
  form.append("response_format", "json");
  try {
    const res = await currentFetch()(`${base}/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) {
      console.error(`[tidequill] transcription failed with ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { text?: string };
    return body.text?.trim() || null;
  } catch (err) {
    console.error("[tidequill] transcription failed:", (err as Error).message);
    return null;
  }
}

function field(form: FormData, name: string): string | undefined {
  const v = form.get(name);
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function evidenceRoutes(app: Hono<Env>, rt: Runtime) {
  app.post("/api/evidence", async (c) => {
    const ctx = requestCtx(c);
    if (!ctx.siteId) throw invalid("Pick a site first.");
    const form = await c.req.formData().catch(() => {
      throw invalid("Send the evidence as a form upload (multipart/form-data).");
    });
    const kind = field(form, "kind") ?? "note";
    if (!(EVIDENCE_KINDS as readonly string[]).includes(kind)) throw invalid(`“${kind}” isn't a kind of evidence. Use photo, voice, note, test, receipt or video.`);
    const file = form.get("file");
    let text = field(form, "text");
    let mediaId: string | undefined;
    let capturedAt = field(form, "capturedAt");
    if (file && typeof file !== "string" && file.size > 0) {
      if (file.size > MAX_UPLOAD_BYTES) throw new TqError("invalid", `That file is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_UPLOAD_BYTES)}.`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { media } = await ingest(ctx, { bytes, filename: file.name || `${kind}`, mime: file.type });
      mediaId = media.id;
      if (!capturedAt) {
        const taken = ctx.db.query<{ taken_at: string | null }, [string]>("SELECT taken_at FROM media_meta WHERE media_id = ?").get(media.id);
        capturedAt = taken?.taken_at ?? undefined;
      }
      if (!text && (kind === "voice" || kind === "video") && (media.kind === "audio" || media.kind === "video")) {
        text = (await transcribe(rt, file, file.name)) ?? undefined;
      }
    }
    const res = await invoke(ctx, "evidence.add", {
      kind,
      text,
      author: field(form, "authorId") ?? field(form, "author"),
      topic: field(form, "topic"),
      mediaId,
      capturedAt,
    });
    if (res.status === "applied") return c.json({ evidence: res.result });
    return c.json(res);
  });
}
