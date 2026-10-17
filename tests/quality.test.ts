import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fromMarkdown, toMarkdown } from "../src/content/markdown.ts";
import { defaultVoice } from "../src/core/voice.ts";
import { scoreAeo } from "../src/quality/aeo.ts";
import { scoreHuman } from "../src/quality/human.ts";
import { setRenderChecksForTests } from "../src/quality/readiness.ts";
import { scoreEntry, type ScoreInput } from "../src/quality/score.ts";
import { scoreSeo } from "../src/quality/seo.ts";
import { analyze, countWords } from "../src/quality/text.ts";
import { scoreVoice } from "../src/quality/voice.ts";
import { GOOD_MD, SLOPPY_MD } from "./quality.fixtures.ts";
import { testSite } from "./helpers.ts";

const fred = { name: "Fred Marsh", bio: "Builds and tests furniture in a one-bedroom apartment.", isPersona: false, voice: { ...defaultVoice(), person: "I" as const, sentenceLength: { value: 30, label: "Short", avgWords: 13 } } };

function input(md: string, over: Partial<ScoreInput["entry"]> = {}, rest: Partial<ScoreInput> = {}): ScoreInput {
  return {
    entry: { id: "ent_1", type: "post", status: "draft", title: "How to pick a TV stand for a 77-inch TV", description: "", slug: "tv-stand-77-inch", body: fromMarkdown(md), updatedAt: null, publishedAt: null, ...over },
    authors: [fred],
    minimums: { human: 80, seo: 85, aeo: 80 },
    facts: {},
    others: [],
    ...rest,
  };
}

const a = (md: string, title = "How to pick a TV stand") => analyze({ title, description: "", slug: "x", body: fromMarkdown(md) });

describe("Human score", () => {
  test("specific, first-hand writing scores high; AI-sloppy writing scores clearly lower", () => {
    const good = scoreHuman(a(GOOD_MD));
    const sloppy = scoreHuman(a(SLOPPY_MD));
    expect(good.score).toBeGreaterThanOrEqual(80);
    expect(sloppy.score).toBeLessThan(70);
    expect(good.score - sloppy.score).toBeGreaterThanOrEqual(30);
    expect(good.findings.filter((f) => f.severity !== "info")).toEqual([]);

    const codes = new Set(sloppy.findings.map((f) => f.code));
    for (const code of ["human.puffery", "human.promotional", "human.negative_parallelism", "human.rule_of_three", "human.trailing_clause", "human.summary", "human.chatbot", "human.title_case", "human.no_specifics", "human.no_first_hand"]) {
      expect(codes.has(code)).toBe(true);
    }
  });

  test("fixes push toward substance and offer mechanical cuts only when safe", () => {
    const r = scoreHuman(a(SLOPPY_MD));
    const puffery = r.findings.find((f) => f.code === "human.puffery" && f.quote?.includes("testament"))!;
    expect(puffery.message).toMatch(/say what you saw instead/);
    expect(puffery.suggestion).toBeUndefined();

    const trailing = r.findings.find((f) => f.code === "human.trailing_clause")!;
    expect(trailing.quote).toBe("TV stands come in many sleek, sturdy, and stylish designs, highlighting their importance in modern homes.");
    expect(trailing.suggestion).toBe("TV stands come in many sleek, sturdy, and stylish designs.");

    const chatbot = r.findings.find((f) => f.code === "human.chatbot")!;
    expect(chatbot.severity).toBe("error");
    expect(chatbot.suggestion).toBe("");

    const opener = r.findings.find((f) => f.code === "human.filler")!;
    expect(opener.suggestion).toStartWith("Choosing the perfect TV stand");

    const noNumbers = r.findings.find((f) => f.code === "human.no_specifics")!;
    expect(noNumbers.message).toMatch(/measured, counted or paid/);
  });

  test("uniform rhythm is flagged", () => {
    const flat = Array.from({ length: 10 }, (_, i) => `The stand number ${i} has a shelf that holds the box well.`).join(" ");
    expect(scoreHuman(a(flat)).findings.some((f) => f.code === "human.rhythm")).toBe(true);
  });

  test("persona bylines need sources instead of first-hand detail", () => {
    const r = scoreHuman(a("A 77-inch TV is about 67 inches wide, so the stand should be 70 inches or more."), { persona: true });
    expect(r.findings.some((f) => f.code === "human.no_sources" && f.severity === "warn")).toBe(true);
    expect(r.findings.some((f) => f.code === "human.no_first_hand")).toBe(false);
  });
});

