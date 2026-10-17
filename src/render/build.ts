import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../core/db.ts";
import { entryPath } from "../core/entries.ts";
import { findSite } from "../core/sites.ts";
import type { Ctx } from "../core/types.ts";
import { budgetProblems } from "./checks.ts";
import { ASSETS_DIR } from "./engine.ts";
import { contrastProblems } from "./tokens.ts";
import { fileForPath, hostsFile, publicDir, readJsonFile, removeFile, siteDir, writeAtomic } from "./files.ts";
import { loadSiteModel, relatedPosts, type SiteModel } from "./model.ts";
import { planPages, renderCtx, type PlannedPage, type RenderCtx } from "./pages.ts";
import { agentFiles, feedXml, llmsTxt, mcpManifest, redirectsJson, robotsTxt, searchIndex, sitemapXml } from "./sitefiles.ts";

/**
 * The static build. A full build renders every page; an incremental build
 * (a list of changed entry ids) renders those entries plus every page that
 * shows them: pages linking to them, pages listing them as related, their
 * category and author pages, and the home page. Site files are rewritten
 * every time (they're cheap). Output that no longer belongs is removed.
 */

/** Bump when the render output changes shape, so the next build is a full one. */
const RENDER_VERSION = 1;

export interface BuildCheck {
  name: string;
  passed: boolean;
  message: string;
  blocking: boolean;
  path?: string;
}

export interface BuildReport {
  siteId: string;
  full: boolean;
  /** Pages rendered in this build. */
  pages: number;
  /** Files whose content changed. */
  written: number;
  removed: number;
  ms: number;
  /** Performance-budget and contrast failures, in plain English. Empty when everything passed. */
  checks: BuildCheck[];
}

interface Manifest {
  version: number;
  fingerprint: string;
  /** path -> page key, for every page of the last build. */
  pages: Record<string, string>;
  /** What each entry looked like last build, so a change can find the pages that showed it. */
  entries: Record<string, { path: string; categoryId: string | null; authorIds: string[]; related: string[] }>;
}

function fingerprint(m: SiteModel, rc: RenderCtx): string {
  const s = m.site;
  const parts = {
    v: RENDER_VERSION,
    design: m.design,
    css: rc.css.inline,
    nav: rc.nav,
    footer: rc.footer,
    topics: rc.topics.map((t) => t.href),
    site: [s.name, s.niche, s.locale, s.settings.aiDisclosure, s.settings.timezone, m.baseUrl],
    // Author names and bios appear in bylines and author boxes on many pages.
    authors: m.authors.map((a) => [a.id, a.slug, a.name, a.bio, a.credentials, a.isPersona, a.photoMediaId]),
    categories: m.categories.map((c) => [c.id, c.slug, c.name]),
  };
  return new Bun.CryptoHasher("sha1").update(JSON.stringify(parts)).digest("hex");
}

function affectedPages(m: SiteModel, plan: PlannedPage[], prev: Manifest, entryIds: string[]): PlannedPage[] {
  const changed = new Set(entryIds);
  const keys = new Set(["home", "search", "404"]);
  for (const id of changed) {
    keys.add(`entry:${id}`);
    const now = m.byId.get(id);
    const before = prev.entries[id];
    for (const from of m.linksIn.get(id) ?? []) keys.add(`entry:${from}`);
    for (const cat of [now?.categoryId, before?.categoryId]) if (cat) keys.add(`category:${cat}`);
    for (const a of [...(now?.authorIds ?? []), ...(before?.authorIds ?? [])]) keys.add(`author:${a}`);
  }
  // Pages that showed a changed entry as related (before) or will now (after).
  for (const [id, info] of Object.entries(prev.entries)) if (info.related.some((r) => changed.has(r))) keys.add(`entry:${id}`);
  for (const e of m.posts) if (relatedPosts(m, e).some((r) => changed.has(r.id))) keys.add(`entry:${e.id}`);
  return plan.filter((p) => keys.has(p.key));
}

function copyAssets(out: string): number {
  let written = 0;
  const fontsDir = join(ASSETS_DIR, "fonts");
  const target = join(out, "_tq", "fonts");
  mkdirSync(target, { recursive: true });
  for (const f of readdirSync(fontsDir)) {
    const dest = join(target, f);
    if (existsSync(dest) && statSync(dest).size === statSync(join(fontsDir, f)).size) continue;
    copyFileSync(join(fontsDir, f), `${dest}.tmp`);
    renameSync(`${dest}.tmp`, dest);
    written++;
  }
  if (writeAtomic(join(out, "_tq", "search.js"), readFileSync(join(ASSETS_DIR, "search.js")))) written++;
  return written;
}

/** <dataDir>/hosts.json: hostname -> site id, the edge's only routing table. */
export function writeHostsFile(db: Db, dataDir: string): boolean {
  const rows = db
    .query<{ hostname: string; site_id: string }, []>("SELECT d.hostname, d.site_id FROM domains d JOIN sites s ON s.id = d.site_id WHERE s.deleted_at IS NULL ORDER BY d.hostname")
    .all();
  const map = Object.fromEntries(rows.map((r) => [r.hostname.toLowerCase(), r.site_id]));
  return writeAtomic(hostsFile(dataDir), `${JSON.stringify(map, null, 2)}\n`);
}

