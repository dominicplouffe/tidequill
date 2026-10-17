import type { Db } from "./db.ts";
import { json } from "./db.ts";
import { nowIso } from "./ids.ts";
import { TRUST_LABELS, TRUST_THRESHOLDS, type TrustKind } from "./types.ts";

/**
 * Earned autonomy. The site asks before every change at first. Each proposal
 * approved without edits counts toward that kind of work; at the threshold the
 * site starts doing that work on its own and says so. A discard (or an undo of
 * something it did alone) halves the count and takes the autonomy back.
 * "Ask me first" overrides everything.
 */

export interface TrustState {
  kind: TrustKind;
  label: string;
  clean: number;
  threshold: number | null;
  earned: boolean;
  earnedAt: string | null;
  justEarned?: boolean;
  justLost?: boolean;
}

function row(db: Db, siteId: string, kind: TrustKind) {
  return db.query<{ clean: number; earned_at: string | null }, [string, string]>("SELECT clean, earned_at FROM trust WHERE site_id = ? AND kind = ?").get(siteId, kind);
}

function state(kind: TrustKind, clean: number, earnedAt: string | null): TrustState {
  return { kind, label: TRUST_LABELS[kind], clean, threshold: TRUST_THRESHOLDS[kind], earned: !!earnedAt, earnedAt };
}

export function askMeFirst(db: Db, siteId: string): boolean {
  const s = db.query<{ settings: string }, [string]>("SELECT settings FROM sites WHERE id = ?").get(siteId);
  return !!json<{ askMeFirst?: boolean }>(s?.settings, {}).askMeFirst;
}

export function canActAlone(db: Db, siteId: string, kind: TrustKind): boolean {
  if (TRUST_THRESHOLDS[kind] == null) return false;
  if (askMeFirst(db, siteId)) return false;
  return !!row(db, siteId, kind)?.earned_at;
}

export function recordDecision(db: Db, siteId: string, kind: TrustKind, decision: "clean" | "edited" | "discarded"): TrustState {
  const current = row(db, siteId, kind) ?? { clean: 0, earned_at: null };
  let { clean, earned_at } = current;
  const threshold = TRUST_THRESHOLDS[kind];
  let justEarned = false;
  let justLost = false;
  if (decision === "clean") {
    clean += 1;
    if (threshold != null && clean >= threshold && !earned_at) {
      earned_at = nowIso();
      justEarned = true;
    }
  } else if (decision === "discarded") {
    clean = Math.floor(clean / 2);
    if (earned_at) justLost = true;
    earned_at = null;
  }
  db.query(
    "INSERT INTO trust (site_id, kind, clean, earned_at) VALUES (?, ?, ?, ?) ON CONFLICT(site_id, kind) DO UPDATE SET clean = excluded.clean, earned_at = excluded.earned_at",
  ).run(siteId, kind, clean, earned_at);
  return { ...state(kind, clean, earned_at), justEarned, justLost };
}

/** The "Trust earned so far" panel: every kind of work that can be earned. */
export function trustSummary(db: Db, siteId: string): TrustState[] {
  return (Object.keys(TRUST_THRESHOLDS) as TrustKind[])
    .filter((k) => TRUST_THRESHOLDS[k] != null)
    .map((k) => {
      const r = row(db, siteId, k);
      return state(k, r?.clean ?? 0, r?.earned_at ?? null);
    });
}
