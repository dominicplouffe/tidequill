import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createSession } from "../src/auth/auth.ts";
import { newEntry, saveEntry } from "../src/core/entries.ts";
import { id, nowIso } from "../src/core/ids.ts";
import { buildSite } from "../src/render/build.ts";
import { budgetProblems, checkRenderedEntry } from "../src/render/checks.ts";
import { renderEntryHtml, renderPreview } from "../src/render/preview.ts";
import { HOUSE_DESIGNS, contrastProblems, resolveTokens, siteTokenSet } from "../src/render/tokens.ts";
import { getSite } from "../src/core/sites.ts";
import { createApi } from "../src/server/app.ts";
import { testSite } from "./helpers.ts";

type T = Awaited<ReturnType<typeof testSite>>;

const pub = (t: T, rel = "") => join(t.dataDir, "sites", t.siteId, "public", rel);
const read = (t: T, rel: string) => readFileSync(pub(t, rel), "utf8");

function addFact(t: T, key: string, value: string, kind = "fact", label = key) {
  t.db
    .query("INSERT INTO facts (id, site_id, key, label, value, kind, source_url, verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id("fct"), t.siteId, key, label, value, kind, "https://example.com/oak", nowIso(), nowIso(), nowIso());
}

async function setup() {
  const t = await testSite();
  await t.invoke(t.as(), "authors.create", { name: "Fred Laurent", bio: "Fred builds and tests TV stands in his garage.", credentials: "Furniture maker since 2009" });
  await t.invoke(t.as(), "categories.create", { name: "Buying guides" });
  return t;
}

async function post(t: T, title: string, markdown: string, opts: { publish?: boolean; category?: string } = {}) {
  const d: any = await t.invoke(t.as(), "posts.create", { title, markdown, authors: ["Fred Laurent"], category: opts.category ?? "Buying guides" });
  if (opts.publish !== false) await t.invoke(t.as(), "posts.publish", { id: d.result.id, override: "test" });
  return d.result.id as string;
}

const STAND = `I bought the wrong stand first. It was 60 inches wide and my TV was 67.

## How wide should the stand be?

:::answer
At least 67 inches, ideally 70 to 75. A 77-inch screen is about 67 inches wide.
:::

The oak stand costs {{fact:oak-stand.price}} right now.

| Stand | Width |
| --- | --- |
| Oak & Co. | 72 in |

:::faq
### Will a 65-inch stand fit a 77-inch TV?
Not well: the feet need about 67 inches.
:::
`;

describe("static build", () => {
  test("a published post gets its page, markdown twin, sitemap entry and site files", async () => {
    const t = await setup();
    addFact(t, "oak-stand.price", "$649", "price", "Oak & Co. stand price");
    await post(t, "How to pick a TV stand for a 77-inch TV", STAND);
    await t.rt.drain();

    const html = read(t, "how-to-pick-a-tv-stand-for-a-77-inch-tv/index.html");
    expect(html).toContain("<title>How to pick a TV stand for a 77-inch TV | Walnut &amp; Wire</title>");
    expect(html).toContain('<link rel="canonical" href="https://walnutandwire.test/how-to-pick-a-tv-stand-for-a-77-inch-tv/">');
    expect(html).toContain('<html lang="en-US">');
    expect(html).toContain('<a class="skip" href="#main">');
    expect(html.match(/<h1[ >]/g)?.length).toBe(1);
    expect(html).toContain('property="og:title"');
    expect(html).toContain('name="twitter:card"');
    expect(html).toMatch(/By <a href="\/authors\/fred-laurent\/" rel="author">Fred Laurent<\/a>, updated <time datetime="/);
    expect(html).toContain(">Buying guides</a>");
    expect(html).toContain("$649");
    // No JavaScript: the only scripts are JSON-LD.
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.every((s) => s.includes("application/ld+json"))).toBe(true);
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]!);
    const types = ld["@graph"].map((x: any) => x["@type"]);
    expect(types).toEqual(expect.arrayContaining(["BlogPosting", "BreadcrumbList", "Organization", "FAQPage"]));
    expect(ld["@graph"][0].author[0]).toMatchObject({ "@type": "Person", name: "Fred Laurent" });
    // Fonts are self-hosted.
    expect(html).toContain("/_tq/fonts/newsreader-latin-400-normal.woff2");
    expect(existsSync(pub(t, "_tq/fonts/newsreader-latin-400-normal.woff2"))).toBe(true);

    const md = read(t, "how-to-pick-a-tv-stand-for-a-77-inch-tv/index.md");
    expect(md).toStartWith('---\ntitle: "How to pick a TV stand for a 77-inch TV"');
    expect(md).toContain('author: "Fred Laurent"');
    expect(md).toContain("url: https://walnutandwire.test/how-to-pick-a-tv-stand-for-a-77-inch-tv/");
    expect(md).toContain("The oak stand costs $649 right now.");
    expect(md).toContain("**Short answer:** At least 67 inches");
    expect(md).not.toContain(":::");

    expect(read(t, "sitemap.xml")).toContain("<loc>https://walnutandwire.test/how-to-pick-a-tv-stand-for-a-77-inch-tv/</loc>");
    expect(read(t, "sitemap.xml")).toContain("/topics/buying-guides/");
    expect(read(t, "feed.xml")).toContain("<title>How to pick a TV stand for a 77-inch TV</title>");
    expect(existsSync(pub(t, "topics/buying-guides/index.html"))).toBe(true);
    expect(existsSync(pub(t, "authors/fred-laurent/index.html"))).toBe(true);
    expect(read(t, "index.html")).toContain("How to pick a TV stand for a 77-inch TV");
    expect(read(t, "index.html")).toContain('"@type":"WebSite"');
    expect(read(t, "404.html")).toContain("We couldn't find that page");
    expect(read(t, "search/index.html")).toContain('<script type="module" src="/_tq/search.js"></script>');

    const search = JSON.parse(read(t, "search.json"));
    expect(search[0]).toMatchObject({ title: "How to pick a TV stand for a 77-inch TV", path: "/how-to-pick-a-tv-stand-for-a-77-inch-tv/" });
    expect(search[0].headings).toContain("How wide should the stand be?");
    const products = JSON.parse(read(t, "agent/products.json"));
    expect(products[0]).toMatchObject({ name: "Oak & Co. stand price", price: "$649" });
    expect(JSON.parse(read(t, "agent/pages.json"))[0].markdown).toBe("/how-to-pick-a-tv-stand-for-a-77-inch-tv/index.md");
    expect(JSON.parse(readFileSync(join(t.dataDir, "hosts.json"), "utf8"))).toEqual({ "walnutandwire.test": t.siteId });
  });

  test("robots.txt and llms.txt agree on AI training, and change together", async () => {
    const t = await setup();
    await post(t, "Cable guide", "Hide every cable in five minutes.");
    await t.rt.drain();
    const robots = () => read(t, "robots.txt");
    const llms = () => read(t, "llms.txt");
    const group = (txt: string, agent: string) => txt.split("\n\n").find((g) => g.includes(`User-agent: ${agent}\n`))!;
    expect(group(robots(), "GPTBot")).toContain("Disallow: /");
    expect(group(robots(), "ClaudeBot")).toContain("Disallow: /");
    expect(group(robots(), "OAI-SearchBot")).toContain("Allow: /");
    expect(group(robots(), "Claude-User")).toContain("Allow: /");
    expect(llms()).toContain("Training AI models: not allowed");
    expect(llms()).toContain("https://walnutandwire.test/mcp");
    expect(llms()).toContain("(https://walnutandwire.test/cable-guide/index.md)");

    await t.invoke(t.as(), "settings.update", { allowTrainingCrawlers: true });
    await t.rt.drain();
    expect(group(robots(), "GPTBot")).not.toContain("Disallow");
    expect(llms()).toContain("Training AI models: allowed.");
  });

  test("facts and internal links resolve; a link to a draft is plain text until it goes live", async () => {
    const t = await setup();
    addFact(t, "oak-stand.price", "$649");
    const target = await post(t, "Solid walnut vs veneer", "Veneer is cheaper.", { publish: false });
    const linker = await post(t, "Hide every cable", `See [walnut vs veneer](tq:${target}). Price: {{fact:oak-stand.price}}.`);
    await t.rt.drain();
    let html = read(t, "hide-every-cable/index.html");
    expect(html).toContain("See walnut vs veneer.");
    expect(html).not.toContain("tq:");
    expect(html).toContain("Price: $649.");

    await t.invoke(t.as(), "posts.publish", { id: target, override: "test" });
    const report = await buildSite(t.system(), t.siteId, [target]);
    expect(report.full).toBe(false);
    html = read(t, "hide-every-cable/index.html");
    expect(html).toContain('<a href="/solid-walnut-vs-veneer/">walnut vs veneer</a>');
    expect(read(t, "hide-every-cable/index.md")).toContain("[walnut vs veneer](https://walnutandwire.test/solid-walnut-vs-veneer/)");

    // A fact change rebuilds the pages that show it.
    t.db.query("UPDATE facts SET value = '$599' WHERE key = 'oak-stand.price' AND site_id = ?").run(t.siteId);
    const factId = t.db.query<{ id: string }, [string]>("SELECT id FROM facts WHERE site_id = ?").get(t.siteId)!.id;
    t.rt.services.emit({ type: "fact.changed", siteId: t.siteId, factId });
    await buildSite(t.system(), t.siteId, [linker]);
    expect(read(t, "hide-every-cable/index.html")).toContain("Price: $599.");
  });

  test("unpublishing removes the page and answers 410; slug changes redirect", async () => {
    const t = await setup();
    const a = await post(t, "Cable guide", "Text about cables.");
    const b = await post(t, "Stand guide", "Text about stands.");
    await t.rt.drain();
    expect(existsSync(pub(t, "cable-guide/index.html"))).toBe(true);

    await t.invoke(t.as(), "posts.unpublish", { id: a });
    await t.rt.drain();
    expect(existsSync(pub(t, "cable-guide/index.html"))).toBe(false);
    expect(existsSync(pub(t, "cable-guide/index.md"))).toBe(false);
    expect(read(t, "sitemap.xml")).not.toContain("/cable-guide/");
    expect(read(t, "index.html")).not.toContain("Cable guide");
    let redirects = JSON.parse(read(t, "_redirects.json"));
    expect(redirects["/cable-guide/"]).toEqual({ code: 410 });

    await t.invoke(t.as(), "posts.update", { id: b, slug: "pick-a-stand" });
    await t.rt.drain();
    redirects = JSON.parse(read(t, "_redirects.json"));
    expect(redirects["/stand-guide/"]).toEqual({ to: "/pick-a-stand/", code: 301 });
    expect(existsSync(pub(t, "stand-guide/index.html"))).toBe(false);
    expect(existsSync(pub(t, "pick-a-stand/index.html"))).toBe(true);
  });

  test("incremental builds touch only what changed", async () => {
    const t = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(await post(t, `Guide number ${i}`, `Body ${i}.`));
    await t.rt.drain();
    const full = await buildSite(t.system(), t.siteId, null);
    expect(full.full).toBe(true);
    expect(full.written).toBe(0); // nothing changed since the last build
    await t.invoke(t.as(), "posts.update", { id: ids[2]!, markdown: "Body two, rewritten." });
    const inc = await buildSite(t.system(), t.siteId, [ids[2]!]);
    expect(inc.full).toBe(false);
    expect(inc.pages).toBeLessThan(full.pages);
    expect(read(t, "guide-number-2/index.html")).toContain("Body two, rewritten.");
  });

  test("the home page is the page with slug home when there is one", async () => {
    const t = await setup();
    const d: any = await t.invoke(t.as(), "posts.create", { type: "page", title: "Media furniture that fits small rooms", slug: "home", markdown: "Honest guides by people who build stands." });
    await t.invoke(t.as(), "posts.publish", { id: d.result.id, override: "test" });
    await post(t, "Cable guide", "Text.");
    await t.rt.drain();
    const home = read(t, "index.html");
    expect(home).toContain("<h1>Media furniture that fits small rooms</h1>");
    expect(home).toContain("Honest guides by people who build stands.");
    expect(home).toContain("Cable guide");
    expect(existsSync(pub(t, "index.md"))).toBe(true);
    expect(existsSync(pub(t, "home/index.html"))).toBe(false);
  });

  test("AI disclosure names the real author who reviewed it", async () => {
    const t = await setup();
    const d: any = await t.invoke(t.agent(), "posts.create", { title: "Agent drafted guide", markdown: "Drafted with help.", authors: ["Fred Laurent"], category: "Buying guides" });
    await t.invoke(t.as(), "posts.publish", { id: d.result.id, override: "test" });
    await t.rt.drain();
    expect(read(t, "agent-drafted-guide/index.html")).toContain("Written with AI assistance, reviewed by Fred Laurent.");
    await t.invoke(t.as(), "settings.update", { aiDisclosure: false });
    await t.rt.drain();
    expect(read(t, "agent-drafted-guide/index.html")).not.toContain("Written with AI assistance");
  });

  test("media references become responsive images with dimensions", async () => {
    const t = await setup();
    const mid = id("med");
    t.db
      .query("INSERT INTO media (id, site_id, file_key, mime, width, height, bytes, alt, caption, variants, created_at) VALUES (?, ?, ?, 'image/jpeg', 2400, 1600, 1000, 'Walnut stand', '', ?, ?)")
      .run(mid, t.siteId, `${mid}/original.jpg`, JSON.stringify([
        { width: 640, height: 427, format: "webp", key: `${mid}/640.webp` },
        { width: 1280, height: 853, format: "webp", key: `${mid}/1280.webp` },
      ]), nowIso());
    const pid = await post(t, "Photo guide", `![Fred's 72-inch walnut stand](media:${mid} "Under a 77-inch TV")\n\nText.`);
    await t.invoke(t.as(), "posts.update", { id: pid, heroMediaId: mid });
    await t.rt.drain();
    const html = read(t, "photo-guide/index.html");
    expect(html).toContain(`src="/media/${mid}/1280.webp" alt="Walnut stand" width="1280" height="853"`);
    expect(html).toContain(`srcset="/media/${mid}/640.webp 640w, /media/${mid}/1280.webp 1280w"`);
    expect(html).toContain('alt="Fred&#39;s 72-inch walnut stand"');
    expect(html).toContain("<figcaption>Under a 77-inch TV</figcaption>");
    expect(html).toContain('property="og:image" content="https://walnutandwire.test/media/');
  });

  test("a full build of 1,000 posts takes seconds, and one publish well under 3 s", async () => {
    const t = await setup();
    const author = t.db.query<{ id: string }, [string]>("SELECT id FROM authors WHERE site_id = ?").get(t.siteId)!.id;
    const cats = t.db.query<{ id: string }, [string]>("SELECT id FROM categories WHERE site_id = ?").all(t.siteId);
    t.db.transaction(() => {
      for (let i = 0; i < 1000; i++) {
        const now = new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString();
        const e = newEntry(t.siteId, {
          title: `Stand review ${i}`,
          slug: `stand-review-${i}`,
          status: "published",
          publishedAt: now,
          updatedAt: now,
          authorIds: [author],
          categoryId: cats[0]!.id,
          body: { v: 1, blocks: [{ id: "a", type: "paragraph", text: `Review ${i} of a walnut stand. ${"It is sturdy and wide. ".repeat(30)}` }, { id: "b", type: "heading", level: 2, text: "Verdict" }, { id: "c", type: "answer", text: "Buy it if your TV is under 77 inches." }] },
        });
        saveEntry(t.db, e, { kind: "system" }, null);
      }
    })();
    const full = await buildSite(t.system(), t.siteId, null);
    expect(full.pages).toBeGreaterThan(1000);
    expect(full.checks).toEqual([]);
    expect(full.ms).toBeLessThan(20_000);
    const one = await post(t, "One more review", "Fresh.");
    const inc = await buildSite(t.system(), t.siteId, [one]);
    expect(inc.ms).toBeLessThan(3_000);
    console.log(`full build: ${full.pages} pages in ${full.ms} ms; one publish: ${inc.pages} pages in ${inc.ms} ms`);
  }, 60_000);
});

