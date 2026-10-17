import { z } from "zod";
import { listAuthors } from "../core/authors.ts";
import { entryBySlug } from "../core/entries.ts";
import { TqError, invalid } from "../core/errors.ts";
import { id } from "../core/ids.ts";
import { defineAction, invoke, undoAction, type InvokeResult } from "../core/registry.ts";
import { getSite } from "../core/sites.ts";
import type { Site } from "../core/types.ts";
import { brainEntries, IDEA_SEPARATOR } from "./knowledge.ts";
import { modelFor, parseJson } from "./model.ts";
import { setupPrompt } from "./prompts.ts";
import { createRun, RunRecorder, setRunStatus } from "./runs.ts";
import { capitalize, clip } from "./text.ts";
import { subjectOf } from "./writer.ts";

/**
 * Onboarding step 2: "What is this site about?" One sentence becomes
 * categories, starter pages, Site Brain identity, twelve post ideas, a byline
 * if there is none, and the first three drafts.
 */

export interface NichePlan {
  subject: string;
  audience: string;
  tone: string;
  different: string;
  reviews: boolean;
  affiliate: boolean;
  categories: { name: string; description: string }[];
  pages: { slug: string; title: string; markdown: string }[];
  ideas: { title: string; reason: string }[];
}

const DOMAINS: { words: RegExp; cats: string[] }[] = [
  { words: /\b(tv|media|cables?|wires?|wiring|desk|setup)\b/i, cats: ["Cable management"] },
  { words: /\b(wood|walnut|oak|furniture|stands?|shel(f|ves)|cabinets?|tables?|sofas?|chairs?)\b/i, cats: ["Materials"] },
  { words: /\b(coffee|espresso|brew\w*)\b/i, cats: ["Brewing", "Beans", "Gear"] },
  { words: /\b(recipes?|cook\w*|bak\w*|food|meals?|kitchen)\b/i, cats: ["Recipes", "Techniques", "Ingredients"] },
  { words: /\b(garden\w*|plants?|seeds?|lawns?)\b/i, cats: ["Planting", "Care and pests", "Seasonal jobs"] },
  { words: /\b(travel\w*|trips?|destinations?|flights?)\b/i, cats: ["Destinations", "Planning", "Packing"] },
  { words: /\b(fitness|running|gym|workouts?|training|yoga)\b/i, cats: ["Training plans", "Gear", "Recovery"] },
  { words: /\b(money|financ\w*|budget\w*|invest\w*|savings?)\b/i, cats: ["Saving", "Investing", "Budgeting"] },
  { words: /\b(pets?|dogs?|cats?|puppies|kittens?)\b/i, cats: ["Health", "Training", "Food"] },
  { words: /\b(software|saas|code|coding|developers?|programming)\b/i, cats: ["Tutorials", "Tools", "Best practices"] },
  { words: /\b(cameras?|photograph\w*|lenses)\b/i, cats: ["Gear", "Techniques", "Editing"] },
  { words: /\b(bikes?|cycling|bicycles?)\b/i, cats: ["Bikes", "Maintenance", "Routes"] },
  { words: /\b(camping|hiking|outdoors?|trails?)\b/i, cats: ["Gear", "Trips", "Skills"] },
  { words: /\b(diy|renovat\w*|tools|home improvement)\b/i, cats: ["Projects", "Tools", "Materials"] },
];

const AUDIENCE_CATS: { words: RegExp; cat: string }[] = [
  { words: /\b(small|tiny|compact|apartments?|studios?|flats?)\b/i, cat: "Small spaces" },
  { words: /\b(beginners?|first[- ]time|new to|starting)\b/i, cat: "Getting started" },
  { words: /\b(budget|cheap|affordable|frugal)\b/i, cat: "On a budget" },
  { words: /\b(families|family|kids|children|parents)\b/i, cat: "For families" },
];

const CATEGORY_LINES: Record<string, string> = {
  "Buying guides": "What to check before you buy, in plain words.",
  Reviews: "What we tested, how it held up and who it suits.",
  "Small spaces": "Ideas and picks for rooms where every inch counts.",
  "Cable management": "Hiding, routing and labelling every cable.",
  Materials: "Woods, finishes and what lasts.",
  "Getting started": "The basics, for anyone new to this.",
  "On a budget": "Good results without overspending.",
  "For families": "Practical picks for busy homes.",
  "How-to": "Step-by-step guides.",
  Basics: "The essentials, explained.",
};

