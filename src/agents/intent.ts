import { listAuthors, type Author } from "../core/authors.ts";
import { entryBySlug, findEntry, listEntries, type Entry } from "../core/entries.ts";
import { slugify } from "../core/ids.ts";
import { getSite } from "../core/sites.ts";
import type { Ctx, Site, SiteSettings } from "../core/types.ts";
import { allFacts } from "./knowledge.ts";
import { effectiveTokens, lookModifiers, tweakTokens } from "./look.ts";
import { fitInput, hasAction } from "./optional.ts";
import { freeSlots, nextWeekStart } from "./pipeline.ts";
import { capitalize, listJoin, overlap, parseCount } from "./text.ts";
import { angleTitles } from "./writer.ts";

/**
 * The offline intent parser. Turns what a person says into plan steps: real
 * action names with inputs, plus a few Ask-only steps ("ask.*") for things the
 * agent answers or hands back as a button rather than doing (help, undo,
 * approve, what's waiting). Multi-intent sentences ("…, then write three
 * posts…") become multi-step plans.
 */

export interface PlanStep {
  /** An action name, or an Ask-only step: ask.help, ask.undo, ask.approve, ask.waiting, ask.done, ask.navigate, ask.ask_me_first, ask.stop_asking, ask.reply. */
  action: string;
  input: Record<string, unknown>;
  /** One line on the plan card: "Draft “How to choose a walnut TV stand” as Fred". */
  text: string;
  why?: string;
  /** Command bar hint: what happens when you run it. */
  hint?: string;
}

export interface AskContext {
  entryId?: string;
  blockId?: string;
  path?: string;
  screen?: string;
}

export interface ParsedIntent {
  steps: PlanStep[];
  /** Clauses nothing understood. */
  unknown: string[];
}

interface World {
  ctx: Ctx;
  site: Site;
  authors: Author[];
  entry: Entry | null;
  context: AskContext;
}

const VERBS = "make|write|draft|remember|show|set|publish|change|undo|add|redirect|rewrite|ask|stop|refresh|turn|give|switch|use|create|hide|allow|block|lower|raise|update|approve|open|go|tell|list|find|learn|note|never|always";
const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function contextEntry(ctx: Ctx, context: AskContext): Entry | null {
  if (!ctx.siteId) return null;
  if (context.entryId) return findEntry(ctx.db, ctx.siteId, context.entryId);
  if (context.path) {
    const slug = context.path.replace(/^\/+|\/+$/g, "").split("/").pop() ?? "";
    return entryBySlug(ctx.db, ctx.siteId, slug || "home");
  }
  return null;
}

