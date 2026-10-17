#!/usr/bin/env bun
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createOwner, createSession, createToken, logout, needsSetup, SESSION_COOKIE } from "../auth/auth.ts";
import { boot, startBackground } from "../boot.ts";
import { TqError } from "../core/errors.ts";
import { describeActions, invoke, type InvokeOptions, type InvokeResult } from "../core/registry.ts";
import type { Runtime } from "../core/runtime.ts";
import { findSite, listSites, roleOn } from "../core/sites.ts";
import type { Ctx, Role } from "../core/types.ts";
import { createApi } from "../server/app.ts";
import { startServer } from "../server/main.ts";

/**
 * `tq`, the Tidequill command line. Every command that changes something goes
 * through the same actions as the admin, as the install's owner.
 */

export interface CliIo {
  rt?: Runtime;
  stdout?: { write(s: string): unknown };
  stderr?: { write(s: string): unknown };
  /** Whether we may ask questions interactively (defaults to stdin being a terminal). */
  interactive?: boolean;
  /** Reads one answer interactively (defaults to the terminal prompt). */
  ask?: (question: string) => string | null;
}

const HELP = `Tidequill — your site, writing itself.

Usage: tq <command> [options]

  serve                                Run Tidequill (admin on localhost, sites on their domains)
  setup --email E --name N --password P
                                       Create the owner account (asks if you leave flags out)
  site create <name> [--domain d] [--niche "..."]
                                       Create a site
  sites                                List sites
  build [--site id]                    Rebuild every page of one site (or all sites)
  import wxr <file> --site <id> [--no-media] [--drafts]
                                       Move a WordPress site in from its export file
  audit <url> [--max-pages n] [--json] Free audit of any public site
  token create --name n [--site id] [--role owner|writer|reviewer]
                                       Create a personal access token (for MCP and scripts)
  ask "..." --site <id>                Ask the site's editorial team
  mcp --site <id> --token <token>      Run the admin MCP server over stdio
  actions [--json]                     List every action (also available over MCP)
  run <action> '<json>' --site <id> [--dry-run] [--confirm token] [--propose]
                                       Run any action as the owner
  help                                 Show this

Settings come from the environment: TQ_DATA_DIR (default ./data), TQ_PORT (8080),
TQ_ADMIN_HOSTS, ANTHROPIC_API_KEY / OPENAI_API_KEY / OLLAMA_URL.
`;

const BOOLEAN_FLAGS = new Set(["no-media", "drafts", "json", "dry-run", "propose", "help", "force"]);

export function parseArgs(argv: string[]): { positionals: string[]; flags: Record<string, string | true> } {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const name = a.slice(2);
      const next = argv[i + 1];
      if (!BOOLEAN_FLAGS.has(name) && next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i++;
      } else flags[name] = true;
    } else if (a === "-h") flags.help = true;
    else positionals.push(a);
  }
  return { positionals, flags };
}

class CliError extends Error {}

const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);

/** The person the CLI acts as: an owner of the site, or the install's first owner. */
function ownerCtx(rt: Runtime, siteId: string | null): Ctx {
  const row = siteId
    ? rt.db.query<{ id: string; name: string }, [string]>("SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.site_id = ? AND m.role = 'owner' ORDER BY u.created_at LIMIT 1").get(siteId)
    : rt.db.query<{ id: string; name: string }, []>("SELECT id, name FROM users WHERE password_hash IS NOT NULL ORDER BY created_at LIMIT 1").get();
  if (!row) throw new CliError(siteId ? "That site has no owner." : "There's no owner account yet. Run: tq setup");
  const role: Role | null = siteId ? roleOn(rt.db, row.id, siteId) : null;
  return rt.ctx({ actor: { kind: "human", userId: row.id, name: row.name }, siteId, role });
}

function siteArg(rt: Runtime, flags: Record<string, string | true>, required: boolean): string | null {
  const key = str(flags.site);
  if (!key) {
    if (!required) return null;
    const sites = listSites(rt.db);
    if (sites.length === 1) return sites[0]!.id;
    throw new CliError(sites.length ? `Say which site with --site: ${sites.map((s) => `${s.id} (${s.name})`).join(", ")}.` : "There are no sites yet. Create one with: tq site create \"My site\"");
  }
  const site = findSite(rt.db, key) ?? listSites(rt.db).find((s) => s.domains.includes(key.toLowerCase()) || s.name.toLowerCase() === key.toLowerCase());
  if (!site) throw new CliError(`There's no site called “${key}”. See them with: tq sites`);
  return site.id;
}

