import type { Db } from "./db.ts";

/** v1 has three roles. Owner does everything; Writer writes; Reviewer reads and approves. */
export type Role = "owner" | "writer" | "reviewer";

/** What an action needs. Roles map to permission sets in `permissionsFor`. */
export type Permission = "read" | "write" | "review" | "admin";

export function permissionsFor(role: Role): Permission[] {
  switch (role) {
    case "owner":
      return ["read", "write", "review", "admin"];
    case "writer":
      return ["read", "write"];
    case "reviewer":
      return ["read", "review"];
  }
}

/** Agent roles appear only in run history; to the person it is one editorial team voice. */
export type AgentRole = "editor" | "writer" | "researcher" | "fact_checker" | "seo" | "designer" | "steward";

export type Actor =
  | { kind: "human"; userId: string; name?: string }
  | { kind: "agent"; role: AgentRole; onBehalfOf: string | null; runId?: string }
  | { kind: "system" };

/** read: no change. reversible: undoable change. destructive: deletes; always asks. costly: spends model budget. */
export type Risk = "read" | "reversible" | "destructive" | "costly";

/**
 * Kinds of work that earn autonomy. Thresholds are clean (unedited) approvals
 * needed before the site does that kind of work on its own. `null` = always asks.
 */
export type TrustKind = "links" | "alt_text" | "prices" | "refresh" | "new_post" | "look" | "settings" | "delete" | "other";

export const TRUST_THRESHOLDS: Record<TrustKind, number | null> = {
  links: 10,
  alt_text: 10,
  prices: 10,
  refresh: 30,
  new_post: 50,
  look: null,
  settings: null,
  delete: null,
  other: null,
};

export const TRUST_LABELS: Record<TrustKind, string> = {
  links: "Links",
  alt_text: "Alt text and captions",
  prices: "Prices and facts",
  refresh: "Refreshing old posts",
  new_post: "New posts",
  look: "Changes to the look",
  settings: "Settings",
  delete: "Deleting anything",
  other: "Other changes",
};

/** The handful of site settings. Each is readable back as a sentence (see core/settings.ts). */
export interface SiteSettings {
  askMeFirst: boolean;
  monthlyBudgetUsd: number;
  timezone: string;
  /** Days (0=Sun) and local time new posts are scheduled for. */
  cadence: { days: number[]; time: string };
  readyMinimums: { human: number; seo: number; aeo: number };
  aiDisclosure: boolean;
  allowTrainingCrawlers: boolean;
}

export const DEFAULT_SETTINGS: SiteSettings = {
  askMeFirst: false,
  monthlyBudgetUsd: 40,
  timezone: "UTC",
  cadence: { days: [2, 4, 6], time: "09:00" },
  readyMinimums: { human: 80, seo: 85, aeo: 80 },
  aiDisclosure: true,
  allowTrainingCrawlers: false,
};

export interface Site {
  id: string;
  name: string;
  niche: string;
  locale: string;
  design: string;
  tokens: Record<string, unknown>;
  settings: SiteSettings;
  primaryDomain: string | null;
  domains: string[];
  createdAt: string;
}

/** Process-wide services an action may use. Filled in by the server at boot. */
export interface Services {
  /** Queue a static rebuild. `paths` omitted = whole site. */
  enqueueBuild(siteId: string, reason: string, entryIds?: string[]): void;
  /** Fire-and-forget domain events (published, changed, proposal created...). */
  emit(event: TqEvent): void;
}

export type TqEvent =
  | { type: "entry.changed"; siteId: string; entryId: string }
  | { type: "entry.published"; siteId: string; entryId: string }
  | { type: "entry.unpublished"; siteId: string; entryId: string }
  | { type: "site.changed"; siteId: string; what: "look" | "settings" | "menu" | "domains" | "authors" | "categories" }
  | { type: "fact.changed"; siteId: string; factId: string }
  | { type: "media.changed"; siteId: string; mediaId: string }
  | { type: "proposal.created"; siteId: string; proposalId: string }
  | { type: "proposal.decided"; siteId: string; proposalId: string; status: string }
  | { type: "action.applied"; siteId: string | null; actionId: string; auto: boolean };

export interface Ctx {
  db: Db;
  actor: Actor;
  /** Active site, if the call is site-scoped. */
  siteId: string | null;
  /** Role of the human behind this call on `siteId` (agents inherit their requester's role). */
  role: Role | null;
  services: Services;
  /** Absolute path to the data directory (media, built sites). */
  dataDir: string;
  /** Present when the call happens inside an agent run. */
  runId?: string;
}