/** Finds an author named in text ("Fred", "Fred's", "fred laurent"). */
export function authorIn(text: string, authors: Author[]): Author | null {
  const t = text.toLowerCase();
  let best: Author | null = null;
  for (const a of authors) {
    const full = a.name.toLowerCase();
    const first = full.split(/\s+/)[0]!;
    if (new RegExp(`\\b${escape(full)}\\b`).test(t)) return a;
    if (first.length > 2 && !["the", "editorial"].includes(first) && new RegExp(`\\b${escape(first)}(?:['’]s)?\\b`).test(t)) best ??= a;
  }
  if (!best && /\beditorial team\b/.test(t)) best = authors.find((a) => /editorial team/i.test(a.name)) ?? null;
  return best;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fmtSlot = (iso: string) => {
  const d = new Date(iso);
  return `${SHORT_DAYS[d.getUTCDay()]} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

/** "Tue, Thu and Sat at 09:00" */
export function slotsSentence(slots: string[]): string {
  if (!slots.length) return "";
  const times = new Set(slots.map((s) => s.slice(11, 16)));
  if (times.size === 1) return `${listJoin(slots.map((s) => SHORT_DAYS[new Date(s).getUTCDay()]!))} at ${[...times][0]!.replace(/^0/, "")}`;
  return listJoin(slots.map(fmtSlot));
}

// ---------- Splitting ----------

export function splitClauses(message: string): string[] {
  const text = message.replace(/\s+/g, " ").trim();
  // Sentence breaks are case-sensitive (“Co. stand” is one sentence); "then" and semicolons split too.
  const sentencesOut = text
    .split(/(?<=[a-z0-9”")][.!?])\s+(?=[A-Z“"])/)
    .flatMap((x) => x.split(/\s*;\s*|,?\s+(?:and\s+)?then\s+/i))
    .map((s) => s.replace(/^(then|also|and|plus|after that|next)[,\s]+/i, "").replace(/[.!]+$/, "").trim())
    .filter(Boolean);
  return sentencesOut;
}

/** Splits a clause at "and <verb>" / ", <verb>" boundaries, e.g. "make Fred funnier and write a post about cables". */
function splitAtVerbs(clause: string): string[] {
  const re = new RegExp(`(?:,\\s*(?:and\\s+)?|\\s+and\\s+(?:also\\s+)?)(?=(?:please\\s+)?(?:${VERBS})\\b)`, "i");
  return clause.split(re).map((s) => s.trim()).filter(Boolean);
}

// ---------- Parsing ----------

export function parseIntent(ctx: Ctx, message: string, context: AskContext = {}): ParsedIntent {
  const site = getSite(ctx.db, ctx.siteId!);
  const world: World = { ctx, site, authors: listAuthors(ctx.db, site.id), entry: contextEntry(ctx, context), context };
  const steps: PlanStep[] = [];
  const unknown: string[] = [];
  // Slots already promised to earlier write steps in this plan.
  const reserved: string[] = [];
  for (const clause of splitClauses(message)) {
    const whole = parseClause(world, clause, reserved);
    const parts = splitAtVerbs(clause);
    if (parts.length > 1) {
      const each = parts.map((p) => parseClause(world, p, reserved));
      if (each.every(Boolean) && (!whole || each.length > 1)) {
        for (const s of each) steps.push(...s!);
        continue;
      }
    }
    if (whole) steps.push(...whole);
    else unknown.push(clause);
  }
  return { steps, unknown };
}

type Rule = (w: World, c: string, lower: string, reserved: string[]) => PlanStep[] | null;

function parseClause(w: World, clause: string, reserved: string[]): PlanStep[] | null {
  const c = clause.replace(/^(please|can you|could you|would you|i want you to|i'd like you to|tidequill,?)\s+/i, "").replace(/\?$/, "").trim();
  const lower = c.toLowerCase();
  for (const rule of RULES) {
    const r = rule(w, c, lower, reserved);
    if (r) return r;
  }
  return null;
}

const help: Rule = (_w, c, lower) => {
  if (!/^(how (do|can|would|should) (i|we)|how to|where (do|can) i|is there a way to|what('s| is| are| does) (a |an |the )?(ready light|site brain|earned autonomy|ask me first|proposals?|evidence|answer blocks?|budget|trust|voice match|snapshots?)|help\b|why (did|does|is))/.test(lower)) return null;
  return [{ action: "ask.help", input: { question: c }, text: "Answer: " + c }];
};

const undo: Rule = (_w, _c, lower) => (/^(undo|revert|roll back|take (that|it) back|reverse that)\b/.test(lower) ? [{ action: "ask.undo", input: {}, text: "Find the last change to undo", hint: "Shows the last change with an Undo button" }] : null);

const approve: Rule = (_w, _c, lower) =>
  /^(approve|accept|ok(ay)? (it|that|them|all)|yes,? (approve|publish|go ahead)|go ahead and (approve|publish)|publish (it|them|all of them|everything))\b/.test(lower) ? [{ action: "ask.approve", input: {}, text: "Show what's waiting for approval" }] : null;

const waiting: Rule = (_w, _c, lower) => {
  if (/(what('s| is) waiting|what needs me|anything (for me|waiting|to approve|to review)|what do you need|what('s| is) on today|^today$|show (me )?today|what should i (approve|review)|inbox)/.test(lower)) return [{ action: "ask.waiting", input: {}, text: "Check what's waiting for you" }];
  if (/(what (did|have) you (do|done|been doing)|what happened|what changed|what did the (team|site) do|recent changes|what('s| is) new)/.test(lower)) return [{ action: "ask.done", input: {}, text: "Summarize what the team did" }];
  return null;
};

const settingsShow: Rule = (_w, _c, lower) => {
  if (/\b(show|read|tell|list|what are|see)\b.*\bsettings\b|^(my )?settings$/.test(lower)) return [{ action: "settings.show", input: {}, text: "Read your settings back", hint: "Every setting, as a sentence" }];
  if (/(what do you (handle|do) on your own|what can you do (alone|on your own)|trust (earned|status|so far)|how much do you trust|autonomy)/.test(lower)) return [{ action: "autonomy.status", input: {}, text: "Show the trust earned so far" }];
  return null;
};

const askFirst: Rule = (_w, _c, lower) => {
  if (/^(stop|don'?t|do not|no longer|quit) ask(ing)? (me )?(first|before)|turn off ask me first|^stop asking( me)?$/.test(lower)) return [{ action: "ask.stop_asking", input: {}, text: "Turn off Ask me first", hint: "You flip the switch; I won't do it for you" }];
  if (/^(always )?ask (me )?(first|before (every|any)thing|before you change)|turn on ask me first|^ask me first$/.test(lower)) return [{ action: "ask.ask_me_first", input: {}, text: "Turn on Ask me first", hint: "Every change waits for your approval" }];
  return null;
};

function settingsStep(w: World, patch: Partial<SiteSettings>, text: string): PlanStep[] {
  void w;
  return [{ action: "settings.update", input: patch as Record<string, unknown>, text, hint: "Read back as a sentence before it changes" }];
}

const budget: Rule = (w, _c, lower) => {
  if (!/\bbudget\b/.test(lower)) return null;
  const m = lower.match(/\$\s?(\d+(?:\.\d+)?)|\b(\d+(?:\.\d+)?)\s*(?:dollars|usd|bucks|\$)/) ?? lower.match(/\bto\s+(\d+(?:\.\d+)?)\b/);
  if (!m) return null;
  const amount = Number(m[1] ?? m[2]);
  return settingsStep(w, { monthlyBudgetUsd: amount }, `Set the agent budget to $${amount} a month`);
};

function parseDays(text: string): number[] | null {
  const t = text.toLowerCase();
  if (/\b(every ?day|daily|each day)\b/.test(t)) return [0, 1, 2, 3, 4, 5, 6];
  if (/\bweekdays\b/.test(t)) return [1, 2, 3, 4, 5];
  if (/\bweekends?\b/.test(t)) return [0, 6];
  const days = DAY_NAMES.map((d, i) => (new RegExp(`\\b${d.slice(0, 3)}(${d.slice(3)})?s?\\b`).test(t) ? i : -1)).filter((i) => i >= 0);
  return days.length ? days : null;
}

function parseTime(text: string): string | null {
  const m = text.toLowerCase().match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ?? "00";
  if (m[3]?.startsWith("p") && h < 12) h += 12;
  if (m[3]?.startsWith("a") && h === 12) h = 0;
  if (h > 23 || Number(min) > 59) return null;
  return `${String(h).padStart(2, "0")}:${min}`;
}

const cadence: Rule = (w, c, lower) => {
  if (!/\b(publish|post|schedule|go out|new posts)\b/.test(lower) || /\b(write|draft)\b/.test(lower)) return null;
  const days = parseDays(c);
  if (!days) return null;
  const time = parseTime(c) ?? w.site.settings.cadence.time;
  const names = days.map((d) => capitalize(DAY_NAMES[d]!) + "s");
  return settingsStep(w, { cadence: { days, time } }, `Publish new posts on ${listJoin(names)} at ${time}`);
};

const miscSettings: Rule = (w, _c, lower) => {
  if (/\bhide\b.*\bai (line|disclosure|note)\b|\bturn off\b.*\bai disclosure\b/.test(lower)) return settingsStep(w, { aiDisclosure: false }, "Hide the AI-assistance line under bylines");
  if (/\bshow\b.*\bai (line|disclosure|note)\b|\bturn on\b.*\bai disclosure\b/.test(lower)) return settingsStep(w, { aiDisclosure: true }, "Show the AI-assistance line under bylines");
  if (/\b(block|stop|disallow|forbid)\b.*\bai training\b/.test(lower)) return settingsStep(w, { allowTrainingCrawlers: false }, "Block AI companies from training on the site");
  if (/\ballow\b.*\bai training\b/.test(lower)) return settingsStep(w, { allowTrainingCrawlers: true }, "Allow AI companies to train on the site");
  const min = lower.match(/\b(lower|raise|set|change)\b.*\b(answer[- ]ready|aeo|human|seo|search[- ]ready)\b.*\bminimum\b.*?\b(\d{1,3})\b/) ?? lower.match(/\b(answer[- ]ready|aeo|human|seo|search[- ]ready)\b\s+minimum\s+to\s+(\d{1,3})/);
  if (min) {
    const which = (min[2] && isNaN(Number(min[2])) ? min[2] : min[1])!;
    const n = Number(min[3] ?? min[2]);
    const key = /answer|aeo/.test(which) ? "aeo" : /seo|search/.test(which) ? "seo" : "human";
    return settingsStep(w, { readyMinimums: { [key]: n } as any }, `Set the ${key === "aeo" ? "answer-ready" : key === "seo" ? "search-ready" : "human"} minimum to ${n}`);
  }
  const tz = lower.match(/\btime ?zone\b.*\bto\s+([a-z_]+\/[a-z_]+(?:\/[a-z_]+)?)/i);
  if (tz) {
    const zone = tz[1]!.split("/").map((p) => p.split("_").map(capitalize).join("_")).join("/");
    return settingsStep(w, { timezone: zone }, `Use the ${zone} time zone`);
  }
  return null;
};

const remember: Rule = (_w, c, lower) => {
  let text: string | null = null;
  const m = c.match(/^(?:remember|note|keep in mind|don'?t forget|make a note)(?:\s+that)?[:,]?\s+(.{3,})$/i);
  if (m) text = m[1]!;
  else if (/^(never|always)\s+(recommend|say|use|mention|call|suggest|claim|link)\b/.test(lower)) text = c;
  if (!text) return null;
  text = capitalize(text.replace(/[.]?$/, "."));
  const t = text.toLowerCase();
  const kind = /\b(never|don'?t|do not|always|must|avoid|no one should)\b/.test(t)
    ? "claim_rule"
    : /\b(we|i) (recommend|prefer|think|believe|like|love|hate|avoid|favou?r)\b|\bbetter than\b|\bshould\b/.test(t)
      ? "position"
      : /\b(our (audience|readers|tone)|readers are|this site is|we are a)\b/.test(t)
        ? "identity"
        : /\d/.test(t)
          ? "fact"
          : "position";
  const label = kind === "claim_rule" ? "claim rule" : kind === "identity" ? "identity note" : kind;
  return [{ action: "brain.add", input: { kind, text }, text: `Remember (${label}): ${text}`, hint: "Every agent reads Site Brain first" }];
};

const price: Rule = (w, c, lower) => {
  const m = c.match(/(?:change|update|set|make)\s+(?:the\s+)?price\s+(?:of|for)\s+(?:the\s+)?(.+?)\s+to\s+(\$?\s?\d[\d,]*(?:\.\d{1,2})?)/i) ?? c.match(/^(?:the\s+)?(.+?)\s+(?:now\s+)?costs\s+(\$\s?\d[\d,]*(?:\.\d{1,2})?)(?:\s+now)?$/i);
  if (!m || !/price|costs/.test(lower)) return null;
  const name = m[1]!.trim();
  const value = m[2]!.replace(/\s/g, "").replace(/^(\d)/, "$$$1");
  const facts = allFacts(w.ctx.db, w.site.id)
    .map((f) => ({ f, s: overlap(name, `${f.label} ${f.key.replace(/[.-]/g, " ")}`) + (/price/i.test(`${f.key} ${f.label}`) ? 0.2 : 0) }))
    .filter((x) => x.s >= 0.5)
    .sort((a, b) => b.s - a.s);
  const fact = facts[0]?.f;
  if (fact) {
    const input = fitInput("facts.update", [{ key: fact.key, value }, { id: fact.id, value }, { fact: fact.key, value }, { key: fact.key, value, reason: "Price changed" }]);
    if (input) return [{ action: "facts.update", input: input as Record<string, unknown>, text: `Change ${fact.label} from ${fact.value} to ${value} on every page that uses it`, hint: "Every page that uses it is fixed" }];
  } else {
    const key = `${slugify(name, 50)}.price`;
    const input = fitInput("facts.set", [{ key, label: `${capitalize(name)} price`, value, kind: "price" }, { key, label: `${capitalize(name)} price`, value }, { key, value }]);
    if (input) return [{ action: "facts.set", input: input as Record<string, unknown>, text: `Track the ${name} price (${value}) in the fact ledger` }];
  }
  return [
    {
      action: "ask.reply",
      input: { text: `I can't find a tracked price for “${name}”, and the fact ledger isn't available on this install. Want me to remember it in Site Brain instead? Say “Remember that ${name} costs ${value}.”` },
      text: `Update the ${name} price`,
    },
  ];
};

const domain: Rule = (_w, _c, lower) => {
  const m = lower.match(/\b(?:add|connect|use|point)\s+(?:the\s+)?(?:domain\s+)?((?:[a-z0-9-]+\.)+[a-z]{2,})\b/);
  if (!m || !/domain|connect|add/.test(lower)) return null;
  return [{ action: "sites.add_domain", input: { hostname: m[1]! }, text: `Add the domain ${m[1]}`, hint: "Points it at this site" }];
};

const redirect: Rule = (_w, c) => {
  const m = c.match(/\bredirect\s+(\S+)\s+to\s+(\S+)/i);
  if (!m) return null;
  const norm = (p: string) => (/^https?:/i.test(p) ? p : `/${p.replace(/^\/+/, "")}`);
  return [{ action: "redirects.create", input: { from: norm(m[1]!), to: norm(m[2]!) }, text: `Redirect ${norm(m[1]!)} to ${norm(m[2]!)}`, hint: "Visitors and search engines follow it" }];
};

/** "funnier" -> "a bit funnier", for labels like the prototype's "Make Fred’s voice a bit funnier". */
function softInstruction(ins: string): string {
  const t = ins.trim().replace(/[.!]+$/, "");
  if (/^(funnier|more formal|less formal|more casual|simpler|warmer|drier|punchier|less jokey|less funny|more serious)$/i.test(t)) return `a bit ${t.toLowerCase()}`;
  return t;
}

const voice: Rule = (w, c, lower) => {
  if (!w.authors.length) return null;
  const a = authorIn(c, w.authors);
  if (!a) return null;
  const first = a.name.split(/\s+/)[0]!;
  const nameRe = `(?:${escape(a.name)}|${escape(first)})`;
  let instruction: string | null = null;
  const m1 = c.match(new RegExp(`^(?:make|let)\\s+${nameRe}(?:['’]s\\s+voice|['’]s\\s+writing)?\\s+(.+)$`, "i"));
  const m2 = c.match(new RegExp(`^${nameRe}(?:['’]s\\s+(?:voice|writing))?\\s+(?:should|needs to|must|could|can)\\s+(?:be\\s+|sound\\s+)?(.+)$`, "i"));
  const m3 = c.match(new RegExp(`^${nameRe}\\s+(never\\s+says?\\s+.+|should never say\\s+.+)$`, "i"));
  const m4 = c.match(new RegExp(`^(?:give|use)\\s+${nameRe}\\s+(shorter sentences|longer sentences|more humou?r|less humou?r|british spelling|american spelling)$`, "i"));
  const m5 = c.match(new RegExp(`^(.+?)\\s+for\\s+${nameRe}(?:['’]s voice)?$`, "i"));
  if (m1) instruction = m1[1]!;
  else if (m3) instruction = m3[1]!.replace(/^should never say/i, "never say").replace(/^never says/i, "never say");
  else if (m2) instruction = m2[1]!;
  else if (m4) instruction = m4[1]!;
  else if (m5 && /\b(funn|jok|humou?r|formal|casual|shorter|longer|simpler|serious|never say)\b/i.test(m5[1]!)) instruction = m5[1]!;
  if (!instruction) return null;
  // Not a voice change if it's about writing posts or the look.
  if (/\b(write|draft|post|posts|article)\b/i.test(instruction)) return null;
  if (!/\b(funn|jok|humou?r|formal|casual|relaxed|shorter|longer|short|punch|simpl|plain|serious|never|stop saying|spelling|first person|technical|detail|flowing|concise|friend|warm|dry|witty|playful|sentences)\w*/i.test(instruction)) return null;
  const soft = softInstruction(instruction);
  return [{ action: "authors.adjust_voice", input: { author: a.id, instruction: soft }, text: `Make ${first}’s voice ${soft}`, hint: "Shows a before and after; nothing changes until you approve" }];
};

const rewriteBlock: Rule = (w, c, lower) => {
  const wants = /\b(rewrite|re-write|shorter|shorten|tighten|trim|longer|expand|simpler|simplify|plainer|funnier|more formal|more casual|add a (photo|picture|image)|as \w+|in \w+['’]s voice)\b/.test(lower);
  const aboutSection = /\b(this|the|that)\s+(section|paragraph|part|bit|block|answer|intro|list)\b/.test(lower) || /^(shorter|longer|simpler|funnier|rewrite|shorten|tighten|add a (photo|picture))\b/.test(lower);
  if (!wants || !aboutSection || /\b(posts?|articles?)\s+about\b/.test(lower)) return null;
  if (!w.context.blockId || !w.entry) return [{ action: "ask.reply", input: { text: "Tap the section on your page first, then tell me what to change. I'll rewrite just that part." }, text: "Rewrite a section" }];
  const instruction = c.replace(/\b(please\s+)?(rewrite|re-write)\s+(this|the|that)\s+(section|paragraph|part|bit|block)\s*/i, "").trim() || "Rewrite";
  const instr = /^(as|in)\b/i.test(instruction) ? `Rewrite ${instruction}` : capitalize(instruction);
  return [{ action: "posts.rewrite_block", input: { id: w.entry.id, blockId: w.context.blockId, instruction: instr }, text: `${instr}: one section of “${w.entry.title}”`, hint: "Rewrites just that section; shows a diff on live posts" }];
};

function entryByWords(w: World, words: string): Entry | null {
  const scored = listEntries(w.ctx.db, w.site.id, { limit: 500 })
    .map((e) => ({ e, s: overlap(words, e.title) }))
    .filter((x) => x.s >= 0.5)
    .sort((a, b) => b.s - a.s);
  return scored[0]?.e ?? null;
}

const refresh: Rule = (w, c, lower) => {
  if (!/^(refresh|update|freshen|re-?check)\b/.test(lower) || /\b(price|budget|settings?|domain|voice|tokens?|look)\b/.test(lower)) return null;
  const rest = c.replace(/^(refresh|update|freshen|re-?check)\s+/i, "").replace(/^(the|my|this|that)\s+/i, "").replace(/^(post|page|article|guide)\s*(about|on|called)?\s*/i, "").replace(/["“”]/g, "").trim();
  const e = !rest || /^(this|it)$/i.test(rest) ? w.entry : entryByWords(w, rest) ?? (/(this|it)\b/.test(lower) ? w.entry : null);
  if (!e) return null;
  return [{ action: "posts.refresh", input: { id: e.id }, text: `Refresh “${e.title}”`, hint: "Proposes only the sections that need it" }];
};

const write: Rule = (w, c, lower, reserved) => {
  const m =
    c.match(/^(?:write|draft|create|make|start|do)\s+(?:me\s+|us\s+)?(an?|one|two|three|four|five|six|seven|eight|nine|ten|\d+|some|a few|a couple of)?\s*(?:more\s+|new\s+|short\s+|quick\s+|blog\s+)*(?:posts?|articles?|guides?|reviews?|pieces?|drafts?|stories|explainers?)\b\s*(.*)$/i) ??
    c.match(/^(?:write|draft)\s+(?:something\s+)?(about|on)\s+(.+)$/i);
  if (!m) return null;
  const countWord = m[1] && !/^(about|on)$/i.test(m[1]) ? m[1] : undefined;
  let rest = (m[1] && /^(about|on)$/i.test(m[1]) ? `about ${m[2]}` : m[2] ?? "").trim();
  const count = Math.max(1, Math.min(6, parseCount(countWord) ?? 1));

  // Author: "as Fred", "by Fred", "in Fred's voice".
  let author: Author | null = null;
  const am = rest.match(/\b(?:as|by|in|from)\s+([\w'’-]+(?:\s+[A-Z][\w'-]+)?)(?:['’]s)?(?:\s+voice)?\b/i);
  if (am) {
    author = authorIn(am[0], w.authors);
    if (author) rest = rest.replace(am[0], " ");
  }
  rest = rest.replace(/\bin\s+[\w'’-]+['’]s\s+voice\b/i, " ");

  // Timing.
  let schedule: "next_week" | "tomorrow" | "none" | "next_slot" = "next_slot";
  if (/\b(for |over )?next week\b/i.test(rest)) schedule = "next_week";
  else if (/\btomorrow\b/i.test(rest)) schedule = "tomorrow";
  else if (/\b(as (a )?drafts?|don'?t (schedule|publish)|just drafts?|no schedule)\b/i.test(rest)) schedule = "none";
  rest = rest.replace(/\b(for |over )?(next week|this week|tomorrow)\b/gi, " ").replace(/\b(as (a )?drafts?|don'?t (schedule|publish)( (it|them))?|just drafts?|no schedule)\b/gi, " ");

  const tm = rest.match(/\b(?:about|on|covering)\s+(.+)$/i);
  let topic = (tm ? tm[1]! : rest).replace(/\s+/g, " ").replace(/^[,:\s-]+|[,:\s.-]+$/g, "").replace(/^(the topic of|how)\s+/i, (x) => (/^how/i.test(x) ? x : "")).trim();
  if (!topic || topic.length < 3) return [{ action: "ask.reply", input: { text: "Happy to. What should the post be about? For example: “Write a post about hiding TV cables as Fred.”" }, text: "Write a post" }];
  topic = topic.replace(/^(a|an)\s+(post|article)\s+(about|on)\s+/i, "");

  const site = w.site;
  let slots: string[] = [];
  if (schedule === "next_week") slots = freeSlots(w.ctx.db, site, count + reserved.length, nextWeekStart()).filter((s) => !reserved.includes(s)).slice(0, count);
  else if (schedule === "tomorrow") {
    const t = new Date();
    t.setUTCDate(t.getUTCDate() + 1);
    t.setUTCHours(0, 0, 0, 0);
    slots = freeSlots(w.ctx.db, site, count + reserved.length, t).filter((s) => !reserved.includes(s)).slice(0, count);
  } else if (schedule === "next_slot" && count > 1) slots = freeSlots(w.ctx.db, site, count + reserved.length).filter((s) => !reserved.includes(s)).slice(0, count);
  reserved.push(...slots);

  const titles = count > 1 ? angleTitles(topic, count) : [];
  const steps: PlanStep[] = [];
  for (let i = 0; i < count; i++) {
    const title = titles[i];
    const slot = slots[i];
    const input: Record<string, unknown> = { topic, ...(title ? { title } : {}), ...(author ? { author: author.id } : {}), schedule: schedule === "none" ? "none" : slot ?? "next_slot" };
    const when = schedule === "none" ? " as a draft" : slot ? `, for ${fmtSlot(slot)}` : "";
    steps.push({ action: "posts.write", input, text: `Draft “${title ?? capitalize(topic)}”${author ? ` as ${author.name.split(" ")[0]}` : ""}${when}`, hint: "The draft waits on Today; nothing goes live until you approve" });
  }
  return steps;
};

const LOOK_WORDS = /\b(look|feel|feels|colou?rs?|palette|fonts?|typefaces?|headings?|serif|sans|text size|bigger text|larger text|smaller text|darker|lighter|dark mode|light mode|theme|design|warmer|cooler|premium|luxur\w*|calm\w*|playful|scandinavian|nordic|minimal\w*|modern|elegant|cozy|cosy|editorial|accent|background|neutrals|brighter)\b/;

const look: Rule = (w, c, lower) => {
  if (!LOOK_WORDS.test(lower)) return null;
  if (!/^(make|give|switch|change|use|try|let'?s|i want|can it|the site should|more|less|warmer|darker|lighter|bigger|serif|update the look|restyle|redesign|show me (some )?looks|new look)\b/.test(lower) && !/\b(the site|it|my site|the look|the design|walnut\w*|the theme)\b/.test(lower)) return null;
  // Avoid stealing voice and writing requests.
  if (/\b(posts?|articles?|voice)\b/.test(lower) && !/\b(look|feel|design|theme|colou?rs?|fonts?)\b/.test(lower)) return null;
  const mods = lookModifiers(c);
  const site = w.site;
  if (mods.specific && hasAction("look.update_tokens")) {
    const { patch, changes } = tweakTokens(effectiveTokens(w.ctx, site), c);
    const input = Object.keys(patch).length ? fitInput("look.update_tokens", [{ tokens: patch }, patch, { changes: patch }, { tokens: patch, reason: c }]) : null;
    if (input)
      return [
        {
          action: "look.update_tokens",
          input: input as Record<string, unknown>,
          text: `Update the look: ${changes.length} token change${changes.length === 1 ? "" : "s"} (${listJoin(changes.map((x) => x.split(" ")[0]!.toLowerCase()).filter((x, i, a) => a.indexOf(x) === i))})`,
          hint: "Restyles every page; you see it before it goes live",
        },
      ];
  }
  return [{ action: "look.describe", input: { description: c }, text: "Show three looks to pick from", hint: "Three directions, all easy to read; pick one to preview" }];
};

const setup: Rule = (_w, _c, lower) => (/^(set ?up|seed|bootstrap)\s+(the|my|this)\s+site\b/.test(lower) ? [{ action: "sites.setup", input: {}, text: "Set up categories, starter pages, ideas and first drafts" }] : null);

const lists: Rule = (w, c, lower) => {
  const m = lower.match(/^(?:show|list|find|what are)(?: me)?(?: my| all| the| our)?\s+(drafts|posts|pages|scheduled posts|published posts|live posts)\b(.*)$/);
  if (!m) {
    const by = c.match(/^(?:show(?: me)?\s+)?(?:posts|articles)\s+by\s+(.+)$/i);
    if (by) {
      const a = authorIn(by[1]!, w.authors);
      if (a) return [{ action: "posts.list", input: { author: a.id }, text: `List posts by ${a.name}` }];
    }
    return null;
  }
  const kind = m[1]!;
  const input: Record<string, unknown> = {};
  if (kind === "drafts") input.status = "draft";
  if (kind === "scheduled posts") input.status = "scheduled";
  if (kind === "published posts" || kind === "live posts") input.status = "published";
  input.type = kind === "pages" ? "page" : "post";
  const by = m[2]?.match(/\bby\s+(.+)$/);
  if (by) {
    const a = authorIn(by[1]!, w.authors);
    if (a) input.author = a.id;
  }
  const about = m[2]?.match(/\b(?:about|on)\s+(.+)$/);
  if (about) input.search = about[1]!.trim();
  return [{ action: "posts.list", input, text: `List ${kind}` }];
};

const navigate: Rule = (w, c, lower) => {
  const m = lower.match(/^(?:open|go to|take me to|show me|show)\s+(?:the\s+|my\s+)?(today|settings|capture|ask|inbox|camera)\b/);
  if (m) {
    const to = m[1] === "inbox" ? "/today" : m[1] === "camera" ? "/capture" : `/${m[1]}`;
    return [{ action: "ask.navigate", input: { to, label: `Open ${capitalize(m[1]!)}` }, text: `Open ${capitalize(m[1]!)}` }];
  }
  const a = /^(?:open|go to|show(?: me)?)\s+/.test(lower) ? authorIn(c, w.authors) : null;
  if (a) return [{ action: "ask.navigate", input: { to: `/authors/${a.slug}`, label: `${a.name}’s profile and voice` }, text: `Open ${a.name}` }];
  return null;
};

const RULES: Rule[] = [help, undo, approve, askFirst, waiting, settingsShow, budget, cadence, miscSettings, remember, price, domain, redirect, rewriteBlock, voice, write, refresh, setup, lists, navigate, look];

/** Suggestions offered when nothing matched. */
export const SUGGESTIONS = [
  "Write a post about hiding TV cables as Fred",
  "Make the site feel warmer",
  "Remember that we never recommend glass stands",
  "What's waiting for me?",
  "Show me my settings",
];
