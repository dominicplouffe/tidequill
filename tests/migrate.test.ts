import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { createToken } from "../src/auth/auth.ts";
import { entryBySlug } from "../src/core/entries.ts";
import { undoAction } from "../src/core/registry.ts";
import { setFetch } from "../src/media/net.ts";
import { htmlToDoc } from "../src/migrate/convert.ts";
import { parseWxr } from "../src/migrate/source.ts";
import { createApi } from "../src/server/app.ts";
import { testSite } from "./helpers.ts";

const FIXTURE = readFileSync(join(import.meta.dir, "fixtures/wordpress-export.xml"), "utf8");

afterEach(() => setFetch(null));

/** A fake web: a map of URL -> response, so tests never touch the network. */
function fakeWeb(pages: Record<string, { status?: number; body: string | Uint8Array; type?: string; delayMs?: number }>) {
  const calls: string[] = [];
  setFetch(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const page = pages[url];
    if (!page) return new Response("Not found", { status: 404, headers: { "content-type": "text/html" } });
    if (page.delayMs) await new Promise((r) => setTimeout(r, page.delayMs));
    return new Response(page.body as BodyInit, { status: page.status ?? 200, headers: { "content-type": page.type ?? "text/html; charset=utf-8" } });
  });
  return calls;
}

describe("HTML to blocks", () => {
  test("converts Gutenberg and classic markup, shortcodes and embeds", () => {
    const { doc, unknownShortcodes, missingAlt } = htmlToDoc(
      `<!-- wp:paragraph --><p>Hello <b>there</b> <a href="https://x.example/">friend</a>.</p><!-- /wp:paragraph -->
<h3>Sizes</h3><ol><li>One<ul><li>One A</li></ul></li><li>Two</li></ol>
[su_box title="Note"]Inside the box[/su_box] [Updated] [1]
<figure class="wp-block-embed"><div class="wp-block-embed__wrapper">https://www.youtube.com/watch?v=abc</div></figure>
<script>alert(1)</script><p><img src="/a.jpg"></p>`,
    );
    expect(doc.blocks.map((b) => b.type)).toEqual(["paragraph", "heading", "list", "paragraph", "paragraph", "image"]);
    expect(doc.blocks[0]).toMatchObject({ text: "Hello **there** [friend](https://x.example/)." });
    expect(doc.blocks[1]).toMatchObject({ level: 3, text: "Sizes" });
    expect(doc.blocks[2]).toMatchObject({ ordered: true, items: ["One", "One A", "Two"] });
    expect((doc.blocks[3] as any).text).toBe("Inside the box [Updated] [1]");
    expect((doc.blocks[4] as any).text).toBe("[Watch the video](https://www.youtube.com/watch?v=abc)");
    expect(unknownShortcodes).toEqual(["su_box"]);
    expect(missingAlt).toEqual(["/a.jpg"]);
    expect(JSON.stringify(doc)).not.toContain("alert");
  });

  test("reads a WXR file", () => {
    const wp = parseWxr(FIXTURE);
    expect(wp.title).toBe("Oak & Pine Workshop");
    expect(wp.authors.map((a) => a.displayName)).toEqual(["Fred Marsh", "Anna Reyes"]);
    const post = wp.items.find((i) => i.wpId === "100")!;
    expect(post.date).toBe("2019-05-14T10:00:00.000Z");
    expect(post.categories).toEqual(["tv-stands"]);
    expect(post.tags).toEqual(["Walnut"]);
    expect(post.meta._yoast_wpseo_metadesc).toContain("How wide");
  });
});

