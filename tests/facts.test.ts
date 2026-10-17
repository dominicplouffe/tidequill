import { afterEach, describe, expect, test } from "bun:test";
import { TRUST_THRESHOLDS } from "../src/core/types.ts";
import { changeSummary, verifyText } from "../src/facts/ledger.ts";
import { setFetch } from "../src/links/http.ts";
import { testSite } from "./helpers.ts";

const LABEL = "Oak & Co. stand price";
const KEY = "oak-and-co-stand-price";

async function siteWithPrice(sourceUrl?: string) {
  const t = await testSite();
  const set: any = await t.invoke(t.as(), "facts.set", { label: LABEL, value: "$599", kind: "price", sourceUrl });
  expect(set.result.key).toBe(KEY);
  const ids: string[] = [];
  for (const [title, line] of [
    ["How to pick a TV stand for a 77-inch TV", `The Oak & Co. Walden costs {{fact:${KEY}}} and is 72 inches wide.`],
    ["The best TV stands under $700", `Our pick is the Walden at {{fact:${KEY}}}.`],
    ["Oak & Co. Walden review", `I paid {{fact:${KEY}}} for mine in March.`],
  ] as const) {
    const d: any = await t.invoke(t.as(), "posts.create", { title, markdown: `${line}\n\nMore about stands.\n` });
    await t.invoke(t.as(), "posts.publish", { id: d.result.id, override: "test" });
    ids.push(d.result.id);
  }
  return { t, ids };
}

afterEach(() => setFetch(null));

