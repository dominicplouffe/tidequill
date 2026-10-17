import { registerJob } from "../core/jobs.ts";
import type { Runtime } from "../core/runtime.ts";
import type { TqEvent } from "../core/types.ts";
import { extendApi } from "../server/app.ts";
import { buildSite, writeHostsFile } from "./build.ts";
import { liveRoutes } from "./live.ts";
import "./look.ts";

/**
 * The renderer: house designs, the static build, look actions, live-site
 * editing and previews. Other modules use these exports:
 */
export { buildSite, lastBuild, onSiteBuilt, writeHostsFile, type BuildReport } from "./build.ts";
export { checkRenderedEntry, type PublishCheck } from "./checks.ts";
export { renderEntryHtml, renderPreview, renderPathFromDb } from "./preview.ts";
export { resolveTokens, siteTokenSet, contrastRatio, contrastProblems, HOUSE_DESIGNS, type DesignTokens, type FontId, type TokenOverrides } from "./tokens.ts";
export { publicDir, siteDir } from "./files.ts";

function onEvent(rt: Runtime, e: TqEvent) {
  if (e.type === "site.changed" && e.what === "domains") writeHostsFile(rt.db, rt.config.dataDir);
  if (e.type === "site.changed" && (e.what === "look" || e.what === "menu")) rt.services.enqueueBuild(e.siteId, `site ${e.what} changed`);
  if (e.type === "fact.changed") {
    // Self-healing: every page that shows the fact is rebuilt with the new value.
    const fact = rt.db.query<{ key: string }, [string]>("SELECT key FROM facts WHERE id = ?").get(e.factId);
    const ids = rt.db
      .query<{ id: string }, [string, string, string]>(
        "SELECT id FROM entries WHERE site_id = ? AND status = 'published' AND deleted_at IS NULL AND (id IN (SELECT entry_id FROM fact_usages WHERE fact_id = ?) OR body LIKE ?)",
      )
      .all(e.siteId, e.factId, `%fact:${fact?.key ?? "\u0000"}%`)
      .map((r) => r.id);
    // Facts also feed agent/facts.json, so the site files are rebuilt even when no page uses it.
    rt.services.enqueueBuild(e.siteId, "fact changed", ids);
  }
  if (e.type === "media.changed") {
    const ids = rt.db
      .query<{ id: string }, [string, string, string]>("SELECT id FROM entries WHERE site_id = ? AND status = 'published' AND deleted_at IS NULL AND (hero_media_id = ? OR body LIKE ?)")
      .all(e.siteId, e.mediaId, `%${e.mediaId}%`)
      .map((r) => r.id);
    if (ids.length) rt.services.enqueueBuild(e.siteId, "media changed", ids);
  }
}

export async function install(rt: Runtime) {
  registerJob("build", async (ctx, payload: { entryIds?: string[] | null; reasons?: string[] }, job) => {
    if (!job.siteId) return;
    const report = await buildSite(ctx, job.siteId, payload.entryIds ?? null, payload.reasons ?? []);
    if (report.checks.length) console.warn(`[tidequill] build of ${job.siteId}: ${report.checks.length} publish check${report.checks.length > 1 ? "s" : ""} failed: ${report.checks[0]!.message}`);
  });
  rt.on((e) => onEvent(rt, e));
  extendApi((app, runtime) => liveRoutes(app, runtime));
}