describe("SEO score", () => {
  test("title, meta description, outline, alt text, links and cannibalization", () => {
    const md = "Intro paragraph about stands that is long enough to become a meta description for the post, with a real detail: 72 inches.\n\n## Width\n\n#### Feet\n\nText.\n\n![](media:med_1)";
    const r = scoreSeo(a(md, "The Complete and Ultimate Guide to Choosing a Television Stand for Any Room"), { type: "post", status: "draft", inboundLinks: 0, others: [{ id: "x", title: "Choosing a television stand for any room" }] });
    const codes = r.findings.map((f) => f.code);
    expect(codes).toContain("seo.title_length");
    expect(codes).toContain("seo.meta_missing");
    expect(codes).toContain("seo.heading_order");
    expect(codes).toContain("seo.alt_missing");
    expect(codes).toContain("seo.no_internal_links");
    expect(codes).toContain("seo.cannibalization");
    const meta = r.findings.find((f) => f.code === "seo.meta_missing")!;
    expect(meta.suggestion!.length).toBeLessThanOrEqual(155);
    expect(meta.suggestion).toStartWith("Intro paragraph about stands");
    expect(r.score).toBeLessThan(60);
  });

  test("a well-built post passes", () => {
    const md = `${GOOD_MD}\nSee [how we test stands](tq:ent_a) and [cable tidying](tq:ent_b).\n`;
    const an = analyze({ title: "How to pick a TV stand for a 77-inch TV", description: "How wide a stand a 77-inch TV needs, how much weight it should hold, and the two stands we'd buy after testing them at home.", slug: "tv-stand-77-inch", body: fromMarkdown(md) });
    const r = scoreSeo(an, { type: "post", status: "draft", inboundLinks: 0, others: [] });
    expect(r.findings.filter((f) => f.severity === "warn")).toEqual([]);
    expect(r.score).toBeGreaterThanOrEqual(85);
  });
});

describe("AEO score", () => {
  const questions = `Intro with 3 numbers: 67, 70 and 75 inches.

## How wide should the stand be?

Short.

## How much weight can it hold?

## What about cables?

## Do I need a wall mount?
`;
  test("question headings need direct answers; four questions ask for an FAQ", () => {
    const r = scoreAeo(a(questions), { author: { name: "Fred", bio: "", isPersona: false }, status: "draft", updatedAt: null });
    const direct = r.findings.filter((f) => f.code === "aeo.direct_answer");
    expect(direct.length).toBe(4);
    expect(direct[0]!.message).toBe("Add a direct answer under “How wide should the stand be?” so assistants can quote it.");
    expect(r.findings.find((f) => f.code === "aeo.faq")!.message).toBe("Add FAQ structured data for the 4 questions this post answers.");
  });

  test("drafted answers stay within 40-60 words", () => {
    const r = scoreAeo(a(GOOD_MD.replace("At least 67 inches, ideally 70 to 75. ", "")), { author: null, status: "draft", updatedAt: null });
    for (const f of r.findings.filter((x) => x.code === "aeo.direct_answer" && x.suggestion)) {
      expect(countWords(f.suggestion!)).toBeLessThanOrEqual(60);
    }
    expect(r.findings.some((f) => f.code === "aeo.no_author")).toBe(true);
  });

  test("a post that answers first scores well", () => {
    const r = scoreAeo(a(GOOD_MD), { author: { name: "Fred", bio: "Builds furniture.", isPersona: false }, status: "draft", updatedAt: null });
    expect(r.score).toBeGreaterThanOrEqual(80);
    expect(r.findings.some((f) => f.code === "aeo.direct_answer")).toBe(false);
  });
});