describe("performance budget and publish checks", () => {
  test("budget catches heavy pages and scripts", () => {
    expect(budgetProblems('<html><body><script src="/x.js"></script></body></html>', "/a/", "entry")[0]).toContain("loads JavaScript");
    expect(budgetProblems('<html><script type="module" src="/_tq/search.js"></script></html>', "/search/", "search")).toEqual([]);
    expect(budgetProblems(`<style>${"a{}".repeat(6000)}</style>`, "/a/", "entry")[0]).toContain("over the 14 KB budget");
    const noise = Array.from({ length: 40_000 }, (_, i) => (i * 7919).toString(36)).join(" ");
    expect(budgetProblems(`<p>${noise}</p>`, "/a/", "entry")[0]).toContain("over the 30 KB budget");
  });

  test("a page over budget shows up in the build report in plain English", async () => {
    const t = await setup();
    const noise = Array.from({ length: 12_000 }, (_, i) => `w${(i * 7919).toString(36)}`).join(" ");
    await post(t, "Huge page", noise);
    const report = await buildSite(t.system(), t.siteId, null);
    const fail = report.checks.find((c) => c.name === "Performance budget");
    expect(fail?.path).toBe("/huge-page/");
    expect(fail?.message).toMatch(/^The page at \/huge-page\/ is .* KB compressed, over the 30 KB budget; /);
  });

  test("checkRenderedEntry passes a good draft and explains what's wrong with a bad one", async () => {
    const t = await setup();
    const good = await post(t, "Good guide", STAND, { publish: false });
    const checks = await checkRenderedEntry(t.as(), good);
    expect(checks.map((c) => c.name)).toEqual(["Readable by search and AI crawlers", "Accessibility", "Structured data", "Internal links", "Performance budget"]);
    expect(checks.every((c) => c.passed)).toBe(true);

    const bad = await post(t, "Bad guide", "Intro.\n\n#### Deep heading\n\n[click here](/nowhere/)\n\n![](https://example.com/a.jpg)", { publish: false });
    const res = await checkRenderedEntry(t.as(), bad);
    const by = (n: string) => res.find((c) => c.name === n)!;
    expect(by("Accessibility").passed).toBe(false);
    expect(by("Accessibility").message).toContain("skips a level");
    expect(by("Internal links").passed).toBe(false);
    expect(by("Internal links").blocking).toBe(true);
    expect(by("Internal links").message).toBe("The link to /nowhere/ goes nowhere; point it at a live page or remove it.");
  });
});

