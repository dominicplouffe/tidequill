import { afterEach, describe, expect, test } from "bun:test";
import { ask } from "../src/agents/ask.ts";
import { command } from "../src/agents/command.ts";
import { parseIntent } from "../src/agents/intent.ts";
import { setModelClientForTests, type ModelClient } from "../src/agents/model.ts";
import { nextWeekStart } from "../src/agents/pipeline.ts";
import { hasAction } from "../src/agents/optional.ts";
import { createApi } from "../src/server/app.ts";
import { testSite } from "./helpers.ts";

afterEach(() => setModelClientForTests(null));

async function site() {
  const t = await testSite();
  const fred: any = await t.invoke(t.as(), "authors.create", { name: "Fred Laurent", expertise: ["assembly", "cables"] });
  await t.invoke(t.as(), "authors.create", { name: "Suzie Park", expertise: ["materials"] });
  const post: any = await t.invoke(t.as(), "posts.create", { title: "How to pick a TV stand for a 77-inch TV", authors: ["Fred"], markdown: "Measure the TV first. Then the room. Then the stand.\n\n## How wide should the stand be?\n\nWider than the TV.\n" });
  await t.invoke(t.as(), "posts.publish", { id: post.result.id, override: "test" });
  const blocks: any = await t.invoke(t.as(), "posts.get", { id: post.result.id, includeBlocks: true });
  return { ...t, fredId: fred.result.id as string, postId: post.result.id as string, blockId: blocks.result.blocks[0].id as string };
}

const actions = (t: any, msg: string, context = {}) => parseIntent(t.as(), msg, context).steps.map((s) => s.action);

describe("offline intent parser", () => {
  test("coverage table", async () => {
    const t = await site();
    const look = hasAction("look.update_tokens") ? "look.update_tokens" : "look.describe";
    const table: [string, string[], object?][] = [
      ["Write a post about walnut TV stands", ["posts.write"]],
      ["write a post about hiding cables as Fred for next week", ["posts.write"]],
      ["Write three posts about walnut TV stands in Fred's voice", ["posts.write", "posts.write", "posts.write"]],
      ["draft 2 articles on cable trays", ["posts.write", "posts.write"]],
      ["Make the site warmer", ["look.describe"]],
      ["make it feel more premium", ["look.describe"]],
      ["Use sans-serif headings", [look]],
      ["bigger text please", [look]],
      ["Make the site darker", [look]],
      ["Remember that we never recommend glass stands", ["brain.add"]],
      ["remember we prefer solid wood over veneer", ["brain.add"]],
      ["Show me my settings", ["settings.show"]],
      ["What do you handle on your own?", ["autonomy.status"]],
      ["Ask me first", ["ask.ask_me_first"]],
      ["Stop asking me first", ["ask.stop_asking"]],
      ["Set the budget to $60", ["settings.update"]],
      ["Publish on Mondays and Thursdays at 8:00", ["settings.update"]],
      ["undo", ["ask.undo"]],
      ["Undo that", ["ask.undo"]],
      ["What's waiting?", ["ask.waiting"]],
      ["what did you do this week", ["ask.done"]],
      ["Make Fred funnier", ["authors.adjust_voice"]],
      ["make Suzie's voice a bit less jokey", ["authors.adjust_voice"]],
      ["Fred should never say game-changer", ["authors.adjust_voice"]],
      ["Rewrite this section shorter", ["posts.rewrite_block"], { entryId: t.postId, blockId: t.blockId }],
      ["add a photo here", ["posts.rewrite_block"], { entryId: t.postId, blockId: t.blockId }],
      ["Refresh this post", ["posts.refresh"], { entryId: t.postId }],
      ["Add the domain example.com", ["sites.add_domain"]],
      ["Redirect /old-stands to /tv-stands", ["redirects.create"]],
      ["How do I add a redirect?", ["ask.help"]],
      ["show me my drafts", ["posts.list"]],
      ["Hide the AI line", ["settings.update"]],
      ["Lower the answer-ready minimum to 75", ["settings.update"]],
      ["approve them all", ["ask.approve"]],
      ["Make Fred funnier and write a post about cable trays", ["authors.adjust_voice", "posts.write"]],
      ["Remember that we never recommend glass stands, then show me my settings", ["brain.add", "settings.show"]],
    ];
    for (const [msg, expected, context] of table) {
      expect({ msg, got: actions(t, msg, context) }).toEqual({ msg, got: expected });
    }
    // Inputs are right, not just the action names.
    const [w] = parseIntent(t.as(), "write a post about hiding cables as Fred", {}).steps;
    expect(w!.input).toMatchObject({ topic: "hiding cables", author: t.fredId, schedule: "next_slot" });
    const [b] = parseIntent(t.as(), "Remember that we never recommend glass stands", {}).steps;
    expect(b!.input).toEqual({ kind: "claim_rule", text: "We never recommend glass stands." });
    const [c] = parseIntent(t.as(), "Publish on Mondays and Thursdays at 8:00", {}).steps;
    expect(c!.input).toEqual({ cadence: { days: [1, 4], time: "08:00" } });
    const [v] = parseIntent(t.as(), "Make Fred funnier", {}).steps;
    expect(v!.text).toBe("Make Fred’s voice a bit funnier");
    expect(parseIntent(t.as(), "Set the budget to $60", {}).steps[0]!.input).toEqual({ monthlyBudgetUsd: 60 });
    // Unknown requests are reported as unknown, not guessed.
    expect(parseIntent(t.as(), "sing me a sea shanty", {}).unknown).toEqual(["sing me a sea shanty"]);
  });

  test("price changes go to the fact ledger when it is installed", async () => {
    const t = await site();
    const now = new Date().toISOString();
    t.db.query("INSERT INTO facts (id, site_id, key, label, value, created_at, updated_at) VALUES ('fct_1', ?, 'oak-and-co-stand.price', 'Oak & Co. stand price', '$649', ?, ?)").run(t.siteId, now, now);
    const steps = parseIntent(t.as(), "Change the price of the Oak & Co. stand to $599", {}).steps;
    if (hasAction("facts.update")) {
      expect(steps[0]!.action).toBe("facts.update");
      expect(steps[0]!.text).toContain("$599");
    } else expect(steps[0]!.action).toBe("ask.reply");
  });
});

