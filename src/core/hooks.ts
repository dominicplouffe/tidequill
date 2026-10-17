import type { Entry } from "./entries.ts";
import type { Ctx } from "./types.ts";

/**
 * Extension points other modules plug into at boot, so core never imports
 * feature modules directly.
 */

export interface Finding {
  /** Which part of the Ready light this belongs to. */
  area: "human" | "seo" | "aeo" | "voice" | "check";
  /** One sentence: what's wrong and what to do. */
  message: string;
  severity: "info" | "warn" | "error";
  blockId?: string;
  /** Exact text the finding is about, if any. */
  quote?: string;
  /** A suggested replacement (markdown), if the fix is mechanical. */
  suggestion?: string;
  /** Machine id so "Fix it" can call quality.fix. */
  code: string;
}

export interface Readiness {
  ready: boolean;
  light: "green" | "amber" | "red";
  scores: { human: number; seo: number; aeo: number; voice: number | null };
  minimums: { human: number; seo: number; aeo: number };
  /** One line for cards: "Ready" or "2 fixes before it's ready". */
  headline: string;
  findings: Finding[];
  checks: { name: string; passed: boolean; message: string; blocking: boolean }[];
}

type ReadinessFn = (ctx: Ctx, entry: Entry) => Promise<Readiness> | Readiness;
let readinessFn: ReadinessFn | null = null;

export function setReadinessCheck(fn: ReadinessFn) {
  readinessFn = fn;
}

export async function readiness(ctx: Ctx, entry: Entry): Promise<Readiness | null> {
  return readinessFn ? readinessFn(ctx, entry) : null;
}

/** Called after an entry is saved (link graph, fact usages, search index...). */
type EntrySavedFn = (ctx: Ctx, entry: Entry) => void | Promise<void>;
const entrySaved: EntrySavedFn[] = [];
export function onEntrySaved(fn: EntrySavedFn) {
  entrySaved.push(fn);
}
export async function runEntrySaved(ctx: Ctx, entry: Entry) {
  for (const fn of entrySaved) await fn(ctx, entry);
}

/** Called after a post is published for the first time (internal linking engine, IndexNow...). */
type PublishedFn = (ctx: Ctx, entry: Entry) => void | Promise<void>;
const published: PublishedFn[] = [];
export function onPublished(fn: PublishedFn) {
  published.push(fn);
}
export async function runPublished(ctx: Ctx, entry: Entry) {
  for (const fn of published) {
    try {
      await fn(ctx, entry);
    } catch (err) {
      console.error("[tidequill] after-publish hook failed:", err);
    }
  }
}

/** "How the site is doing": provided by the edge analytics module. */
export interface Health {
  visitsThisWeek: number;
  visitsChangePct: number | null;
  aiVisitsThisWeek: number;
  aiByAssistant: { name: string; visits: number }[];
  medianLoadMs: number | null;
  topPages: { path: string; visits: number }[];
}
type HealthFn = (ctx: Ctx, siteId: string) => Health | Promise<Health>;
let healthFn: HealthFn | null = null;
export function setHealthProvider(fn: HealthFn) {
  healthFn = fn;
}
export async function health(ctx: Ctx, siteId: string): Promise<Health | null> {
  return healthFn ? healthFn(ctx, siteId) : null;
}