describe("WordPress import", () => {
  test("imports posts, pages, authors, categories, SEO descriptions and media, with redirects and a report", async () => {
    const jpeg = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#8a5a2b" } }).jpeg().toBuffer();
    const calls = fakeWeb({ "https://oakandpine.example/wp-content/uploads/2019/05/oak-stand.jpg": { body: new Uint8Array(jpeg), type: "image/jpeg" } });
    const t = await testSite();
    const token = createToken(t.db, t.owner.id, "test", null, null);
    const api = createApi(t.rt);
    const form = new FormData();
    form.append("file", new File([FIXTURE], "export.xml", { type: "text/xml" }));
    const up = await api.fetch(new Request("http://localhost/api/migrate/wxr", { method: "POST", body: form, headers: { authorization: `Bearer ${token}`, "x-tq-site": t.siteId } }));
    expect(up.status).toBe(200);
    const uploaded = (await up.json()) as any;
    expect(uploaded.fileId).toStartWith("wxr_");
    expect(uploaded.items).toBe(5);

    const started: any = await t.invoke(t.as(), "migrate.wordpress", { fileId: uploaded.fileId });
    expect(started.status).toBe("applied");
    expect(started.result.jobId).toStartWith("job_");
    await t.rt.drain();

    const status: any = await t.invoke(t.as(), "migrate.status", {});
    expect(status.result.status).toBe("done");
    const report = status.result.report;
    expect(report.counts).toMatchObject({ posts: 3, pages: 1, categories: 1, authors: 2, media: 1, redirects: 2 });
    expect(report.unknownShortcodes.map((s: any) => s.name)).toEqual(["contact-form-7"]);
    expect(report.unknownShortcodes[0].suggestion).toContain("contact form");
    expect(report.seo.descriptions).toBe(2);
    expect(report.thinPages.length).toBe(3);
    expect(report.warnings.join(" ")).toContain("cdn.elsewhere.example/walnut.jpg");
    expect(report.summary[0]).toBe("Imported 3 posts and 1 page, with 1 new category, 2 new authors and 1 image.");
    // The fake web was only asked for images.
    expect(calls.every((u) => u.includes("/wp-content/uploads/") || u.includes("cdn.elsewhere"))).toBe(true);

    const post = entryBySlug(t.db, t.siteId, "how-to-pick-a-tv-stand")!;
    const old = entryBySlug(t.db, t.siteId, "old-style")!;
    const about = entryBySlug(t.db, t.siteId, "about")!;
    expect(post.status).toBe("published");
    expect(post.publishedAt).toBe("2019-05-14T10:00:00.000Z");
    expect(post.updatedAt).toBe("2020-01-02T08:00:00.000Z");
    expect(post.description).toBe("How wide your TV stand should be, measured on real stands.");
    expect(post.tags).toEqual(["Walnut"]);
    expect(about.type).toBe("page");
    expect(old.description).toBe("A classic-editor post from 2019.");
    expect(old.categoryId).toBeNull();

    const cat = t.db.query<any, [string]>("SELECT * FROM categories WHERE site_id = ?").all(t.siteId);
    expect(cat.map((c) => c.name)).toEqual(["TV Stands"]);
    expect(post.categoryId).toBe(cat[0].id);
    const fred = t.db.query<any, [string]>("SELECT * FROM authors WHERE site_id = ? AND name = 'Fred Marsh'").get(t.siteId);
    expect(post.authorIds).toEqual([fred.id]);

    // Blocks, with media and internal links rewritten.
    const types = post.body.blocks.map((b) => b.type);
    expect(types).toEqual(["paragraph", "heading", "list", "image", "table", "quote", "image", "paragraph"]);
    const [intro, , list, image, table, quote, caption, last] = post.body.blocks as any[];
    expect(intro.text).toBe(`I bought the **wrong** stand first. Read [about us](tq:${about.id}) to see why we test everything & measure twice.`);
    expect(list.items).toEqual(["Measure the *feet* of the TV", "Add six inches"]);
    expect(image.src).toMatch(/^media:med_/);
    expect(image.alt).toBe("Oak TV stand in a small living room");
    expect(image.caption).toBe("Our oak stand after six months");
    expect(post.heroMediaId).toBe(image.src.slice(6));
    expect(table).toMatchObject({ header: ["TV", "Stand width"], rows: [['65"', "60 in"], ['77"', "70 in"]] });
    expect(quote).toMatchObject({ text: "Measure twice, buy once.", cite: "Fred" });
    expect(caption).toMatchObject({ src: "https://cdn.elsewhere.example/walnut.jpg", alt: "Walnut console", caption: "A walnut console we liked" });
    expect(last.text).toBe(`Questions? See the [older post](tq:${old.id}).`);

    expect(old.body.blocks.map((b) => b.type)).toEqual(["paragraph", "paragraph", "code", "divider", "image"]);
    expect((old.body.blocks[2] as any).lang).toBe("bash");
    expect((old.body.blocks[2] as any).text).toBe("cut -d, -f1 sizes.csv\n\necho done");
    expect((old.body.blocks[4] as any).src).toBe(image.src);

    const drafts = t.db.query<any, [string]>("SELECT slug, status FROM entries WHERE site_id = ? AND status = 'draft'").all(t.siteId);
    expect(drafts).toEqual([{ slug: "walnut-console-notes", status: "draft" }]);
    expect(entryBySlug(t.db, t.siteId, "deleted-thing")).toBeNull();

    // Old /2019/05/... permalinks redirect; /about/ didn't change.
    const redirects = t.db.query<any, [string]>("SELECT from_path, to_path, code FROM redirects WHERE site_id = ? ORDER BY from_path").all(t.siteId);
    expect(redirects).toEqual([
      { from_path: "/2019/05/how-to-pick-a-tv-stand/", to_path: "/how-to-pick-a-tv-stand/", code: 301 },
      { from_path: "/2019/05/old-style/", to_path: "/old-style/", code: 301 },
    ]);
    expect(report.urlMap.find((u: any) => u.entryId === about.id)).toMatchObject({ old: "/about/", new: "/about/" });

    // Running it again skips what's already there.
    const again: any = await t.invoke(t.as(), "migrate.wordpress", { fileId: uploaded.fileId, downloadMedia: false });
    await t.rt.drain();
    const second: any = await t.invoke(t.as(), "migrate.status", { jobId: again.result.jobId });
    expect(second.result.report.counts.skipped).toBe(4);
    expect(second.result.report.counts.posts).toBe(0);

    // Undo removes what the first import created.
    await undoAction(t.as(), started.actionId);
    expect(entryBySlug(t.db, t.siteId, "how-to-pick-a-tv-stand")).toBeNull();
    expect(t.db.query("SELECT COUNT(*) AS n FROM redirects WHERE site_id = ?").get(t.siteId)).toEqual({ n: 0 });
  });

  test("an agent proposes an import instead of running it", async () => {
    const t = await testSite();
    const res: any = await t.invoke(t.agent("editor"), "migrate.wordpress", { url: "https://oakandpine.example" });
    expect(res.status).toBe("proposed");
    expect(res.summary).toBe("Import the WordPress site at oakandpine.example");
  });

  test("reads a live site through the REST API", async () => {
    const api = "https://live.example/wp-json/wp/v2";
    const j = (v: unknown) => ({ body: JSON.stringify(v), type: "application/json" });
    fakeWeb({
      [`${api}/users?per_page=100&page=1`]: j([{ id: 7, slug: "fred", name: "Fred Marsh" }]),
      [`${api}/categories?per_page=100&page=1`]: j([{ id: 3, slug: "tv-stands", name: "TV Stands", description: "" }]),
      [`${api}/tags?per_page=100&page=1`]: j([]),
      [`${api}/media?per_page=100&page=1`]: j([]),
      [`${api}/posts?per_page=100&page=1`]: j([
        {
          id: 1,
          slug: "hello-stand",
          status: "publish",
          date_gmt: "2021-03-04T05:06:07",
          link: "https://live.example/2021/03/hello-stand/",
          title: { rendered: "Hello &amp; stand" },
          content: { rendered: "<p>Body text.</p>" },
          excerpt: { rendered: "<p>Short.</p>" },
          author: 7,
          categories: [3],
          tags: [],
          featured_media: 0,
          yoast_head_json: { description: "From Yoast over REST." },
        },
      ]),
      [`${api}/pages?per_page=100&page=1`]: j([]),
    });
    const t = await testSite();
    await t.invoke(t.as(), "migrate.wordpress", { url: "https://live.example" });
    await t.rt.drain();
    const status: any = await t.invoke(t.as(), "migrate.status", {});
    expect(status.result.error).toBeNull();
    const e = entryBySlug(t.db, t.siteId, "hello-stand")!;
    expect(e.title).toBe("Hello & stand");
    expect(e.description).toBe("From Yoast over REST.");
    expect(e.publishedAt).toBe("2021-03-04T05:06:07.000Z");
    expect(status.result.report.urlMap[0]).toMatchObject({ old: "/2021/03/hello-stand/", new: "/hello-stand/" });
  });
});