function words(s: string) {
  return s.replace(/[.!]+$/, "").trim();
}

/** Plans a site from its one-sentence niche, without a model. Deterministic. */
export function planFromNiche(site: Pick<Site, "name" | "primaryDomain">, niche: string): NichePlan {
  const n = words(niche);
  const reviews = /\b(reviews?|test(s|ed|ing)?|honest|compar\w*|best|buying|buyers?)\b/i.test(n);
  const affiliate = reviews || /\b(affiliate|deals?|gear|products?|buy|shop\w*|furniture|gadgets?|tools|equipment)\b/i.test(n);

  // "Honest guides to TV stands and media furniture for small living rooms, written by people who build and test them."
  const core = n.replace(/^(honest|practical|simple|independent|friendly|expert|the best|useful)?\s*(guides?|reviews?|recipes|tips|advice|news|ideas|stories|notes|articles)\s+(to|on|about|for|of)\s+/i, "").replace(/^(a|an|the)\s+(blog|site|magazine|newsletter)\s+(about|on|for)\s+/i, "");
  const differentRaw = core.match(/,?\s*((?:written|made|run|tested|reviewed|curated)\s+by\s+.+|by\s+(?:people|a|an|two|three|our)\s+.+|from\s+(?:people|a|an)\s+.+)$/i)?.[1];
  const withoutDifferent = differentRaw ? core.slice(0, core.length - differentRaw.length).replace(/[,\s]+$/, "") : core;
  const forPart = withoutDifferent.match(/\s+for\s+(.+)$/i)?.[1];
  const subject = (forPart ? withoutDifferent.slice(0, withoutDifferent.length - forPart.length - 5) : withoutDifferent).trim() || n;
  const place = forPart && /\b(rooms?|spaces?|apartments?|homes?|houses?|kitchens?|gardens?|flats?|offices?|studios?)\b/i.test(forPart);
  const audience = forPart ? (place ? `people with ${forPart}` : forPart) : `people who care about ${subject.toLowerCase()}`;
  const different = differentRaw ? capitalize(differentRaw.replace(/^,\s*/, "")) : "Practical, specific answers from a team that checks its facts and updates its pages";
  const tone = reviews ? "Plain, specific and honest: we say what was tested and what wasn't, and we never oversell." : "Plain, warm and practical: short answers first, then the detail.";

  const cats: string[] = [];
  if (affiliate) cats.push("Buying guides");
  if (reviews) cats.push("Reviews");
  for (const a of AUDIENCE_CATS) if (a.words.test(n) && !cats.includes(a.cat)) cats.push(a.cat);
  for (const d of DOMAINS) if (d.words.test(n)) for (const c of d.cats) if (!cats.includes(c)) cats.push(c);
  for (const g of ["How-to", "Basics", "Ideas", "News"]) if (cats.length < 4 && !cats.includes(g)) cats.push(g);
  const categories = cats.slice(0, 6).map((name) => ({ name, description: CATEGORY_LINES[name] ?? `Guides about ${name.toLowerCase()}.` }));

  const parts = subject.split(/\s+and\s+|,\s*/).map((s) => s.trim()).filter(Boolean);
  const primary = subjectOf(parts[0] ?? subject);
  const secondary = parts[1] ? subjectOf(parts[1]) : null;
  const aud = audience.replace(/^people with /, "");
  const extraCats = categories.map((c) => c.name).filter((c) => !["Buying guides", "Reviews", "How-to", "Basics", "Ideas", "News"].includes(c));
  const ideaList: { title: string; reason: string }[] = [
    { title: `How to choose ${primary.aOne} for ${aud}`, reason: "The first question new buyers search; the page to rank for first." },
    { title: `${capitalize(primary.plural)} buying guide: what to check first`, reason: "A pillar guide every other post can link to." },
    { title: `${capitalize(primary.one)} mistakes and how to avoid them`, reason: "People search for problems before products; this meets them early." },
    { title: `How to pick the right size of ${primary.one}`, reason: "Size is the most common reason for returns; a clear answer earns trust." },
    { title: `What to look for in a well-made ${primary.one}`, reason: "Shows real expertise and sets up future reviews." },
    { title: `Is ${primary.aOne} worth it?`, reason: "Answers the price question every buyer asks before spending." },
    { title: `How to care for ${primary.aOne}`, reason: "Care questions bring steady search traffic all year." },
    secondary
      ? { title: `${capitalize(secondary.plural)} for ${aud}: a practical guide`, reason: "Covers the second half of the niche, so it isn't a one-topic site." }
      : { title: `${capitalize(primary.plural)} for beginners: a practical guide`, reason: "Catches readers at the very start of their search." },
    ...extraCats.slice(0, 2).map((c) => ({ title: `${c} and ${primary.plural}: the basics`, reason: `Gives the ${c} category its first post.` })),
    { title: `Questions to ask before buying ${primary.aOne}`, reason: "A checklist post answer engines like to quote." },
    secondary
      ? { title: `${capitalize(primary.one)} or ${secondary.one}: which do you need?`, reason: "Comparison searches are high-intent and easy to answer well." }
      : { title: `${capitalize(primary.plural)} compared: how to decide`, reason: "Comparison searches are high-intent and easy to answer well." },
    { title: `How long should ${primary.aOne} last?`, reason: "A durability question that supports the buying guides." },
    { title: `${capitalize(primary.plural)}: what to avoid when you buy`, reason: "Warning-sign posts get shared and linked." },
  ];
  const seen = new Set<string>();
  const ideas = ideaList
    .map((i) => ({ title: clip(i.title, 60), reason: i.reason }))
    .filter((i) => !seen.has(i.title.toLowerCase()) && seen.add(i.title.toLowerCase()))
    .slice(0, 12);

  return { subject, audience: capitalize(audience), tone, different, reviews, affiliate, categories, pages: starterPages(site, { niche: n, different, reviews, affiliate, subject }), ideas };
}

