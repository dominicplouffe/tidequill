import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { health } from "../src/core/hooks.ts";
import { _resetAnalyticsForTests, flushAnalytics, recordHit } from "../src/edge/analytics.ts";
import { handleEdge } from "../src/edge/index.ts";
import { bestPassages, terms } from "../src/edge/mcp.ts";
import { testSite } from "./helpers.ts";

type T = Awaited<ReturnType<typeof testSite>>;

async function site() {
  const t = await testSite();
  await t.invoke(t.as(), "authors.create", { name: "Fred Laurent", bio: "Builds stands." });
  await t.invoke(t.as(), "categories.create", { name: "Buying guides" });
  t.db
    .query("INSERT INTO facts (id, site_id, key, label, value, kind, created_at, updated_at) VALUES ('fct_1', ?, 'oak-stand.price', 'Oak & Co. stand price', '$649', 'price', ?, ?)")
    .run(t.siteId, new Date().toISOString(), new Date().toISOString());
  const d: any = await t.invoke(t.as(), "posts.create", {
    title: "How to pick a TV stand for a 77-inch TV",
    markdown: "I bought the wrong stand first.\n\n## How wide should the stand be?\n\nAt least 67 inches, ideally 70 to 75. The oak stand costs {{fact:oak-stand.price}}.\n\n## Which wood lasts?\n\nSolid walnut outlasts veneer in humid rooms.",
    authors: ["Fred Laurent"],
    category: "Buying guides",
  });
  await t.invoke(t.as(), "posts.publish", { id: d.result.id, override: "test" });
  await t.rt.drain();
  return { ...t, entryId: d.result.id as string };
}

function get(t: T, path: string, headers: Record<string, string> = {}, host = "walnutandwire.test", method = "GET") {
  return handleEdge(new Request(`http://${host}${path}`, { method, headers: { host, ...headers } }), t.rt);
}

function rpc(t: T, body: unknown) {
  return handleEdge(new Request("http://walnutandwire.test/mcp", { method: "POST", headers: { host: "walnutandwire.test", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) }), t.rt);
}

