import { afterEach, describe, expect, test } from "bun:test";
import { enqueue } from "../src/core/jobs.ts";
import { findAnchor, related } from "../src/links/related.ts";
import { setFetch } from "../src/links/http.ts";
import { testSite } from "./helpers.ts";

afterEach(() => setFetch(null));

const OLDER = [
  {
    title: "How we test TV stands",
    markdown:
      "## Our load test\n\nWe stack paint cans on every stand for a week and measure the sag with a straightedge.\n\n## Why size matters\n\nA 77-inch TV stand has to be at least 67 inches wide, and most readers ask us about it first. We tested twelve stands in 2025.\n",
  },
  {
    title: "The best TV stands under $700",
    markdown: "## Our pick\n\nThe Oak & Co. Walden is the one we'd buy. It held 150 pounds in our test.\n\n## For bigger screens\n\nIf you're shopping for a TV stand for a 77-inch TV, skip the 60-inch models entirely.\n",
  },
  {
    title: "How to hide TV cables behind a stand",
    markdown: "## Cable cutouts\n\nDrill a 3.5-inch hole at the back. A cable raceway costs about $15 and hides the rest.\n\n## Power strips\n\nMount the strip under the top shelf with two screws.\n",
  },
  {
    title: "Sourdough starter basics",
    markdown: "Feed it twice a day with 50 grams of flour and 50 grams of water. Keep it at 24 degrees.\n",
  },
];

const NEW_POST = {
  title: "How to pick a TV stand for a 77-inch TV",
  markdown:
    "I bought the wrong stand first. It was 60 inches wide and the TV was 67.\n\n## How wide should the stand be?\n\nAt least 67 inches. Before you buy, read how we test TV stands and why our load test matters.\n\n## What about cables?\n\nYou'll want a cutout so you can hide TV cables behind the stand.\n\n## Which one to buy\n\nOur list of the best TV stands under $700 has the Walden at the top.\n",
};

async function siteWithPosts() {
  const t = await testSite();
  const ids: string[] = [];
  for (const p of OLDER) {
    const d: any = await t.invoke(t.as(), "posts.create", p);
    await t.invoke(t.as(), "posts.publish", { id: d.result.id, override: "test" });
    ids.push(d.result.id);
  }
  return { t, ids };
}

describe("relatedness and anchors (pure)", () => {
  test("TF-IDF finds topical neighbours and ignores unrelated posts", () => {
    const docs = [
      { id: "new", title: NEW_POST.title, headings: ["How wide should the stand be?", "What about cables?"], categoryId: "c1", tags: [] },
      { id: "test", title: OLDER[0]!.title, headings: ["Our load test", "Why size matters"], categoryId: "c1", tags: [] },
      { id: "cables", title: OLDER[2]!.title, headings: ["Cable cutouts"], categoryId: "c1", tags: [] },
      { id: "bread", title: OLDER[3]!.title, headings: [], categoryId: "c2", tags: [] },
    ];
    const r = related(docs, "new");
    expect(r.map((x) => x.id)).toContain("test");
    expect(r.map((x) => x.id)).not.toContain("bread");
  });

  test("anchors are existing words that name the target, never inside links", () => {
    const target = { title: "How to hide TV cables behind a stand", headings: ["Cable cutouts"] };
    const a = findAnchor([{ blockId: "b1", raw: "You'll want a cutout so you can hide TV cables behind the stand." }], target, { sourceTitle: "How to pick a TV stand" });
    expect(a!.anchor).toBe("hide TV cables");
    expect(findAnchor([{ blockId: "b1", raw: "See [hide TV cables](tq:x) for more." }], target)).toBeNull();
    expect(findAnchor([{ blockId: "b1", raw: "Bread, flour and water." }], target)).toBeNull();
    // Words every post on a TV stand site shares don't describe one page.
    expect(findAnchor([{ blockId: "b1", raw: "Pick the right TV stand first." }], target, { sourceTitle: "How to pick a TV stand" })).toBeNull();
    // A phrase from the target's title is the best anchor.
    expect(findAnchor([{ blockId: "b1", raw: "Read how we test TV stands before you buy." }], { title: "How we test TV stands", headings: [] }, { sourceTitle: "How to pick a TV stand" })!.anchor).toBe("how we test TV stands");
  });
});