describe("fact ledger", () => {
  test("new facts get a key from the label, a check interval by kind, and usage tracking", async () => {
    const { t, ids } = await siteWithPrice();
    const list: any = await t.invoke(t.as(), "facts.list", {});
    expect(list.result).toHaveLength(1);
    expect(list.result[0]).toMatchObject({ key: KEY, value: "$599", kind: "price", checkEveryDays: 7, usages: 3, unsourced: true });
    expect(list.result[0].pages.map((p: any) => p.id).sort()).toEqual([...ids].sort());

    const spec: any = await t.invoke(t.agent("researcher"), "facts.set", { label: "Walden width", value: "72 inches", kind: "spec" });
    expect(spec.status).toBe("applied"); // A new, unused fact changes nothing readers see.
    expect(((await t.invoke(t.as(), "facts.get", { key: "walden-width" }) as any) as any).result.checkEveryDays).toBe(30);

    // Removing the token from a post drops the usage.
    await t.invoke(t.as(), "posts.update", { id: ids[2], markdown: "I paid $599 for mine in March.\n" });
    expect(((await t.invoke(t.as(), "facts.get", { key: KEY }) as any) as any).result.usages).toBe(2);
  });

  test("a price change fixes every page at once, and undo puts it back", async () => {
    const { t, ids } = await siteWithPrice();
    const r: any = await t.invoke(t.agent("fact_checker"), "facts.update", { key: KEY, value: "$649" });
    expect(r.status).toBe("proposed");
    expect(r.summary).toBe("The Oak & Co. stand went from $599 to $649. Update the price on 3 pages that mention it.");
    expect(r.diff[0]).toMatchObject({ label: LABEL, before: "$599", after: "$649" });
    expect(r.diff.find((d: any) => d.label === "On “How to pick a TV stand for a 77-inch TV”")).toMatchObject({
      before: "The Oak & Co. Walden costs $599 and is 72 inches wide.",
      after: "The Oak & Co. Walden costs $649 and is 72 inches wide.",
    });
    const proposal: any = await t.invoke(t.as(), "proposals.get", { id: r.proposalId });
    expect(proposal.result.trustKind).toBe("prices");

    t.db.query("DELETE FROM jobs").run();
    const approved: any = await t.invoke(t.as(), "proposals.approve", { id: r.proposalId });
    expect(approved.result.summary).toBe("The Oak & Co. stand went from $599 to $649. Updated the price on 3 pages that mention it.");
    const fact: any = ((await t.invoke(t.as(), "facts.get", { key: KEY })) as any).result;
    expect(fact.value).toBe("$649");
    expect(fact.verifiedAt).not.toBeNull();
    // Pages keep the token; the value lives in one place.
    for (const id of ids) {
      const post: any = ((await t.invoke(t.as(), "posts.get", { id })) as any).result;
      expect(post.markdown).toContain(`{{fact:${KEY}}}`);
      expect(post.markdown).not.toContain("$649");
    }
    // Every affected page is queued for a rebuild.
    const build = t.db.query<{ payload: string }, []>("SELECT payload FROM jobs WHERE kind = 'build' AND status = 'queued'").get();
    expect(JSON.parse(build!.payload).entryIds.sort()).toEqual([...ids].sort());

    await t.invoke(t.as(), "history.undo", { actionId: approved.result.actionId });
    expect(((await t.invoke(t.as(), "facts.get", { key: KEY }) as any) as any).result.value).toBe("$599");
  });

  test("ten clean approvals earn 'prices'; then the site fixes prices on its own", async () => {
    const { t } = await siteWithPrice();
    let price = 599;
    for (let i = 0; i < TRUST_THRESHOLDS.prices!; i++) {
      price += 10;
      const r: any = await t.invoke(t.agent("fact_checker"), "facts.update", { key: KEY, value: `$${price}` });
      expect(r.status).toBe("proposed");
      await t.invoke(t.as(), "proposals.approve", { id: r.proposalId });
    }
    const auto: any = await t.invoke(t.agent("fact_checker"), "facts.update", { key: KEY, value: "$749" });
    expect(auto.status).toBe("applied");
    expect(auto.auto).toBe(true);
    const today: any = await t.invoke(t.as(), "today.get", {});
    expect(today.result.doneOnItsOwn[0].summary).toBe(`The Oak & Co. stand went from $${price} to $749. Updated the price on 3 pages that mention it.`);
    expect(today.result.trust.find((x: any) => x.kind === "prices").earned).toBe(true);
  });

  test("a stale proposal refuses to overwrite a newer value", async () => {
    const { t } = await siteWithPrice();
    const r: any = await t.invoke(t.agent("fact_checker"), "facts.update", { key: KEY, value: "$649" });
    await t.invoke(t.as(), "facts.update", { key: KEY, value: "$629" });
    await expect(t.invoke(t.as(), "proposals.approve", { id: r.proposalId })).rejects.toThrow(/changed to \$629/);
  });

  test("link a literal price to a fact, and detect prices worth tracking", async () => {
    const t = await testSite();
    await t.invoke(t.as(), "facts.set", { label: LABEL, value: "$599" });
    const d: any = await t.invoke(t.as(), "posts.create", { title: "Walden review", markdown: "I paid $599 for the Walden, not $5990. It is 72 inches wide.\n\n[$599 at Oak & Co.](https://oakandco.example/walden)\n" });
    const found: any = await t.invoke(t.as(), "facts.detect", { id: d.result.id });
    const price = found.result.find((c: any) => c.text === "$599");
    expect(price).toMatchObject({ kind: "price", factKey: KEY });
    expect(price.advice).toBe(`Link “$599” to “${LABEL}” so it updates on its own.`);
    expect(found.result.some((c: any) => c.kind === "measurement" && c.text === "72 inches")).toBe(true);

    const linked: any = await t.invoke(t.agent("fact_checker"), "facts.link", { id: d.result.id, factKey: KEY, text: "$599" });
    expect(linked.status).toBe("applied"); // A draft: invisible.
    const post: any = ((await t.invoke(t.as(), "posts.get", { id: d.result.id })) as any).result;
    expect(post.markdown).toContain(`I paid {{fact:${KEY}}} for the Walden, not $5990.`);
    expect(post.markdown).toContain("[$599 at Oak & Co.](https://oakandco.example/walden)");
    expect(((await t.invoke(t.as(), "facts.get", { key: KEY }) as any) as any).result.usages).toBe(1);

    // On a live post the same change is a 'prices' proposal.
    const live: any = await t.invoke(t.as(), "posts.create", { title: "Best stands", markdown: "The Walden is $599.\n" });
    await t.invoke(t.as(), "posts.publish", { id: live.result.id, override: "test" });
    const p: any = await t.invoke(t.agent("fact_checker"), "facts.link", { id: live.result.id, factKey: KEY, text: "$599" });
    expect(p.status).toBe("proposed");
  });

  test("unsourced, overdue and conflicting facts are flagged", async () => {
    const t = await testSite();
    await t.invoke(t.as(), "facts.set", { label: "Walden width", value: "72 inches", kind: "spec" });
    await t.invoke(t.as(), "facts.set", { label: "Walden width", key: "walden-width-2", value: "71.5 inches", kind: "spec", sourceUrl: "https://oakandco.example/walden" });
    t.db.query("UPDATE facts SET verified_at = '2020-01-01T00:00:00.000Z' WHERE key = 'walden-width-2'").run();
    const stale: any = ((await t.invoke(t.as(), "facts.stale", {})) as any).result;
    expect(stale.unsourced.map((f: any) => f.key)).toEqual(["walden-width"]);
    expect(stale.overdue.map((f: any) => f.key)).toEqual(["walden-width-2"]);
    expect(stale.conflicts).toHaveLength(1);
    expect(stale.conflicts[0].advice).toBe("“Walden width” is 72 inches in one place and 71.5 inches in another; keep the right one and update the other.");
  });
});

