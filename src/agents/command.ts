import { listAuthors } from "../core/authors.ts";
import { entryPath, listEntries } from "../core/entries.ts";
import { getSite, settingsSentences } from "../core/sites.ts";
import type { Ctx } from "../core/types.ts";
import { estimateWrite } from "./actions.ts";
import { parseIntent } from "./intent.ts";
import { categories } from "./knowledge.ts";
import { modelFor } from "./model.ts";
import { fuzzyScore } from "./text.ts";

/**
 * The command bar: one input that is search, navigation and agent at once.
 * "Fred" finds Fred; "make fred funnier" offers to do it. `doIt` items come
 * from the intent parser (each `ask` is what to send to Ask); `goTo` items are
 * fuzzy matches over posts, authors, categories, settings and screens.
 */

export interface CommandResult {
  doIt: { label: string; hint: string; ask: string }[];
  goTo: { label: string; kind: string; href: string }[];
}

const SCREENS = [
  { label: "Today", kind: "Screen", href: "/today", words: "today inbox approvals waiting home" },
  { label: "Ask", kind: "Screen", href: "/ask", words: "ask chat conversation" },
  { label: "Settings", kind: "Screen", href: "/settings", words: "settings preferences budget domains members" },
  { label: "Capture", kind: "Screen", href: "/capture", words: "capture camera photo voice note evidence phone" },
];

const SETTING_LABELS: Record<string, string> = {
  askMeFirst: "Ask me first",
  monthlyBudgetUsd: "Agent budget",
  cadence: "Publishing days",
  readyMinimums: "Ready minimums",
  aiDisclosure: "AI disclosure line",
  allowTrainingCrawlers: "AI training",
  domains: "Domains",
  trust: "Trust earned",
};

const STARTERS = [
  { label: "Write a post", hint: "Tell me the topic; the draft waits on Today", ask: "Write a post about " },
  { label: "What's waiting for me?", hint: "Proposals and what the team did", ask: "What's waiting for me?" },
  { label: "Show me my settings", hint: "Every setting, as a sentence", ask: "Show me my settings" },
  { label: "Change the look", hint: "Three directions to pick from", ask: "Make the site feel " },
];

export function command(ctx: Ctx, rawQuery: string): CommandResult {
  const query = rawQuery.trim();
  if (!ctx.siteId) return { doIt: [], goTo: SCREENS.map(({ label, kind, href }) => ({ label, kind, href })) };
  if (!query) return { doIt: STARTERS, goTo: SCREENS.map(({ label, kind, href }) => ({ label, kind, href })) };
  const site = getSite(ctx.db, ctx.siteId);

  // ---- Do it ----
  const doIt: CommandResult["doIt"] = [];
  const words = query.split(/\s+/).length;
  if (words >= 2) {
    const parsed = parseIntent(ctx, query, {});
    const offline = modelFor(ctx).offline;
    const writes = parsed.steps.filter((s) => s.action === "posts.write");
    for (const s of parsed.steps.filter((x) => x.action !== "ask.reply").slice(0, 3)) {
      if (s.action === "posts.write" && writes.length > 1 && s !== writes[0]) continue;
      if (s.action === "posts.write" && writes.length > 1) {
        const est = estimateWrite(ctx) * writes.length;
        doIt.push({ label: `Draft ${writes.length} posts: ${writes.map((w) => w.text.replace(/^Draft /, "")).join("; ")}`, hint: est ? `About $${est.toFixed(2)}, ${writes.length * 2} minutes` : "The drafts wait on Today; nothing goes live until you approve", ask: query });
        continue;
      }
      const est = s.action === "posts.write" ? estimateWrite(ctx) : 0;
      doIt.push({ label: s.text, hint: est && !offline ? `About $${est.toFixed(2)}, 2 minutes` : s.hint ?? "Nothing changes until you approve", ask: query });
    }
  }

  // ---- Go to ----
  const scored: { label: string; kind: string; href: string; score: number }[] = [];
  const authors = listAuthors(ctx.db, site.id);
  for (const a of authors) {
    const s = Math.max(fuzzyScore(query, a.name), fuzzyScore(query, a.slug), ...a.name.split(/\s+/).map((n) => fuzzyScore(query, n)));
    if (s >= 0.35) {
      scored.push({ label: a.name, kind: "Author", href: `/authors/${a.slug}`, score: s + 0.05 });
      scored.push({ label: `${a.name.split(" ")[0]}’s voice settings`, kind: "Settings", href: `/authors/${a.slug}`, score: s });
      for (const e of listEntries(ctx.db, site.id, { authorId: a.id, type: "post", limit: 3 })) {
        scored.push({ label: e.title, kind: e.status === "published" ? "Published" : e.status === "scheduled" ? "Scheduled" : "Draft", href: e.status === "published" ? `/live?path=${entryPath(e)}` : `/drafts/${e.id}`, score: s - 0.1 });
      }
    }
  }
  for (const e of listEntries(ctx.db, site.id, { limit: 500 })) {
    const s = fuzzyScore(query, e.title);
    if (s >= 0.45) scored.push({ label: e.title, kind: e.type === "page" ? "Page" : e.status === "published" ? "Published" : e.status === "scheduled" ? "Scheduled" : "Draft", href: e.status === "published" ? `/live?path=${entryPath(e)}` : `/drafts/${e.id}`, score: s });
  }
  for (const c of categories(ctx.db, site.id)) {
    const s = fuzzyScore(query, c.name);
    if (s >= 0.45) scored.push({ label: c.name, kind: "Category", href: `/live?path=/topics/${c.slug}/`, score: s - 0.05 });
  }
  for (const st of settingsSentences(site)) {
    const label = SETTING_LABELS[st.key] ?? st.key;
    const s = Math.max(fuzzyScore(query, label), fuzzyScore(query, st.sentence) * 0.8);
    if (s >= 0.45) scored.push({ label, kind: "Setting", href: "/settings", score: s - 0.1 });
  }
  for (const sc of SCREENS) {
    const s = Math.max(fuzzyScore(query, sc.label), ...sc.words.split(" ").map((w) => fuzzyScore(query, w) * 0.9));
    if (s >= 0.5) scored.push({ label: sc.label, kind: sc.kind, href: sc.href, score: s - 0.15 });
  }
  const seen = new Set<string>();
  const goTo = scored
    .sort((a, b) => b.score - a.score)
    .filter((x) => {
      const k = `${x.label}|${x.href}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 8)
    .map(({ label, kind, href }) => ({ label, kind, href }));

  // A bare name ("Fred") with nothing to do yet: offer the common things.
  if (!doIt.length) {
    const a = authors.find((x) => x.name.split(/\s+/).some((n) => fuzzyScore(query, n) >= 0.8));
    if (a) {
      const first = a.name.split(" ")[0];
      doIt.push({ label: `Write a post as ${first}`, hint: "Tell me the topic; the draft waits on Today", ask: `Write a post as ${first} about ` });
      doIt.push({ label: `Make ${first}’s voice a bit funnier`, hint: "Shows a before and after; nothing changes until you approve", ask: `Make ${first} funnier` });
    } else if (words >= 2) {
      doIt.push({ label: `Ask: “${query}”`, hint: "I'll work out the plan", ask: query });
    }
  }
  return { doIt, goTo };
}
