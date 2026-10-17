import { join } from "node:path";
import type { Health } from "../core/hooks.ts";
import { ASSISTANT_GROUPS, OTHER_BOTS, botGroup } from "../render/crawlers.ts";
import { readJsonFile, siteDir, writeAtomic } from "../render/files.ts";

/**
 * Cookieless analytics: page views per path and day, AI assistant and
 * crawler visits by group, and response times. Nothing identifies a visitor;
 * counts live in memory and are flushed to
 * <dataDir>/sites/<siteId>/analytics/YYYY-MM-DD.json every minute.
 */

export interface DayStats {
  date: string;
  views: Record<string, number>;
  bots: Record<string, number>;
  /** Pages each assistant read, for "which pages do assistants read". */
  botPages: Record<string, Record<string, number>>;
  requests: number;
  /** A sample of response times in ms (bounded), for the median. */
  ms: number[];
}

const MAX_SAMPLES = 2000;
const pending = new Map<string, { dataDir: string; siteId: string; day: DayStats }>();

function emptyDay(date: string): DayStats {
  return { date, views: {}, bots: {}, botPages: {}, requests: 0, ms: [] };
}

const today = (now = new Date()) => now.toISOString().slice(0, 10);

export function analyticsDir(dataDir: string, siteId: string): string {
  return join(siteDir(dataDir, siteId), "analytics");
}

export interface Hit {
  path: string;
  userAgent: string | null;
  ms: number;
  /** Counts as a page view (an HTML page or a markdown twin, answered 200 or 304). */
  page: boolean;
}

export function recordHit(dataDir: string, siteId: string, hit: Hit, now = new Date()) {
  const date = today(now);
  const key = `${dataDir}\u0000${siteId}\u0000${date}`;
  let p = pending.get(key);
  if (!p) {
    p = { dataDir, siteId, day: emptyDay(date) };
    pending.set(key, p);
  }
  const d = p.day;
  d.requests++;
  if (d.ms.length < MAX_SAMPLES) d.ms.push(Math.round(hit.ms * 100) / 100);
  if (!hit.page) return;
  const group = botGroup(hit.userAgent);
  if (group) {
    d.bots[group] = (d.bots[group] ?? 0) + 1;
    const pages = (d.botPages[group] ??= {});
    pages[hit.path] = (pages[hit.path] ?? 0) + 1;
  } else if (!hit.path.endsWith(".md")) {
    d.views[hit.path] = (d.views[hit.path] ?? 0) + 1;
  }
}

function addInto(target: Record<string, number>, src: Record<string, number>) {
  for (const [k, v] of Object.entries(src)) target[k] = (target[k] ?? 0) + v;
}

export function mergeDays(a: DayStats, b: DayStats): DayStats {
  const out: DayStats = { date: a.date, views: { ...a.views }, bots: { ...a.bots }, botPages: {}, requests: a.requests + b.requests, ms: [] };
  addInto(out.views, b.views);
  addInto(out.bots, b.bots);
  for (const src of [a.botPages, b.botPages]) for (const [g, pages] of Object.entries(src)) addInto((out.botPages[g] ??= {}), pages);
  const ms = [...a.ms, ...b.ms];
  // Keep an even spread when the sample is full.
  out.ms = ms.length <= MAX_SAMPLES ? ms : ms.filter((_, i) => i % Math.ceil(ms.length / MAX_SAMPLES) === 0);
  return out;
}

/** Writes every pending day to disk, merging with what's already there. */
export function flushAnalytics() {
  for (const [key, p] of pending) {
    pending.delete(key);
    const file = join(analyticsDir(p.dataDir, p.siteId), `${p.day.date}.json`);
    const existing = readJsonFile<DayStats>(file, emptyDay(p.day.date));
    try {
      writeAtomic(file, JSON.stringify(mergeDays(existing, p.day)));
    } catch (err) {
      console.error("[tidequill] couldn't save analytics:", (err as Error).message);
    }
  }
}

function dayStats(dataDir: string, siteId: string, date: string): DayStats {
  let d = readJsonFile<DayStats>(join(analyticsDir(dataDir, siteId), `${date}.json`), emptyDay(date));
  const live = pending.get(`${dataDir}\u0000${siteId}\u0000${date}`);
  if (live) d = mergeDays(d, live.day);
  return d;
}

function lastDays(n: number, offset: number, now: Date): string[] {
  return Array.from({ length: n }, (_, i) => today(new Date(now.getTime() - (i + offset) * 86_400_000)));
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return Math.round((s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2) * 10) / 10;
}

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

/** "How the site is doing": this week against last week, from the analytics files. */
export function siteHealth(dataDir: string, siteId: string, now = new Date()): Health {
  const week = lastDays(7, 0, now).map((d) => dayStats(dataDir, siteId, d));
  const prior = lastDays(7, 7, now).map((d) => dayStats(dataDir, siteId, d));
  const views: Record<string, number> = {};
  const bots: Record<string, number> = {};
  for (const d of week) {
    addInto(views, d.views);
    addInto(bots, d.bots);
  }
  const visitsThisWeek = sum(views);
  const visitsLastWeek = prior.reduce((n, d) => n + sum(d.views), 0);
  const assistants = ASSISTANT_GROUPS.map((g) => g.name);
  return {
    visitsThisWeek,
    visitsChangePct: visitsLastWeek ? Math.round(((visitsThisWeek - visitsLastWeek) / visitsLastWeek) * 100) : null,
    aiVisitsThisWeek: assistants.reduce((n, a) => n + (bots[a] ?? 0), 0),
    aiByAssistant: [...assistants, OTHER_BOTS]
      .map((name) => ({ name, visits: bots[name] ?? 0 }))
      .filter((x) => x.visits > 0)
      .sort((a, b) => b.visits - a.visits),
    medianLoadMs: median(week.flatMap((d) => d.ms)),
    topPages: Object.entries(views)
      .map(([path, visits]) => ({ path, visits }))
      .sort((a, b) => b.visits - a.visits)
      .slice(0, 5),
  };
}

export function _resetAnalyticsForTests() {
  pending.clear();
}
