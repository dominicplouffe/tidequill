import type { Config } from "../config.ts";
import { openDb, type Db } from "./db.ts";
import { enqueueBuild, pruneJobs, runDueJobs, seedRecurring } from "./jobs.ts";
import type { Actor, Ctx, Role, Services, TqEvent } from "./types.ts";

/**
 * The runtime ties an install together: one database, one event bus, the job
 * worker. Everything that needs a Ctx gets it from here.
 */
/** Listeners get the runtime that emitted the event, so they never hold on to another install's database. */
export type Listener = (e: TqEvent, rt: Runtime) => void | Promise<void>;

export class Runtime {
  readonly db: Db;
  readonly services: Services;
  private listeners: Listener[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];
  private working = false;

  constructor(readonly config: Config, db?: Db) {
    this.db = db ?? openDb(config.dbPath);
    this.services = {
      enqueueBuild: (siteId, reason, entryIds) => {
        enqueueBuild(this.db, siteId, reason, entryIds);
        this.kick();
      },
      emit: (event) => {
        for (const l of this.listeners) {
          try {
            const r = l(event, this);
            if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch((err) => console.error("[tidequill] event listener failed:", err));
          } catch (err) {
            console.error("[tidequill] event listener failed:", err);
          }
        }
      },
    };
  }

  on(listener: Listener) {
    this.listeners.push(listener);
  }

  /** Listeners installed so far (tests share module installs across runtimes). */
  get eventListeners(): readonly Listener[] {
    return this.listeners;
  }

  ctx(opts: { actor?: Actor; siteId?: string | null; role?: Role | null; runId?: string } = {}): Ctx {
    return {
      db: this.db,
      actor: opts.actor ?? { kind: "system" },
      siteId: opts.siteId ?? null,
      role: opts.role ?? null,
      services: this.services,
      dataDir: this.config.dataDir,
      runId: opts.runId,
    };
  }

  /** Run due jobs until the queue is empty (used by tests and the CLI). */
  async drain(max = 100) {
    for (let i = 0; i < max; i++) {
      const n = await runDueJobs((siteId) => this.ctx({ siteId }));
      if (n === 0) return;
    }
  }

  private kickTimer: ReturnType<typeof setTimeout> | null = null;
  /** Schedules a worker pass soon (debounced), so a publish goes live in well under 3 seconds. */
  kick() {
    if (!this.timers.length || this.kickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      void this.work();
    }, 150);
  }

  private async work() {
    if (this.working) return;
    this.working = true;
    try {
      await this.drain(20);
    } finally {
      this.working = false;
    }
  }

  start(scheduler: () => Promise<void>) {
    this.timers.push(setInterval(() => void this.work(), 1000));
    const tick = async () => {
      try {
        seedRecurring(this.db);
        await scheduler();
        pruneJobs(this.db);
      } catch (err) {
        console.error("[tidequill] scheduler failed:", err);
      }
    };
    this.timers.push(setInterval(() => void tick(), 60_000));
    void tick();
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.kickTimer) clearTimeout(this.kickTimer);
  }
}