describe("verification against the source", () => {
  const page = (price: string) =>
    `<html><head><script>var price = "$1";</script></head><body><nav>Sale! Everything $99</nav><h1>Oak &amp; Co. Walden TV stand</h1><p>Solid oak, 72 inches.</p><span class="price">${price}</span><footer>Gift cards from $25</footer></body></html>`;

  test("reads the price next to the product name, as data", () => {
    const text = page("$649.00").replace(/<[^>]+>/g, " ");
    expect(verifyText(text, { label: LABEL, value: "$599", kind: "price" })).toEqual({ status: "changed", found: "$649.00" });
    expect(verifyText(text, { label: LABEL, value: "$649", kind: "price" }).status).toBe("verified");
    expect(verifyText("Nothing here", { label: "Walden width", value: "72 inches", kind: "spec" }).status).toBe("unclear");
    expect(changeSummary({ label: "Walden width", kind: "spec" }, "72 inches", "71.5 inches", 1)).toBe("The Walden width changed from 72 inches to 71.5 inches. Update the page that mentions it.");
  });

  test("facts.verify: verified, changed, unreachable", async () => {
    const { t } = await siteWithPrice("https://oakandco.example/walden");
    let html = page("$599");
    let status = 200;
    const seen: string[] = [];
    setFetch(async (url) => {
      seen.push(url);
      return new Response(html, { status, headers: { "content-type": "text/html" } });
    });
    expect(((await t.invoke(t.as(), "facts.verify", { key: KEY }) as any) as any).result).toMatchObject({ status: "verified" });
    html = page("$649");
    expect(((await t.invoke(t.as(), "facts.verify", { key: KEY }) as any) as any).result).toMatchObject({ status: "changed", found: "$649" });
    status = 503;
    expect(((await t.invoke(t.as(), "facts.verify", { key: KEY }) as any) as any).result).toMatchObject({ status: "unreachable" });
    setFetch(async () => {
      throw new TypeError("fetch failed");
    });
    expect(((await t.invoke(t.as(), "facts.verify", { key: KEY }) as any) as any).result.status).toBe("unreachable");
    expect(seen.every((u) => u === "https://oakandco.example/walden")).toBe(true);
  });

  test("the re-verify job proposes the new price as the fact checker", async () => {
    const { t } = await siteWithPrice("https://oakandco.example/walden");
    t.db.query("UPDATE facts SET verified_at = '2020-01-01T00:00:00.000Z'").run();
    setFetch(async () => new Response(page("$649"), { headers: { "content-type": "text/html" } }));
    const { enqueue } = await import("../src/core/jobs.ts");
    enqueue(t.db, "facts.reverify", t.siteId, {});
    await t.rt.drain();
    const pending: any = ((await t.invoke(t.as(), "proposals.list", {})) as any).result;
    const p = pending.find((x: any) => x.actionName === "facts.update");
    expect(p.summary).toBe("The Oak & Co. stand went from $599 to $649. Update the price on 3 pages that mention it.");
    expect(p.actor).toMatchObject({ kind: "agent", role: "fact_checker" });
    // Running again doesn't duplicate the proposal.
    enqueue(t.db, "facts.reverify", t.siteId, {});
    await t.rt.drain();
    const again: any = ((await t.invoke(t.as(), "proposals.list", {})) as any).result;
    expect(again.filter((x: any) => x.actionName === "facts.update")).toHaveLength(1);
  });
});
