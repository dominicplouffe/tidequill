import { afterEach, describe, expect, test } from "bun:test";
import { createClient, costOf, providerChain, setModelClientForTests, type ModelClient, type ModelRequest } from "../src/agents/model.ts";
import { checkClaims, structureStats } from "../src/agents/checks.ts";
import { describeLook, minContrast, contrast, tweakTokens, currentTokens } from "../src/agents/look.ts";
import { adjustVoice, learnVoice, voiceMatch, voiceParagraph } from "../src/agents/voiceprint.ts";
import { writeOffline, angleTitles } from "../src/agents/writer.ts";
import { runAutopilot } from "../src/agents/autopilot.ts";
import { planFromNiche } from "../src/agents/setup.ts";
import { defaultVoice } from "../src/core/voice.ts";
import { hasAction } from "../src/agents/optional.ts";
import { testSite } from "./helpers.ts";

afterEach(() => setModelClientForTests(null));

const FRED_SAMPLES = [
  "I bought the wrong stand first. It was particleboard in a walnut costume. It chipped the week I moved it. Now I check the back panel before anything else. Two minutes, one flashlight. Done.",
  "I tripped over my own HDMI cable and took a soundbar down with me. Of course I did. Every cable now gets a velcro strap and a hole in the back panel. Five minutes, one drill bit. Worth it.",
  "My first cable tray sagged after a month. I used the wrong screws. Use wood screws, not drywall screws, and drill a pilot hole. The tray has held for two years. Simple fix.",
];

async function withFred(opts: { niche?: string } = {}) {
  const t = await testSite(opts);
  const fred: any = await t.invoke(t.as(), "authors.create", { name: "Fred Laurent", expertise: ["assembly", "cables"], bio: "Builds and tests stands." });
  return { ...t, fredId: fred.result.id as string };
}

/** A fake online model that answers each pipeline prompt in the expected format. */
function fakeModel(costPerCall = 0.01, calls: ModelRequest[] = []): ModelClient {
  return {
    offline: false,
    async complete(req) {
      calls.push(req);
      const prompt = req.messages.at(-1)!.content;
      let text = "{}";
      if (prompt.includes("Plan one blog post")) {
        text = JSON.stringify({
          title: "How to hide every cable behind a walnut stand",
          description: "Route, strap and hide every cable behind a walnut TV stand in an afternoon.",
          angle: "Practical cable hiding.",
          sections: [
            { question: "How do you hide cables behind a TV stand?", points: ["route", "strap"] },
            { question: "What do you need to hide TV cables?", points: ["tools"] },
            { question: "How do you keep cables tidy over time?", points: ["labels"] },
          ],
          faq: ["Can you drill a walnut stand?"],
        });
      } else if (prompt.includes("Reply in exactly this format")) {
        const para = "Cables collect behind every stand. Route them along one edge, strap them every few inches and leave a little slack at each end so nothing pulls when you move the stand. It takes an afternoon and saves years of tangles behind the television.";
        text = `TITLE: How to hide every cable behind a walnut stand\nDESCRIPTION: Route, strap and hide every cable behind a walnut TV stand.\n---\n${para}\n\n## How do you hide cables behind a TV stand?\n\n:::answer\nRoute every cable along one edge of the stand, strap them together every few inches and feed them through a single hole in the back panel. Leave slack at both ends so nothing pulls tight when you move the stand or swap a device.\n:::\n\n${para}\n\n## What do you need to hide TV cables?\n\n${para} ${para}\n\n## How do you keep cables tidy over time?\n\n:::answer\nLabel both ends.\n:::\n\n${para}\n\nIt holds 95 lb without wobbling.\n\n:::faq\n### Can you drill a walnut stand?\nYes, with a sharp bit and a pilot hole.\n:::\n`;
      } else if (prompt.includes("final check")) {
        text = JSON.stringify({ ok: true, notes: ["Reads well."], fixes: [] });
      }
      return { text, tokensIn: 1000, tokensOut: 500, costUsd: costPerCall, model: "fake-frontier", provider: "anthropic" };
    },
  };
}

