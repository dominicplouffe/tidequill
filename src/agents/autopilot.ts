import { json } from "../core/db.ts";
import { TqError } from "../core/errors.ts";
import { invoke } from "../core/registry.ts";
import { getSite } from "../core/sites.ts";
import type { Ctx } from "../core/types.ts";
import { estimateWrite } from "./actions.ts";
import { allFacts, ideas, isStale, lessons } from "./knowledge.ts";
import { assertBudget } from "./runs.ts";
import { overlap } from "./text.ts";

/**
 * The site runs itself. Every 6 hours per site:
 * - if fewer posts are lined up for the next 7 days than the cadence has slots,
 *   and budget remains, start one post from the best unused idea (one at a time,
 *   never more than 3 a day);
 * - every published post older than 180 days that uses a stale fact gets a
 *   refresh proposal, at most once a week per post.
 * Drafts are invisible; publishing and refreshes are proposals until trust is earned.
 */

export const AUTOPILOT_JOB = "agents.autopilot";
export const AUTOPILOT_EVERY_MS = 6 * 3_600_000;
const MAX_POSTS_PER_DAY = 3;
const REFRESH_AGE_DAYS = 180;
const MAX_REFRESHES_PER_PASS = 2;

export interface AutopilotReport {
  wrote: string | null;
  refreshed: string[];
  why: string;
}

function ownerOf(ctx: Ctx, siteId: string): string | null {
  return ctx.db.query<{ user_id: string }, [string]>("SELECT user_id FROM memberships WHERE site_id = ? AND role = 'owner' ORDER BY rowid LIMIT 1").get(siteId)?.user_id ?? null;
}

export async function runAutopilot(base: Ctx, now = new Date()): Promise<AutopilotReport> {
  const siteId = base.siteId;
  if (!siteId) return { wrote: null, refreshed: [], why: "No site." };
  const db = base.db;
  const site = getSite(db, siteId);
  const owner = ownerOf(base, siteId);
  if (!owner) return { wrote: null, refreshed: [], why: "The site has no owner." };
  const agent = (role: "editor" | "steward"): Ctx => ({ ...base, actor: { kind: "agent", role, onBehalfOf: owner }, role: "owner" });
  const report: AutopilotReport = { wrote: null, refreshed: [], why: "" };

  // ---- Writing ----
  const in7 = new Date(now.getTime() + 7 * 86_400_000).toISOString();
  const nowIso = now.toISOString();
  const scheduled = db.query<{ n: number }, [string, string, string]>("SELECT COUNT(*) AS n FROM entries WHERE site_id = ? AND status = 'scheduled' AND deleted_at IS NULL AND publish_at >= ? AND publish_at <= ?").get(siteId, nowIso, in7)?.n ?? 0;
  const proposed = db
    .query<{ payload: string }, [string]>("SELECT payload FROM proposals WHERE site_id = ? AND status = 'pending' AND action_name = 'posts.publish'")
    .all(siteId)
    .filter((p) => {
      const at = json<{ at?: string | null }>(p.payload, {}).at;
      return at && at >= nowIso && at <= in7;
    }).length;
  const writeRuns = db.query<{ status: string; created_at: string }, [string]>("SELECT status, created_at FROM agent_runs WHERE site_id = ? AND json_extract(plan, '$.kind') = 'write'").all(siteId);
  const inFlight = writeRuns.filter((r) => r.status === "queued" || r.status === "running").length;
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const today = writeRuns.filter((r) => r.created_at >= dayStart.toISOString()).length;
  const target = site.settings.cadence.days.length || 7;
  const lined = scheduled + proposed;

  if (lined >= target) report.why = `${lined} posts are lined up for the next 7 days; the cadence needs ${target}.`;
  else if (inFlight > 0) report.why = "A post is already being written.";
  else if (today >= MAX_POSTS_PER_DAY) report.why = `Already started ${today} posts today.`;
  else {
    const rejected = lessons(db, siteId, 50).map((l) => l.text);
    const existing = db.query<{ title: string }, [string]>("SELECT title FROM entries WHERE site_id = ? AND deleted_at IS NULL AND type = 'post'").all(siteId).map((r) => r.title);
    const idea = ideas(db, siteId).find((i) => !i.used && !existing.some((t) => overlap(i.title, t) >= 0.85) && !rejected.some((l) => overlap(i.title, l) >= 0.85));
    if (!idea) report.why = "No unused ideas left. Ask me for more ideas.";
    else {
      try {
        assertBudget(db, siteId, estimateWrite(base));
        const r = await invoke(agent("editor"), "posts.write", { topic: idea.title, title: idea.title, idea: idea.id, schedule: "next_slot", source: "autopilot" });
        if (r.status === "applied") {
          report.wrote = (r.result as { runId: string }).runId;
          report.why = `Started “${idea.title}”: ${lined} of ${target} slots are filled for the next 7 days.`;
        } else report.why = "Writing needs your go-ahead first.";
      } catch (err) {
        if (err instanceof TqError && err.code === "budget") report.why = err.message;
        else throw err;
      }
    }
  }

  // ---- Refreshing ----
  const cutoff = new Date(now.getTime() - REFRESH_AGE_DAYS * 86_400_000).toISOString();
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const stale = new Set(allFacts(db, siteId).filter((f) => isStale(f, now.getTime())).map((f) => f.key));
  const staleIds = new Set(allFacts(db, siteId).filter((f) => isStale(f, now.getTime())).map((f) => f.id));
  if (stale.size) {
    const old = db.query<{ id: string; body: string; title: string }, [string, string]>("SELECT id, body, title FROM entries WHERE site_id = ? AND status = 'published' AND deleted_at IS NULL AND COALESCE(updated_at, published_at) <= ?").all(siteId, cutoff);
    for (const e of old) {
      if (report.refreshed.length >= MAX_REFRESHES_PER_PASS) break;
      const keys = [...e.body.matchAll(/\{\{\s*fact:([\w.-]+)\s*\}\}/g)].map((m) => m[1]!);
      const viaUsage = db.query<{ fact_id: string }, [string]>("SELECT fact_id FROM fact_usages WHERE entry_id = ?").all(e.id).some((u) => staleIds.has(u.fact_id));
      if (!keys.some((k) => stale.has(k)) && !viaUsage) continue;
      const recent =
        db.query("SELECT 1 FROM agent_runs WHERE site_id = ? AND json_extract(plan, '$.kind') = 'refresh' AND json_extract(plan, '$.input.id') = ? AND created_at >= ?").get(siteId, e.id, weekAgo) ??
        db.query("SELECT 1 FROM proposals WHERE site_id = ? AND entry_id = ? AND action_name IN ('posts.update', 'posts.update_block') AND created_at >= ?").get(siteId, e.id, weekAgo);
      if (recent) continue;
      try {
        await invoke(agent("steward"), "posts.refresh", { id: e.id });
        report.refreshed.push(e.id);
      } catch (err) {
        if (err instanceof TqError && err.code === "budget") break;
        console.error("[tidequill] autopilot refresh failed:", (err as Error).message);
      }
    }
  }
  return report;
}