describe("free audit", () => {
  test("reports pages, titles, descriptions, alt text, thin and slow pages, broken links and plugins", async () => {
    const page = (title: string, desc: string, body: string) =>
      `<html><head><title>${title}</title>${desc ? `<meta name="description" content="${desc}">` : ""}<link rel="stylesheet" href="/wp-content/plugins/contact-form-7/style.css"></head><body><nav>Menu</nav><main>${body}</main></body></html>`;
    const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
    fakeWeb({
      "https://shop.example/robots.txt": { body: "User-agent: *\nSitemap: https://shop.example/sitemap.xml", type: "text/plain" },
      "https://shop.example/sitemap.xml": {
        type: "application/xml",
        body: `<?xml version="1.0"?><urlset><url><loc>https://shop.example/</loc></url><url><loc>https://shop.example/a/</loc></url><url><loc>https://shop.example/b/</loc></url><url><loc>https://shop.example/slow/</loc></url></urlset>`,
      },
      "https://shop.example/": { body: page("Home", "Welcome", `<p>${words(400)}</p><a href="/missing/">old</a><img src="/x.jpg">`) },
      "https://shop.example/a/": { body: page("Same title", "", `<p>${words(50)}</p><img src="/y.jpg" alt="A chair">`) },
      "https://shop.example/b/": { body: page("Same title", "B page", `<p>${words(350)}</p>`) },
      "https://shop.example/slow/": { body: page("", "Slow", `<p>${words(320)}</p>`), delayMs: 30 },
    });
    const t = await testSite();
    const res: any = await t.invoke(t.as("owner"), "migrate.audit", { url: "shop.example" });
    const r = res.result;
    expect(r.source).toBe("sitemap");
    expect(r.pageCount).toBe(4);
    expect(r.checked).toBe(4);
    expect(r.missingDescriptions).toEqual(["https://shop.example/a/"]);
    expect(r.missingTitles).toEqual(["https://shop.example/slow/"]);
    expect(r.duplicateTitles).toEqual([{ title: "Same title", urls: ["https://shop.example/a/", "https://shop.example/b/"] }]);
    expect(r.missingAlt).toEqual({ images: 1, pages: [{ url: "https://shop.example/", count: 1 }] });
    expect(r.thinPages).toEqual([{ url: "https://shop.example/a/", words: 50 }]);
    expect(r.brokenLinks).toEqual([{ url: "https://shop.example/missing/", status: 404, foundOn: "https://shop.example/" }]);
    expect(r.plugins.find((p: any) => p.plugin.startsWith("Contact Form 7")).detected).toEqual(["contact-form-7"]);
    expect(r.summary.join(" ")).toContain("You won't need contact-form-7 on Tidequill.");

    // Slow pages use the measured time to first byte.
    const slow: any = await t.invoke(t.as(), "migrate.audit", { url: "https://shop.example/" });
    expect(slow.result.pages.find((p: any) => p.url.endsWith("/slow/")).ttfbMs).toBeGreaterThanOrEqual(25);
  });

  test("crawls from the home page when there is no sitemap", async () => {
    fakeWeb({
      "https://tiny.example/": { body: `<title>Home</title><a href="/one/">1</a><a href="https://other.example/">x</a>` },
      "https://tiny.example/one/": { body: `<title>One</title><a href="/">home</a>` },
      "https://other.example/": { body: "ok" },
    });
    const t = await testSite();
    const res: any = await t.invoke(t.as(), "migrate.audit", { url: "https://tiny.example" });
    expect(res.result.source).toBe("crawl");
    expect(res.result.pages.map((p: any) => p.url).sort()).toEqual(["https://tiny.example/", "https://tiny.example/one/"]);
    expect(res.result.brokenLinks).toEqual([]);
  });
});