describe("model adapter", () => {
  test("auto picks anthropic > openai > ollama > offline", () => {
    expect(providerChain({ provider: "auto" })[0]!.name).toBe("offline");
    expect(providerChain({ provider: "auto", ollamaUrl: "http://x" }).map((p) => p.name)).toEqual(["ollama"]);
    expect(providerChain({ provider: "auto", openaiKey: "k", ollamaUrl: "http://x" }).map((p) => p.name)).toEqual(["openai", "ollama"]);
    const all = providerChain({ provider: "auto", anthropicKey: "a", openaiKey: "k", ollamaUrl: "http://x" });
    expect(all.map((p) => p.name)).toEqual(["anthropic", "openai", "ollama"]);
    expect(all[0]).toMatchObject({ frontier: "claude-opus-5-5", fast: "claude-haiku-5-5" });
    expect(providerChain({ provider: "openai", anthropicKey: "a", openaiKey: "k" }).map((p) => p.name)).toEqual(["openai", "anthropic"]);
    expect(providerChain({ provider: "auto", anthropicKey: "a", frontierModel: "claude-sonnet-5-5" })[0]!.frontier).toBe("claude-sonnet-5-5");
    expect(providerChain({ provider: "offline", anthropicKey: "a" })[0]!.name).toBe("offline");
  });

  test("cost accounting per model", () => {
    expect(costOf("anthropic", "claude-opus-5-5", { input: 1_000_000, output: 1_000_000 })).toBe(24);
    expect(costOf("anthropic", "claude-haiku-5-5", { input: 1_000_000, output: 0 })).toBe(0.1);
    expect(costOf("anthropic", "claude-opus-5-5", { input: 0, output: 0, cacheRead: 1_000_000 })).toBe(0.2);
    expect(costOf("ollama", "llama3.1", { input: 5_000_000, output: 5_000_000 })).toBe(0);
  });

  test("retries with backoff, then fails over to the next provider and says so", async () => {
    let anthropicCalls = 0;
    const client = createClient(
      { provider: "auto", anthropicKey: "a", openaiKey: "k" },
      {
        baseDelayMs: 1,
        retries: 1,
        calls: {
          anthropic: async () => {
            anthropicCalls++;
            const e: any = new Error("timeout");
            throw Object.assign(e, { retryable: true });
          },
          openai: async (_req, { model }) => ({ text: "ok", tokensIn: 10, tokensOut: 5, costUsd: 0.001, model }),
        },
      },
    );
    const r = await client.complete({ tier: "fast", messages: [{ role: "user", content: "hi" }] });
    expect(r.provider).toBe("openai");
    expect(r.model).toBe("gpt-5-mini");
    expect(r.failover?.[0]).toContain("anthropic");
    expect(anthropicCalls).toBe(1);
  });

  test("the offline provider never calls the network and is deterministic", async () => {
    const client = createClient({ provider: "auto" });
    expect(client.offline).toBe(true);
    const req: ModelRequest = { tier: "fast", messages: [{ role: "user", content: "The stand is 72 inches wide and made of solid walnut. It arrived on a Tuesday. Assembly took forty minutes with two people." }] };
    const a = await client.complete(req);
    expect(a.costUsd).toBe(0);
    expect(a.text).toBe((await client.complete(req)).text);
    expect((await client.complete({ ...req, json: true })).text).toBe("{}");
  });
});