function starterPages(site: Pick<Site, "name" | "primaryDomain">, p: { niche: string; different: string; reviews: boolean; affiliate: boolean; subject: string }) {
  const email = site.primaryDomain ? `hello@${site.primaryDomain.replace(/^www\./, "")}` : null;
  const niche = p.niche.replace(/^[A-Z]/, (c) => c.toLowerCase());
  const pages = [
    {
      slug: "about",
      title: "About",
      markdown: `${site.name} publishes ${niche}.

${p.different.replace(/[.]?$/, ".")} Every guide answers the questions readers actually ask, with the short answer first and the detail after.

## How we work

When we recommend something, we say why. When something changes, like a price or a model, we update every page that mentions it and show the date it was last checked.${p.reviews ? " Our testing method is on the [How we test](/how-we-test/) page." : ""}

## Get in touch

Questions, corrections and ideas are welcome on the [Contact](/contact/) page.
`,
    },
  ];
  if (p.reviews)
    pages.push({
      slug: "how-we-test",
      title: "How we test",
      markdown: `We only call something tested when someone on the team has used it the way you would.

## What we check

- How it fits the space and the way people actually use it
- How it is made: materials, joints, fixings and finish
- How it holds up after weeks of everyday use
- What it costs over the years you will own it

## What we write down

Every test leaves notes, photos and measurements. Those notes are what our reviews are built from, and they appear in the post so you can judge for yourself.

## What we don't do

We don't accept payment for reviews, and a brand never sees a review before it is published. If we haven't tested something, we say so.
`,
    });
  pages.push(
    {
      slug: "contact",
      title: "Contact",
      markdown: `${email ? `Write to us at [${email}](mailto:${email}).` : "Write to us any time; we read every message."} We usually reply within two working days.

Spotted a mistake or an out-of-date price? Tell us the page and what changed, and we'll fix it.
`,
    },
    {
      slug: "privacy",
      title: "Privacy",
      markdown: `${site.name} keeps what it knows about you to a minimum.

## What we collect

We count visits with cookieless analytics: no tracking cookies, no fingerprinting and no personal profiles. If you email us, we keep your message only as long as we need to answer it.

## What we don't do

We don't sell or share personal data, and we don't run third-party ad trackers.

## Questions

Ask us anything about privacy through the [Contact](/contact/) page.
`,
    },
  );
  if (p.affiliate)
    pages.push({
      slug: "affiliate-disclosure",
      title: "Affiliate disclosure",
      markdown: `:::disclosure
Some links on ${site.name} are affiliate links. If you buy through them, we may earn a commission at no extra cost to you.
:::

Commissions never decide what we recommend. We pick first and look for a link afterwards, and we recommend things we would buy ourselves even when there is no link to earn from.
`,
    });
  return pages;
}