describe("link graph", () => {
  test("saving a post records its internal and external links", async () => {
    const { t, ids } = await siteWithPosts();
    const d: any = await t.invoke(t.as(), "posts.create", { title: "Links", markdown: `See [how we test](tq:${ids[0]}) and the [LG spec sheet](https://www.lg.com/us/tvs).\n` });
    const rows = t.db.query<any, [string]>("SELECT to_entry_id, url, anchor FROM links WHERE from_entry_id = ? ORDER BY anchor").all(d.result.id);
    expect(rows).toEqual([
      { to_entry_id: null, url: "https://www.lg.com/us/tvs", anchor: "LG spec sheet" },
      { to_entry_id: ids[0], url: null, anchor: "how we test" },
    ]);
    await t.invoke(t.as(), "posts.update", { id: d.result.id, markdown: "No links now.\n" });
    expect(t.db.query("SELECT COUNT(*) AS n FROM links WHERE from_entry_id = ?").get(d.result.id)).toEqual({ n: 0 });
  });

  test("orphans are live posts nothing links to", async () => {
    const { t, ids } = await siteWithPosts();
    let orphans: any = ((await t.invoke(t.as(), "links.orphans", {})) as any).result;
    expect(orphans.map((o: any) => o.id).sort()).toEqual([...ids].sort());
    await t.invoke(t.as(), "links.add", { id: ids[1]!, targetId: ids[0]!, anchor: "our test" });
    orphans = ((await t.invoke(t.as(), "links.orphans", {})) as any).result;
    expect(orphans.map((o: any) => o.id)).not.toContain(ids[0]);
  });
});