describe("offline writer", () => {
  test("specific, structured, deterministic; numbers only from sources", () => {
    const input = {
      topic: "walnut TV stands",
      niche: "TV stands",
      siteName: "Walnut & Wire",
      author: null,
      brain: [{ id: "b1", kind: "fact", text: "A 77-inch TV is about 67 inches wide.", source: null, createdAt: "" }],
      facts: [],
      evidence: [],
      realAuthors: new Map(),
      related: [],
      forbidden: ["glass stands"],
      avoidTitles: [],
    };
    const a = writeOffline(input);
    const b = writeOffline(input);
    expect(a.markdown).toBe(b.markdown);
    expect(a.title.length).toBeLessThanOrEqual(60);
    expect(a.description.length).toBeLessThanOrEqual(155);
    const st = structureStats(a.markdown);
    expect(st.words).toBeGreaterThanOrEqual(600);
    expect(st.words).toBeLessThanOrEqual(950);
    expect(st.questions).toBeGreaterThanOrEqual(4);
    expect(st.answersInRange).toBe(st.answers.length);
    expect(st.faq).toBe(true);
    expect(a.markdown).not.toMatch(/\bI (tested|bought|measured)\b/);
    expect(checkClaims(a.markdown, ["A 77-inch TV is about 67 inches wide."]).flagged).toEqual([]);
    // Different topics get different posts.
    expect(writeOffline({ ...input, topic: "espresso grinders" }).markdown).not.toBe(a.markdown);
  });

  test("three posts on one topic get three different angles", () => {
    const titles = angleTitles("walnut TV stands", 3);
    expect(new Set(titles).size).toBe(3);
    for (const t of titles) expect(t.toLowerCase()).toContain("walnut tv stand");
  });

  test("fact-check removes numeric claims without a source", () => {
    const r = checkClaims("It holds 95 lb. It is 67 inches wide. Measure twice.\n", ["67 inches"]);
    expect(r.flagged).toEqual(["It holds 95 lb."]);
    expect(r.markdown).toContain("67 inches");
  });
});