describe("Ask", () => {
  test("the prototype request: look change + 3 drafts for next week as Fred, grouped", async () => {
    const t = await site();
    const msg = "Make walnutandwire feel more premium: serif headings, warmer neutrals. Then write three posts for next week in Fred's voice about walnut TV stands.";
    const res = await ask(t.as(), { message: msg });
    expect(res.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const reply = res.messages[1]!;
    expect(reply.text).toStartWith("Here's the plan. Nothing changes on the live site until you approve.");
    const plan = reply.cards[0] as any;
    expect(plan.type).toBe("plan");
    expect(plan.steps).toHaveLength(5);
    expect(plan.steps.filter((s: any) => s.text.startsWith("Draft “"))).toHaveLength(3);
    expect(plan.steps.every((s: any) => s.text.includes("as Fred") || !s.text.startsWith("Draft"))).toBe(true);
    expect(plan.steps[4].text).toBe("Schedule them Tue, Thu and Sat at 9:00, after you approve each draft.");
    expect(plan.minutes).toBeGreaterThanOrEqual(1);
    expect(plan.groupId).toBeTruthy();
    const looks = reply.cards.find((c) => c.type === "looks" || c.type === "proposal");
    expect(looks).toBeTruthy();
    expect(reply.cards.filter((c) => c.type === "progress")).toHaveLength(3);

    // Drafts are written in the background, then the conversation hears back.
    await t.rt.drain();
    const proposals = t.db.query<any, [string]>("SELECT * FROM proposals WHERE group_id = ? AND action_name = 'posts.publish' ORDER BY created_at").all(plan.groupId);
    expect(proposals).toHaveLength(3);
    const days = proposals.map((p) => new Date(JSON.parse(p.payload).at).getUTCDay());
    expect(days).toEqual([2, 4, 6]);
    const weekStart = nextWeekStart().getTime();
    for (const p of proposals) expect(Date.parse(JSON.parse(p.payload).at)).toBeGreaterThanOrEqual(weekStart);
    const titles = t.db.query<any, []>("SELECT title FROM entries WHERE type = 'post' AND status = 'draft'").all().map((r) => r.title);
    expect(new Set(titles).size).toBe(3);
    const authors = t.db.query<any, []>("SELECT author_ids FROM entries WHERE type = 'post' AND status = 'draft'").all();
    for (const a of authors) expect(JSON.parse(a.author_ids)).toEqual([t.fredId]);

    const conv = await ask(t.as(), { conversationId: res.conversationId, message: "what's waiting?" });
    const all = (await import("../src/agents/ask.ts")).conversation;
    const history = await all(t.as(), res.conversationId);
    const done = history.messages.find((m) => m.text === "Done. 3 posts are waiting for you.");
    expect(done).toBeTruthy();
    expect(done!.cards.filter((c) => c.type === "proposal")).toHaveLength(3);
    // Progress cards now read done.
    expect(history.messages[1]!.cards.filter((c: any) => c.type === "progress").every((c: any) => c.status === "done")).toBe(true);
    expect(conv.messages[1]!.text).toMatch(/things are waiting for you/);
  });

  test("conversations persist and belong to their person", async () => {
    const t = await site();
    const a = await ask(t.as(), { message: "Remember that we never recommend glass stands" });
    expect(a.messages[1]!.text).toBe("Done. I'll remember that.");
    expect(a.messages[1]!.cards[0]!.type).toBe("applied");
    const b = await ask(t.as(), { conversationId: a.conversationId, message: "Show me my settings" });
    expect(b.conversationId).toBe(a.conversationId);
    expect(b.messages[1]!.cards[0]!.type).toBe("settings");
    const { conversation } = await import("../src/agents/ask.ts");
    const full = await conversation(t.as(), a.conversationId);
    expect(full.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const stranger = t.rt.ctx({ actor: { kind: "human", userId: "usr_other" }, siteId: t.siteId, role: "owner" });
    await expect(conversation(stranger, a.conversationId)).rejects.toThrow(/not found/);
    const brain: any = await t.invoke(t.as(), "brain.search", { kind: "claim_rule" });
    expect(brain.result[0].text).toBe("We never recommend glass stands.");
  });

  test("commands are handed back as buttons, never run by the agent", async () => {
    const t = await site();
    const r: any = await t.invoke(t.agent("steward"), "redirects.create", { from: "/a", to: "/b/" });
    const approve = await ask(t.as(), { message: "approve them all" });
    expect(approve.messages[1]!.cards.some((c: any) => c.type === "proposal" && c.proposalId === r.proposalId)).toBe(true);
    expect((t.db.query("SELECT status FROM proposals WHERE id = ?").get(r.proposalId) as any).status).toBe("pending");

    await t.invoke(t.as(), "settings.update", { monthlyBudgetUsd: 55 });
    const undo = await ask(t.as(), { message: "undo that" });
    const card = undo.messages[1]!.cards[0] as any;
    expect(card).toMatchObject({ type: "applied", undoable: true });
    expect((t.db.query("SELECT status FROM actions WHERE id = ?").get(card.actionId) as any).status).toBe("applied");

    const stop = await ask(t.as(), { message: "stop asking me first" });
    expect(stop.messages[1]!.cards[0]).toMatchObject({ type: "navigate", to: "/settings" });
  });

  test("changes from Ask are proposals; voice changes carry a before and after", async () => {
    const t = await site();
    const r = await ask(t.as(), { message: "Set the budget to $60 and make Fred funnier" });
    const cards = r.messages[1]!.cards;
    expect(cards[0]!.type).toBe("plan");
    const proposals = cards.filter((c) => c.type === "proposal") as any[];
    expect(proposals).toHaveLength(2);
    expect(proposals[0].summary).toContain("$60");
    expect(proposals[1].diff.some((d: any) => d.label === "Hear it")).toBe(true);
    const groups = new Set(t.db.query<any, []>("SELECT group_id FROM proposals").all().map((p) => p.group_id));
    expect(groups.size).toBe(1);
  });

  test("knows the page you're on", async () => {
    const t = await site();
    const r = await ask(t.as(), { message: "Rewrite this section shorter", context: { entryId: t.postId, blockId: t.blockId } });
    const p = r.messages[1]!.cards.find((c) => c.type === "proposal") as any;
    expect(p).toBeTruthy();
    expect(p.entry.id).toBe(t.postId);
    const none = await ask(t.as(), { message: "Rewrite this section shorter" });
    expect(none.messages[1]!.text).toMatch(/Tap the section/);
  });

  test("help answers offer to do it; unknown requests get suggestions, never errors", async () => {
    const t = await site();
    const h = await ask(t.as(), { message: "How do I add a redirect?" });
    expect(h.messages[1]!.text).toMatch(/Redirect \/old-page to \/new-page/);
    const u = await ask(t.as(), { message: "sing me a sea shanty" });
    expect(u.messages[1]!.text).toMatch(/^I'm not sure how to do that yet\. You could try/);
    expect(u.messages[1]!.cards).toEqual([]);
    const bad = await ask(t.as(), { message: "write a post about cables as Nobody" });
    expect(bad.messages[1]!.cards.some((c) => c.type === "progress" || c.type === "error")).toBe(true);
  });

  test("with a model: the planner's steps are validated against the catalog", async () => {
    const t = await site();
    const fake: ModelClient = {
      offline: false,
      async complete() {
        return {
          text: JSON.stringify({
            reply: "Here's the plan. Nothing changes on the live site until you approve.",
            steps: [
              { action: "redirects.create", input: { from: "/x", to: "/y/" }, why: "Send /x to /y" },
              { action: "posts.delete", input: { id: t.postId }, why: "Delete it" },
              { action: "settings.update", input: { monthlyBudgetUsd: "lots" }, why: "Bad input" },
              { action: "proposals.approve", input: {}, why: "Approve" },
              { action: "made.up", input: {}, why: "Nope" },
            ],
          }),
          tokensIn: 100,
          tokensOut: 50,
          costUsd: 0.002,
          model: "fake",
          provider: "anthropic",
        };
      },
    };
    setModelClientForTests(() => fake);
    const r = await ask(t.as(), { message: "send /x to /y and delete my post" });
    const plan = r.messages[1]!.cards[0] as any;
    expect(plan.type).toBe("plan");
    expect(plan.steps.map((s: any) => s.text)).toEqual(["Send /x to /y", "Approve"]);
    expect(plan.costUsd).toBeCloseTo(0.002, 3);
    expect(t.db.query("SELECT COUNT(*) AS n FROM entries WHERE id = ? AND deleted_at IS NULL").get(t.postId)).toEqual({ n: 1 });
    expect(r.messages[1]!.text).toStartWith("Here's the plan.");
  });
});

describe("command bar", () => {
  test("“Fred” finds Fred; “make fred funnier” offers to do it", async () => {
    const t = await site();
    const fred = command(t.as(), "Fred");
    expect(fred.goTo[0]).toEqual({ label: "Fred Laurent", kind: "Author", href: expect.stringMatching(/^\/authors\//) });
    expect(fred.goTo.some((g) => g.label === "Fred’s voice settings")).toBe(true);
    expect(fred.goTo.some((g) => g.label === "How to pick a TV stand for a 77-inch TV" && g.kind === "Published")).toBe(true);
    const doit = command(t.as(), "make fred funnier");
    expect(doit.doIt[0]).toEqual({ label: "Make Fred’s voice a bit funnier", hint: "Shows a before and after; nothing changes until you approve", ask: "make fred funnier" });
    expect(command(t.as(), "budget").goTo.some((g) => g.label === "Agent budget" && g.href === "/settings")).toBe(true);
    expect(command(t.as(), "tv stand").goTo[0]!.label).toBe("How to pick a TV stand for a 77-inch TV");
    expect(command(t.as(), "").doIt.length).toBeGreaterThan(0);
    expect(command(t.as(), "write three posts about cable trays").doIt[0]!.label).toMatch(/^Draft 3 posts/);
  });
});

describe("HTTP", () => {
  test("POST /api/ask, GET /api/ask/:id, GET /api/runs/:id, POST /api/command", async () => {
    const t = await site();
    const app = createApi(t.rt);
    const login = await app.request("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "owner@example.com", password: "correct horse battery" }), headers: { "content-type": "application/json" } });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const h = { cookie, "x-tq-site": t.siteId, "content-type": "application/json" };
    const res = await app.request("/api/ask", { method: "POST", headers: h, body: JSON.stringify({ message: "write a post about cable trays as Fred" }) });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.messages).toHaveLength(2);
    const progress = body.messages[1].cards.find((c: any) => c.type === "progress");
    const run: any = await (await app.request(`/api/runs/${progress.runId}`, { headers: h })).json();
    expect(run).toMatchObject({ id: progress.runId, status: "queued", proposalIds: [] });
    expect(run.steps[0]).toMatchObject({ role: "editor", label: "Brief", status: "pending" });
    await t.rt.drain();
    const after: any = await (await app.request(`/api/runs/${progress.runId}`, { headers: h })).json();
    expect(after.status).toBe("done");
    expect(after.proposalIds).toHaveLength(1);
    const conv: any = await (await app.request(`/api/ask/${body.conversationId}`, { headers: h })).json();
    expect(conv.messages.length).toBe(3);
    const cmd: any = await (await app.request("/api/command", { method: "POST", headers: h, body: JSON.stringify({ query: "fred" }) })).json();
    expect(cmd.goTo[0].label).toBe("Fred Laurent");
    const empty = await app.request("/api/ask", { method: "POST", headers: h, body: JSON.stringify({ message: "" }) });
    expect(empty.status).toBe(400);
    const anon = await app.request(`/api/runs/${progress.runId}`);
    expect(anon.status).toBe(401);
  });
});