describe("internal linking on publish", () => {
  test("links the new post to its relatives and proposes links to it from older posts", async () => {
    const { t, ids } = await siteWithPosts();
    const d: any = await t.invoke(t.as(), "posts.create", NEW_POST);
    const newId = d.result.id;

    // While it's a draft, suggestions are there but nothing is proposed.
    const suggest: any = ((await t.invoke(t.as(), "links.suggest", { id: newId })) as any).result;
    expect(suggest.outgoing.length).toBeGreaterThanOrEqual(2);
    expect(suggest.outgoing.map((s: any) => s.targetId)).not.toContain(ids[3]);

    await t.invoke(t.as(), "posts.publish", { id: newId, override: "test" });
    const pending: any[] = ((await t.invoke(t.as(), "proposals.list", {})) as any).result.filter((p: any) => p.actionName === "links.add");
    const outgoing = pending.filter((p) => p.input.id === newId);
    const incoming = pending.filter((p) => p.input.targetId === newId);
    expect(outgoing.length).toBeGreaterThanOrEqual(1);
    expect(outgoing.length).toBeLessThanOrEqual(3);
    expect(incoming.length).toBeGreaterThanOrEqual(1);
    expect(incoming.length).toBeLessThanOrEqual(5);
    for (const p of pending) {
      expect(p.actor).toMatchObject({ kind: "agent", role: "seo" });
      expect(p.trustKind).toBe("links");
      expect(p.input.targetId).not.toBe(ids[3]); // The sourdough post is unrelated.
      expect(p.input.id).not.toBe(p.input.targetId);
    }
    // Each outgoing link uses words already in the new post, one paragraph each.
    expect(new Set(outgoing.map((p) => p.input.blockId)).size).toBe(outgoing.length);
    expect(outgoing[0].summary).toMatch(/^Link “.+” in “How to pick a TV stand for a 77-inch TV” to “.+”$/);

    // Approving them all works in any order: each touches its own paragraph.
    for (const p of [...outgoing].reverse()) await t.invoke(t.as(), "proposals.approve", { id: p.id });
    const post: any = ((await t.invoke(t.as(), "posts.get", { id: newId })) as any).result;
    for (const p of outgoing) expect(post.markdown).toContain(`[${p.input.anchor}](tq:${p.input.targetId})`);

    const firstIncoming = incoming[0];
    await t.invoke(t.as(), "proposals.approve", { id: firstIncoming.id });
    const orphans: any = ((await t.invoke(t.as(), "links.orphans", {})) as any).result;
    expect(orphans.map((o: any) => o.id)).not.toContain(newId);
  });

  test("once 'links' trust is earned, the links go in on their own", async () => {
    const { t } = await siteWithPosts();
    t.db.query("INSERT INTO trust (site_id, kind, clean, earned_at) VALUES (?, 'links', 10, ?)").run(t.siteId, new Date().toISOString());
    const d: any = await t.invoke(t.as(), "posts.create", NEW_POST);
    await t.invoke(t.as(), "posts.publish", { id: d.result.id, override: "test" });
    const auto = t.db.query<any, [string]>("SELECT summary FROM actions WHERE site_id = ? AND name = 'links.add' AND auto = 1").all(t.siteId);
    expect(auto.length).toBeGreaterThanOrEqual(2);
    // Older posts' own publishes left proposals; none involve the new post.
    const pending: any[] = ((await t.invoke(t.as(), "proposals.list", {})) as any).result.filter((p: any) => p.actionName === "links.add" && (p.input.id === d.result.id || p.input.targetId === d.result.id));
    expect(pending).toHaveLength(0);
  });

  test("links.add rules: live targets only, one link per section, descriptive anchors", async () => {
    const { t, ids } = await siteWithPosts();
    const draft: any = await t.invoke(t.as(), "posts.create", { title: "Draft", markdown: "Hidden." });
    await expect(t.invoke(t.as(), "links.add", { id: ids[1]!, targetId: draft.result.id, anchor: "our test" })).rejects.toThrow(/isn't live/);
    await expect(t.invoke(t.as(), "links.add", { id: ids[1]!, targetId: ids[0]!, anchor: "click here" })).rejects.toThrow(/say where the link goes/);
    await expect(t.invoke(t.as(), "links.add", { id: ids[1]!, targetId: ids[0]!, anchor: "not in the text" })).rejects.toThrow(/couldn't find/);
    await t.invoke(t.as(), "links.add", { id: ids[1]!, targetId: ids[0]!, anchor: "our test" });
    await expect(t.invoke(t.as(), "links.add", { id: ids[1]!, targetId: ids[0]!, anchor: "Walden" })).rejects.toThrow(/one link per section/);
    // Undo takes the link out again.
    const add: any = await t.invoke(t.as(), "links.add", { id: ids[1]!, targetId: ids[0]!, anchor: "skip the 60-inch models" });
    await t.invoke(t.as(), "history.undo", { actionId: add.actionId });
    const post: any = ((await t.invoke(t.as(), "posts.get", { id: ids[1]! })) as any).result;
    expect(post.markdown).toContain("skip the 60-inch models entirely");
    expect(post.markdown).toContain(`[our test](tq:${ids[0]})`);
  });
});

describe("external link checks", () => {
  test("HEAD then GET, 404 and dead domains are broken, the rest warn", async () => {
    const { t } = await siteWithPosts();
    const d: any = await t.invoke(t.as(), "posts.create", {
      title: "Sources",
      markdown: "[ok](https://ok.example/a) [gone](https://gone.example/b) [nohead](https://nohead.example/c) [dns](https://nxdomain.example/d) [flaky](https://flaky.example/e) [local](http://127.0.0.1/x)\n",
    });
    const calls: string[] = [];
    setFetch(async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      if (url.includes("gone")) return new Response("", { status: 404 });
      if (url.includes("nohead")) return new Response("", { status: init?.method === "HEAD" ? 405 : 200 });
      if (url.includes("nxdomain")) throw Object.assign(new Error("getaddrinfo ENOTFOUND nxdomain.example"), { code: "ENOTFOUND" });
      if (url.includes("flaky")) return new Response("", { status: 503 });
      return new Response("", { status: 200 });
    });
    const r: any = ((await t.invoke(t.as(), "links.check", { id: d.result.id })) as any).result;
    const by = Object.fromEntries(r.results.map((x: any) => [x.url, x.status]));
    expect(by).toEqual({
      "https://ok.example/a": "ok",
      "https://gone.example/b": "broken",
      "https://nohead.example/c": "ok",
      "https://nxdomain.example/d": "broken",
      "https://flaky.example/e": "error",
      "http://127.0.0.1/x": "skipped",
    });
    expect(r.summary).toBe("2 of 6 links are broken.");
    expect(calls).toContain("GET https://nohead.example/c");
    expect(calls.some((c) => c.includes("127.0.0.1"))).toBe(false);
  });

  test("the daily job proposes unlinking broken links on live posts, keeping the words", async () => {
    const { t } = await siteWithPosts();
    const d: any = await t.invoke(t.as(), "posts.create", { title: "Sources", markdown: "Check the [old spec sheet](https://gone.example/spec) before you buy.\n" });
    await t.invoke(t.as(), "posts.publish", { id: d.result.id, override: "test" });
    t.db.query("DELETE FROM proposals").run();
    setFetch(async () => new Response("", { status: 404 }));
    enqueue(t.db, "links.check", t.siteId, {});
    await t.rt.drain();
    const pending: any[] = ((await t.invoke(t.as(), "proposals.list", {})) as any).result.filter((p: any) => p.actionName === "links.remove");
    expect(pending).toHaveLength(1);
    expect(pending[0].actor).toMatchObject({ kind: "agent", role: "steward" });
    expect(pending[0].trustKind).toBe("links");
    expect(pending[0].summary).toBe("Unlink “old spec sheet” in “Sources” (the page it pointed to is gone)");
    await t.invoke(t.as(), "proposals.approve", { id: pending[0].id });
    const post: any = ((await t.invoke(t.as(), "posts.get", { id: d.result.id })) as any).result;
    expect(post.markdown).toBe("Check the old spec sheet before you buy.\n");
  });
});
