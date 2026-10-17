import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authFromToken, needsSetup } from "../src/auth/auth.ts";
import { runCli, parseArgs } from "../src/cli/main.ts";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/core/db.ts";
import { entryBySlug } from "../src/core/entries.ts";
import { Runtime } from "../src/core/runtime.ts";
import { setFetch } from "../src/media/net.ts";
import { testSite } from "./helpers.ts";

afterEach(() => setFetch(null));

function capture() {
  let out = "";
  let err = "";
  return {
    stdout: { write: (s: string) => (out += s) },
    stderr: { write: (s: string) => (err += s) },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

async function freshRuntime() {
  await testSite(); // makes sure every module is installed once in this process
  const config = { ...loadConfig({ TQ_DATA_DIR: mkdtempSync(join(tmpdir(), "tq-cli-")), TQ_MODEL_PROVIDER: "offline" }), dbPath: ":memory:" };
  return new Runtime(config, openDb(":memory:"));
}

describe("tq", () => {
  test("parses flags", () => {
    expect(parseArgs(["site", "create", "My", "site", "--domain", "a.test", "--niche=Stands", "--json"])).toEqual({
      positionals: ["site", "create", "My", "site"],
      flags: { domain: "a.test", niche: "Stands", json: true },
    });
  });

  test("help", async () => {
    const io = capture();
    expect(await runCli(["help"], { ...io, rt: await freshRuntime() })).toBe(0);
    expect(io.out).toContain("setup --email");
  });

  test("setup, site create, sites and token create on a fresh install", async () => {
    const rt = await freshRuntime();
    const io = capture();
    expect(await runCli(["setup", "--email", "dana@example.com"], { ...io, rt, interactive: false })).toBe(1);
    expect(io.err).toContain("Missing --name");
    expect(needsSetup(rt.db)).toBe(true);

    const answers = ["Dana Owner", "correct horse battery"];
    expect(await runCli(["setup", "--email", "dana@example.com"], { ...io, rt, interactive: true, ask: () => answers.shift()! })).toBe(0);
    expect(io.out).toContain("Created the owner account for Dana Owner (dana@example.com).");
    expect(needsSetup(rt.db)).toBe(false);
    expect(await runCli(["setup", "--email", "x@example.com", "--name", "X", "--password", "another long one"], { ...io, rt })).toBe(0);
    expect(io.out).toContain("already set up");

    expect(await runCli(["site", "create", "Walnut", "&", "Wire", "--domain", "walnut.test", "--niche", "TV stands for small rooms"], { ...io, rt })).toBe(0);
    expect(io.out).toMatch(/Created Walnut & Wire \(site_[a-z0-9]+\) at walnut\.test\./);
    const io2 = capture();
    await runCli(["sites"], { ...io2, rt });
    expect(io2.out).toMatch(/site_[a-z0-9]+ {2}Walnut & Wire {2}walnut\.test {2}0 published, 0 waiting for you/);

    const io3 = capture();
    expect(await runCli(["token", "create", "--name", "claude", "--site", "walnut.test", "--role", "writer"], { ...io3, rt })).toBe(0);
    const token = io3.out.split("\n")[0]!;
    expect(token).toStartWith("tq_");
    const auth = authFromToken(rt.db, token)!;
    expect(auth.user.email).toBe("dana@example.com");
    expect(auth.token).toMatchObject({ role: "writer" });
    expect(io3.out).toContain("on Walnut & Wire only as a writer");
  });

  test("actions and run", async () => {
    const t = await testSite();
    const io = capture();
    await runCli(["actions"], { ...io, rt: t.rt });
    expect(io.out).toContain("posts.create");
    expect(io.out).toContain("media.set_alt");

    const run = capture();
    expect(await runCli(["run", "posts.create", '{"title":"Hello from the terminal","markdown":"Hi."}', "--site", t.siteId], { ...run, rt: t.rt })).toBe(0);
    expect(run.out).toContain("New draft: “Hello from the terminal”.");
    expect(entryBySlug(t.db, t.siteId, "hello-from-the-terminal")?.status).toBe("draft");

    const bad = capture();
    expect(await runCli(["run", "posts.create", "{nope", "--site", t.siteId], { ...bad, rt: t.rt })).toBe(1);
    expect(bad.err).toContain("isn't valid JSON");
    const missing = capture();
    expect(await runCli(["run", "posts.nothing", "{}"], { ...missing, rt: t.rt })).toBe(1);
    expect(missing.err).toContain("There's no action called posts.nothing");

    const dry = capture();
    const id = entryBySlug(t.db, t.siteId, "hello-from-the-terminal")!.id;
    await runCli(["run", "posts.delete", JSON.stringify({ id }), "--site", t.siteId, "--dry-run"], { ...dry, rt: t.rt });
    expect(dry.out).toContain("Dry run: Delete “Hello from the terminal”. Nothing was changed. To go ahead: --confirm");
  });

  test("import wxr", async () => {
    const t = await testSite();
    const io = capture();
    const code = await runCli(["import", "wxr", join(import.meta.dir, "fixtures/wordpress-export.xml"), "--site", t.siteId, "--no-media"], { ...io, rt: t.rt });
    expect(code).toBe(0);
    expect(io.out).toContain("Read Oak & Pine Workshop: 5 posts and pages.");
    expect(io.out).toContain("Imported 3 posts and 1 page");
    expect(io.out).toContain("2 old addresses now redirect");
    expect(io.out).toContain("[contact-form-7] on 1 page");
    expect(entryBySlug(t.db, t.siteId, "old-style")?.status).toBe("published");
  });

  test("audit", async () => {
    setFetch(async (input) => {
      const url = String(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url === "https://audit.example/") return new Response(`<title>Home</title><meta name="description" content="Hi"><p>Short page</p>`, { headers: { "content-type": "text/html" } });
      return new Response("nope", { status: 404 });
    });
    const t = await testSite();
    const io = capture();
    expect(await runCli(["audit", "audit.example"], { ...io, rt: t.rt })).toBe(0);
    expect(io.out).toContain("There's no sitemap, so I followed links from the home page and found 1 page.");
    expect(io.out).toContain("Thin pages:");
  });

  test("build reports each site", async () => {
    const t = await testSite();
    const io = capture();
    await runCli(["build", "--site", t.siteId], { ...io, rt: t.rt });
    expect(io.out).toMatch(/(Rebuilt|Couldn't rebuild) Walnut & Wire/);
  });

  test("unknown commands and missing sites explain themselves", async () => {
    const t = await testSite();
    const io = capture();
    expect(await runCli(["frobnicate"], { ...io, rt: t.rt })).toBe(1);
    expect(io.err).toContain("There's no command “frobnicate”");
    expect(await runCli(["build", "--site", "nope"], { ...io, rt: t.rt })).toBe(1);
    expect(io.err).toContain("There's no site called “nope”");
  });
});