describe("edge", () => {
  test("serves the site by Host with ETags, 304s, compression and cache headers", async () => {
    const t = await site();
    const res = await get(t, "/how-to-pick-a-tv-stand-for-a-77-inch-tv/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    const html = await res.text();
    expect(html).toContain("<h1>How to pick a TV stand for a 77-inch TV</h1>");
    const etag = res.headers.get("etag")!;
    expect(etag).toBeTruthy();

    const again = await get(t, "/how-to-pick-a-tv-stand-for-a-77-inch-tv/", { "if-none-match": etag });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");

    const br = await get(t, "/how-to-pick-a-tv-stand-for-a-77-inch-tv/", { "accept-encoding": "gzip, deflate, br" });
    expect(br.headers.get("content-encoding")).toBe("br");
    expect(br.headers.get("vary")).toBe("Accept-Encoding");
    const gz = await get(t, "/", { "accept-encoding": "gzip" });
    expect(gz.headers.get("content-encoding")).toBe("gzip");

    const head = await get(t, "/", {}, "walnutandwire.test", "HEAD");
    expect(head.status).toBe(200);
    expect(Number(head.headers.get("content-length"))).toBeGreaterThan(1000);
    expect(await head.text()).toBe("");

    const md = await get(t, "/how-to-pick-a-tv-stand-for-a-77-inch-tv/index.md");
    expect(md.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await md.text()).toContain("The oak stand costs $649.");

    const font = await get(t, "/_tq/fonts/hanken-grotesk-latin-400-normal.woff2");
    expect(font.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(font.headers.get("content-type")).toBe("font/woff2");

    expect((await get(t, "/robots.txt")).status).toBe(200);
    expect((await get(t, "/_redirects.json")).status).toBe(404);
    expect((await get(t, "/../tidequill.db")).status).toBe(404);
    expect((await get(t, "/", {}, "unknown.test")).status).toBe(404);
  });

  test("redirects: table rules, 410 for removed pages, trailing slashes and www", async () => {
    const t = await site();
    await t.invoke(t.as(), "redirects.create", { from: "/old-stand-guide/", to: "/how-to-pick-a-tv-stand-for-a-77-inch-tv/" });
    await t.rt.drain();
    const r = await get(t, "/old-stand-guide/");
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe("/how-to-pick-a-tv-stand-for-a-77-inch-tv/");
    expect((await get(t, "/old-stand-guide")).status).toBe(301);

    const slash = await get(t, "/how-to-pick-a-tv-stand-for-a-77-inch-tv");
    expect(slash.status).toBe(301);
    expect(slash.headers.get("location")).toBe("/how-to-pick-a-tv-stand-for-a-77-inch-tv/");

    const www = await get(t, "/topics/buying-guides/?a=1", {}, "www.walnutandwire.test");
    expect(www.status).toBe(301);
    expect(www.headers.get("location")).toBe("https://walnutandwire.test/topics/buying-guides/?a=1");

    const missing = await get(t, "/nope/");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("We couldn't find that page");

    await t.invoke(t.as(), "posts.unpublish", { id: t.entryId });
    await t.rt.drain();
    const gone = await get(t, "/how-to-pick-a-tv-stand-for-a-77-inch-tv/");
    expect(gone.status).toBe(410);
  });

  test("serves media from the media folder and previews under /_site/<id>/", async () => {
    const t = await site();
    const dir = join(t.dataDir, "media", t.siteId, "med_1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "640.webp"), new Uint8Array([1, 2, 3, 4]));
    const media = await get(t, "/media/med_1/640.webp");
    expect(media.status).toBe(200);
    expect(media.headers.get("content-type")).toBe("image/webp");
    expect(media.headers.get("cache-control")).toContain("immutable");

    const base = `/_site/${t.siteId}`;
    const preview = await handleEdge(new Request(`http://localhost${base}/how-to-pick-a-tv-stand-for-a-77-inch-tv/`, { headers: { host: "localhost" } }), t.rt, { siteId: t.siteId, basePath: base });
    const html = await preview.text();
    expect(html).toContain(`href="${base}/authors/fred-laurent/"`);
    expect(html).toContain(`url(${base}/_tq/fonts/`);
    expect(html).not.toContain('href="/topics/');
    const redirect = await handleEdge(new Request(`http://localhost${base}/topics/buying-guides`, { headers: { host: "localhost" } }), t.rt, { siteId: t.siteId, basePath: base });
    expect(redirect.headers.get("location")).toBe(`${base}/topics/buying-guides/`);
  });

  test("the site's own MCP endpoint answers from the built files", async () => {
    const t = await site();
    const init: any = await (await rpc(t, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } })).json();
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.serverInfo.name).toBe("Walnut & Wire");
    expect(init.result.capabilities.tools).toBeTruthy();
    expect((await rpc(t, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);

    const list: any = await (await rpc(t, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
    expect(list.result.tools.map((x: any) => x.name)).toEqual(["search", "get_page", "list_facts", "ask"]);

    const search: any = await (await rpc(t, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search", arguments: { query: "tv stand width" } } })).json();
    expect(search.result.structuredContent.results[0]).toMatchObject({ title: "How to pick a TV stand for a 77-inch TV", url: "https://walnutandwire.test/how-to-pick-a-tv-stand-for-a-77-inch-tv/" });

    const page: any = await (await rpc(t, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_page", arguments: { path: "https://walnutandwire.test/how-to-pick-a-tv-stand-for-a-77-inch-tv/" } } })).json();
    expect(page.result.content[0].text).toContain("# How to pick a TV stand for a 77-inch TV");
    const nopage: any = await (await rpc(t, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_page", arguments: { path: "/nope/" } } })).json();
    expect(nopage.result.isError).toBe(true);

    const facts: any = await (await rpc(t, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "list_facts", arguments: { kind: "price" } } })).json();
    expect(facts.result.content[0].text).toContain("Oak & Co. stand price: $649");

    const ask: any = await (await rpc(t, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "ask", arguments: { question: "Which wood lasts longer in humid rooms?" } } })).json();
    expect(ask.result.structuredContent.passages[0]).toMatchObject({ heading: "Which wood lasts?", url: "https://walnutandwire.test/how-to-pick-a-tv-stand-for-a-77-inch-tv/#which-wood-lasts" });

    const bad: any = await (await rpc(t, { jsonrpc: "2.0", id: 8, method: "resources/list" })).json();
    expect(bad.error.code).toBe(-32601);
    const batch: any = await (await rpc(t, [{ jsonrpc: "2.0", id: 9, method: "ping" }, { jsonrpc: "2.0", id: 10, method: "tools/list" }])).json();
    expect(batch.map((r: any) => r.id)).toEqual([9, 10]);

    const manifest: any = await (await get(t, "/.well-known/mcp.json")).json();
    expect(manifest).toMatchObject({ endpoint: "https://walnutandwire.test/mcp", transport: "streamable-http" });
    expect((await get(t, "/mcp")).status).toBe(405);
  });

  test("cookieless analytics count views and AI visits, and feed site health", async () => {
    _resetAnalyticsForTests();
    const t = await site();
    const path = "/how-to-pick-a-tv-stand-for-a-77-inch-tv/";
    await get(t, path, { "user-agent": "Mozilla/5.0 (Macintosh) Safari/605" });
    await get(t, path, { "user-agent": "Mozilla/5.0 (iPhone) Safari/605" });
    await get(t, path, { "user-agent": "Mozilla/5.0 AppleWebKit/537.36; compatible; ChatGPT-User/1.0; +https://openai.com/bot" });
    await get(t, `${path}index.md`, { "user-agent": "Claude-User/1.0" });
    await get(t, "/", { "user-agent": "Mozilla/5.0 (compatible; PerplexityBot/1.0)" });
    await get(t, "/robots.txt", { "user-agent": "Mozilla/5.0" });

    // A week-old day file, to compare against.
    const lastWeek = new Date(Date.now() - 8 * 86_400_000).toISOString().slice(0, 10);
    const dir = join(t.dataDir, "sites", t.siteId, "analytics");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${lastWeek}.json`), JSON.stringify({ date: lastWeek, views: { [path]: 1 }, bots: {}, botPages: {}, requests: 1, ms: [] }));

    const h = (await health(t.system(), t.siteId))!;
    expect(h.visitsThisWeek).toBe(2);
    expect(h.visitsChangePct).toBe(100);
    expect(h.aiVisitsThisWeek).toBe(3);
    expect(h.aiByAssistant.map((a) => a.name).sort()).toEqual(["ChatGPT", "Claude", "Perplexity"]);
    expect(h.topPages[0]).toEqual({ path, visits: 2 });
    expect(h.medianLoadMs).toBeGreaterThanOrEqual(0);

    flushAnalytics();
    const today = new Date().toISOString().slice(0, 10);
    const day = JSON.parse(readFileSync(join(dir, `${today}.json`), "utf8"));
    expect(day.views[path]).toBe(2);
    expect(day.bots.ChatGPT).toBe(1);
    expect(day.ms.length).toBe(6);
    // Flushing again merges instead of overwriting.
    recordHit(t.dataDir, t.siteId, { path, userAgent: "Mozilla/5.0", ms: 1, page: true });
    flushAnalytics();
    expect(JSON.parse(readFileSync(join(dir, `${today}.json`), "utf8")).views[path]).toBe(3);
  });

  test("passage retrieval prefers the section that answers", () => {
    expect(terms("How wide should the stand be?")).toEqual(["wide", "stand"]);
    const ps = [
      { title: "Guide", url: "/a/#one", heading: "Colors", text: "Walnut is darker than oak." },
      { title: "Guide", url: "/a/#two", heading: "Width", text: "The stand should be at least 67 inches wide for a 77-inch TV." },
    ];
    expect(bestPassages(ps, "how wide should a stand be")[0]!.url).toBe("/a/#two");
  });
});