function describeResult(r: InvokeResult): string {
  switch (r.status) {
    case "done":
      return "Done.";
    case "applied":
      return `${r.summary}.`;
    case "proposed":
      return `Proposed: ${r.summary}. It's waiting for approval on Today.`;
    case "dry_run":
      return `Dry run: ${r.summary}. Nothing was changed.${r.confirmToken ? ` To go ahead: --confirm ${r.confirmToken}` : ""}`;
    case "needs_confirmation":
      return `${r.summary} needs confirmation. Run it again with --confirm ${r.confirmToken}`;
  }
}

export async function runCli(argv: string[], io: CliIo = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const print = (s = "") => void stdout.write(`${s}\n`);
  const { positionals, flags } = parseArgs(argv);
  const [cmd = "help", ...rest] = positionals;
  if (flags.help || cmd === "help") {
    print(HELP);
    return 0;
  }

  // stdio MCP: stdout belongs to the protocol, so everything else logs to stderr.
  if (cmd === "mcp") console.log = (...a: unknown[]) => console.error(...a);

  let rt = io.rt;
  try {
    rt ??= await boot();
    switch (cmd) {
      case "serve": {
        startBackground(rt);
        const server = startServer(rt);
        print(`Tidequill is running on http://localhost:${server.port}`);
        if (needsSetup(rt.db)) print(`Open http://localhost:${server.port} to create the owner account (or run: tq setup).`);
        return 0;
      }

      case "setup": {
        if (!needsSetup(rt.db)) {
          print("This install is already set up. Sign in at the admin, or create another site with: tq site create");
          return 0;
        }
        const interactive = io.interactive ?? !!process.stdin.isTTY;
        const askFn = io.ask ?? ((q: string) => prompt(q));
        const need = (key: string, question: string) => {
          const v = str(flags[key]);
          if (v) return v;
          if (!interactive) throw new CliError(`Missing --${key}. Usage: tq setup --email you@example.com --name "Your Name" --password "a long password"`);
          const answer = askFn(question)?.trim();
          if (!answer) throw new CliError(`Setup needs your ${key}.`);
          return answer;
        };
        const email = need("email", "Your email:");
        const name = need("name", "Your name:");
        const password = need("password", "A password (at least 10 characters):");
        const user = await createOwner(rt.db, email, name, password);
        print(`Created the owner account for ${user.name} (${user.email}).`);
        print(`Next: tq site create "My site" --domain example.com --niche "What the site is about, in one sentence"`);
        return 0;
      }

      case "site": {
        const [sub, ...words] = rest;
        if (sub !== "create") throw new CliError('Usage: tq site create "My site" [--domain example.com] [--niche "..."]');
        const name = words.join(" ").trim();
        if (!name) throw new CliError("Give the site a name: tq site create \"My site\"");
        const res = await invoke(ownerCtx(rt, null), "sites.create", { name, domain: str(flags.domain), niche: str(flags.niche) });
        const site = (res as { result: { id: string; name: string; domain: string | null } }).result;
        print(`Created ${site.name} (${site.id})${site.domain ? ` at ${site.domain}` : ""}.`);
        print(site.domain ? `Point ${site.domain} at this server and it will be served there.` : `Preview it at /_site/${site.id}/ on the admin, or add a domain later.`);
        return 0;
      }

      case "sites": {
        const sites = listSites(rt.db);
        if (!sites.length) {
          print('No sites yet. Create one with: tq site create "My site"');
          return 0;
        }
        for (const s of sites) {
          const published = rt.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM entries WHERE site_id = ? AND status = 'published' AND deleted_at IS NULL").get(s.id)?.n ?? 0;
          const waiting = rt.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM proposals WHERE site_id = ? AND status = 'pending'").get(s.id)?.n ?? 0;
          print(`${s.id}  ${s.name}  ${s.primaryDomain ?? "(no domain)"}  ${published} published, ${waiting} waiting for you`);
        }
        return 0;
      }

      case "build": {
        const one = siteArg(rt, flags, false);
        const sites = one ? [findSite(rt.db, one)!] : listSites(rt.db);
        if (!sites.length) {
          print("There are no sites to build.");
          return 0;
        }
        const started = new Date().toISOString();
        for (const s of sites) rt.services.enqueueBuild(s.id, "tq build");
        await rt.drain(1000);
        let failed = 0;
        for (const s of sites) {
          const job = rt.db
            .query<{ status: string; last_error: string | null }, [string, string]>("SELECT status, last_error FROM jobs WHERE site_id = ? AND kind = 'build' AND created_at >= ? ORDER BY created_at DESC LIMIT 1")
            .get(s.id, started) ?? rt.db.query<{ status: string; last_error: string | null }, [string]>("SELECT status, last_error FROM jobs WHERE site_id = ? AND kind = 'build' ORDER BY created_at DESC LIMIT 1").get(s.id);
          if (job?.status === "done") print(`Rebuilt ${s.name}.`);
          else {
            failed++;
            const why = job?.last_error?.split("\n")[0] ?? "it didn't finish";
            print(`Couldn't rebuild ${s.name}: ${why.startsWith("No handler") ? "the renderer isn't installed" : why}.`);
          }
        }
        return failed ? 1 : 0;
      }

      case "import": {
        const [kind, file] = rest;
        if (kind !== "wxr" || !file) throw new CliError("Usage: tq import wxr export.xml --site <site id>");
        const path = resolve(file);
        if (!existsSync(path)) throw new CliError(`There's no file at ${path}.`);
        const siteId = siteArg(rt, flags, true)!;
        const { storeWxr } = await import("../migrate/index.ts");
        const stored = storeWxr(rt.config.dataDir, siteId, readFileSync(path, "utf8"));
        print(`Read ${stored.title || "the export"}: ${stored.items} posts and pages.`);
        const res = await invoke(ownerCtx(rt, siteId), "migrate.wordpress", { fileId: stored.fileId, downloadMedia: !flags["no-media"], asDrafts: !!flags.drafts });
        if (res.status !== "applied") {
          print(describeResult(res));
          return 0;
        }
        await rt.drain(1000);
        const status = (await invoke(ownerCtx(rt, siteId), "migrate.status", { jobId: (res.result as { jobId: string }).jobId })) as { result: any };
        const s = status.result;
        if (s.error) {
          print(s.error);
          return 1;
        }
        for (const line of s.report?.summary ?? []) print(line);
        if (s.report?.unknownShortcodes?.length) {
          print("");
          print("Shortcodes to check:");
          for (const u of s.report.unknownShortcodes) print(`  [${u.name}] on ${u.count} page${u.count === 1 ? "" : "s"}: ${u.suggestion}`);
        }
        if (s.report?.warnings?.length) {
          print("");
          for (const w of s.report.warnings.slice(0, 20)) print(`Note: ${w}`);
        }
        print("");
        print(`Undo the whole import from Today, or with: tq run history.undo '{"actionId":"${res.actionId}"}' --site ${siteId}`);
        return 0;
      }

      case "audit": {
        const [url] = rest;
        if (!url) throw new CliError("Usage: tq audit https://example.com");
        print(`Auditing ${url} (up to ${str(flags["max-pages"]) ?? 200} pages, 4 at a time)…`);
        const ctx = rt.ctx({ actor: { kind: "system" } });
        const res = (await invoke(ctx, "migrate.audit", { url, maxPages: str(flags["max-pages"]) ? Number(flags["max-pages"]) : undefined })) as { result: any };
        const r = res.result;
        if (flags.json) {
          print(JSON.stringify(r, null, 2));
          return 0;
        }
        for (const line of r.summary) print(line);
        const sample = (title: string, items: string[]) => {
          if (!items.length) return;
          print("");
          print(`${title}:`);
          for (const i of items.slice(0, 10)) print(`  ${i}`);
          if (items.length > 10) print(`  …and ${items.length - 10} more`);
        };
        sample("Missing a description", r.missingDescriptions);
        sample("Shared titles", r.duplicateTitles.map((d: any) => `“${d.title}”: ${d.urls.join(", ")}`));
        sample("Thin pages", r.thinPages.map((p: any) => `${p.url} (${p.words} words)`));
        sample("Slow pages", r.slowPages.map((p: any) => `${p.url} (${p.ttfbMs} ms)`));
        sample("Broken links", r.brokenLinks.map((b: any) => `${b.url} (${b.status ?? "no answer"}) on ${b.foundOn}`));
        const replaced = r.plugins.filter((p: any) => p.detected.length);
        if (replaced.length) {
          print("");
          print("Plugins you won't need:");
          for (const p of replaced) print(`  ${p.detected.join(", ")} → ${p.inTidequill}`);
        }
        return 0;
      }

      case "token": {
        const [sub] = rest;
        if (sub !== "create") throw new CliError("Usage: tq token create --name my-assistant [--site <id>] [--role writer]");
        const name = str(flags.name);
        if (!name) throw new CliError("Give the token a name, e.g. --name claude-desktop");
        const role = str(flags.role) as Role | undefined;
        if (role && !["owner", "writer", "reviewer"].includes(role)) throw new CliError("The role can be owner, writer or reviewer.");
        const siteId = siteArg(rt, flags, false);
        const ctx = ownerCtx(rt, siteId);
        const userId = (ctx.actor as { userId: string }).userId;
        const token = createToken(rt.db, userId, name, siteId, role ?? null);
        print(token);
        print(`Copy it now; it won't be shown again. It acts for ${(ctx.actor as { name?: string }).name ?? "the owner"}${siteId ? ` on ${findSite(rt.db, siteId)!.name} only` : " on every site"}${role ? ` as a ${role}` : ""}.`);
        return 0;
      }

      case "ask": {
        const message = rest.join(" ").trim();
        if (!message) throw new CliError('Usage: tq ask "Draft a post about walnut stands" --site <id>');
        const siteId = siteArg(rt, flags, true)!;
        const ctx = ownerCtx(rt, siteId);
        const session = createSession(rt.db, (ctx.actor as { userId: string }).userId);
        const res = await createApi(rt).fetch(
          new Request("http://localhost/api/ask", {
            method: "POST",
            headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}`, "x-tq-site": siteId },
            body: JSON.stringify({ message, conversationId: str(flags.conversation) }),
          }),
        );
        // The session only existed for this one in-process call.
        logout(rt.db, session);
        if (res.status === 404) throw new CliError("Ask isn't available on this install yet.");
        const body = (await res.json()) as any;
        if (!res.ok) throw new CliError(body?.error?.message ?? `Ask failed (${res.status}).`);
        for (const m of (body.messages ?? []).filter((x: any) => x.role === "assistant")) {
          if (m.text) print(m.text);
          for (const card of m.cards ?? []) {
            if (card.type === "proposal") print(`  • Proposed: ${card.summary} (approve on Today)`);
            else if (card.type === "applied") print(`  • Done: ${card.summary}`);
            else if (card.type === "plan") print(`  • Plan: ${card.title} (${card.steps.length} steps, about $${card.costUsd.toFixed(2)})`);
            else if (card.type === "error") print(`  • ${card.message}`);
            else if (card.type === "results") for (const i of card.items.slice(0, 10)) print(`  • ${i.title}${i.subtitle ? ` — ${i.subtitle}` : ""}`);
            else if (card.type === "settings") for (const s of card.sentences) print(`  • ${s.sentence}`);
          }
        }
        if (body.conversationId) print(`(Continue with --conversation ${body.conversationId})`);
        return 0;
      }

      case "mcp": {
        const token = str(flags.token) ?? process.env.TQ_TOKEN;
        if (!token) throw new CliError("Give an access token with --token (create one with: tq token create --name my-assistant).");
        startBackground(rt);
        const { runStdio } = await import("../mcp/index.ts");
        await runStdio(rt, token, str(flags.site) ?? null);
        rt.stop();
        return 0;
      }

      case "actions": {
        const all = describeActions();
        if (flags.json) {
          print(JSON.stringify(all, null, 2));
          return 0;
        }
        const width = Math.max(...all.map((a) => a.name.length));
        for (const a of all) print(`${a.name.padEnd(width)}  ${a.title}${a.risk === "read" ? "" : ` (${a.risk})`}`);
        print("");
        print(`${all.length} actions. Run one with: tq run <action> '<json input>' --site <id>`);
        return 0;
      }

      case "run": {
        const [name, rawJson] = rest;
        if (!name) throw new CliError("Usage: tq run posts.list '{\"status\":\"draft\"}' --site <id>");
        let input: unknown = {};
        if (rawJson) {
          try {
            input = JSON.parse(rawJson);
          } catch {
            throw new CliError("The input isn't valid JSON. Wrap it in single quotes: '{\"title\":\"Hello\"}'");
          }
        }
        const def = describeActions().find((d) => d.name === name);
        if (!def) throw new CliError(`There's no action called ${name}. See them with: tq actions`);
        const siteId = def.siteScoped ? siteArg(rt, flags, true) : null;
        const opts: InvokeOptions = { dryRun: !!flags["dry-run"], propose: !!flags.propose, confirm: str(flags.confirm) };
        const res = await invoke(ownerCtx(rt, siteId), name, input, opts);
        if (res.status !== "done") print(describeResult(res));
        print(JSON.stringify(res.status === "done" || res.status === "applied" ? res.result : res, null, 2));
        if (res.status === "applied") await rt.drain(100);
        return 0;
      }

      default:
        throw new CliError(`There's no command “${cmd}”. Run tq help to see them.`);
    }
  } catch (err) {
    if (err instanceof CliError || err instanceof TqError) {
      stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const code = await runCli(argv.length ? argv : ["serve"]).catch((err) => {
    console.error(err);
    return 1;
  });
  // `serve` keeps running; everything else exits when it's done.
  if (argv[0] !== "serve" && argv.length) process.exit(code);
  else if (code !== 0) process.exit(code);
}