describe("voice match", () => {
  test("matches the author's fingerprint and flags phrases they never use", () => {
    const good = scoreVoice(a(GOOD_MD), fred.voice, "Fred");
    const sloppy = scoreVoice(a(SLOPPY_MD), fred.voice, "Fred");
    expect(good.score).toBeGreaterThanOrEqual(80);
    expect(sloppy.score).toBeLessThan(good.score - 30);
    expect(sloppy.findings.some((f) => f.code === "voice.banned" && f.message.includes("never says “elevate”"))).toBe(true);
    expect(sloppy.findings.some((f) => f.code === "voice.person")).toBe(true);
  });
  test("no author, no voice score", () => {
    expect(scoreEntry(input(GOOD_MD, {}, { authors: [] })).scores.voice).toBeNull();
  });
});

describe("Ready light", () => {
  test("headline counts fixes; green only when every minimum and check passes", () => {
    const r = scoreEntry(input(SLOPPY_MD));
    expect(r.ready).toBe(false);
    expect(r.light).toBe("red");
    expect(r.headline).toMatch(/^\d+ fixes before it's ready$/);
    expect(r.findings[0]!.severity).toBe("error");

    const md = `${GOOD_MD}\n## Will a 65-inch stand work?\n\nNot for a 77-inch TV. A 65-inch stand is about 57 inches wide at most, so the TV would overhang by 5 inches on each side and the feet would sit right at the edge of the top.\n\nRead [how we test stands](tq:ent_a) and [how to hide cables](tq:ent_b).\n`;
    const ok = scoreEntry(
      input(md, { description: "How wide a stand a 77-inch TV needs, how much weight it should hold, and the two stands we'd buy after testing them at home." }, {
        linkTargets: { ent_a: { status: "published", title: "How we test" }, ent_b: { status: "published", title: "Cables" } },
      }),
    );
    // Four question headings and no FAQ yet: one AEO fix.
    expect(ok.findings.some((f) => f.code === "aeo.faq")).toBe(true);
    const withFaq = scoreEntry(
      input(`${md}\n${ok.findings.find((f) => f.code === "aeo.faq")!.suggestion}\n`, { description: "How wide a stand a 77-inch TV needs, how much weight it should hold, and the two stands we'd buy after testing them at home." }, {
        linkTargets: { ent_a: { status: "published", title: "How we test" }, ent_b: { status: "published", title: "Cables" } },
      }),
    );
    expect(withFaq.scores.human).toBeGreaterThanOrEqual(80);
    expect(withFaq.scores.seo).toBeGreaterThanOrEqual(85);
    expect(withFaq.scores.aeo).toBeGreaterThanOrEqual(80);
    expect(withFaq.headline).toBe("Ready");
    expect(withFaq.light).toBe("green");
  });

  test("a persona can't claim first-hand experience", () => {
    const r = scoreEntry(input(GOOD_MD, {}, { authors: [{ ...fred, name: "Sam Reed", isPersona: true }] }));
    const f = r.findings.find((x) => x.code === "check.persona_first_hand")!;
    expect(f.severity).toBe("error");
    expect(f.message).toContain("Sam Reed is a persona");
    expect(r.ready).toBe(false);
    expect(r.checks.find((c) => c.name === "First-hand claims")!.passed).toBe(false);
  });

  test("internal links to drafts or deleted pages block publishing", () => {
    const r = scoreEntry(input(`${GOOD_MD}\nSee [our cable guide](tq:ent_draft) and [old post](tq:ent_gone).\n`, {}, { linkTargets: { ent_draft: { status: "draft", title: "Cable guide" } } }));
    const broken = r.findings.filter((f) => f.code === "check.internal_link_broken");
    expect(broken.length).toBe(2);
    expect(broken[0]!.message).toContain("draft “Cable guide”");
    expect(r.checks.find((c) => c.name === "Internal links")).toMatchObject({ passed: false, blocking: true });
    expect(r.light).toBe("red");
  });

  test("unknown fact references block publishing", () => {
    const r = scoreEntry(input(`${GOOD_MD}\nIt costs {{fact:missing-price}}.\n`));
    expect(r.findings.some((f) => f.code === "check.unknown_fact")).toBe(true);
    expect(r.ready).toBe(false);
  });

  test("pages like About aren't held to article checks", () => {
    const about = "Walnut & Wire is two people in Toronto who build and test media furniture. We started in 2023 after a stand collapsed under our TV. We buy every stand we review.";
    const r = scoreEntry(input(about, { type: "page", title: "About Walnut & Wire", slug: "about" }, { authors: [] }));
    const codes = r.findings.map((f) => f.code);
    for (const code of ["aeo.no_citations", "aeo.no_author", "human.no_sources", "seo.no_internal_links", "seo.no_external_links"]) expect(codes).not.toContain(code);
  });

  test("scores a 3,000-word post in well under 200 ms", () => {
    const long = Array.from({ length: 11 }, () => GOOD_MD).join("\n");
    const ins = input(long);
    expect(countWords(toMarkdown(ins.entry.body))).toBeGreaterThan(3000);
    scoreEntry(ins);
    const t0 = performance.now();
    scoreEntry(ins);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe("quality actions", () => {
  beforeAll(() => setRenderChecksForTests(null));
  afterAll(() => setRenderChecksForTests(undefined));

  async function site() {
    const t = await testSite();
    await t.invoke(t.as(), "authors.create", { name: "Fred Marsh", bio: "Builds furniture.", voice: fred.voice });
    return t;
  }

  test("posts.get and quality.score return the Ready light", async () => {
    const t = await site();
    const d: any = await t.invoke(t.as(), "posts.create", { title: "How to pick a TV stand for a 77-inch TV", markdown: SLOPPY_MD, authors: ["Fred Marsh"] });
    const got: any = await t.invoke(t.as(), "posts.get", { id: d.result.id });
    expect(got.result.ready.light).toBe("red");
    expect(got.result.ready.scores.voice).not.toBeNull();
    const scored: any = await t.invoke(t.as(), "quality.score", { id: d.result.id });
    expect(scored.result.headline).toMatch(/fixes before it's ready/);
  });

  test("Fix it: meta description, cut a stock phrase, add a direct answer and an FAQ", async () => {
    const t = await site();
    const md = `${GOOD_MD}\n## Do I need a wall mount?\n\nOnly if the wall is narrower than 80 inches, highlighting the importance of measuring first. A mount costs about $90 and takes an afternoon.\n`;
    const d: any = await t.invoke(t.as(), "posts.create", { title: "How to pick a TV stand for a 77-inch TV", markdown: md, authors: ["Fred Marsh"] });
    const id = d.result.id;

    // Drafts are invisible to readers, so the editorial team can fix them without asking.
    const meta: any = await t.invoke(t.agent("seo"), "quality.fix", { id, code: "seo.meta_missing" });
    expect(meta.status).toBe("applied");
    let post: any = ((await t.invoke(t.as(), "posts.get", { id })) as any).result;
    expect(post.description).toStartWith("I bought the wrong stand first.");

    const cut: any = await t.invoke(t.as(), "quality.fix", { id, code: "human.trailing_clause" });
    expect(cut.status).toBe("applied");
    post = ((await t.invoke(t.as(), "posts.get", { id })) as any).result;
    expect(post.markdown).toContain("Only if the wall is narrower than 80 inches. A mount costs");

    const chat: any = await t.invoke(t.as(), "posts.update", { id, markdown: `${post.markdown}\nThat's the whole list. I hope this helps!\n` });
    expect(chat.status).toBe("applied");
    await t.invoke(t.as(), "quality.fix", { id, code: "human.chatbot" });
    post = ((await t.invoke(t.as(), "posts.get", { id })) as any).result;
    expect(post.markdown).toContain("That's the whole list.\n");

    const faq: any = await t.invoke(t.as(), "quality.fix", { id, code: "aeo.faq" });
    expect(faq.status).toBe("applied");
    post = ((await t.invoke(t.as(), "posts.get", { id, includeBlocks: true })) as any).result;
    const faqBlock = post.blocks.find((b: any) => b.type === "faq");
    expect(faqBlock.items.map((i: any) => i.q)).toEqual(["How wide should the stand be?", "How much weight can it hold?", "What about cables?", "Do I need a wall mount?"]);

    // Undo puts back exactly what the fix changed.
    await t.invoke(t.as(), "history.undo", { actionId: faq.actionId });
    post = ((await t.invoke(t.as(), "posts.get", { id, includeBlocks: true })) as any).result;
    expect(post.blocks.some((b: any) => b.type === "faq")).toBe(false);
    expect(post.markdown).toContain("Only if the wall is narrower than 80 inches. A mount costs");
  });

  test("direct answer fix inserts an answer block under the heading; alt text without a caption needs a person", async () => {
    const t = await site();
    const long =
      "A 77-inch TV is about 67 inches wide. You want a few inches of stand on each side, so look for 70 to 75 inches. Narrower stands make the screen look like it's balancing. " +
      "Measure the feet too, because some sets need 60 inches between them, and the spec sheet lists that as stand width. I checked ours with a tape and got 60.2 inches. " +
      "If your room is tight, a 72-inch stand is the sweet spot: it leaves a hand's width on each side and still fits between most windows and doors.";
    const md = `Intro with 67 inches.\n\n## How wide should the stand be?\n\n${long}\n\n![](media:med_1)\n`;
    const d: any = await t.invoke(t.as(), "posts.create", { title: "TV stand width", markdown: md, authors: ["Fred Marsh"] });
    const scored: any = await t.invoke(t.as(), "quality.score", { id: d.result.id });
    const finding = scored.result.findings.find((f: any) => f.code === "aeo.direct_answer");
    expect(countWords(finding.suggestion)).toBeGreaterThanOrEqual(40);
    expect(countWords(finding.suggestion)).toBeLessThanOrEqual(60);
    const r: any = await t.invoke(t.as(), "quality.fix", { id: d.result.id, code: "aeo.direct_answer", blockId: finding.blockId });
    expect(r.status).toBe("applied");
    const post: any = ((await t.invoke(t.as(), "posts.get", { id: d.result.id, includeBlocks: true })) as any).result;
    const i = post.blocks.findIndex((b: any) => b.id === finding.blockId);
    expect(post.blocks[i + 1]).toMatchObject({ type: "answer", text: finding.suggestion });

    const alt = scored.result.findings.find((f: any) => f.code === "seo.alt_missing");
    await expect(t.invoke(t.as(), "quality.fix", { id: d.result.id, code: "seo.alt_missing", blockId: alt.blockId })).rejects.toThrow(/Describe what the photo shows/);
  });

  test("fixes on live posts are proposed as refreshes until trust is earned", async () => {
    const t = await site();
    const d: any = await t.invoke(t.as(), "posts.create", { title: "How to pick a TV stand for a 77-inch TV", markdown: GOOD_MD, authors: ["Fred Marsh"] });
    await t.invoke(t.as(), "posts.publish", { id: d.result.id, override: "test" });
    const r: any = await t.invoke(t.agent("seo"), "quality.fix", { id: d.result.id, code: "seo.meta_missing" });
    expect(r.status).toBe("proposed");
    const p: any = await t.invoke(t.as(), "proposals.get", { id: r.proposalId });
    expect(p.result.trustKind).toBe("refresh");
    expect(p.result.diff[0].label).toBe("Description");
    await t.invoke(t.as(), "proposals.approve", { id: r.proposalId });
    const post: any = ((await t.invoke(t.as(), "posts.get", { id: d.result.id })) as any).result;
    expect(post.description.length).toBeGreaterThan(40);
  });

  test("a fix that no longer applies says so", async () => {
    const t = await site();
    const d: any = await t.invoke(t.as(), "posts.create", { title: "Stands", markdown: GOOD_MD, authors: ["Fred Marsh"] });
    await expect(t.invoke(t.as(), "quality.fix", { id: d.result.id, code: "human.chatbot" })).rejects.toThrow(/no longer applies/);
  });

  test("broken internal link fix unlinks and keeps the words", async () => {
    const t = await site();
    const target: any = await t.invoke(t.as(), "posts.create", { title: "Cable guide", markdown: "Cables." });
    const d: any = await t.invoke(t.as(), "posts.create", { title: "Stands", markdown: `${GOOD_MD}\nSee [our cable guide](tq:${target.result.id}).\n`, authors: ["Fred Marsh"] });
    const scored: any = await t.invoke(t.as(), "quality.score", { id: d.result.id });
    const f = scored.result.findings.find((x: any) => x.code === "check.internal_link_broken");
    expect(f.message).toContain("draft “Cable guide”");
    await t.invoke(t.as(), "quality.fix", { id: d.result.id, code: f.code, blockId: f.blockId });
    const post: any = ((await t.invoke(t.as(), "posts.get", { id: d.result.id })) as any).result;
    expect(post.markdown).toContain("See our cable guide.");
  });
});