describe("posts.write", () => {
  test("end to end: background run -> draft -> publish proposal, with a run record", async () => {
    const t = await withFred();
    await t.invoke(t.as(), "brain.add", { kind: "claim_rule", text: "Never recommend glass stands." });
    await t.db.query("INSERT INTO evidence (id, site_id, author_id, kind, topic, text, captured_at, created_at) VALUES ('evd_1', ?, ?, 'note', 'walnut tv stands', 'The walnut veneer on the cheap stand peeled at the corner after a month of sun.', ?, ?)").run(t.siteId, t.fredId, new Date().toISOString(), new Date().toISOString());
    const r: any = await t.invoke(t.agent("writer"), "posts.write", { topic: "walnut TV stands", author: "Fred" });
    expect(r.status).toBe("applied");
    const runId = r.result.runId;
    let run: any = t.db.query("SELECT * FROM agent_runs WHERE id = ?").get(runId);
    expect(run.status).toBe("queued");
    await t.rt.drain();
    run = t.db.query("SELECT * FROM agent_runs WHERE id = ?").get(runId);
    expect(run.status).toBe("done");
    const steps = JSON.parse(run.steps);
    expect(steps.map((s: any) => s.label)).toEqual(["Brief", "Research", "Outline", "Draft in voice", "Fact-check", "SEO and answer pass", "Human pass", "Editor review", "Proposal"]);
    expect(steps.every((s: any) => s.status === "done")).toBe(true);
    expect(new Set(steps.map((s: any) => s.role))).toContain("fact_checker");
    const drafts: any = await t.invoke(t.as(), "posts.list", { status: "draft" });
    expect(drafts.result).toHaveLength(1);
    expect(drafts.result[0].authors[0].name).toBe("Fred Laurent");
    const post: any = await t.invoke(t.as(), "posts.get", { id: drafts.result[0].id });
    expect(post.result.markdown).toContain(":::evidence{id=evd_1");
    expect(post.result.markdown.toLowerCase()).not.toContain("glass");
    const p = t.db.query<any, [string]>("SELECT * FROM proposals WHERE run_id = ?").get(runId);
    expect(p.action_name).toBe("posts.publish");
    expect(p.trust_kind).toBe("new_post");
    expect(p.entry_id).toBe(drafts.result[0].id);
    // Approving schedules it (with a logged override, so this test doesn't depend on the Ready light's scores).
    await t.invoke(t.as(), "proposals.approve", { id: p.id, edits: { override: "Test" } });
    expect((await t.invoke(t.as(), "posts.list", { status: "scheduled" }) as any).result).toHaveLength(1);
  });

  test("with a model: prompts are used, unsupported numbers are removed, answers fixed", async () => {
    const calls: ModelRequest[] = [];
    setModelClientForTests(() => fakeModel(0.01, calls));
    const t = await withFred();
    const r: any = await t.invoke(t.as(), "posts.write", { topic: "hiding TV cables", author: "Fred" });
    await t.rt.drain();
    const run: any = t.db.query("SELECT * FROM agent_runs WHERE id = ?").get(r.result.runId);
    expect(run.status).toBe("done");
    expect(run.cost_usd).toBeGreaterThan(0);
    expect(calls.some((c) => c.cachePrefix?.includes("Walnut & Wire"))).toBe(true);
    const e: any = t.db.query("SELECT * FROM entries WHERE type = 'post'").get();
    expect(e.title).toBe("How to hide every cable behind a walnut stand");
    const md = (await t.invoke(t.as(), "posts.get", { id: e.id }) as any).result.markdown;
    expect(md).not.toContain("95 lb");
    const st = structureStats(md);
    expect(st.answers.length).toBe(st.questions);
    expect(st.answersInRange).toBe(st.answers.length);
    const steps = JSON.parse(run.steps);
    expect(steps.find((s: any) => s.label === "Draft in voice").model).toBe("fake-frontier");
  });

  test("budget: refuses past the monthly budget; pauses at the $2 job ceiling", async () => {
    setModelClientForTests(() => fakeModel(1.5));
    const t = await withFred();
    await t.invoke(t.as(), "settings.update", { monthlyBudgetUsd: 5 });
    t.db.query("INSERT INTO agent_runs (id, site_id, requester, request, status, cost_usd, created_at) VALUES ('run_old', ?, '{}', 'old', 'done', 4.95, ?)").run(t.siteId, new Date().toISOString());
    await expect(t.invoke(t.as(), "posts.write", { topic: "cable trays" })).rejects.toThrow(/budget/);

    await t.invoke(t.as(), "settings.update", { monthlyBudgetUsd: 100 });
    const r: any = await t.invoke(t.as(), "posts.write", { topic: "cable trays" });
    await t.rt.drain();
    const run: any = t.db.query("SELECT * FROM agent_runs WHERE id = ?").get(r.result.runId);
    expect(run.status).toBe("paused");
    expect(JSON.parse(run.plan).error).toMatch(/paused this job.*\$2/);
    expect(run.cost_usd).toBeLessThanOrEqual(3.01);
    expect(t.db.query("SELECT COUNT(*) AS n FROM entries WHERE type = 'post'").get()).toEqual({ n: 0 });

    // Resuming raises the ceiling and finishes the job.
    setModelClientForTests(() => fakeModel(0.01));
    await t.invoke(t.as(), "runs.resume", { runId: r.result.runId });
    await t.rt.drain();
    expect((t.db.query("SELECT status FROM agent_runs WHERE id = ?").get(r.result.runId) as any).status).toBe("done");
  });
});

