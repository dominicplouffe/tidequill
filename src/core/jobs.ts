import type { Db } from "./db.ts";
import { json } from "./db.ts";
import { id, nowIso } from "./ids.ts";
import type { Ctx } from "./types.ts";

/**
 * A tiny durable job queue in SQLite. Builds, link checks, fact re-verification
 * and agent runs all go through it, so work survives restarts.
 */

export type JobHandler = (ctx: Ctx, payload: any, job: { id: string; siteId: string | null; attempts: number }) => Promise<void> | void;

const handlers = new Map<string, JobHandler>();
const recurring: { kind: string; everyMs: number; perSite: boolean }[] = [];

export function registerJob(kind: string, handler: JobHandler) {
  handlers.set(kind, handler);
}

/** A job that runs every `everyMs`, once per site (perSite) or once per install. */
export function registerRecurring(kind: string, everyMs: number, perSite = true) {
  recurring.push({ kind, everyMs, perSite });
}

export function enqueue(db: Db, kind: string, siteId: string | null, payload: unknown = {}, runAt = new Date()): string {
  const jid = id("job");
  db.query("INSERT INTO jobs (id, site_id, kind, payload, status, run_at, created_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)").run(jid, siteId, kind, JSON.stringify(payload), runAt.toISOString(), nowIso());
  return jid;
}

/** Build jobs for the same site coalesce: a queued build absorbs new entry ids (or becomes a full build). */
export function enqueueBuild(db: Db, siteId: string, reason: string, entryIds?: string[]) {
  const queued = db.query<{ id: string; payload: string }, [string]>("SELECT id, payload FROM jobs WHERE site_id = ? AND kind = 'build' AND status = 'queued' LIMIT 1").get(siteId);
  if (queued) {
    const p = json<{ entryIds: string[] | null; reasons: string[] }>(queued.payload, { entryIds: null, reasons: [] });
    const merged = p.entryIds === null || !entryIds ? null : [...new Set([...p.entryIds, ...entryIds])];
    db.query("UPDATE jobs SET payload = ? WHERE id = ?").run(JSON.stringify({ entryIds: merged, reasons: [...p.reasons, reason].slice(-20) }), queued.id);
    return queued.id;
  }
  return enqueue(db, "build", siteId, { entryIds: entryIds ?? null, reasons: [reason] });
}

/** Runs due jobs once. Returns how many ran. */
export async function runDueJobs(makeCtx: (siteId: string | null) => Ctx, limit = 10): Promise<number> {
  const probe = makeCtx(null);
  const db = probe.db;
  const due = db.query<any, [string, number]>("SELECT * FROM jobs WHERE status = 'queued' AND run_at <= ? ORDER BY run_at LIMIT ?").all(nowIso(), limit);
  let ran = 0;
  for (const job of due) {
    const claimed = db.query("UPDATE jobs SET status = 'running', attempts = attempts + 1 WHERE id = ? AND status = 'queued'").run(job.id);
    if (claimed.changes === 0) continue;
    const handler = handlers.get(job.kind);
    if (!handler) {
      db.query("UPDATE jobs SET status = 'failed', last_error = ?, finished_at = ? WHERE id = ?").run(`No handler for ${job.kind}`, nowIso(), job.id);
      continue;
    }
    try {
      await handler(makeCtx(job.site_id), json(job.payload, {}), { id: job.id, siteId: job.site_id, attempts: job.attempts + 1 });
      db.query("UPDATE jobs SET status = 'done', finished_at = ? WHERE id = ?").run(nowIso(), job.id);
    } catch (err) {
      const attempts = job.attempts + 1;
      const msg = String((err as Error)?.stack ?? err).slice(0, 2000);
      if (attempts < 3) {
        const retryAt = new Date(Date.now() + attempts * attempts * 30_000).toISOString();
        db.query("UPDATE jobs SET status = 'queued', run_at = ?, last_error = ? WHERE id = ?").run(retryAt, msg, job.id);
      } else {
        db.query("UPDATE jobs SET status = 'failed', last_error = ?, finished_at = ? WHERE id = ?").run(msg, nowIso(), job.id);
      }
      console.error(`[tidequill] job ${job.kind} failed:`, (err as Error)?.message ?? err);
    }
    ran++;
  }
  return ran;
}

/** Seeds recurring jobs that are due (called by the scheduler every minute). */
export function seedRecurring(db: Db) {
  const sites = db.query<{ id: string }, []>("SELECT id FROM sites WHERE deleted_at IS NULL").all();
  for (const r of recurring) {
    const targets = r.perSite ? sites.map((s) => s.id) : [null];
    for (const siteId of targets) {
      const last = db
        .query<{ created_at: string }, [string, string | null, string | null]>("SELECT created_at FROM jobs WHERE kind = ? AND (site_id = ? OR (site_id IS NULL AND ? IS NULL)) ORDER BY created_at DESC LIMIT 1")
        .get(r.kind, siteId, siteId);
      if (!last || Date.now() - Date.parse(last.created_at) >= r.everyMs) enqueue(db, r.kind, siteId, {});
    }
  }
}

export function pruneJobs(db: Db) {
  db.query("DELETE FROM jobs WHERE status IN ('done', 'failed') AND created_at < ?").run(new Date(Date.now() - 14 * 86_400_000).toISOString());
}
