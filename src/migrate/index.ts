import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { json } from "../core/db.ts";
import { TqError, forbidden, invalid } from "../core/errors.ts";
import { id } from "../core/ids.ts";
import { enqueue, registerJob } from "../core/jobs.ts";
import { defineAction } from "../core/registry.ts";
import type { Runtime } from "../core/runtime.ts";
import type { Actor, Ctx } from "../core/types.ts";
import { formatBytes, publicUrl } from "../media/net.ts";
import { requestCtx, extendApi } from "../server/app.ts";
import { runAudit } from "./audit.ts";
import { htmlText } from "./convert.ts";
import { emptyCreated, runImport, undoImport, type Created, type ImportProgress, type ImportReport } from "./importer.ts";
import { fetchWpRest, looksLikeWxr, parseWxr } from "./source.ts";

export { runAudit, auditSummary, PLUGIN_MAP, type AuditReport } from "./audit.ts";
export { htmlToDoc, expandShortcodes, autop } from "./convert.ts";
export { parseWxr, fetchWpRest, type WpSite } from "./source.ts";
export { runImport, summarize, type ImportReport } from "./importer.ts";

/**
 * WordPress migration and the free audit.
 *
 * `migrate.wordpress` queues a background job (job kind "migrate.wordpress")
 * whose payload carries live progress and, at the end, the full report. Read it
 * with `migrate.status`. Undo removes everything the import created.
 */

export const MIGRATE_JOB = "migrate.wordpress";
const MAX_WXR_BYTES = 100 * 1024 * 1024;

function importsDir(dataDir: string, siteId: string) {
  return join(dataDir, "imports", siteId);
}

function wxrPath(dataDir: string, siteId: string, fileId: string): string | null {
  if (!/^wxr_[a-z0-9]+$/.test(fileId)) return null;
  return join(importsDir(dataDir, siteId), `${fileId}.xml`);
}

/** Keeps an uploaded WordPress export for `migrate.wordpress`. Returns its file id. */
export function storeWxr(dataDir: string, siteId: string, text: string): { fileId: string; title: string; items: number } {
  if (!looksLikeWxr(text)) throw invalid("That file isn't a WordPress export. In WordPress, go to Tools → Export → All content, and upload the .xml file it gives you.");
  const fileId = id("wxr");
  mkdirSync(importsDir(dataDir, siteId), { recursive: true });
  writeFileSync(wxrPath(dataDir, siteId, fileId)!, text);
  return { fileId, title: exportTitle(text), items: countContent(text) };
}

function exportTitle(text: string): string {
  return htmlText(text.match(/<channel>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1] ?? "");
}

function countContent(text: string): number {
  return [...text.matchAll(/<wp:post_type>(?:<!\[CDATA\[)?(post|page)(?:\]\]>)?<\/wp:post_type>/g)].length;
}

interface MigrateSource {
  kind: "wxr" | "rest";
  fileId?: string;
  url?: string;
  username?: string;
  appPassword?: string;
}

interface MigratePayload {
  source: MigrateSource;
  options: { downloadMedia: boolean; asDrafts: boolean };
  actionId: string | null;
  actor: Actor;
  label: string;
  progress?: ImportProgress;
  created?: Created;
  report?: ImportReport;
  error?: string;
}

const migrateInput = z
  .object({
    fileId: z.string().optional().describe("Id of an export file uploaded to /api/migrate/wxr"),
    url: z.string().optional().describe("Address of the live WordPress site, for the REST API"),
    username: z.string().optional().describe("WordPress username (for drafts and private content)"),
    appPassword: z.string().optional().describe("A WordPress application password; it is used once and then forgotten"),
    downloadMedia: z.boolean().default(true).describe("Copy images into the media library and point posts at the copies"),
    asDrafts: z.boolean().optional().describe("Import everything as drafts instead of keeping what was published live"),
  })
  .refine((v) => !!v.fileId !== !!v.url, "Give either an uploaded export file (fileId) or the site's address (url), not both");