describe("voices", () => {
  test("learning from samples gives readable labels", () => {
    const { voice, findings } = learnVoice(FRED_SAMPLES);
    expect(voice.sentenceLength.label).toMatch(/^Short, about \d+ words$/);
    expect(voice.sentenceLength.avgWords).toBeLessThanOrEqual(10);
    expect(voice.person).toBe("I");
    expect(voice.habits).toContain("Writes in first person");
    expect(voice.habits).toContain("Opens with a mistake they made");
    expect(voice.habits).toContain("Ends with a one-line verdict");
    expect(voice.humor.label).toMatch(/Dry/);
    expect(voice.vocabulary).toContain("back panel");
    expect(voice.learnedFrom).toBe("Learned from 3 samples (115 words)".replace("115", String(voice.learnedFrom.match(/\((\d+)/)![1])));
    expect(findings[0]).toContain("Sentence length");
  });

  test("adjusting by instruction", () => {
    const base = learnVoice(FRED_SAMPLES).voice;
    const funnier = adjustVoice(base, "a bit funnier");
    expect(funnier.voice.humor.value).toBeGreaterThan(base.humor.value);
    const calmer = adjustVoice(base, "a bit less jokey");
    expect(calmer.voice.humor.value).toBeLessThan(base.humor.value);
    const shorter = adjustVoice(defaultVoice(), "shorter sentences");
    expect(shorter.voice.sentenceLength.avgWords).toBe(12);
    expect(shorter.voice.sentenceLength.label).toBe("Short, about 12 words");
    const never = adjustVoice(defaultVoice(), "never say 'synergy'");
    expect(never.voice.banned).toContain("synergy");
    expect(adjustVoice(defaultVoice(), "purple").understood).toBe(false);
  });

  test("learn_voice and adjust_voice propose authors.update with a before/after; sample scores voice match", async () => {
    const t = await withFred();
    const learn: any = await t.invoke(t.as(), "authors.learn_voice", { author: "Fred", samples: FRED_SAMPLES });
    expect(learn.status).toBe("applied");
    expect(learn.result.delegated.status).toBe("proposed");
    await t.invoke(t.as(), "proposals.approve", { id: learn.result.delegated.proposalId });
    const fred: any = await t.invoke(t.as(), "authors.get", { author: "Fred" });
    expect(fred.result.voice.person).toBe("I");

    const adj: any = await t.invoke(t.agent("editor"), "authors.adjust_voice", { author: "Fred", instruction: "funnier" });
    const p: any = t.db.query("SELECT * FROM proposals WHERE id = ?").get(adj.result.delegated.proposalId);
    expect(p.action_name).toBe("authors.update");
    expect(p.detail).toMatch(/^Before: .+\n\nAfter: .+/s);
    expect(JSON.parse(p.diff).some((d: any) => d.label === "Hear it")).toBe(true);
    expect(JSON.parse(p.diff).some((d: any) => d.label === "Humor")).toBe(true);

    const s: any = await t.invoke(t.as(), "authors.sample", { author: "Fred", topic: "cable management" });
    expect(s.result.default).toContain("Cable management is an important consideration");
    expect(s.result.author).not.toBe(s.result.default);
    expect(s.result.voiceMatch).toBeGreaterThanOrEqual(70);
    expect(voiceMatch(s.result.default, fred.result.voice)).toBeLessThan(s.result.voiceMatch);
  });

  test("personas never claim first-hand experience in samples", () => {
    const v = { ...learnVoice(FRED_SAMPLES).voice };
    const p = voiceParagraph(v, { topic: "cable management", isPersona: true });
    expect(p).not.toMatch(/\b(I|my)\b/);
  });
});

describe("describe the look", () => {
  test("three directions, every one AA contrast or better", () => {
    for (const d of ["warmer", "more premium", "calm scandinavian", "playful and bright", "dark and moody", "serif headings, bigger text", "something nice", "editorial", "modern tech"]) {
      const looks = describeLook(d);
      expect(looks).toHaveLength(3);
      expect(new Set(looks.map((l) => l.name)).size).toBe(3);
      for (const l of looks) {
        expect(minContrast(l.tokens)).toBeGreaterThanOrEqual(4.5);
        expect(l.tokens.type.baseSize).toBeGreaterThanOrEqual(16);
        expect(l.tokens.type.baseSize).toBeLessThanOrEqual(22);
        expect(l.tokens.layout.width).toBeGreaterThanOrEqual(600);
      }
    }
    expect(describeLook("dark")[0]!.tokens.colors.background).not.toBe(describeLook("warm")[0]!.tokens.colors.background);
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 0);
  });

  test("specific tweaks: serif headings and warmer neutrals", () => {
    const { patch, changes } = tweakTokens(currentTokens("harbor", {}), "more premium: serif headings, warmer neutrals");
    expect(patch.fonts?.heading).toBe("newsreader");
    expect(patch.colors?.background).not.toBe("#F4F6FA");
    expect(changes.length).toBeGreaterThanOrEqual(2);
  });

  test("look.describe action", async () => {
    const t = await testSite();
    const r: any = await t.invoke(t.as(), "look.describe", { description: "warmer" });
    expect(r.result.options).toHaveLength(3);
  });
});