describe("the look", () => {
  test("every house design is readable in light and dark", () => {
    for (const d of HOUSE_DESIGNS) expect(contrastProblems({ light: d.tokens, dark: d.dark })).toEqual([]);
  });

  test("update_tokens refuses unreadable colors, applies good ones, and undo restores", async () => {
    const t = await setup();
    await post(t, "Cable guide", "Text.");
    await t.rt.drain();
    await expect(t.invoke(t.as(), "look.update_tokens", { colors: { text: "#EEEEEE" } })).rejects.toThrow(/too faint .* make the text color darker/);

    const res: any = await t.invoke(t.as(), "look.update_tokens", { colors: { accent: "#1F5FAE" }, type: { baseSize: 20 } });
    expect(res.status).toBe("applied");
    expect(res.undoable).toBe(true);
    const dry: any = await t.invoke(t.as(), "look.update_tokens", { colors: { link: "#1F5FAE" } }, { dryRun: true });
    expect(dry.diff[0]).toEqual({ label: "Link color", before: "#8A5A2B", after: "#1F5FAE", format: "color" });
    expect(resolveTokens(getSite(t.db, t.siteId)).colors.accent).toBe("#1F5FAE");
    await t.rt.drain();
    expect(read(t, "cable-guide/index.html")).toContain("--accent:#1F5FAE");
    expect(read(t, "cable-guide/index.html")).toContain("--base:20px");

    await t.invoke(t.as(), "history.undo", { actionId: res.actionId });
    expect(resolveTokens(getSite(t.db, t.siteId)).colors.accent).toBe("#8A5A2B");
    await t.rt.drain();
    expect(read(t, "cable-guide/index.html")).toContain("--accent:#8A5A2B");

    // Agents propose look changes; they never earn them.
    const agent: any = await t.invoke(t.agent("designer"), "look.update_tokens", { fonts: { heading: "hanken" } });
    expect(agent.status).toBe("proposed");
  });

  test("set_design switches the house design and every design renders", async () => {
    const t = await setup();
    await post(t, "Cable guide", STAND);
    for (const design of ["workshop", "studio", "harbor"] as const) {
      const res: any = await t.invoke(t.as(), "look.set_design", { design });
      expect(res.status).toBe("applied");
      await t.rt.drain();
      const html = read(t, "cable-guide/index.html");
      expect(html).toContain(`--bg:${HOUSE_DESIGNS.find((d) => d.name === design)!.tokens.colors.background}`);
      expect(html).toContain("prefers-color-scheme:dark");
      if (design === "workshop") expect(html).toContain('class="crumbs"');
    }
    const look: any = await t.invoke(t.as(), "look.get", {});
    expect(look.result.design).toBe("harbor");
    expect(look.result.designs.map((d: any) => d.name)).toEqual(["harbor", "workshop", "studio"]);
    expect(siteTokenSet(getSite(t.db, t.siteId)).dark.background).toBe("#161A17");
  });
});