defineAction({
  name: "migrate.wordpress",
  title: "Move a WordPress site in",
  description:
    "Imports a WordPress site from an export file or its live REST API: posts, pages, categories, tags, authors, SEO descriptions, published status and dates, and images. Every old address that changes gets a 301 redirect. Runs in the background; read progress and the report with migrate.status. Nothing changes on the old site. Undo removes everything it imported.",
  permission: "admin",
  risk: "costly",
  trust: "other",
  input: migrateInput,
  prepare(ctx, input) {
    const siteId = ctx.siteId!;
    let source: MigrateSource;
    let label: string;
    if (input.fileId) {
      const path = wxrPath(ctx.dataDir, siteId, input.fileId);
      if (!path || !existsSync(path)) throw invalid("That export file wasn't found. Upload it again.");
      const text = readFileSync(path, "utf8");
      const n = countContent(text);
      const title = exportTitle(text);
      source = { kind: "wxr", fileId: input.fileId };
      label = `${n} post${n === 1 ? "" : "s"} and pages from ${title || "the WordPress export"}`;
    } else {
      const url = publicUrl(input.url!);
      if ((input.username && !input.appPassword) || (!input.username && input.appPassword)) throw invalid("Give both the WordPress username and an application password, or neither.");
      source = { kind: "rest", url: url.toString(), username: input.username, appPassword: input.appPassword };
      label = `the WordPress site at ${url.hostname}`;
    }
    return {
      summary: `Import ${label}`,
      detail: `Posts and pages keep their addresses, dates and published status; changed addresses get redirects.${input.downloadMedia ? " Images are copied into the media library." : ""}`,
      payload: { source, options: { downloadMedia: input.downloadMedia, asDrafts: !!input.asDrafts }, label },
    };
  },
  apply(ctx, p: { source: MigrateSource; options: MigratePayload["options"]; label: string }) {
    const payload: MigratePayload = { ...p, actionId: ctx.actionId, actor: ctx.actor };
    const jobId = enqueue(ctx.db, MIGRATE_JOB, ctx.siteId!, payload);
    return {
      result: { jobId, status: "queued", message: `Importing ${p.label}. This runs in the background; ask “how is the import going?” any time.` },
      summary: `Started importing ${p.label}`,
      undo: { jobId },
    };
  },
  undo(ctx, u: { jobId: string }) {
    const job = ctx.db.query<{ status: string; payload: string }, [string, string]>("SELECT status, payload FROM jobs WHERE id = ? AND site_id = ?").get(u.jobId, ctx.siteId!);
    if (!job) return;
    if (job.status === "running") throw new TqError("conflict", "The import is still running. Undo it when it finishes.");
    if (job.status === "queued") {
      ctx.db.query("UPDATE jobs SET status = 'failed', last_error = 'Cancelled by undo', finished_at = ? WHERE id = ?").run(new Date().toISOString(), u.jobId);
      return;
    }
    const p = json<MigratePayload>(job.payload, {} as MigratePayload);
    undoImport(ctx, p.report?.created ?? p.created ?? emptyCreated());
  },
});

defineAction({
  name: "migrate.status",
  title: "How is the import going?",
  description: "Progress of a WordPress import and, when it's done, its report: counts, the old-to-new address map, unknown shortcodes, images without alt text, thin pages and duplicate titles.",
  permission: "read",
  risk: "read",
  input: z.object({ jobId: z.string().optional().describe("Defaults to the latest import on this site") }),
  run(ctx, input) {
    const row = input.jobId
      ? ctx.db.query<any, [string, string]>("SELECT * FROM jobs WHERE id = ? AND site_id = ? AND kind = 'migrate.wordpress'").get(input.jobId, ctx.siteId!)
      : ctx.db.query<any, [string]>("SELECT * FROM jobs WHERE site_id = ? AND kind = 'migrate.wordpress' ORDER BY created_at DESC LIMIT 1").get(ctx.siteId!);
    if (!row) throw new TqError("not_found", "There's no import on this site yet.");
    const p = json<MigratePayload>(row.payload, {} as MigratePayload);
    const status = p.error ? "failed" : row.status === "done" ? "done" : row.status === "failed" ? "failed" : row.status;
    return {
      jobId: row.id,
      status,
      label: p.label,
      progress: p.progress ?? null,
      error: p.error ?? (row.status === "failed" ? row.last_error : null),
      report: p.report ?? null,
      startedAt: row.created_at,
      finishedAt: row.finished_at,
    };
  },
});