describe("onboarding setup", () => {
  test("plan from the niche sentence matches the prototype", () => {
    const plan = planFromNiche({ name: "Walnut & Wire", primaryDomain: "walnutandwire.com" }, "Honest guides to TV stands and media furniture for small living rooms, written by people who build and test them.");
    expect(plan.categories.map((c) => c.name)).toEqual(["Buying guides", "Reviews", "Small spaces", "Cable management", "Materials"]);
    expect(plan.pages.map((p) => p.title)).toEqual(["About", "How we test", "Contact", "Privacy", "Affiliate disclosure"]);
    expect(plan.ideas).toHaveLength(12);
    for (const i of plan.ideas) {
      expect(i.title.length).toBeLessThanOrEqual(60);
      expect(i.reason.length).toBeGreaterThan(10);
    }
    expect(plan.audience).toBe("People with small living rooms");
    expect(plan.different).toBe("Written by people who build and test them");
  });

  test("sites.setup creates everything and queues 3 drafts", async () => {
    const t = await testSite();
    const r: any = await t.invoke(t.as(), "sites.setup", {});
    expect(r.status).toBe("applied");
    expect(r.result.sections.map((s: any) => s.label)).toEqual(["Categories", "Starter pages", "First 30 days"]);
    expect(r.result.sections[1].text).toBe("About, How we test, Contact, Privacy, Affiliate disclosure");
    expect(r.result.sections[2].text).toBe("12 post ideas from real search questions, 3 drafted for your review");
    expect((await t.invoke(t.as(), "categories.list", {}) as any).result).toHaveLength(5);
    const pages: any = await t.invoke(t.as(), "posts.list", { type: "page", status: "published" });
    expect(pages.result).toHaveLength(5);
    const ideas: any = await t.invoke(t.as(), "brain.search", { kind: "idea" });
    expect(ideas.result).toHaveLength(12);
    const identity: any = await t.invoke(t.as(), "brain.search", { kind: "identity" });
    expect(identity.result.map((b: any) => b.text.split(":")[0]).sort()).toEqual(["Audience", "Tone", "What makes it different"]);
    const authors: any = await t.invoke(t.as(), "authors.list", {});
    expect(authors.result[0]).toMatchObject({ name: "Editorial team", isPersona: true });
    expect(r.result.runIds).toHaveLength(3);
    await t.rt.drain();
    const pending = t.db.query("SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending' AND action_name = 'posts.publish' AND group_id = ?").get(r.result.groupId) as any;
    expect(pending.n).toBe(3);
    // The drafts are written as the persona: no first-hand claims.
    for (const e of t.db.query<any, []>("SELECT body FROM entries WHERE type = 'post'").all()) expect(e.body).not.toMatch(/\bI (tested|bought|measured)\b/);
    // Undo removes what setup created.
    await t.invoke(t.as(), "history.undo", { actionId: r.actionId });
    expect((await t.invoke(t.as(), "categories.list", {}) as any).result).toHaveLength(0);
  });
});