type BuiltListener = (siteId: string, dataDir: string, report: BuildReport) => void;
const builtListeners: BuiltListener[] = [];

/** Called after every build (the edge drops its cached copies of site files). */
export function onSiteBuilt(fn: BuiltListener) {
  builtListeners.push(fn);
}

export async function buildSite(ctx: Ctx, siteId: string, entryIds: string[] | null, reasons: string[] = []): Promise<BuildReport> {
  const t0 = performance.now();
  if (!findSite(ctx.db, siteId)) {
    // A deleted site: nothing to build, but its domains must stop routing to it.
    writeHostsFile(ctx.db, ctx.dataDir);
    return { siteId, full: true, pages: 0, written: 0, removed: 0, ms: 0, checks: [] };
  }
  const m = loadSiteModel(ctx.db, siteId);
  const root = siteDir(ctx.dataDir, siteId);
  const out = publicDir(ctx.dataDir, siteId);
  mkdirSync(out, { recursive: true });
  const manifestFile = join(root, "build-manifest.json");
  const prev = readJsonFile<Manifest | null>(manifestFile, null);
  const rc = renderCtx(m);
  const plan = planPages(m);
  const fp = fingerprint(m, rc);
  const full = entryIds === null || !prev || prev.version !== RENDER_VERSION || prev.fingerprint !== fp;
  const targets = full ? plan : affectedPages(m, plan, prev, entryIds);

  let written = 0;
  let removed = 0;
  const checks: BuildCheck[] = [];
  const write = (rel: string | null, data: string | Uint8Array) => {
    if (rel && writeAtomic(join(out, rel), data)) written++;
  };

  for (const p of targets) {
    const file = fileForPath(p.path);
    if (!file) {
      checks.push({ name: "Page address", passed: false, blocking: true, message: `The address ${p.path} can't be published; give the page a simpler address.`, path: p.path });
      continue;
    }
    const page = p.render(rc);
    write(file, page.html);
    const md = fileForPath(p.path, "index.md");
    if (page.markdown) write(md, page.markdown);
    else if (md && p.path.endsWith("/") && removeFile(join(out, md), out)) removed++;
    for (const message of budgetProblems(page.html, p.path, page.kind)) checks.push({ name: "Performance budget", passed: false, blocking: true, message, path: p.path });
  }

  // WCAG AA contrast of the design tokens, light and dark.
  for (const p of contrastProblems(m.tokens)) checks.push({ name: "Accessibility", passed: false, blocking: true, message: p.message });

  // Pages from the last build that the site no longer has (unpublished, deleted, moved).
  const livePaths = new Set(plan.map((p) => p.path));
  for (const path of Object.keys(prev?.pages ?? {})) {
    if (livePaths.has(path)) continue;
    for (const f of ["index.html", "index.md"]) {
      const rel = fileForPath(path, f);
      if (rel && removeFile(join(out, rel), out)) removed++;
    }
  }

  write("sitemap.xml", sitemapXml(m, plan));
  write("feed.xml", feedXml(m));
  write("robots.txt", robotsTxt(m));
  write("llms.txt", llmsTxt(m));
  write("search.json", JSON.stringify(searchIndex(m)));
  write("_redirects.json", JSON.stringify(redirectsJson(m, livePaths), null, 1));
  write(".well-known/mcp.json", JSON.stringify(mcpManifest(m), null, 2));
  for (const [rel, data] of Object.entries(agentFiles(m))) write(rel, JSON.stringify(data));
  written += copyAssets(out);

  const manifest: Manifest = {
    version: RENDER_VERSION,
    fingerprint: fp,
    pages: Object.fromEntries(plan.map((p) => [p.path, p.key])),
    entries: Object.fromEntries(
      m.entries.map((e) => [e.id, { path: entryPath(e), categoryId: e.categoryId, authorIds: e.authorIds, related: relatedPosts(m, e).map((r) => r.id) }]),
    ),
  };
  writeAtomic(manifestFile, JSON.stringify(manifest));
  writeHostsFile(ctx.db, ctx.dataDir);

  const report: BuildReport = { siteId, full, pages: targets.length, written, removed, ms: Math.round(performance.now() - t0), checks };
  writeAtomic(join(root, "build.json"), JSON.stringify({ ...report, reasons, at: new Date().toISOString() }, null, 2));
  for (const fn of builtListeners) fn(siteId, ctx.dataDir, report);
  return report;
}

/** The last build's report, for the admin ("Published in 0.4 s, 2 issues"). */
export function lastBuild(dataDir: string, siteId: string): (BuildReport & { reasons: string[]; at: string }) | null {
  return readJsonFile(join(siteDir(dataDir, siteId), "build.json"), null);
}