defineAction({
  name: "migrate.audit",
  title: "Audit a site for free",
  description:
    "Checks any public site without changing it: page count, missing titles and descriptions, duplicate titles, images without alt text, thin pages (under 300 words), slow pages, a sample of broken links, and which WordPress plugins Tidequill replaces. Reads at most 200 pages, 4 at a time.",
  permission: "read",
  risk: "read",
  siteScoped: false,
  input: z.object({ url: z.string().min(3).max(2000), maxPages: z.number().int().min(1).max(200).optional() }),
  run(_ctx, input) {
    return runAudit(input.url, { maxPages: input.maxPages });
  },
});

// ---------- Job ----------

async function migrateJob(ctx: Ctx, payload: MigratePayload, job: { id: string }) {
  let state: MigratePayload = { ...payload, created: payload.created ?? emptyCreated() };
  const save = () => ctx.db.query("UPDATE jobs SET payload = ? WHERE id = ?").run(JSON.stringify(state), job.id);
  const progress = (p: ImportProgress) => {
    state = { ...state, progress: p };
    save();
  };
  // People's revisions say who imported: the person (or agent) who started it.
  const actx: Ctx = { ...ctx, actor: payload.actor ?? { kind: "system" } };
  try {
    progress({ phase: "reading", done: 0, total: 0, message: "Reading the WordPress site" });
    const src = payload.source;
    let wp;
    if (src.kind === "wxr") {
      const path = wxrPath(ctx.dataDir, ctx.siteId!, src.fileId ?? "");
      if (!path || !existsSync(path)) throw invalid("The export file is gone. Upload it again.");
      wp = parseWxr(readFileSync(path, "utf8"));
    } else {
      wp = await fetchWpRest(src.url!, { username: src.username, appPassword: src.appPassword }, (what, n) => progress({ phase: "reading", done: n, total: 0, message: `Read ${n} ${what}` }));
    }
    const report = await runImport(actx, wp, payload.options, { source: src.kind === "wxr" ? "WordPress export file" : src.url!, actionId: payload.actionId, created: state.created }, progress);
    state = { ...state, report };
  } catch (err) {
    const message = err instanceof TqError ? err.message : `The import stopped: ${(err as Error).message}`;
    state = { ...state, error: `${message} What was imported so far stays; run the import again to finish (anything already imported is skipped), or undo it.` };
    state.progress = { phase: "failed", done: state.progress?.done ?? 0, total: state.progress?.total ?? 0, message };
    console.error("[tidequill] WordPress import failed:", (err as Error).message);
  } finally {
    // The application password was needed once; don't keep it anywhere.
    if (state.source.appPassword) {
      state = { ...state, source: { ...state.source, appPassword: undefined } };
      if (payload.actionId) {
        ctx.db.query("UPDATE actions SET input = json_remove(input, '$.appPassword') WHERE id = ?").run(payload.actionId);
        ctx.db.query("UPDATE proposals SET input = json_remove(input, '$.appPassword'), payload = json_remove(payload, '$.source.appPassword') WHERE action_id = ?").run(payload.actionId);
      }
    }
    save();
  }
}

// ---------- Install ----------

let installed = false;

export async function install(_rt: Runtime) {
  if (installed) return;
  installed = true;
  registerJob(MIGRATE_JOB, migrateJob);
  extendApi((app) => {
    /** Upload a WordPress export (WXR): multipart `file` → `{ fileId, title, items }`. Then call migrate.wordpress with the fileId. */
    app.post("/api/migrate/wxr", async (c) => {
      const ctx = requestCtx(c);
      if (!ctx.siteId) throw invalid("Pick the site to import into first.");
      if (ctx.role !== "owner") throw forbidden("Only an owner can import a site.");
      const form = await c.req.formData().catch(() => {
        throw invalid("Send the export as a form upload (multipart/form-data) in a field called “file”.");
      });
      const file = form.get("file");
      if (!file || typeof file === "string") throw invalid("Choose the WordPress export file (.xml) to upload.");
      if (file.size > MAX_WXR_BYTES) throw invalid(`That export is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_WXR_BYTES)}. Export posts and pages separately and import them one after the other.`);
      return c.json(storeWxr(ctx.dataDir, ctx.siteId, await file.text()));
    });
  });
}