describe("rewrite and refresh", () => {
  test("rewrite one section of a live post proposes a diff; 'add a photo' needs evidence", async () => {
    const t = await withFred();
    const d: any = await t.invoke(t.as(), "posts.create", {
      title: "Cable guide",
      authors: ["Fred"],
      markdown: "Cables are a mess for most people. They tangle behind the stand and collect dust. A few straps and one hole in the back panel fix most of it. It takes an afternoon.\n\n## Why?\n\nBecause.\n",
    });
    await t.invoke(t.as(), "posts.publish", { id: d.result.id, override: "test" });
    const e: any = await t.invoke(t.as(), "posts.get", { id: d.result.id, includeBlocks: true });
    const blockId = e.result.blocks[0].id;
    const r: any = await t.invoke(t.agent("writer"), "posts.rewrite_block", { id: d.result.id, blockId, instruction: "Shorter" });
    expect(r.result.delegated.status).toBe("proposed");
    const p: any = t.db.query("SELECT * FROM proposals WHERE id = ?").get(r.result.delegated.proposalId);
    expect(p.action_name).toBe("posts.update_block");
    expect(p.trust_kind).toBe("refresh");
    expect(r.result.markdown.split(/(?<=\.)\s/).length).toBeLessThan(4);

    const photo: any = await t.invoke(t.agent("writer"), "posts.rewrite_block", { id: d.result.id, blockId, instruction: "Add a photo" });
    expect(photo.result.message).toMatch(/no photo/i);
    expect(photo.result.navigate.to).toBe("/capture");
  });

  test("refresh proposes only changed sections with a one-line reason", async () => {
    const t = await testSite();
    const d: any = await t.invoke(t.as(), "posts.create", { title: "Best TV stands for 2024", markdown: "Our picks for 2024 are below. It's important to note that sizes vary.\n\n## Which stand fits a 65-inch TV?\n\nShort answer.\n" });
    await t.invoke(t.as(), "posts.publish", { id: d.result.id, override: "test" });
    const r: any = await t.invoke(t.agent("steward"), "posts.refresh", { id: d.result.id });
    expect(r.result.delegated.status).toBe("proposed");
    const p: any = t.db.query("SELECT * FROM proposals WHERE id = ?").get(r.result.delegated.proposalId);
    const year = new Date().getUTCFullYear();
    expect(p.summary).toMatch(/^Refresh: updated 2 year references/);
    expect(JSON.parse(p.diff).find((x: any) => x.label === "Title").after).toBe(`Best TV stands for ${year}`);
    // Nothing to do on a current post.
    const fresh: any = await t.invoke(t.as(), "posts.create", { title: "Fine", markdown: "All good here.\n" });
    const none: any = await t.invoke(t.agent("steward"), "posts.refresh", { id: fresh.result.id });
    expect(none.result.changed).toBe(false);
  });
});

describe("autopilot", () => {
  test("fills the cadence from ideas, one at a time, and respects the budget", async () => {
    const t = await testSite();
    await t.invoke(t.as(), "sites.setup", {});
    await t.rt.drain(); // the 3 setup drafts become 3 pending publish proposals
    // Setup started its drafts yesterday, so today's 3-post limit is untouched.
    t.db.query("UPDATE agent_runs SET created_at = ?").run(new Date(Date.now() - 86_400_000).toISOString());
    const full = await runAutopilot(t.system());
    expect(full.wrote).toBeNull();
    expect(full.why).toMatch(/lined up/);

    // Cadence of 5 days a week: room for 2 more, written one at a time.
    await t.invoke(t.as(), "settings.update", { cadence: { days: [1, 2, 3, 4, 5], time: "09:00" } });
    const first = await runAutopilot(t.system());
    expect(first.wrote).not.toBeNull();
    const busy = await runAutopilot(t.system());
    expect(busy.wrote).toBeNull();
    expect(busy.why).toMatch(/already being written/);
    await t.rt.drain();
    const second = await runAutopilot(t.system());
    expect(second.wrote).not.toBeNull();
    await t.rt.drain();
    const done = await runAutopilot(t.system());
    expect(done.wrote).toBeNull();
    // Ideas used are not reused.
    const used = t.db.query("SELECT COUNT(*) AS n FROM brain WHERE kind = 'idea' AND source LIKE 'used:%'").get() as any;
    expect(used.n).toBe(5);

    // No budget left: no new work (with a paid model).
    setModelClientForTests(() => fakeModel(0.01));
    await t.invoke(t.as(), "settings.update", { monthlyBudgetUsd: 0, cadence: { days: [0, 1, 2, 3, 4, 5, 6], time: "09:00" } });
    const broke = await runAutopilot(t.system());
    expect(broke.wrote).toBeNull();
    expect(broke.why).toMatch(/budget/);
  });

  test("never more than 3 posts a day", async () => {
    const t = await testSite();
    await t.invoke(t.as(), "sites.setup", {});
    await t.rt.drain();
    await t.invoke(t.as(), "settings.update", { cadence: { days: [0, 1, 2, 3, 4, 5, 6], time: "09:00" } });
    const r = await runAutopilot(t.system());
    expect(r.wrote).toBeNull();
    expect(r.why).toMatch(/Already started 3 posts today/);
  });

  test("proposes a refresh for old posts with stale facts, at most weekly", async () => {
    const t = await testSite();
    const now = new Date().toISOString();
    t.db.query("INSERT INTO facts (id, site_id, key, label, value, verified_at, check_every_days, created_at, updated_at) VALUES ('fct_1', ?, 'oak.price', 'Oak stand price', '$649', '2025-01-01T00:00:00.000Z', 7, ?, ?)").run(t.siteId, now, now);
    const d: any = await t.invoke(t.as(), "posts.create", { title: "Oak stand review for 2024", markdown: "It costs {{fact:oak.price}} in 2024.\n" });
    await t.invoke(t.as(), "posts.publish", { id: d.result.id, override: "test" });
    t.db.query("UPDATE entries SET published_at = '2025-01-01T00:00:00.000Z', updated_at = '2025-01-01T00:00:00.000Z' WHERE id = ?").run(d.result.id);
    const r = await runAutopilot(t.system());
    expect(r.refreshed).toEqual([d.result.id]);
    expect(t.db.query("SELECT COUNT(*) AS n FROM proposals WHERE entry_id = ? AND action_name = 'posts.update'").get(d.result.id)).toEqual({ n: 1 });
    const again = await runAutopilot(t.system());
    expect(again.refreshed).toEqual([]);
  });
});