function planSummary(plan: NichePlan, drafts: number) {
  return [
    { label: "Categories", items: plan.categories.map((c) => c.name) },
    { label: "Starter pages", text: plan.pages.map((p) => p.title).join(", ") },
    { label: "First 30 days", text: `${plan.ideas.length} post ideas from real search questions, ${drafts} drafted for your review` },
  ];
}

defineAction({
  name: "sites.setup",
  title: "Set up the site",
  description:
    "Onboarding: from the site's one-sentence niche, creates 4–6 categories, starter pages (About, How we test, Contact, Privacy, Affiliate disclosure as fits), Site Brain identity entries, 12 post ideas, an Editorial team byline if there are no authors, and starts drafting the first 3 posts for your review. Undo removes what it created.",
  permission: "admin",
  risk: "reversible",
  trust: "other",
  input: z.object({ niche: z.string().min(8).max(500).optional().describe("One sentence: what the site is about. Defaults to the niche saved on the site.") }),
  prepare(ctx, input) {
    const site = getSite(ctx.db, ctx.siteId!);
    const niche = (input.niche ?? site.niche).trim();
    if (!niche) throw invalid("Tell me what the site is about in one sentence first, like “Honest guides to TV stands for small living rooms.”");
    const plan = planFromNiche(site, niche);
    const drafts = Math.min(3, plan.ideas.length);
    const sections = planSummary(plan, drafts);
    return {
      summary: `Set up ${site.name}: ${plan.categories.length} categories, ${plan.pages.length} starter pages, ${plan.ideas.length} post ideas and ${drafts} first drafts`,
      detail: "You can change any of this later by asking.",
      diff: sections.map((s) => ({ label: s.label, before: null, after: s.items ? s.items.join(", ") : s.text! })),
      payload: { niche, plan, sections, groupId: id("grp") },
    };
  },
  async apply(ctx, p: { niche: string; plan: NichePlan; sections: ReturnType<typeof planSummary>; groupId: string }) {
    const site = getSite(ctx.db, ctx.siteId!);
    const actionIds: string[] = [];
    const track = (r: InvokeResult) => {
      if (r.status === "applied") actionIds.push(r.actionId);
      return r;
    };
    const tryInvoke = async (name: string, input: unknown, opts = {}) => {
      try {
        return track(await invoke(ctx, name, input, opts));
      } catch (err) {
        if (err instanceof TqError && (err.code === "conflict" || err.code === "invalid")) return null;
        throw err;
      }
    };
    let plan = p.plan;
    const runId = createRun(ctx, { request: `Set up the site: ${p.niche}`, label: `Set up ${site.name}`, kind: "setup", outline: ["Plan", "Categories", "Starter pages", "Site Brain", "Ideas", "First drafts"], status: "running", groupId: p.groupId, source: "setup" });
    const rec = new RunRecorder(ctx.db, runId);

    try {
      if (p.niche !== site.niche) await tryInvoke("sites.update", { niche: p.niche });

      // With a model, sharpen the ideas from real search intent; the preview's categories and pages stay as shown.
      await rec.step(
        "Plan",
        async () => {
          const client = rec.client(modelFor(ctx));
          if (client.offline) return "offline";
          const r = await client.complete({ tier: "frontier", json: true, maxTokens: 3000, messages: [{ role: "user", content: setupPrompt(p.niche, site.name) }] }).catch(() => null);
          const j = r ? parseJson<{ ideas?: { title: string; reason: string }[]; audience?: string; tone?: string; different?: string }>(r.text) : null;
          const ideas = (j?.ideas ?? []).filter((i) => i?.title && i?.reason).map((i) => ({ title: clip(String(i.title), 60), reason: clip(String(i.reason), 160) }));
          if (ideas.length >= 8) plan = { ...plan, ideas: ideas.slice(0, 12), audience: j?.audience ?? plan.audience, tone: j?.tone ?? plan.tone, different: j?.different ?? plan.different };
          return "model";
        },
        (m) => (m === "model" ? "Planned with the model." : `Planned from the niche sentence: ${plan.categories.length} categories, ${plan.ideas.length} ideas.`),
      );

      const cats = await rec.step(
        "Categories",
        async () => {
          const out: string[] = [];
          for (const c of plan.categories) if (await tryInvoke("categories.create", c)) out.push(c.name);
          return out;
        },
        (c) => `Added ${c.length}: ${c.join(", ")}.`,
      );

      const pages = await rec.step(
        "Starter pages",
        async () => {
          const out: { id: string; title: string; path: string }[] = [];
          for (const pg of plan.pages) {
            if (entryBySlug(ctx.db, ctx.siteId!, pg.slug)) continue;
            const created = await tryInvoke("posts.create", { type: "page", title: pg.title, slug: pg.slug, markdown: pg.markdown, description: clip(`${pg.title} — ${site.name}.`, 150) });
            if (!created || created.status !== "applied") continue;
            const pid = (created.result as { id: string }).id;
            // The owner started setup, so starter pages go live directly (with a logged reason if the Ready light isn't green).
            try {
              track(await invoke(ctx, "posts.publish", { id: pid }));
            } catch {
              await tryInvoke("posts.publish", { id: pid, override: "Starter page created during setup" });
            }
            out.push({ id: pid, title: pg.title, path: `/${pg.slug}/` });
          }
          return out;
        },
        (pg) => `Published ${pg.map((x) => x.title).join(", ")}.`,
      );

      await rec.step(
        "Site Brain",
        async () => {
          const existing = new Set(brainEntries(ctx.db, ctx.siteId!, ["identity"]).map((b) => b.text.toLowerCase()));
          const entries = [`Audience: ${plan.audience.replace(/[.]?$/, ".")}`, `Tone: ${plan.tone}`, `What makes it different: ${plan.different.replace(/[.]?$/, ".")}`];
          for (const text of entries) if (!existing.has(text.toLowerCase())) await tryInvoke("brain.add", { kind: "identity", text, source: "setup" });
          return entries.length;
        },
        (n) => `Saved ${n} identity notes: audience, tone and what makes the site different.`,
      );

      const ideaIds = await rec.step(
        "Ideas",
        async () => {
          const have = new Set(brainEntries(ctx.db, ctx.siteId!, ["idea"]).map((b) => b.text.split(IDEA_SEPARATOR)[0]!.toLowerCase()));
          const ids: { id: string; title: string }[] = [];
          for (const i of plan.ideas) {
            if (have.has(i.title.toLowerCase())) continue;
            const r = await tryInvoke("brain.add", { kind: "idea", text: `${i.title}${IDEA_SEPARATOR}${i.reason}`, source: "setup" });
            if (r?.status === "applied") ids.push({ id: (r.result as { id: string }).id, title: i.title });
          }
          return ids;
        },
        (ids) => `Saved ${ids.length} post ideas.`,
      );

      let authorId: string | null = null;
      if (!listAuthors(ctx.db, ctx.siteId!).length) {
        const a = await tryInvoke("authors.create", { name: "Editorial team", isPersona: true, bio: `The ${site.name} editorial team.`, expertise: plan.categories.slice(0, 3).map((c) => c.name.toLowerCase()) });
        if (a?.status === "applied") authorId = (a.result as { id: string }).id;
      }

      const runIds = await rec.step(
        "First drafts",
        async () => {
          const out: string[] = [];
          for (const idea of ideaIds.slice(0, 3)) {
            try {
              const r = await invoke(ctx, "posts.write", { topic: idea.title, title: idea.title, idea: idea.id, schedule: "next_slot", groupId: p.groupId, source: "setup" });
              if (r.status === "applied") out.push((r.result as { runId: string }).runId);
            } catch (err) {
              if (err instanceof TqError && err.code === "budget") {
                rec.note(err.message);
                break;
              }
              throw err;
            }
          }
          return out;
        },
        (ids) => `Started ${ids.length} draft${ids.length === 1 ? "" : "s"}.`,
      );

      setRunStatus(ctx.db, runId, "done");
      return {
        result: {
          title: "Here's what I set up",
          sections: planSummary(plan, runIds.length),
          categories: cats,
          pages,
          ideas: plan.ideas,
          identity: { audience: plan.audience, tone: plan.tone, different: plan.different },
          authorId,
          runIds,
          runId,
          groupId: p.groupId,
        },
        summary: `Set up ${site.name}: ${cats.length} categories, ${pages.length} starter pages, ${ideaIds.length} ideas, ${runIds.length} drafts on the way`,
        undo: { actionIds },
      };
    } catch (err) {
      setRunStatus(ctx.db, runId, "failed", (err as Error).message);
      throw err;
    }
  },
  async undo(ctx, u: { actionIds: string[] }) {
    for (const aid of [...u.actionIds].reverse()) {
      try {
        await undoAction(ctx, aid);
      } catch {
        /* already undone or no longer undoable: keep going */
      }
    }
  },
});
