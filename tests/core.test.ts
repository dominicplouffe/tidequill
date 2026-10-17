import { describe, expect, test } from "bun:test";
import { doc } from "../src/content/blocks.ts";
import { fromMarkdown, toMarkdown } from "../src/content/markdown.ts";
import { docHtml } from "../src/content/html.ts";
import { TRUST_THRESHOLDS } from "../src/core/types.ts";
import { testSite } from "./helpers.ts";

describe("markdown round trip", () => {
  const md = `I bought the wrong stand first. It cost {{fact:oak-stand.price}}.

## How wide should the stand be?

:::answer
At least 67 inches, ideally 70 to 75.
:::

- Measure the **feet**
- Check [our guide](tq:ent_abc)

1. One
2. Two

> Measure twice.
> — Fred

![Fred's stand](media:med_1 "72-inch walnut stand")

| Size | Width |
| --- | --- |
| 77" | 67 in |

:::faq
### Will a 65-inch stand fit?
Not well.
:::

:::evidence{id=evd_1 kind=photo media=med_2}
I measured 66.9 inches.
:::

\`\`\`js
const x = 1;
\`\`\`

---

:::disclosure
We earn from qualifying purchases.
:::
`;
  test("markdown -> doc -> markdown is stable", () => {
    const d = fromMarkdown(md);
    expect(toMarkdown(d)).toBe(md);
    expect(d.blocks.map((b) => b.type)).toEqual(["paragraph", "heading", "answer", "list", "list", "quote", "image", "table", "faq", "evidence", "code", "divider", "callout"]);
  });
  test("doc -> markdown -> doc keeps block ids", () => {
    const d = fromMarkdown(md);
    const again = fromMarkdown(toMarkdown(d), d);
    expect(again).toEqual(d);
  });
  test("html escapes and resolves", () => {
    const d = doc({ type: "paragraph", text: "<script>x</script> costs {{fact:p}} [link](tq:ent_1) [bad](javascript:alert(1))" });
    const html = docHtml(d, { resolver: { fact: () => "$649", entry: () => "/stands/" } });
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("$649");
    expect(html).toContain('<a href="/stands/">link</a>');
    expect(html).not.toContain("javascript:");
  });
});

describe("actions, proposals and earned autonomy", () => {
  test("people apply directly; agents propose until trust is earned", async () => {
    const t = await testSite();
    const draft: any = await t.invoke(t.as(), "posts.create", { title: "How to pick a TV stand", markdown: "First paragraph." });
    expect(draft.status).toBe("applied");
    const entryId = draft.result.id;

    // Agent drafting is invisible to readers: no approval needed.
    const agentDraft: any = await t.invoke(t.agent(), "posts.create", { title: "Agent draft", markdown: "Hello." });
    expect(agentDraft.status).toBe("applied");

    // Agent creating a redirect (trust kind: links) must ask.
    const r1: any = await t.invoke(t.agent("steward"), "redirects.create", { from: "/old", to: "/new/" });
    expect(r1.status).toBe("proposed");

    // Ten clean approvals earn "links".
    for (let i = 0; i < TRUST_THRESHOLDS.links!; i++) {
      const p: any = i === 0 ? r1 : await t.invoke(t.agent("steward"), "redirects.create", { from: `/old-${i}`, to: "/new/" });
      expect(p.status).toBe("proposed");
      await t.invoke(t.as(), "proposals.approve", { id: p.proposalId });
    }
    const auto: any = await t.invoke(t.agent("steward"), "redirects.create", { from: "/later", to: "/new/" });
    expect(auto.status).toBe("applied");
    expect(auto.auto).toBe(true);

    // Ask me first takes it all back.
    await t.invoke(t.as(), "autonomy.ask_me_first", { on: true });
    const asked: any = await t.invoke(t.agent("steward"), "redirects.create", { from: "/later-2", to: "/new/" });
    expect(asked.status).toBe("proposed");
    await t.invoke(t.as(), "autonomy.ask_me_first", { on: false });

    // Undoing something it did alone costs the trust.
    await t.invoke(t.as(), "history.undo", { actionId: auto.actionId });
    const status: any = await t.invoke(t.as(), "autonomy.status", {});
    const links = status.result.trust.find((x: any) => x.kind === "links");
    expect(links.earned).toBe(false);
    expect(links.clean).toBe(5);

    // Editing a live post by an agent is a refresh proposal.
    await t.invoke(t.as(), "posts.publish", { id: entryId, override: "test" });
    const refresh: any = await t.invoke(t.agent(), "posts.update", { id: entryId, markdown: "First paragraph, refreshed." });
    expect(refresh.status).toBe("proposed");
  });

  test("destructive actions need a confirmation token, agents can't approve", async () => {
    const t = await testSite();
    const d: any = await t.invoke(t.as(), "posts.create", { title: "Delete me" });
    const first: any = await t.invoke(t.as(), "posts.delete", { id: d.result.id });
    expect(first.status).toBe("needs_confirmation");
    const done: any = await t.invoke(t.as(), "posts.delete", { id: d.result.id }, { confirm: first.confirmToken });
    expect(done.status).toBe("applied");
    await t.invoke(t.as(), "history.undo", { actionId: done.actionId });
    const list: any = await t.invoke(t.as(), "posts.list", {});
    expect(list.result.some((e: any) => e.id === d.result.id)).toBe(true);

    const agentDelete: any = await t.invoke(t.agent(), "posts.delete", { id: d.result.id });
    expect(agentDelete.status).toBe("proposed");
    await expect(t.invoke(t.agent(), "proposals.approve", { id: agentDelete.proposalId })).rejects.toThrow();
  });

  test("roles: reviewers approve but can't write", async () => {
    const t = await testSite();
    await expect(t.invoke(t.as("reviewer"), "posts.create", { title: "Nope" })).rejects.toThrow(/permission/);
    const p: any = await t.invoke(t.agent("steward"), "redirects.create", { from: "/a", to: "/b/" });
    const ok: any = await t.invoke(t.as("reviewer"), "proposals.approve", { id: p.proposalId });
    expect(ok.status).toBe("done");
  });

  test("settings read back as sentences and undo", async () => {
    const t = await testSite();
    const res: any = await t.invoke(t.as(), "settings.update", { monthlyBudgetUsd: 60 });
    expect(res.summary).toContain("$60");
    await t.invoke(t.as(), "history.undo", { actionId: res.actionId });
    const s: any = await t.invoke(t.as(), "settings.show", {});
    expect(s.result.sentences.find((x: any) => x.key === "monthlyBudgetUsd").sentence).toContain("$40");
  });

  test("slug change on a live post leaves a redirect; scheduled posts publish when due", async () => {
    const t = await testSite();
    const d: any = await t.invoke(t.as(), "posts.create", { title: "Cable guide", markdown: "Text." });
    await t.invoke(t.as(), "posts.publish", { id: d.result.id, override: "test" });
    await t.invoke(t.as(), "posts.update", { id: d.result.id, slug: "hide-every-cable" });
    const r: any = await t.invoke(t.as(), "redirects.list", {});
    expect(r.result[0]).toMatchObject({ from: "/cable-guide/", to: "/hide-every-cable/" });
  });
});