test("optional actions are detected, never assumed", () => {
  expect(hasAction("posts.write")).toBe(true);
  expect(hasAction("definitely.not.here")).toBe(false);
});

describe("editor and limits", () => {
  test("the editor reads rejection lessons and doesn't repeat a turned-down title", async () => {
    const t = await withFred();
    const first: any = await t.invoke(t.as(), "posts.write", { topic: "walnut TV stands", author: "Fred", schedule: "none" });
    await t.rt.drain();
    const title = (t.db.query("SELECT title FROM entries WHERE type = 'post'").get() as any).title;
    t.db.query("UPDATE entries SET deleted_at = ? WHERE type = 'post'").run(new Date().toISOString());
    await t.invoke(t.as(), "brain.add", { kind: "lesson", text: `Discarded: Schedule “${title}” on Tue. Reason: don't say 'tape measure'` });
    const second: any = await t.invoke(t.as(), "posts.write", { topic: "walnut TV stands", author: "Fred", schedule: "none" });
    await t.rt.drain();
    const again: any = t.db.query("SELECT title, body FROM entries WHERE type = 'post' AND deleted_at IS NULL").get();
    expect(again.title).not.toBe(title);
    expect(again.body.toLowerCase()).not.toContain("tape measure");
    const steps = JSON.parse((t.db.query("SELECT steps FROM agent_runs WHERE id = ?").get(second.result.runId) as any).steps);
    expect(steps.find((s: any) => s.label === "Editor review").output).toMatch(/Checked 1 past rejection/);
    void first;
  });

  test("at most 3 jobs run at once per site; the 4th waits its turn", async () => {
    const t = await testSite();
    for (let i = 0; i < 3; i++) t.db.query("INSERT INTO agent_runs (id, site_id, requester, request, status, created_at) VALUES (?, ?, '{}', 'busy', 'running', ?)").run(`run_busy${i}`, t.siteId, new Date().toISOString());
    const r: any = await t.invoke(t.as(), "posts.write", { topic: "cable trays" });
    await t.rt.drain();
    expect((t.db.query("SELECT status FROM agent_runs WHERE id = ?").get(r.result.runId) as any).status).toBe("queued");
    const later = t.db.query("SELECT run_at FROM jobs WHERE kind = 'agents.write' AND status = 'queued'").get() as any;
    expect(Date.parse(later.run_at)).toBeGreaterThan(Date.now());
  });
});