describe("live-site editing and previews", () => {
  async function api(t: T) {
    const app = createApi(t.rt);
    const sid = createSession(t.db, t.owner.id);
    return (path: string, init: RequestInit = {}) => app.fetch(new Request(`http://localhost${path}`, { ...init, headers: { cookie: `tq_session=${sid}`, ...(init.headers ?? {}) } }));
  }

  test("GET /live/:siteId/<slug>/ renders a draft annotated, with the overlay snippet", async () => {
    const t = await setup();
    const other = await post(t, "Walnut vs veneer", "Text.");
    const draft = await post(t, "Draft stand guide", `First paragraph. See [the other guide](tq:${other}).\n\n## Width\n\nAt least 67 inches.`, { publish: false });
    const fetch = await api(t);
    const res = await fetch(`/live/${t.siteId}/draft-stand-guide/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h1 data-tq-field="title">Draft stand guide</h1>');
    expect(html).toMatch(/<p data-tq-block="[a-z0-9]+" data-tq-type="paragraph">First paragraph/);
    expect(html).toContain(`href="/live/${t.siteId}/walnut-vs-veneer/"`);
    expect(html).toContain(`url(/_site/${t.siteId}/_tq/fonts/`);
    const snippet = `<script>window.__TQ_LIVE__ = {"siteId":"${t.siteId}","entryId":"${draft}","path":"/draft-stand-guide/","siteName":"Walnut & Wire","domain":"walnutandwire.test"};</script>\n<script type="module" src="/live-overlay.js"></script>\n</body>`;
    expect(html).toContain(snippet);

    // Not signed in: no live page.
    const anon = await createApi(t.rt).fetch(new Request(`http://localhost/live/${t.siteId}/`));
    expect(anon.status).toBe(401);
  });

  test("previews render patched entries and tokens without saving", async () => {
    const t = await setup();
    const pid = await post(t, "Cable guide", "Original text.");
    const fetch = await api(t);
    const res = await fetch(`/api/preview?entryId=${pid}&tokens=${encodeURIComponent(JSON.stringify({ colors: { accent: "#1F5FAE" } }))}`);
    const html = await res.text();
    expect(html).toContain("--accent:#1F5FAE");
    expect(html).not.toContain("__TQ_LIVE__");
    const post2 = await fetch("/api/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entryId: pid, patch: { markdown: "Proposed text." } }) });
    expect(await post2.text()).toContain("Proposed text.");
    expect(renderEntryHtml(t.as(), t.siteId, pid, { annotate: true })).toContain("data-tq-block");
    expect(renderPreview(t.as(), t.siteId, { tokens: { colors: { background: "#FFFFFF" } } })).toContain("--bg:#FFFFFF");
    expect(resolveTokens(getSite(t.db, t.siteId)).colors.background).toBe("#F6F3EE");
  });
});
